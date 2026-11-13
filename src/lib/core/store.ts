/**
 * MeshLink storage interface + reference in-memory store.
 *
 * The app implements this interface over expo-sqlite (see src/lib/db.ts);
 * tests, the simulator and the relay-node tool use the memory store or a
 * Node-side SQLite adapter. Keeping storage behind an interface lets every
 * transport-independent behavior be unit-tested.
 */

import { Envelope, decodeEnvelope, encodeEnvelope } from './protocol';
import { bytesToHex, hexToBytes, bytesToB64, b64ToBytes } from './bytes';

export type MessageStatus = 'queued' | 'handed' | 'delivered' | 'read' | 'request' | 'failed';

export type MessageKind = 'text' | 'voice' | 'image' | 'reaction' | 'delete' | 'edit' | 'profile' | 'receipt' | 'file-meta' | 'file-chunk' | 'sos';

export interface MessageRecord {
  /** Hex of the 8-byte msgId. */
  id: string;
  /** Contact id (hex of sender identity Ed25519 public key). */
  contactId: string;
  direction: 'in' | 'out';
  kind: MessageKind;
  body: string;
  /** Reference payload (base64 media for small payloads; file metadata). */
  media: string | null;
  /** Target message id for reactions/edits/deletes. */
  targetId: string | null;
  priority: Priority2;
  ts: number;
  status: MessageStatus;
}

type Priority2 = number;

export interface ContactRecord {
  /** Hex of the contact's Ed25519 identity public key. */
  id: string;
  name: string;
  signPub: string;
  dhPub: string;
  /** 32-byte pairwise secret (hex) used for rotating tags. */
  pairwise: string;
  /** Current published prekey bundle of the contact (for session re-init). */
  bundle: { spk: string; spkSig: string; opk: string | null; pqPk: string; bundleId: string } | null;
  safetyNumber: string;
  trusted: boolean;
  blocked: boolean;
  /** Identity verified in person (safety number compared). */
  verified: boolean;
  /**
   * Hex conversation tag (stranger return address) while this contact is a
   * non-paired conversation; cleared once both sides are on pairwise tags.
   */
  strangerTag?: string | null;
  lastSeen: number;
  addedAt: number;
}

export interface OwnBundleRecord {
  bundleId: string;
  kind: 'hello';
  ephXPriv: string;
  ephPqSk: string;
  createdAt: number;
}

export interface QueueRecord {
  msgId: string;
  envB64: string;
  copies: number;
  forMe: boolean;
  createdAt: number;
}

export interface NetworkEventRecord {
  ts: number;
  kind: 'link-up' | 'link-down' | 'peer-seen' | 'hops-observed' | 'relay-forward' | 'session' | 'security';
  detail: string;
}

/** AsyncStorage-style key/value for small secrets and settings. */
export interface Store {
  kvGet(key: string): Promise<string | null>;
  kvSet(key: string, value: string): Promise<void>;
  kvDel(key: string): Promise<void>;

  putContact(c: ContactRecord): Promise<void>;
  getContact(id: string): Promise<ContactRecord | null>;
  listContacts(): Promise<ContactRecord[]>;
  deleteContact(id: string): Promise<void>;

  putSession(contactId: string, stateJson: string): Promise<void>;
  getSession(contactId: string): Promise<string | null>;
  deleteSession(contactId: string): Promise<void>;

  putMessage(m: MessageRecord): Promise<void>;
  getMessage(id: string): Promise<MessageRecord | null>;
  listMessages(contactId: string, limit?: number): Promise<MessageRecord[]>;
  setMessageStatus(id: string, status: MessageStatus): Promise<void>;
  listMessageRequests(): Promise<MessageRecord[]>;

  putQueueItem(q: QueueRecord): Promise<void>;
  deleteQueueItem(msgId: string): Promise<void>;
  listQueueItems(): Promise<QueueRecord[]>;

  putOwnBundle(b: OwnBundleRecord): Promise<void>;
  listOwnBundles(): Promise<OwnBundleRecord[]>;

  logEvent(e: NetworkEventRecord): Promise<void>;
  listEvents(limit?: number): Promise<NetworkEventRecord[]>;
}

