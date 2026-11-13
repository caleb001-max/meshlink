/**
 * MeshLink wire protocol v2 — compact binary envelope codec.
 *
 * Full field-by-field spec with test vectors lives in docs/protocol/SPEC.md.
 * Design rules implemented here:
 *  - Version negotiation: every envelope starts with "ML" + version byte; an
 *    unknown version is ignored, never re-relayed (forward/backward compat).
 *  - Age-based expiry: `expiresInSec` is the REMAINING lifetime. Every hop
 *    subtracts the time the envelope spent in transit (measured locally with
 *    the receiving node's own clock) — absolute clocks are never compared.
 *  - Replay/duplicate protection: random 64-bit msgId + bounded dedup set
 *    (see relay.ts), never wall-clock timestamps.
 *  - Priority classes with fixed-size padding buckets so a relay sees only a
 *    coarse size bucket, not the exact content length.
 *  - Metadata privacy: srcTag/dstTag are 8-byte rotating pseudonymous tags.
 *    No display names, identity keys or stable IDs ever appear in an envelope.
 */

import {
  bytesToHex,
  bytesToUtf8,
  concat,
  hexToBytes,
  readU16le,
  readU64le,
  u16le,
  u64le,
  utf8ToBytes,
} from './bytes';

export const MAGIC = new Uint8Array([0x4d, 0x4c]); // "ML"
export const PROTOCOL_VERSION = 2;

export const TYPE_HELLO = 1;
export const TYPE_MSG = 2;
export const TYPE_ACK = 3;
export const TYPE_INVENTORY = 4;
export const TYPE_REQUEST = 5;

export type EnvelopeType = 1 | 2 | 3 | 4 | 5;
export const TYPE_NAMES: Record<number, string> = {
  1: 'HELLO',
  2: 'MSG',
  3: 'ACK',
  4: 'INVENTORY',
  5: 'REQUEST',
};

/** Priority classes: SOS first, then text/receipts, voice, media, bulk files. */
export const PRIO_SOS = 0;
export const PRIO_TEXT = 1;
export const PRIO_VOICE = 2;
export const PRIO_MEDIA = 3;
export const PRIO_BULK = 4;
export type Priority = 0 | 1 | 2 | 3 | 4;

export const FLAG_E2E = 1; // payload is end-to-end encrypted (MSG)
export const FLAG_CTL_AUTH = 2; // payload ends with a 8-byte trust-circle MAC
export const FLAG_SESSION_INIT = 4; // MSG carries an X3DH + ratchet init header
export const FLAG_PQ_HYBRID = 8; // session-init header includes an ML-KEM ciphertext
export const FLAG_HAS_BUNDLE = 16; // HELLO carries an ephemeral prekey bundle

/** Hop limits and lifetimes (seconds). */
export const DEFAULT_HOP_LIMIT = 8;
export const SOS_HOP_LIMIT = 5;
export const DEFAULT_EXPIRES_SEC = 24 * 3600;
export const SOS_EXPIRES_SEC = 3600;
export const EPHEMERAL_EXPIRES_SEC = 900; // HELLO/inventory-style control traffic

/** Default relay copies for spray-and-wait (binary spray). */
export const DEFAULT_SPRAY_COPIES = 8;

/** Payload padding buckets per priority (bytes). A relay only sees this bucket. */
export const SIZE_BUCKETS: Record<Priority, number> = {
  0: 512,
  1: 1024,
  2: 8192,
  3: 16384,
  4: 16384,
};

/** Envelope header size: 2 magic + 1 ver + 1 type + 1 prio + 1 flags + 1 hopLimit
 *  + 1 hopCount + 2 expires + 1 spray + 8 msgId + 8 srcTag + 8 dstTag + 2 len = 37. */
export const HEADER_LEN = 37;
export const MAX_PAYLOAD = 65535 - 16; // leave room for an AEAD tag
/** Fragment header: idx(1) + count(1) + msgId(8) + len(2) = 12 bytes. */
export const FRAG_HEADER_LEN = 12;
/** Safety cap for decoder inputs (blocks absurd allocations). */
export const MAX_WIRE_FRAME = 262144;

