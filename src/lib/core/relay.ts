/**
 * MeshLink relay engine — the delay-tolerant networking heart.
 *
 * Phones in a mesh are sparse and moving, so this engine implements
 * store-carry-forward gossip routing, not end-to-end paths:
 *
 *  - OutboundQueue: priority-aware store-and-forward with age-based expiry,
 *    per-sender quotas and eviction that protects SOS traffic.
 *  - DedupSet: bounded duplicate detection keyed by 64-bit msgId.
 *  - Inventory: compact set reconciliation of what each link's peer already
 *    has, so relays forward only what is missing (broadcast-storm control).
 *  - Spray-and-wait: limited-copy forwarding; copies halve at each relay,
 *    bounding redundancy in dense crowds.
 *  - Suppression: randomized delay + counter-based suppression on relay.
 *  - Policies: relaying is strictly opt-in, with battery/storage constraints
 *    and optional trust-circle authentication (see ADR-006).
 *
 * Validated in the discrete-event simulator before shipping (see
 * docs/architecture/SPIKE_RESULTS.md). Routing approach and alternatives are
 * recorded in docs/DECISIONS.md ADR-003.
 */

import {
  DEFAULT_SPRAY_COPIES,
  Envelope,
  InventoryEntry,
  PRIO_SOS,
  Priority,
  SIZE_BUCKETS,
  decodeInventory,
  encodeEnvelope,
  isExpired,
  tagToDebug,
} from './protocol';
import { bytesEqual, bytesToHex, randomInt } from './bytes';

export interface QueueItem {
  env: Envelope;
  /** Envelope bytes as first encoded (kept stable for retransmission). */
  bytes: Uint8Array;
  createdAt: number;
  /** Last time aging was applied (monotonic local clock). */
  lastTouched?: number;
  /** Remaining spray copies for relay (0 for messages addressed to us). */
  copies: number;
  /** Whether this item is addressed to us (never re-forwarded). */
  forMe: boolean;
  sizeBucket: Priority;
}

export interface RelayPolicy {
  /** Master opt-in: without this nothing is ever relayed. */
  relayEnabled: boolean;
  /** Only relay while charging. */
  relayOnlyCharging: boolean;
  /** Only relay while connected to Wi-Fi. */
  relayOnlyWifi: boolean;
  /** Only relay traffic authenticated to one of our trust circles. */
  relayOnlyTrusted: boolean;
  /** Hard cap on relay queue memory. */
  maxQueueBytes: number;
  /** Max stored messages per originating sender (Sybil defense). */
  maxPerPeer: number;
  /** Battery hint from the platform (0..1). Below this, relaying throttles. */
  batteryLevel: number;
  batterySaverThreshold: number;
}

export const DEFAULT_POLICY: RelayPolicy = {
  relayEnabled: false,
  relayOnlyCharging: false,
  relayOnlyWifi: false,
  relayOnlyTrusted: false,
  maxQueueBytes: 8 * 1024 * 1024,
  maxPerPeer: 200,
  batteryLevel: 1,
  batterySaverThreshold: 0.15,
};

export interface LinkContext {
  linkId: string;
  /** Tag under which the peer announced itself on this link (may be empty). */
  peerTag: Uint8Array | null;
  wifi: boolean;
  charging: boolean;
}

export interface RelayEvents {
  onForward?: (env: Envelope, toLinkId: string) => void;
  onEvict?: (msgId: string, reason: string) => void;
  onStored?: (msgId: string) => void;
}

/** Bounded duplicate detection: LRU over msgIds. */
export class DedupSet {
  private seen = new Set<string>();
  private order: string[] = [];

  constructor(private capacity = 20000) {}

  checkAndAdd(id: Uint8Array): boolean {
    const key = bytesToHex(id);
    if (this.seen.has(key)) return false;
    if (this.seen.size >= this.capacity) {
      const drop = Math.floor(this.capacity / 4);
      for (let i = 0; i < drop; i++) {
        const old = this.order.shift();
        if (old) this.seen.delete(old);
      }
    }
    this.seen.add(key);
    this.order.push(key);
    return true;
  }

  has(id: Uint8Array): boolean {
    return this.seen.has(bytesToHex(id));
  }

  get size(): number {
    return this.seen.size;
  }
}

/**
 * Randomized relay delay + counter-based suppression state for a message.
 * A relay forwards only after a short random jitter and only if it has not
 * observed too many OTHER relays already carrying the message. Relays are
 * counted as DISTINCT peers (from inventories, keyed by peer link tag) so a
 * peer repeating its inventory does not inflate the counter; observations
 * without a peer identity count individually. This is the classic
 * broadcast-storm counter threshold.
 */