export function msgIdHex(id: Uint8Array): string {
  return bytesToHex(id);
}

/** Utility used by the app adapter and tools. */
export function queueRecordFromEnvelope(env: Envelope, copies: number, forMe: boolean, createdAt: number): QueueRecord {
  return { msgId: bytesToHex(env.msgId), envB64: bytesToB64(encodeEnvelope(env)), copies, forMe, createdAt };
}

export function envelopeFromRecord(q: QueueRecord): Envelope {
  return decodeEnvelope(b64ToBytes(q.envB64));
}

// ------------------------------------------------------------------ memory

export class MemoryStore implements Store {
  private kv = new Map<string, string>();
  private contacts = new Map<string, ContactRecord>();
  private sessions = new Map<string, string>();
  private messages = new Map<string, MessageRecord>();
  private queue = new Map<string, QueueRecord>();
  private ownBundles = new Map<string, OwnBundleRecord>();
  private events: NetworkEventRecord[] = [];

  async kvGet(key: string): Promise<string | null> {
    return this.kv.get(key) ?? null;
  }
  async kvSet(key: string, value: string): Promise<void> {
    this.kv.set(key, value);
  }
  async kvDel(key: string): Promise<void> {
    this.kv.delete(key);
  }

  async putContact(c: ContactRecord): Promise<void> {
    this.contacts.set(c.id, { ...c });
  }
  async getContact(id: string): Promise<ContactRecord | null> {
    return this.contacts.get(id) ?? null;
  }
  async listContacts(): Promise<ContactRecord[]> {
    return [...this.contacts.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }
  async deleteContact(id: string): Promise<void> {
    this.contacts.delete(id);
    this.sessions.delete(id);
  }

  async putSession(contactId: string, stateJson: string): Promise<void> {
    this.sessions.set(contactId, stateJson);
  }
  async getSession(contactId: string): Promise<string | null> {
    return this.sessions.get(contactId) ?? null;
  }
  async deleteSession(contactId: string): Promise<void> {
    this.sessions.delete(contactId);
  }

  async putMessage(m: MessageRecord): Promise<void> {
    this.messages.set(m.id, { ...m });
  }
  async getMessage(id: string): Promise<MessageRecord | null> {
    return this.messages.get(id) ?? null;
  }
  async listMessages(contactId: string, limit = 500): Promise<MessageRecord[]> {
    return [...this.messages.values()]
      .filter((m) => m.contactId === contactId)
      .sort((a, b) => a.ts - b.ts)
      .slice(-limit);
  }
  async setMessageStatus(id: string, status: MessageStatus): Promise<void> {
    const m = this.messages.get(id);
    if (m) m.status = status;
  }
  async listMessageRequests(): Promise<MessageRecord[]> {
    return [...this.messages.values()].filter((m) => m.status === 'request').sort((a, b) => b.ts - a.ts);
  }

  async putQueueItem(q: QueueRecord): Promise<void> {
    this.queue.set(q.msgId, { ...q });
  }
  async deleteQueueItem(msgId: string): Promise<void> {
    this.queue.delete(msgId);
  }
  async listQueueItems(): Promise<QueueRecord[]> {
    return [...this.queue.values()];
  }

  async putOwnBundle(b: OwnBundleRecord): Promise<void> {
    this.ownBundles.set(b.bundleId, { ...b });
    // Bounded ring: keep the 32 most recent bundles (>= ~5h of epochs).
    if (this.ownBundles.size > 32) {
      const sorted = [...this.ownBundles.values()].sort((a, b) => b.createdAt - a.createdAt);
      for (const old of sorted.slice(32)) this.ownBundles.delete(old.bundleId);
    }
  }
  async listOwnBundles(): Promise<OwnBundleRecord[]> {
    return [...this.ownBundles.values()];
  }

  async logEvent(e: NetworkEventRecord): Promise<void> {
    this.events.push({ ...e });
    if (this.events.length > 2000) this.events.splice(0, this.events.length - 2000);
  }
  async listEvents(limit = 200): Promise<NetworkEventRecord[]> {
    return this.events.slice(-limit);
  }
}

export { hexToBytes };