export interface Envelope {
  type: EnvelopeType;
  priority: Priority;
  flags: number;
  hopLimit: number;
  hopCount: number;
  /** Remaining lifetime in seconds; decremented by every hop by transit time. */
  expiresInSec: number;
  /** Remaining spray-and-wait relay copies (0 = none left / direct). */
  sprayCopies: number;
  msgId: Uint8Array; // 8 bytes
  srcTag: Uint8Array; // 8 bytes rotating sender tag
  dstTag: Uint8Array; // 8 bytes rotating recipient tag, or zeros for broadcast
  payload: Uint8Array;
}

// ------------------------------------------------------------------ encoding

export function encodeEnvelope(env: Envelope): Uint8Array {
  if (env.msgId.length !== 8 || env.srcTag.length !== 8 || env.dstTag.length !== 8) {
    throw new Error('tags must be 8 bytes');
  }
  if (env.payload.length > MAX_PAYLOAD) throw new Error('payload too large');
  const out = new Uint8Array(HEADER_LEN + env.payload.length);
  out[0] = MAGIC[0];
  out[1] = MAGIC[1];
  out[2] = PROTOCOL_VERSION;
  out[3] = env.type;
  out[4] = env.priority;
  out[5] = env.flags;
  out[6] = env.hopLimit;
  out[7] = env.hopCount;
  out.set(u16le(env.expiresInSec), 8);
  out[10] = env.sprayCopies;
  out.set(env.msgId, 11);
  out.set(env.srcTag, 19);
  out.set(env.dstTag, 27);
  out.set(u16le(env.payload.length), 35);
  out.set(env.payload, HEADER_LEN);
  return out;
}

/** Thrown for any structurally invalid input — callers MUST treat as junk. */
export class ProtocolError extends Error {}

export function decodeEnvelope(buf: Uint8Array): Envelope {
  if (buf.length < HEADER_LEN) throw new ProtocolError('truncated');
  if (buf[0] !== MAGIC[0] || buf[1] !== MAGIC[1]) throw new ProtocolError('bad magic');
  const version = buf[2];
  if (version !== PROTOCOL_VERSION) throw new ProtocolError(`unsupported version ${version}`);
  const type = buf[3] as EnvelopeType;
  if (type < TYPE_HELLO || type > TYPE_REQUEST) throw new ProtocolError('bad type');
  const priority = buf[4] as Priority;
  if (priority > PRIO_BULK) throw new ProtocolError('bad priority');
  const flags = buf[5];
  if (flags & ~31) throw new ProtocolError('bad flags');
  const payloadLen = readU16le(buf, 35);
  if (HEADER_LEN + payloadLen > buf.length) throw new ProtocolError('truncated payload');
  return {
    type,
    priority,
    flags,
    hopLimit: buf[6],
    hopCount: buf[7],
    expiresInSec: readU16le(buf, 8),
    sprayCopies: buf[10],
    msgId: buf.slice(11, 19),
    srcTag: buf.slice(19, 27),
    dstTag: buf.slice(27, 35),
    payload: buf.slice(HEADER_LEN, HEADER_LEN + payloadLen),
  };
}

/** Relays spend this much transit time from an envelope's remaining life. */
export function ageEnvelope(env: Envelope, transitSec: number): void {
  env.expiresInSec = Math.max(0, env.expiresInSec - Math.max(0, Math.ceil(transitSec)));
  env.hopCount = Math.min(255, env.hopCount + 1);
}

export function isExpired(env: Envelope): boolean {
  return env.expiresInSec <= 0;
}