export class SuppressionState {
  private relayPeers = new Map<string, Set<string>>();
  private anonCount = new Map<string, number>();
  private deadline = new Map<string, number>();

  observeRelay(msgId: Uint8Array, peerKey?: string): void {
    const key = bytesToHex(msgId);
    if (peerKey) {
      let set = this.relayPeers.get(key);
      if (!set) {
        set = new Set();
        this.relayPeers.set(key, set);
      }
      set.add(peerKey);
    } else {
      this.anonCount.set(key, (this.anonCount.get(key) ?? 0) + 1);
    }
  }

  /** Total suppression counter for this message: distinct peers + anonymous. */
  relayCountFor(msgId: Uint8Array): number {
    const key = bytesToHex(msgId);
    return (this.relayPeers.get(key)?.size ?? 0) + (this.anonCount.get(key) ?? 0);
  }

  /** True once the random delay passed and copies seen < threshold. */
  shouldRelay(msgId: Uint8Array, threshold = 2, now = Date.now()): boolean {
    const key = bytesToHex(msgId);
    const dl = this.deadline.get(key);
    if (dl !== undefined) {
      if (now < dl) return false;
      this.deadline.delete(key);
    }
    return this.relayCountFor(msgId) < threshold;
  }

  startJitter(msgId: Uint8Array, maxMs = 400, now = Date.now()): void {
    const key = bytesToHex(msgId);
    if (!this.deadline.has(key)) this.deadline.set(key, now + randomInt(0, maxMs));
  }

  prune(now = Date.now()): void {
    for (const [key, dl] of this.deadline) if (now > dl + 5000) this.deadline.delete(key);
    if (this.relayPeers.size > 5000) this.relayPeers.clear();
    if (this.anonCount.size > 5000) this.anonCount.clear();
  }
}

/**
 * Priority store-and-forward queue with quotas and protective eviction.
 * Eviction order: expired first, then lowest priority and oldest. SOS is
 * never evicted while any non-SOS item exists.
 */
export class OutboundQueue {
  private items = new Map<string, QueueItem>();
  private order: string[] = [];
  private bytes = 0;
  private perPeer = new Map<string, number>();

  constructor(private policy: RelayPolicy, private events: RelayEvents = {}) {}

