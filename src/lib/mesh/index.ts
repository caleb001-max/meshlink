// Mesh router: dedupe, TTL relay, discovery beacons, and end-to-end encryption.
// A message from A can reach C through B ("bouncing" off intermediaries) because
// every relay forwards unknown envelopes; only the destination can decrypt.
import * as db from '../db';
import { encryptFor, decryptFrom, getIdentity, type Identity } from '../crypto';
import { randomId } from '../codec';
import { getDisplayName } from '../settings';
import {
  AckBody,
  DEFAULT_TTL,
  DecryptedPayload,
  Envelope,
  EnvelopeType,
  HelloBody,
  MESH_PORT,
  MsgBody,
  makeEnvelope,
} from './protocol';
import { LanTransport } from './lan';
import { BleTransport } from './ble';

const MAX_SEEN = 5000;
const HELLO_INTERVAL_MS = 15000;

export type CallState = 'idle' | 'outgoing' | 'incoming' | 'active' | 'ended';

export interface MeshSnapshot {
  version: number;
  started: boolean;
  lanPeers: number;
  ip: string | null;
  port: number;
  ble: string;
}

class MeshRouter {
  lan = new LanTransport();
  ble = new BleTransport();

  identity: Identity | null = null;
  myName = 'Anonymous';
  started = false;
  /** Bumped on every state change so React screens can re-render via useSyncExternalStore. */
  version = 0;

  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private helloTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();
  private callListeners = new Set<(src: string, type: EnvelopeType) => void>();
  private lastSnapshot: MeshSnapshot | null = null;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await db.getDb();
    this.identity = await getIdentity();
    this.myName = await getDisplayName();

    this.lan.onLine = (line) => void this.handleLine(line);
    this.ble.onLine = (line) => void this.handleLine(line);
    await this.lan.start();
    // Bluetooth is best-effort: never let it break the LAN path.
    void this.ble.start().catch(() => {
      this.ble.status = 'unavailable';
    });

    this.helloTimer = setInterval(() => void this.sendHello(), HELLO_INTERVAL_MS);
    void this.sendHello();
    this.notify();
  }

  stop(): void {
    if (this.helloTimer) clearInterval(this.helloTimer);
    this.helloTimer = null;
    this.lan.stop();
    this.ble.stop();
    this.started = false;
    this.notify();
  }

  get myPk(): string {
    return this.identity?.pk ?? '';
  }

  async setName(name: string): Promise<void> {
    this.myName = name;
    await this.sendHello();
  }

  async sendHello(): Promise<void> {
    if (!this.identity) return;
    const env = makeEnvelope('HELLO', this.identity.pk, this.myName, '*', DEFAULT_TTL, {
      name: this.myName,
      pk: this.identity.pk,
    } satisfies HelloBody);
    this.broadcast(env);
  }

  /** Send an end-to-end encrypted message (text / photo / voice note). */
  async sendMessage(peerPk: string, kind: 'text' | 'photo' | 'audio', text: string, media: string | null): Promise<void> {
    if (!this.identity) return;
    const payload: DecryptedPayload = { mid: randomId(), kind, text, media };
    const cipher = encryptFor(JSON.stringify(payload), peerPk, this.identity);
    await db.insertMessage({
      id: payload.mid,
      peer: peerPk,
      fromMe: true,
      kind,
      body: text,
      media,
      ts: Date.now(),
      status: 'sent',
    });
    const env = makeEnvelope('MSG', this.identity.pk, this.myName, peerPk, DEFAULT_TTL, {
      cipher,
    } satisfies MsgBody);
    this.broadcast(env);
    this.notify();
  }

  /** Call signaling (voice streaming itself ships in v1.1). */
  sendCallSignal(peerPk: string, type: 'CALL_OFFER' | 'CALL_ANSWER' | 'CALL_END'): void {
    if (!this.identity) return;
    const env = makeEnvelope(type, this.identity.pk, this.myName, peerPk, DEFAULT_TTL, {});
    this.broadcast(env);
  }

  onCall(fn: (src: string, type: EnvelopeType) => void): () => void {
    this.callListeners.add(fn);
    return () => this.callListeners.delete(fn);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Snapshot for useSyncExternalStore (cached identity per version). */
  getSnapshot(): MeshSnapshot {
    if (!this.lastSnapshot || this.lastSnapshot.version !== this.version) {
      this.lastSnapshot = {
        version: this.version,
        started: this.started,
        lanPeers: this.lan.peerCount,
        ip: this.lan.localIp,
        port: MESH_PORT,
        ble: this.ble.status,
      };
    }
    return this.lastSnapshot;
  }

  // ---------------------------------------------------------------- internals

  private broadcast(env: Envelope): void {
    const line = JSON.stringify(env);
    this.lan.send(line);
    this.ble.send(line);
  }

  private async handleLine(line: string): Promise<void> {
    let env: Envelope;
    try {
      env = JSON.parse(line) as Envelope;
    } catch {
      return;
    }
    if (!env || env.v !== 1 || typeof env.id !== 'string' || typeof env.type !== 'string') return;
    if (!this.identity || env.src === this.identity.pk) return;
    if (this.seen.has(env.id)) return;

    // Track freshness cheaply.
    this.seen.add(env.id);
    this.seenOrder.push(env.id);
    if (this.seenOrder.length > MAX_SEEN) {
      const drop = this.seenOrder.splice(0, this.seenOrder.length - MAX_SEEN / 2);
      for (const id of drop) this.seen.delete(id);
    }

    switch (env.type) {
      case 'HELLO': {
        const body = env.body as HelloBody;
        await db.upsertPeer({
          pk: env.src,
          name: body?.name || env.srcName || 'Unknown',
          lastSeen: env.ts,
          via: 'mesh',
        });
        this.notify();
        break;
      }
      case 'MSG': {
        if (env.dst === this.identity.pk) {
          await this.receiveMessage(env);
        } else if (env.ttl > 1) {
          this.relay(env);
        }
        break;
      }
      case 'ACK': {
        const body = env.body as AckBody;
        if (env.dst === this.identity.pk) {
          await db.markDelivered(body.of);
          this.notify();
        } else if (env.ttl > 1) {
          this.relay(env);
        }
        break;
      }
      case 'CALL_OFFER':
      case 'CALL_ANSWER':
      case 'CALL_END': {
        if (env.dst === this.identity.pk) {
          for (const fn of this.callListeners) fn(env.src, env.type);
        } else if (env.ttl > 1) {
          this.relay(env);
        }
        break;
      }
    }
  }

  private relay(env: Envelope): void {
    const forwarded = { ...env, ttl: env.ttl - 1 };
    this.broadcast(forwarded);
  }

  private async receiveMessage(env: Envelope): Promise<void> {
    if (!this.identity) return;
    try {
      const body = env.body as MsgBody;
      const payload = JSON.parse(decryptFrom(body.cipher, env.src, this.identity)) as DecryptedPayload;
      await db.upsertPeer({ pk: env.src, name: env.srcName, lastSeen: env.ts, via: 'mesh' });
      await db.insertMessage({
        id: payload.mid,
        peer: env.src,
        fromMe: false,
        kind: payload.kind,
        body: payload.text,
        media: payload.media,
        ts: env.ts,
        status: 'delivered',
      });
      const ack = makeEnvelope('ACK', this.identity.pk, this.myName, env.src, DEFAULT_TTL, {
        of: payload.mid,
      } satisfies AckBody);
      this.broadcast(ack);
      this.notify();
    } catch {
      // Not addressed to us, tampered, or stale key — drop silently.
    }
  }

  private notify(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }
}

export const mesh = new MeshRouter();