/** Pads a plaintext payload up to its priority bucket (never shrinks). */
export function padToBucket(priority: Priority, payload: Uint8Array): Uint8Array {
  let bucket = SIZE_BUCKETS[priority];
  if (priority === PRIO_BULK) {
    // Bulk payloads round up to whole buckets but do not pad more than 1 bucket.
    bucket = Math.max(bucket, Math.ceil(payload.length / SIZE_BUCKETS[PRIO_BULK]) * SIZE_BUCKETS[PRIO_BULK]);
  }
  if (payload.length > bucket) bucket = payload.length;
  if (payload.length === bucket) return payload;
  const out = new Uint8Array(bucket);
  out.set(payload, 0);
  return out;
}

// ------------------------------------------------------------------ frames

/**
 * Splits an envelope into transport-sized fragments. All fragments of one
 * envelope share the envelope's msgId, so reassembly is idempotent and
 * duplicates collapse.
 */
export function fragmentEnvelope(envBytes: Uint8Array, mtu: number): Uint8Array[] {
  if (mtu < FRAG_HEADER_LEN + 1) throw new ProtocolError('mtu too small');
  const payloadMtu = mtu - FRAG_HEADER_LEN;
  const count = Math.ceil(envBytes.length / payloadMtu);
  if (count > 255) throw new ProtocolError('too many fragments');
  const frags: Uint8Array[] = [];
  const id = envBytes.slice(11, 19); // envelope msgId doubles as reassembly key
  for (let i = 0; i < count; i++) {
    const chunk = envBytes.slice(i * payloadMtu, (i + 1) * payloadMtu);
    const f = new Uint8Array(FRAG_HEADER_LEN + chunk.length);
    f[0] = i;
    f[1] = count;
    f.set(id, 2);
    f.set(u16le(chunk.length), 10);
    f.set(chunk, FRAG_HEADER_LEN);
    frags.push(f);
  }
  return frags;
}

export interface Fragment {
  index: number;
  count: number;
  id: Uint8Array;
  data: Uint8Array;
}

export function decodeFragment(f: Uint8Array): Fragment {
  if (f.length < FRAG_HEADER_LEN) throw new ProtocolError('truncated fragment');
  const index = f[0];
  const count = f[1];
  if (count === 0 || index >= count) throw new ProtocolError('bad fragment header');
  const len = readU16le(f, 10);
  if (FRAG_HEADER_LEN + len > f.length) throw new ProtocolError('truncated fragment data');
  return { index, count, id: f.slice(2, 10), data: f.slice(FRAG_HEADER_LEN, FRAG_HEADER_LEN + len) };
}

/**
 * Bounded fragment reassembler. State is keyed by envelope msgId; each key
 * holds its expected fragment count. Entries expire after `timeoutMs`.
 */
export class Reassembler {
  private parts = new Map<string, { count: number; have: Map<number, Uint8Array>; bytes: number; at: number }>();

  constructor(private timeoutMs = 60_000, private maxSessions = 64, private maxBytes = 512 * 1024) {}

  /** Returns the complete envelope bytes once all fragments have arrived. */
  add(frag: Fragment): Uint8Array | null {
    const key = bytesToHex(frag.id);
    let entry = this.parts.get(key);
    if (!entry) {
      if (this.parts.size >= this.maxSessions) this.prune(true);
      entry = { count: frag.count, have: new Map(), bytes: 0, at: Date.now() };
      this.parts.set(key, entry);
    }
    if (entry.count !== frag.count) return null; // inconsistent sender; drop
    if (entry.have.has(frag.index)) return null; // duplicate fragment
    entry.have.set(frag.index, frag.data);
    entry.bytes += frag.data.length;
    if (entry.bytes > this.maxBytes) {
      this.parts.delete(key);
      throw new ProtocolError('reassembly too large');
    }
    if (entry.have.size === entry.count) {
      this.parts.delete(key);
      const ordered: Uint8Array[] = [];
      for (let i = 0; i < entry.count; i++) ordered.push(entry.have.get(i)!);
      return concat(...ordered);
    }
    return null;
  }

  /** Drops timed-out partial reassemblies; with force=true also oldest entries. */
  prune(force = false): void {
    const now = Date.now();
    for (const [key, e] of this.parts) {
      if (force || now - e.at > this.timeoutMs) this.parts.delete(key);
    }
  }

