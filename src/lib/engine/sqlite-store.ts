/**
 * Expo SQLite implementation of the MeshLink `Store` interface.
 * Keeps all node state (contacts, sessions, messages, relay queue, discovery
 * events) on the device. No server, no remote database.
 */
import * as SQLite from 'expo-sqlite';
import type {
  ContactRecord,
  MessageRecord,
  MessageStatus,
  NetworkEventRecord,
  OwnBundleRecord,
  QueueRecord,
  Store,
} from '../core/store';

interface ContactRow {
  id: string;
  name: string;
  signPub: string;
  dhPub: string;
  pairwise: string;
  bundle: string | null;
  safetyNumber: string;
  trusted: number;
  blocked: number;
  verified: number;
  strangerTag: string | null;
  lastSeen: number;
  addedAt: number;
}

interface MessageRow {
  id: string;
  contactId: string;
  direction: string;
  kind: string;
  body: string;
  media: string | null;
  targetId: string | null;
  priority: number;
  ts: number;
  status: string;
}

interface ChatRow {
  contactId: string;
  name: string;
  trusted: number;
  lastBody: string | null;
  lastKind: string | null;
  lastDirection: string | null;
  lastStatus: string | null;
  lastTs: number | null;
  addedAt: number;
}

export interface ChatSummary {
  contactId: string;
  name: string;
  lastBody: string;
  lastKind: string;
  lastDirection: 'in' | 'out' | null;
  lastStatus: MessageStatus | null;
  ts: number;
  trusted: boolean;
}

export interface StoreStats {
  contacts: number;
  messages: number;
  queued: number;
  events: number;
  bytes: number;
}

function toContact(row: ContactRow): ContactRecord {
  let bundle: ContactRecord['bundle'] = null;
  if (row.bundle) {
    try {
      bundle = JSON.parse(row.bundle) as ContactRecord['bundle'];
    } catch {
      bundle = null;
    }
  }
  return {
    id: row.id,
    name: row.name,
    signPub: row.signPub,
    dhPub: row.dhPub,
    pairwise: row.pairwise,
    bundle,
    safetyNumber: row.safetyNumber,
    trusted: !!row.trusted,
    blocked: !!row.blocked,
    verified: !!row.verified,
    strangerTag: row.strangerTag,
    lastSeen: row.lastSeen,
    addedAt: row.addedAt,
  };
}

function toMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    contactId: row.contactId,
    direction: row.direction === 'in' ? 'in' : 'out',
    kind: row.kind as MessageRecord['kind'],
    body: row.body,
    media: row.media,
    targetId: row.targetId,
    priority: row.priority,
    ts: row.ts,
    status: row.status as MessageStatus,
  };
}

export class SqliteStore implements Store {
  private db: SQLite.SQLiteDatabase | null = null;
  private eventInserts = 0;

  constructor(private readonly name = 'meshlink.db') {}

