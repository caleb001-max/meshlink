// SQLite message + peer store.
import * as SQLite from 'expo-sqlite';

export interface Peer {
  pk: string;
  name: string;
  lastSeen: number;
  via: string;
}

export interface Message {
  id: string;
  peer: string;
  fromMe: boolean;
  kind: 'text' | 'photo' | 'audio';
  body: string;
  media: string | null;
  ts: number;
  status: 'pending' | 'sent' | 'delivered';
}

let db: SQLite.SQLiteDatabase | null = null;

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  db = await SQLite.openDatabaseAsync('chimera.db');
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS peers (
      pk TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      lastSeen INTEGER NOT NULL,
      via TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY NOT NULL,
      peer TEXT NOT NULL,
      fromMe INTEGER NOT NULL,
      kind TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      media TEXT,
      ts INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS messages_peer_ts ON messages(peer, ts);
  `);
  return db;
}

export async function upsertPeer(peer: Peer): Promise<void> {
  const d = await getDb();
  await d.runAsync(
    `INSERT INTO peers (pk, name, lastSeen, via) VALUES (?, ?, ?, ?)
     ON CONFLICT(pk) DO UPDATE SET name = excluded.name, lastSeen = excluded.lastSeen, via = excluded.via`,
    peer.pk,
    peer.name,
    peer.lastSeen,
    peer.via,
  );
}

export async function listPeers(): Promise<Peer[]> {
  const d = await getDb();
  return d.getAllAsync<Peer>('SELECT * FROM peers ORDER BY lastSeen DESC');
}

export async function getPeer(pk: string): Promise<Peer | null> {
  const d = await getDb();
  return d.getFirstAsync<Peer>('SELECT * FROM peers WHERE pk = ?', pk);
}

export async function insertMessage(msg: Message): Promise<void> {
  const d = await getDb();
  await d.runAsync(
    `INSERT OR REPLACE INTO messages (id, peer, fromMe, kind, body, media, ts, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    msg.id,
    msg.peer,
    msg.fromMe ? 1 : 0,
    msg.kind,
    msg.body,
    msg.media,
    msg.ts,
    msg.status,
  );
}

export async function listMessages(peerPk: string): Promise<Message[]> {
  const d = await getDb();
  const rows = await d.getAllAsync<Omit<Message, 'fromMe'> & { fromMe: number }>(
    'SELECT * FROM messages WHERE peer = ? ORDER BY ts ASC',
    peerPk,
  );
  return rows.map((r) => ({ ...r, fromMe: !!r.fromMe }));
}

export async function markDelivered(id: string): Promise<void> {
  const d = await getDb();
  await d.runAsync("UPDATE messages SET status = 'delivered' WHERE id = ?", id);
}

export interface ChatSummary {
  peer: string;
  name: string;
  lastBody: string;
  lastKind: string;
  ts: number;
}

export async function listChats(): Promise<ChatSummary[]> {
  const d = await getDb();
  return d.getAllAsync<ChatSummary>(
    `SELECT m.peer, p.name, m.body AS lastBody, m.kind AS lastKind, m.ts
     FROM messages m JOIN peers p ON p.pk = m.peer
     WHERE m.id IN (SELECT id FROM messages GROUP BY peer HAVING MAX(ts))
     ORDER BY m.ts DESC`,
  );
}

/** Panic wipe: erases every trace of the hidden app's data. */
export async function wipeDatabase(): Promise<void> {
  const d = await getDb();
  await d.execAsync('DELETE FROM messages; DELETE FROM peers;');
}