  get size(): number {
    return this.parts.size;
  }
}

// ------------------------------------------------------- control body codecs

export interface HelloBody {
  version: number;
  /** capability bits: 1 = willing to relay, 2 = Wi-Fi available, 4 = L2CAP */
  caps: number;
  /** Ephemeral X25519 prekey (32 bytes) for X3DH with strangers. */
  ephX: Uint8Array;
  /** Ephemeral ML-KEM-768 prekey (1184 bytes), PQ-hybrid partner of ephX. */
  ephPq: Uint8Array;
}

export function encodeHello(body: HelloBody): Uint8Array {
  if (body.ephX.length !== 32) throw new ProtocolError('ephX must be 32 bytes');
  if (body.ephPq.length !== 1184) throw new ProtocolError('ephPq must be 1184 bytes');
  return concat(new Uint8Array([body.version, body.caps]), body.ephX, body.ephPq);
}

export function decodeHello(buf: Uint8Array): HelloBody {
  if (buf.length !== 2 + 32 + 1184) throw new ProtocolError('bad hello body');
  return {
    version: buf[0],
    caps: buf[1],
    ephX: buf.slice(2, 34),
    ephPq: buf.slice(34, 34 + 1184),
  };
}

export interface InventoryEntry {
  msgId: Uint8Array; // 8 bytes
  copies: number;
  priority: Priority;
  /** First byte of the size bucket the relay can expect (see SIZE_BUCKETS). */
  sizeBucket: Priority;
  dstTag: Uint8Array; // rotating tag; relays use it to pre-filter, never to identify
}

export function encodeInventory(entries: InventoryEntry[]): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([entries.length])];
  for (const e of entries) {
    parts.push(e.msgId, new Uint8Array([e.copies, e.priority, e.sizeBucket]), e.dstTag);
  }
  return concat(...parts);
}

export function decodeInventory(buf: Uint8Array): InventoryEntry[] {
  if (buf.length < 1) throw new ProtocolError('bad inventory');
  const n = buf[0];
  if (n > 64) throw new ProtocolError('inventory too large');
  const out: InventoryEntry[] = [];
  let o = 1;
  for (let i = 0; i < n; i++) {
    if (o + 19 > buf.length) throw new ProtocolError('bad inventory entry');
    out.push({
      msgId: buf.slice(o, o + 8),
      copies: buf[o + 8],
      priority: buf[o + 9] as Priority,
      sizeBucket: buf[o + 10] as Priority,
      dstTag: buf.slice(o + 11, o + 19),
    });
    o += 19;
  }
  return out;
}

export function encodeAckBatch(msgIds: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([msgIds.length])];
  for (const id of msgIds) {
    if (id.length !== 8) throw new ProtocolError('ack id must be 8 bytes');
    parts.push(id);
  }
  return concat(...parts);
}

export function decodeAckBatch(buf: Uint8Array): Uint8Array[] {
  if (buf.length < 1 || buf[0] > 64) throw new ProtocolError('bad ack batch');
  const out: Uint8Array[] = [];
  for (let i = 0; i < buf[0]; i++) {
    const o = 1 + i * 8;
    if (o + 8 > buf.length) throw new ProtocolError('bad ack batch');
    out.push(buf.slice(o, o + 8));
  }
  return out;
}

export function encodeRequestBatch(msgIds: Uint8Array[]): Uint8Array {
  return encodeAckBatch(msgIds); // same shape, different envelope type
}

export function decodeRequestBatch(buf: Uint8Array): Uint8Array[] {
  return decodeAckBatch(buf);
}

/** Human-readable debug name for a tag (never persisted, never sent). */
export function tagToDebug(tag: Uint8Array): string {
  return bytesToHex(tag).slice(0, 8);
}

/** Legacy helpers kept for tests. */
export { bytesToUtf8, hexToBytes, u64le, readU64le, utf8ToBytes };
