import { Database } from "bun:sqlite";
import { join } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS channels (
  name TEXT PRIMARY KEY,
  description TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  author TEXT NOT NULL,
  author_type TEXT NOT NULL CHECK(author_type IN ('human', 'agent')),
  content TEXT NOT NULL,
  reply_to TEXT,
  agent_context TEXT,
  ts TEXT NOT NULL,
  FOREIGN KEY (channel) REFERENCES channels(name)
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_ts ON messages(channel, ts);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
`;

export interface Message {
  id: string;
  channel: string;
  author: string;
  author_type: "human" | "agent";
  content: string;
  reply_to?: string | null;
  agent_context?: string | null;
  ts: string;
}

export function openDb(chatDir: string): Database {
  const db = new Database(join(chatDir, "chat.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(SCHEMA);
  return db;
}

export function generateId(): string {
  return `msg_${crypto.randomUUID()}`;
}

export function insertMessage(db: Database, msg: Message): boolean {
  const r = db.run(
    `INSERT OR IGNORE INTO messages (id, channel, author, author_type, content, reply_to, agent_context, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [msg.id, msg.channel, msg.author, msg.author_type, msg.content, msg.reply_to ?? null, msg.agent_context ?? null, msg.ts]
  );
  return r.changes > 0;
}

export function insertMessages(db: Database, msgs: Message[]): Message[] {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO messages (id, channel, author, author_type, content, reply_to, agent_context, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const inserted: Message[] = [];
  db.transaction(() => {
    for (const msg of msgs) {
      const r = stmt.run(msg.id, msg.channel, msg.author, msg.author_type, msg.content, msg.reply_to ?? null, msg.agent_context ?? null, msg.ts);
      if (r.changes > 0) inserted.push(msg);
    }
  })();
  return inserted;
}

export function queryMessages(db: Database, channel: string, opts: { last?: number; since?: string; search?: string } = {}): Message[] {
  const conds = ["channel = ?"];
  const params: any[] = [channel];

  if (opts.since) {
    conds.push("ts > ?");
    params.push(opts.since);
  }
  if (opts.search) {
    conds.push("content LIKE ?");
    params.push(`%${opts.search}%`);
  }

  const where = conds.join(" AND ");

  if (opts.last) {
    return db.prepare(
      `SELECT * FROM (SELECT * FROM messages WHERE ${where} ORDER BY ts DESC LIMIT ?) ORDER BY ts ASC`
    ).all(...params, opts.last) as Message[];
  }

  return db.prepare(
    `SELECT * FROM messages WHERE ${where} ORDER BY ts ASC`
  ).all(...params) as Message[];
}

export function getMessagesSince(db: Database, since: string): Message[] {
  return db.prepare("SELECT * FROM messages WHERE ts > ? ORDER BY ts ASC").all(since) as Message[];
}

export function getAllMessages(db: Database): Message[] {
  return db.prepare("SELECT * FROM messages ORDER BY ts ASC").all() as Message[];
}

export function getChannels(db: Database): { name: string; description: string; created_at: string }[] {
  return db.prepare("SELECT * FROM channels ORDER BY name").all() as any[];
}

export function createChannel(db: Database, name: string, description = ""): void {
  db.run("INSERT OR IGNORE INTO channels (name, description) VALUES (?, ?)", [name, description]);
}

export function ensureChannel(db: Database, name: string): void {
  db.run("INSERT OR IGNORE INTO channels (name) VALUES (?)", [name]);
}