  get size(): number {
    return this.items.size;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  /** Returns false if rejected (duplicate or quota). */
  push(env: Envelope, now = Date.now()): boolean {
    const key = bytesToHex(env.msgId);
    if (this.items.has(key)) return false;
    if (isExpired(env)) return false;
    const item: QueueItem = {
      env,
      bytes: encodeEnvelope(env),
      createdAt: now,
      copies: env.sprayCopies,
      forMe: false,
      sizeBucket: env.priority,
    };
    this.bytes += item.bytes.length;
    const srcKey = bytesToHex(env.srcTag);
    this.perPeer.set(srcKey, (this.perPeer.get(srcKey) ?? 0) + 1);
    this.items.set(key, item);
    this.order.push(key);
    this.enforceQuotas();
    return true;
  }

  /** Marks an item as delivered to us (kept briefly for ACK batching). */
  markForMe(msgId: Uint8Array): QueueItem | null {
    const key = bytesToHex(msgId);
    const item = this.items.get(key);
    if (!item) return null;
    item.forMe = true;
    return item;
  }

  get(msgId: Uint8Array): QueueItem | null {
    return this.items.get(bytesToHex(msgId)) ?? null;
  }

  /** Consumes one copy for a destination; returns true if a copy remains. */
  consumeCopy(msgId: Uint8Array): boolean {
    const item = this.items.get(bytesToHex(msgId));
    if (!item) return false;
    if (item.copies > 0) item.copies -= 1;
    if (item.copies <= 0 && item.forMe) this.drop(msgId, 'delivered');
    return item.copies > 0;
  }

  drop(msgId: Uint8Array, reason: string): void {
    const key = bytesToHex(msgId);
    const item = this.items.get(key);
    if (!item) return;
    this.items.delete(key);
    this.order = this.order.filter((k) => k !== key);
    this.bytes -= item.bytes.length;
    const srcKey = bytesToHex(item.env.srcTag);
    const count = (this.perPeer.get(srcKey) ?? 1) - 1;
    if (count <= 0) this.perPeer.delete(srcKey);
    else this.perPeer.set(srcKey, count);
    this.events.onEvict?.(key, reason);
  }

  /** Removes expired items; returns them so callers can log. */
  expireExpired(now = Date.now()): QueueItem[] {
    const removed: QueueItem[] = [];
    for (const key of [...this.order]) {
      const item = this.items.get(key);
      if (!item) continue;
      // Age-based expiry: decrement the envelope's remaining life by the time
      // it spent waiting here, measured with the local monotonic wall clock.
      // No absolute timestamps are compared across devices.
      const elapsedSec = Math.ceil((now - (item.lastTouched ?? item.createdAt)) / 1000);
      item.lastTouched = now;
      item.env.expiresInSec = Math.max(0, item.env.expiresInSec - elapsedSec);
      if (item.env.expiresInSec <= 0) {
        removed.push(item);
        this.drop(item.env.msgId, 'expired');
      }
    }
    return removed;
  }

  /** Items eligible to be sent to a peer that reports the given inventory. */
  missingFor(entries: InventoryEntry[]): QueueItem[] {
    const theyHave = new Set(entries.map((e) => bytesToHex(e.msgId)));
    return this.listAll().filter((item) => !theyHave.has(bytesToHex(item.env.msgId)));
  }

  listAll(): QueueItem[] {
    return this.order.map((k) => this.items.get(k)!).filter(Boolean);
  }

  /** Compact gossip inventory (highest priority first, bounded count). */
  buildInventory(max = 64): InventoryEntry[] {
    const items = this.listAll()
      .filter((i) => !i.forMe)
      .sort((a, b) => a.env.priority - b.env.priority || b.createdAt - a.createdAt)
      .slice(0, max);
    return items.map((i) => ({
      msgId: i.env.msgId,
      copies: i.copies,
      priority: i.env.priority,
      sizeBucket: i.sizeBucket,
      dstTag: i.env.dstTag,
    }));
  }

  private enforceQuotas(): void {
    if (this.bytes <= this.policy.maxQueueBytes) return;
    // Evict lowest priority, oldest first; protect SOS.
    const items = this.listAll().sort((a, b) => {
      if (a.env.priority !== b.env.priority) return b.env.priority - a.env.priority; // higher number = lower priority
      return a.createdAt - b.createdAt;
    });
    for (const item of items) {
      if (this.bytes <= this.policy.maxQueueBytes) break;
      if (item.env.priority === PRIO_SOS && this.size > 1) continue;
      this.drop(item.env.msgId, 'quota');
    }
  }

  /** Per-originating-sender cap (Sybil defense). */
  overPerPeer(env: Envelope): boolean {
    return (this.perPeer.get(bytesToHex(env.srcTag)) ?? 0) >= this.policy.maxPerPeer;
  }
}

/** Per-peer token bucket rate limiter. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private ratePerSec: number,
    private burst: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.burst, at: now };
      this.buckets.set(key, b);
    }
    const elapsed = (now - b.at) / 1000;
    b.at = now;
    b.tokens = Math.min(this.burst, b.tokens + elapsed * this.ratePerSec);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}

/**
 * Decides whether this node may relay an envelope and under which policy.
 * Pure function of policy + envelope + trust hints, so it is unit-testable.
 */
export function relayDecision(
  policy: RelayPolicy,
  env: Envelope,
  opts: { isForMe: boolean; circleAuthOk: boolean; link: LinkContext; rateOk: boolean },
): { relay: boolean; reason: string } {
  if (opts.isForMe) return { relay: false, reason: 'for-me' };
  if (env.hopCount >= env.hopLimit) return { relay: false, reason: 'hop-limit' };
  if (isExpired(env)) return { relay: false, reason: 'expired' };
  if (!policy.relayEnabled) return { relay: false, reason: 'opt-out' };
  if (policy.relayOnlyCharging && !opts.link.charging) return { relay: false, reason: 'not-charging' };
  if (policy.relayOnlyWifi && !opts.link.wifi) return { relay: false, reason: 'not-wifi' };
  if (policy.relayOnlyTrusted && !opts.circleAuthOk) return { relay: false, reason: 'untrusted' };
  if (env.priority !== PRIO_SOS && policy.batteryLevel < policy.batterySaverThreshold) {
    return { relay: false, reason: 'battery-saver' };
  }
  if (!opts.rateOk) return { relay: false, reason: 'rate-limit' };
  return { relay: true, reason: 'ok' };
}

/** Splits relay copies across destinations (binary spray). */
export function copiesForDestination(item: QueueItem, destinations: number): number {
  if (item.copies <= 0) return 0;
  if (destinations <= 1) return item.copies;
  return Math.max(1, Math.floor(item.copies / destinations));
}

/** Debug label used by diagnostics; never contains message content. */
export function describeQueueItem(item: QueueItem): string {
  return `msg=${tagToDebug(item.env.msgId)} prio=${item.env.priority} copies=${item.copies} ttl=${item.env.expiresInSec}s size=${SIZE_BUCKETS[item.sizeBucket]}`;
}

export { bytesToHex };