  async open(): Promise<void> {
    if (this.db) return;
    const db = await SQLite.openDatabaseAsync(this.name);
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS kv (
        k TEXT PRIMARY KEY NOT NULL,
        v TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        signPub TEXT NOT NULL,
        dhPub TEXT NOT NULL,
        pairwise TEXT NOT NULL,
        bundle TEXT,
        safetyNumber TEXT NOT NULL,
        trusted INTEGER NOT NULL DEFAULT 0,
        blocked INTEGER NOT NULL DEFAULT 0,
        verified INTEGER NOT NULL DEFAULT 0,
        strangerTag TEXT,
        lastSeen INTEGER NOT NULL,
        addedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        contactId TEXT PRIMARY KEY NOT NULL,
        state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY NOT NULL,
        contactId TEXT NOT NULL,
        direction TEXT NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        media TEXT,
        targetId TEXT,
        priority INTEGER NOT NULL DEFAULT 1,
        ts INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued'
      );
      CREATE INDEX IF NOT EXISTS messages_contact_ts ON messages(contactId, ts);
      CREATE INDEX IF NOT EXISTS messages_status ON messages(status);
      CREATE TABLE IF NOT EXISTS queue_items (
        msgId TEXT PRIMARY KEY NOT NULL,
        envB64 TEXT NOT NULL,
        copies INTEGER NOT NULL,
        forMe INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS own_bundles (
        bundleId TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,
        ephXPriv TEXT NOT NULL,
        ephPqSk TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        detail TEXT NOT NULL
      );
    `);
    this.db = db;
  }

  private async d(): Promise<SQLite.SQLiteDatabase> {
    if (!this.db) await this.open();
    return this.db as SQLite.SQLiteDatabase;
  }

  async close(): Promise<void> {
    const db = this.db;
    this.db = null;
    if (db) await db.closeAsync();
  }

  /** Removes the whole database file (panic wipe). */
  async destroy(): Promise<void> {
    await this.close();
    await SQLite.deleteDatabaseAsync(this.name);
  }

  // ------------------------------------------------------------------ kv

  async kvGet(key: string): Promise<string | null> {
    const row = await (await this.d()).getFirstAsync<{ v: string }>('SELECT v FROM kv WHERE k = ?', key);
    return row?.v ?? null;
  }

  async kvSet(key: string, value: string): Promise<void> {
    await (await this.d()).runAsync('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', key, value);
  }

  async kvDel(key: string): Promise<void> {
    await (await this.d()).runAsync('DELETE FROM kv WHERE k = ?', key);
  }

  // ------------------------------------------------------------ contacts

  async putContact(c: ContactRecord): Promise<void> {
    await (await this.d()).runAsync(
      `INSERT INTO contacts (id, name, signPub, dhPub, pairwise, bundle, safetyNumber, trusted, blocked, verified, strangerTag, lastSeen, addedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         signPub = excluded.signPub,
         dhPub = excluded.dhPub,
         pairwise = excluded.pairwise,
         bundle = excluded.bundle,
         safetyNumber = excluded.safetyNumber,
         trusted = excluded.trusted,
         blocked = excluded.blocked,
         verified = excluded.verified,
         strangerTag = excluded.strangerTag,
         lastSeen = excluded.lastSeen,
         addedAt = excluded.addedAt`,
      c.id,
      c.name,
      c.signPub,
      c.dhPub,
      c.pairwise,
      c.bundle ? JSON.stringify(c.bundle) : null,
      c.safetyNumber,
      c.trusted ? 1 : 0,
      c.blocked ? 1 : 0,
      c.verified ? 1 : 0,
      c.strangerTag ?? null,
      c.lastSeen,
      c.addedAt,
    );
  }

  async getContact(id: string): Promise<ContactRecord | null> {
    const row = await (await this.d()).getFirstAsync<ContactRow>('SELECT * FROM contacts WHERE id = ?', id);
    return row ? toContact(row) : null;
  }

  async listContacts(): Promise<ContactRecord[]> {
    const rows = await (await this.d()).getAllAsync<ContactRow>('SELECT * FROM contacts ORDER BY lastSeen DESC');
    return rows.map(toContact);
  }

  async deleteContact(id: string): Promise<void> {
    const db = await this.d();
    await db.runAsync('DELETE FROM contacts WHERE id = ?', id);
    await db.runAsync('DELETE FROM sessions WHERE contactId = ?', id);
  }

  // ------------------------------------------------------------ sessions

  async putSession(contactId: string, stateJson: string): Promise<void> {
    await (await this.d()).runAsync(
      'INSERT INTO sessions (contactId, state) VALUES (?, ?) ON CONFLICT(contactId) DO UPDATE SET state = excluded.state',
      contactId,
      stateJson,
    );
  }

  async getSession(contactId: string): Promise<string | null> {
    const row = await (await this.d()).getFirstAsync<{ state: string }>('SELECT state FROM sessions WHERE contactId = ?', contactId);
    return row?.state ?? null;
  }

  async deleteSession(contactId: string): Promise<void> {
    await (await this.d()).runAsync('DELETE FROM sessions WHERE contactId = ?', contactId);
  }

  // ------------------------------------------------------------ messages

  async putMessage(m: MessageRecord): Promise<void> {
    await (await this.d()).runAsync(
      `INSERT INTO messages (id, contactId, direction, kind, body, media, targetId, priority, ts, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         body = excluded.body,
         media = excluded.media,
         targetId = excluded.targetId,
         priority = excluded.priority,
         ts = excluded.ts,
         status = excluded.status`,
      m.id,
      m.contactId,
      m.direction,
      m.kind,
      m.body,
      m.media,
      m.targetId,
      m.priority,
      m.ts,
      m.status,
    );
  }

  async getMessage(id: string): Promise<MessageRecord | null> {
    const row = await (await this.d()).getFirstAsync<MessageRow>('SELECT * FROM messages WHERE id = ?', id);
    return row ? toMessage(row) : null;
  }

  async listMessages(contactId: string, limit = 500): Promise<MessageRecord[]> {
    const rows = await (await this.d()).getAllAsync<MessageRow>(
      `SELECT * FROM (
         SELECT * FROM messages WHERE contactId = ? ORDER BY ts DESC LIMIT ?
       ) ORDER BY ts ASC`,
      contactId,
      limit,
    );
    return rows.map(toMessage);
  }

  async setMessageStatus(id: string, status: MessageStatus): Promise<void> {
    await (await this.d()).runAsync('UPDATE messages SET status = ? WHERE id = ?', status, id);
  }

  async listMessageRequests(): Promise<MessageRecord[]> {
    const rows = await (await this.d()).getAllAsync<MessageRow>(
      "SELECT * FROM messages WHERE status = 'request' ORDER BY ts DESC LIMIT 200",
    );
    return rows.map(toMessage);
  }

  async listChats(): Promise<ChatSummary[]> {
    const rows = await (await this.d()).getAllAsync<ChatRow>(
      `SELECT c.id AS contactId, c.name AS name, c.trusted AS trusted,
         (SELECT body FROM messages m WHERE m.contactId = c.id ORDER BY m.ts DESC LIMIT 1) AS lastBody,
         (SELECT kind FROM messages m WHERE m.contactId = c.id ORDER BY m.ts DESC LIMIT 1) AS lastKind,
         (SELECT direction FROM messages m WHERE m.contactId = c.id ORDER BY m.ts DESC LIMIT 1) AS lastDirection,
         (SELECT status FROM messages m WHERE m.contactId = c.id ORDER BY m.ts DESC LIMIT 1) AS lastStatus,
         (SELECT MAX(ts) FROM messages m WHERE m.contactId = c.id) AS lastTs,
         c.addedAt AS addedAt
       FROM contacts c
       ORDER BY COALESCE(lastTs, c.addedAt) DESC`,
    );
    return rows.map((r) => ({
      contactId: r.contactId,
      name: r.name,
      lastBody: r.lastBody ?? '',
      lastKind: r.lastKind ?? '',
      lastDirection: (r.lastDirection as 'in' | 'out' | null) ?? null,
      lastStatus: (r.lastStatus as MessageStatus | null) ?? null,
      ts: r.lastTs ?? r.addedAt,
      trusted: !!r.trusted,
    }));
  }

  // --------------------------------------------------------------- queue

  async putQueueItem(q: QueueRecord): Promise<void> {
    await (await this.d()).runAsync(
      'INSERT OR REPLACE INTO queue_items (msgId, envB64, copies, forMe, createdAt) VALUES (?, ?, ?, ?, ?)',
      q.msgId,
      q.envB64,
      q.copies,
      q.forMe ? 1 : 0,
      q.createdAt,
    );
  }

  async deleteQueueItem(msgId: string): Promise<void> {
    await (await this.d()).runAsync('DELETE FROM queue_items WHERE msgId = ?', msgId);
  }

  async listQueueItems(): Promise<QueueRecord[]> {
    const rows = await (await this.d()).getAllAsync<{ msgId: string; envB64: string; copies: number; forMe: number; createdAt: number }>(
      'SELECT * FROM queue_items',
    );
    return rows.map((r) => ({ msgId: r.msgId, envB64: r.envB64, copies: r.copies, forMe: !!r.forMe, createdAt: r.createdAt }));
  }

  // --------------------------------------------------------- own bundles

  async putOwnBundle(b: OwnBundleRecord): Promise<void> {
    const db = await this.d();
    await db.runAsync(
      'INSERT OR REPLACE INTO own_bundles (bundleId, kind, ephXPriv, ephPqSk, createdAt) VALUES (?, ?, ?, ?, ?)',
      b.bundleId,
      b.kind,
      b.ephXPriv,
      b.ephPqSk,
      b.createdAt,
    );
    await db.runAsync(
      'DELETE FROM own_bundles WHERE bundleId NOT IN (SELECT bundleId FROM own_bundles ORDER BY createdAt DESC LIMIT 32)',
    );
  }

  async listOwnBundles(): Promise<OwnBundleRecord[]> {
    const rows = await (await this.d()).getAllAsync<{ bundleId: string; kind: string; ephXPriv: string; ephPqSk: string; createdAt: number }>(
      'SELECT * FROM own_bundles ORDER BY createdAt DESC',
    );
    return rows.map((r) => ({ bundleId: r.bundleId, kind: 'hello', ephXPriv: r.ephXPriv, ephPqSk: r.ephPqSk, createdAt: r.createdAt }));
  }

  // -------------------------------------------------------------- events

  async logEvent(e: NetworkEventRecord): Promise<void> {
    const db = await this.d();
    await db.runAsync('INSERT INTO events (ts, kind, detail) VALUES (?, ?, ?)', e.ts, e.kind, e.detail);
    // Bounded log: never grows past a few thousand rows.
    if (++this.eventInserts % 50 === 0) {
      await db.runAsync('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 2000)');
    }
  }

  async listEvents(limit = 200): Promise<NetworkEventRecord[]> {
    const rows = await (await this.d()).getAllAsync<{ ts: number; kind: string; detail: string }>(
      'SELECT ts, kind, detail FROM events ORDER BY id DESC LIMIT ?',
      limit,
    );
    return rows.reverse().map((r) => ({ ts: r.ts, kind: r.kind as NetworkEventRecord['kind'], detail: r.detail }));
  }

  async clearEvents(): Promise<void> {
    await (await this.d()).runAsync('DELETE FROM events');
    this.eventInserts = 0;
  }

  async stats(): Promise<StoreStats> {
    const db = await this.d();
    const one = async (sql: string): Promise<number> => {
      const row = await db.getFirstAsync<{ n: number }>(sql);
      return row?.n ?? 0;
    };
    const contacts = await one('SELECT COUNT(*) AS n FROM contacts');
    const messages = await one('SELECT COUNT(*) AS n FROM messages');
    const queued = await one('SELECT COUNT(*) AS n FROM queue_items');
    const events = await one('SELECT COUNT(*) AS n FROM events');
    const pageCount = await db.getFirstAsync<{ page_count: number }>('PRAGMA page_count');
    const pageSize = await db.getFirstAsync<{ page_size: number }>('PRAGMA page_size');
    const bytes = (pageCount?.page_count ?? 0) * (pageSize?.page_size ?? 0);
    return { contacts, messages, queued, events, bytes };
  }
}
