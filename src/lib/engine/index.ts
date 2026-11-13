/**
 * App-facing MeshLink engine.
 *
 * Owns the single MeshNode instance, its encrypted-at-rest SQLite store, the
 * SecureStore identity and the LAN transport. Screens read an immutable
 * snapshot via useSyncExternalStore and call the async methods below.
 */
import * as SecureStore from 'expo-secure-store';
import { MeshNode, type LinkInfo } from '../core/node';
import {
  identityFromStorable,
  identityToStorable,
  newIdentity,
  type Identity,
} from '../core/crypto';
import { PRIO_MEDIA, PRIO_VOICE } from '../core/protocol';
import { hexToBytes } from '../core/bytes';
import type { ContactRecord, MessageKind, MessageRecord, NetworkEventRecord } from '../core/store';
import { getDisplayName, setDisplayName } from '../settings';
import { LanTransport } from './lan';
import { SqliteStore, type ChatSummary, type StoreStats } from './sqlite-store';

const IDENTITY_KEY = 'meshlink.identity.v2';
const RELAY_KEY = 'relay.enabled';
const MAX_INLINE_MEDIA_B64 = 48 * 1024;

export interface EngineSnapshot {
  version: number;
  started: boolean;
  starting: boolean;
  displayName: string;
  myId: string | null;
  relayEnabled: boolean;
  requestCount: number;
  lan: { running: boolean; ip: string | null; port: number; peers: number };
  links: LinkInfo[];
  queueSize: number;
  queueBytes: number;
  contacts: number;
  epoch: number;
  securityWarning: string | null;
  error: string | null;
}

class Engine {
  private readonly store = new SqliteStore();
  private readonly lan = new LanTransport();
  private node: MeshNode | null = null;
  private listeners = new Set<() => void>();
  private startPromise: Promise<void> | null = null;
  private snapshot: EngineSnapshot | null = null;
  private lastWarning: string | null = null;
  private lastError: string | null = null;
  private requestCount = 0;

