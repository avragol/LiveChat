// db.ts - Turso database client and schema initialization
import { createClient } from '@libsql/client';

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  throw new Error('Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN environment variables');
}

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

console.log('🔌 Connecting to Turso:', url);

export const db = createClient({ url, authToken });

export async function initDb(): Promise<void> {
  await db.execute(`CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    email TEXT NOT NULL,
    text TEXT NOT NULL,
    room TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    room TEXT NOT NULL,
    subscription TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(email, room, subscription)
  )`);
  await db.execute("INSERT OR IGNORE INTO rooms (name) VALUES ('General')");
  console.log('✅ Database initialized');
}

export async function getRooms(): Promise<string[]> {
  const result = await db.execute('SELECT name FROM rooms ORDER BY created_at ASC');
  return result.rows.map(r => r.name as string);
}

export async function createRoom(name: string): Promise<void> {
  await db.execute({ sql: 'INSERT INTO rooms (name) VALUES (?)', args: [name] });
}

export async function roomExists(name: string): Promise<boolean> {
  const result = await db.execute({ sql: 'SELECT 1 FROM rooms WHERE name = ?', args: [name] });
  return result.rows.length > 0;
}

export async function getRoomCount(): Promise<number> {
  const result = await db.execute('SELECT COUNT(*) as count FROM rooms');
  return (result.rows[0]?.count as number) ?? 0;
}

export async function getRecentMessages(room: string, limit = 50): Promise<Message[]> {
  const result = await db.execute({
    sql: 'SELECT * FROM messages WHERE room = ? ORDER BY timestamp DESC LIMIT ?',
    args: [room, limit],
  });
  return result.rows.map(r => ({
    id: r.id as string,
    username: r.username as string,
    email: r.email as string,
    text: r.text as string,
    room: r.room as string,
    timestamp: r.timestamp as number,
  })).reverse();
}

export async function saveMessage(message: Message): Promise<void> {
  await db.execute({
    sql: 'INSERT INTO messages (id, username, email, text, room, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
    args: [message.id, message.username, message.email, message.text, message.room, message.timestamp],
  });
}

export async function savePushSubscription(email: string, room: string, subscription: string): Promise<void> {
  await db.execute({
    sql: 'INSERT OR REPLACE INTO push_subscriptions (email, room, subscription) VALUES (?, ?, ?)',
    args: [email, room, subscription],
  });
}

export async function getPushSubscriptionsForRoom(room: string, excludeEmail: string): Promise<{ email: string; subscription: string }[]> {
  const result = await db.execute({
    sql: 'SELECT email, subscription FROM push_subscriptions WHERE room = ? AND email != ?',
    args: [room, excludeEmail],
  });
  return result.rows.map(r => ({ email: r.email as string, subscription: r.subscription as string }));
}

export async function deletePushSubscription(email: string, room: string, subscription: string): Promise<void> {
  await db.execute({
    sql: 'DELETE FROM push_subscriptions WHERE email = ? AND room = ? AND subscription = ?',
    args: [email, room, subscription],
  });
}

export async function unsubscribeUserFromRoom(email: string, room: string): Promise<void> {
  await db.execute({
    sql: 'DELETE FROM push_subscriptions WHERE email = ? AND room = ?',
    args: [email, room],
  });
}

export interface Message {
  id: string;
  username: string;
  email: string;
  text: string;
  room: string;
  timestamp: number;
}