  version = 0;
  starting = false;
  started = false;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): EngineSnapshot => {
    if (this.snapshot) return this.snapshot;
    const node = this.node;
    const state = node?.snapshot();
    this.snapshot = {
      version: this.version,
      started: this.started,
      starting: this.starting,
      displayName: node?.displayName ?? 'Anonymous',
      myId: node?.identityId ?? null,
      relayEnabled: node?.policy.relayEnabled ?? false,
      requestCount: this.requestCount,
      lan: {
        running: this.lan.started,
        ip: this.lan.ip,
        port: this.lan.port,
        peers: this.lan.peerCount,
      },
      links: state?.links ?? [],
      queueSize: state?.queueSize ?? 0,
      queueBytes: state?.queueBytes ?? 0,
      contacts: state?.contacts ?? 0,
      epoch: state?.epoch ?? 0,
      securityWarning: this.lastWarning,
      error: this.lastError,
    };
    return this.snapshot;
  };

  async start(): Promise<void> {
    if (this.started) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    if (this.started || this.node) return;
    this.starting = true;
    this.lastError = null;
    this.notify();
    try {
      await this.store.open();
      const identity = await this.loadIdentity();
      const displayName = await getDisplayName();
      const relayEnabled = (await this.store.kvGet(RELAY_KEY)) === '1';
      const node = new MeshNode({
        identity,
        store: this.store,
        displayName,
        policy: { relayEnabled },
      });
      node.events = {
        onMessagesChanged: () => void this.refresh(),
        onContactsChanged: () => void this.refresh(),
        onLinksChanged: () => this.notify(),
        onDeliveryChanged: () => this.notify(),
        onMessageRequest: () => void this.refresh(),
        onSecurityWarning: (what) => {
          this.lastWarning = what;
          this.notify();
        },
        onSos: () => void this.refresh(),
      };
      await node.start();
      this.node = node;
      this.lan.onStatus = () => this.notify();
      await this.lan.start(node);
      this.started = true;
      await this.refreshCounts();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : 'engine start failed';
    } finally {
      this.starting = false;
      this.notify();
    }
  }

  stop(): void {
    this.lan.stop();
    this.node?.stop();
    this.node = null;
    this.started = false;
    this.notify();
  }

  /** Erases identity, database and queue. Used by the panic wipe. */
  async wipe(): Promise<void> {
    this.stop();
    try {
      await this.store.destroy();
    } catch {
      /* db may already be gone */
    }
    try {
      await SecureStore.deleteItemAsync(IDENTITY_KEY);
    } catch {
      /* not available (e.g. web) */
    }
    this.requestCount = 0;
    this.lastWarning = null;
    this.lastError = null;
    this.snapshot = null;
    this.notify();
  }

  // ------------------------------------------------------------ identity

  private async loadIdentity(): Promise<Identity> {
    let raw: string | null = null;
    let secure = true;
    try {
      raw = await SecureStore.getItemAsync(IDENTITY_KEY);
    } catch {
      secure = false;
      raw = await this.store.kvGet('identity.fallback');
    }
    if (raw) {
      try {
        return identityFromStorable(JSON.parse(raw) as ReturnType<typeof identityToStorable>);
      } catch {
        /* regenerate below */
      }
    }
    const identity = newIdentity();
    const serialized = JSON.stringify(identityToStorable(identity));
    if (secure) {
      try {
        await SecureStore.setItemAsync(IDENTITY_KEY, serialized);
        return identity;
      } catch {
        secure = false;
      }
    }
    await this.store.kvSet('identity.fallback', serialized);
    return identity;
  }

  get myId(): string | null {
    return this.node?.identityId ?? null;
  }

  async setName(name: string): Promise<void> {
    const clean = name.trim().slice(0, 24);
    if (!clean) return;
    await setDisplayName(clean);
    if (this.node) {
      this.node.displayName = clean;
      await this.node.broadcastHello();
    }
    this.notify();
  }

  // ----------------------------------------------------------- messaging

  async sendText(contactId: string, body: string): Promise<string> {
    const node = this.requireNode();
    const text = body.trim();
    if (!text) throw new Error('empty message');
    const id = await node.sendMessage(contactId, 'text', text);
    this.notify();
    return id;
  }

  /** Small inline media only (voice note or compressed photo). */
  async sendMedia(contactId: string, kind: 'voice' | 'image', mediaB64: string, caption = ''): Promise<string> {
    if (!mediaB64) throw new Error('empty media');
    if (mediaB64.length > MAX_INLINE_MEDIA_B64) {
      throw new Error('Attachment is too large for the mesh in this build (48 KB limit).');
    }
    const node = this.requireNode();
    const id = await node.sendMessage(contactId, kind, caption, {
      media: mediaB64,
      priority: kind === 'voice' ? PRIO_VOICE : PRIO_MEDIA,
    });
    this.notify();
    return id;
  }

  /** First contact: send to an ephemeral nearby HELLO tag. */
  async sendIntro(tagHex: string, body: string): Promise<string> {
    const node = this.requireNode();
    const id = await node.sendMessage(null, 'text', body.trim() || 'Hello from MeshLink', {
      dstHelloTag: hexToBytes(tagHex),
    });
    this.notify();
    return id;
  }

  /** SOS to trusted contacts plus every nearby HELLO address (bounded). */
  async sendSos(body: string): Promise<number> {
    const node = this.requireNode();
    const text = body.trim() || 'SOS — I need help.';
    let sent = 0;
    const contacts = (await this.store.listContacts()).filter((c) => c.trusted && !c.blocked);
    for (const contact of contacts) {
      try {
        await node.sendMessage(contact.id, 'sos', text, { sos: true });
        sent++;
      } catch {
        /* no session yet: skip, contact still receives normal traffic later */
      }
    }
    for (const tag of node.peerHelloTags().slice(0, 16)) {
      try {
        await node.sendMessage(null, 'sos', text, { sos: true, dstHelloTag: hexToBytes(tag) });
        sent++;
      } catch {
        /* tag expired */
      }
    }
    this.notify();
    return sent;
  }

  async acceptRequest(contactId: string): Promise<void> {
    const node = this.requireNode();
    await node.setTrusted(contactId, true);
    const requests = (await this.store.listMessageRequests()).filter((m) => m.contactId === contactId);
    for (const m of requests) await this.store.setMessageStatus(m.id, 'delivered');
    await this.refresh();
  }

  // ------------------------------------------------------------ contacts

  async pairFromQr(raw: string): Promise<string> {
    const node = this.requireNode();
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error('That QR code is not a MeshLink pairing code.');
    }
    const d = data as Record<string, unknown>;
    const required = ['signPub', 'dhPub', 'name', 'spk', 'spkSig', 'pqPk'];
    if (!d || required.some((k) => typeof d[k] !== 'string')) {
      throw new Error('Pairing code is missing key material.');
    }
    const id = await node.pairFromQr({
      signPub: String(d.signPub),
      dhPub: String(d.dhPub),
      name: String(d.name).slice(0, 24),
      spk: String(d.spk),
      spkSig: String(d.spkSig),
      opk: typeof d.opk === 'string' ? d.opk : null,
      pqPk: String(d.pqPk),
    });
    await this.refresh();
    return id;
  }

  qrPayload(): string {
    return this.requireNode().qrPayload();
  }

  async contacts(): Promise<ContactRecord[]> {
    await this.store.open();
    return this.store.listContacts();
  }

  async contact(id: string): Promise<ContactRecord | null> {
    await this.store.open();
    return this.store.getContact(id);
  }

  async setTrusted(id: string, trusted: boolean): Promise<void> {
    await this.requireNode().setTrusted(id, trusted);
    this.notify();
  }

  async setVerified(id: string, verified: boolean): Promise<void> {
    await this.requireNode().setVerified(id, verified);
    this.notify();
  }

  async setBlocked(id: string, blocked: boolean): Promise<void> {
    await this.requireNode().setBlocked(id, blocked);
    this.notify();
  }

  // --------------------------------------------------------------- chats

  async chats(): Promise<ChatSummary[]> {
    await this.store.open();
    return this.store.listChats();
  }

  async messages(contactId: string): Promise<MessageRecord[]> {
    await this.store.open();
    return this.store.listMessages(contactId);
  }

  async requests(): Promise<MessageRecord[]> {
    await this.store.open();
    return this.store.listMessageRequests();
  }

  async events(limit = 100): Promise<NetworkEventRecord[]> {
    await this.store.open();
    return this.store.listEvents(limit);
  }

  async stats(): Promise<StoreStats> {
    await this.store.open();
    return this.store.stats();
  }

  async clearEvents(): Promise<void> {
    await this.store.open();
    await this.store.clearEvents();
    this.notify();
  }

  // ------------------------------------------------------------ transports

  async setRelayEnabled(enabled: boolean): Promise<void> {
    await this.store.open();
    await this.store.kvSet(RELAY_KEY, enabled ? '1' : '0');
    if (this.node) this.node.policy.relayEnabled = enabled;
    this.notify();
  }

  /** Broadcasts our current ephemeral HELLO bundle to every direct link. */
  async announce(): Promise<void> {
    await this.requireNode().broadcastHello();
    this.notify();
  }

  async scanLan(): Promise<number> {
    const found = await this.lan.scanSubnet();
    try {
      await this.node?.broadcastHello();
    } catch {
      /* no links yet: scan result still stands */
    }
    this.notify();
    return found;
  }

  async linkTo(ip: string): Promise<boolean> {
    return this.lan.connectTo(ip);
  }

  nearbyTags(): string[] {
    return this.node?.peerHelloTags() ?? [];
  }

  // --------------------------------------------------------------- helpers

  private requireNode(): MeshNode {
    if (!this.node) throw new Error('MeshLink engine is not started yet.');
    return this.node;
  }

  private async refreshCounts(): Promise<void> {
    try {
      this.requestCount = (await this.store.listMessageRequests()).length;
    } catch {
      this.requestCount = 0;
    }
  }

  private async refresh(): Promise<void> {
    await this.refreshCounts();
    this.notify();
  }

  private notify(): void {
    this.version++;
    this.snapshot = null;
    for (const fn of this.listeners) fn();
  }

  /** True when `kind` can be carried inline by this build. */
  static canSendMedia(kind: MessageKind): boolean {
    return kind === 'voice' || kind === 'image';
  }
}

export const engine = new Engine();
