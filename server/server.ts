// server.ts
import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import { OAuth2Client } from 'google-auth-library';
import { createHmac, timingSafeEqual } from 'crypto';
import webpush from 'web-push';
import {
  initDb, getRooms, createRoom, roomExists, getRoomCount,
  getRecentMessages, saveMessage,
  savePushSubscription, getPushSubscriptionsForRoom, deletePushSubscription,
  unsubscribeUserFromRoom,
  upsertUserSession, deleteUserSession,
  type Message,
} from './db.js';

// ── App setup ────────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: ['http://localhost:5173', 'https://livechat-0im1.onrender.com'],
    methods: ['GET', 'POST'],
  },
});

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_MESSAGE_LENGTH = 500;
const MAX_ROOMS = 50;
const RATE_LIMIT_WINDOW_MS = 5000;
const RATE_LIMIT_MAX_MESSAGES = 5;
const BOT_SECRET = '156360yoseff!!!';
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('Missing JWT_SECRET environment variable');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY!;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY!;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.warn('⚠️  VAPID keys not set — push notifications disabled');
} else {
  webpush.setVapidDetails('mailto:admin@livechat.app', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log('🔔 Web Push enabled');
}

// ── Google OAuth client ───────────────────────────────────────────────────────

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ── Minimal JWT implementation (no extra deps) ────────────────────────────────
// Header: { alg: "HS256", typ: "JWT" }
// Payload: { email, name, exp }

function b64url(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf) : buf;
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function signJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body   = b64url(JSON.stringify(payload));
  const sig    = b64url(createHmac('sha256', JWT_SECRET!).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

type JwtVerifyResult =
  | { ok: true;  payload: { email: string; name: string; exp: number } }
  | { ok: false; reason: 'malformed' | 'invalid_signature' | 'expired' };

function verifyJwt(token: string): { email: string; name: string; exp: number } | null {
  const r = verifyJwtDetailed(token);
  return r.ok ? r.payload : null;
}

function verifyJwtDetailed(token: string): JwtVerifyResult {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed' };
    const [header, body, sig] = parts as [string, string, string];
    const expected = b64url(createHmac('sha256', JWT_SECRET!).update(`${header}.${body}`).digest());
    const sigBuf      = Buffer.from(sig,      'base64');
    const expectedBuf = Buffer.from(expected, 'base64');
    if (sigBuf.length !== expectedBuf.length) return { ok: false, reason: 'invalid_signature' };
    if (!timingSafeEqual(sigBuf, expectedBuf)) return { ok: false, reason: 'invalid_signature' };
    const payload = JSON.parse(Buffer.from(body, 'base64').toString());
    if (Date.now() > payload.exp) return { ok: false, reason: 'expired' };
    return { ok: true, payload };
  } catch { return { ok: false, reason: 'malformed' }; }
}

function issueSessionToken(email: string, name: string): string {
  return signJwt({ email, name, exp: Date.now() + SESSION_TTL_MS });
}

// ── Google id_token verification (initial login) ──────────────────────────────

async function verifyGoogleToken(idToken: string): Promise<{ name: string; email: string } | null> {
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload?.name) return null;
    return { name: payload.name, email: payload.email };
  } catch { return null; }
}

// ── Runtime state ─────────────────────────────────────────────────────────────

interface AuthenticatedUser { username: string; email: string; room: string; }
const authenticatedUsers = new Map<string, AuthenticatedUser>();
const rateLimits = new Map<string, { count: number; windowStart: number }>();

const getUsersInRoom = (room: string) =>
  Array.from(authenticatedUsers.entries())
    .filter(([, u]) => u.room === room)
    .map(([id, u]) => ({ id, username: u.username, room: u.room }));

const checkRateLimit = (socketId: string): boolean => {
  const now = Date.now();
  const rl = rateLimits.get(socketId);
  if (!rl || now - rl.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(socketId, { count: 1, windowStart: now });
    return true;
  }
  if (rl.count >= RATE_LIMIT_MAX_MESSAGES) return false;
  rl.count += 1;
  return true;
};

// ── Push Notifications ────────────────────────────────────────────────────────

async function sendPushToRoom(message: Message, senderEmail: string): Promise<void> {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  const subscriptions = await getPushSubscriptionsForRoom(message.room, senderEmail);
  if (subscriptions.length === 0) return;

  const onlineEmailsInRoom = new Set(
    [...authenticatedUsers.values()]
      .filter(u => u.room === message.room)
      .map(u => u.email)
  );

  const payload = JSON.stringify({
    title: `${message.username} בחדר #${message.room}`,
    body: message.text.length > 80 ? message.text.slice(0, 80) + '…' : message.text,
    room: message.room,
  });

  const offlineSubscriptions = subscriptions.filter(({ email }) => !onlineEmailsInRoom.has(email));
  if (offlineSubscriptions.length === 0) return;

  console.log(`🔔 Sending push to ${offlineSubscriptions.length} offline subscriber(s) in #${message.room}`);

  await Promise.allSettled(
    offlineSubscriptions.map(async ({ email, subscription }) => {
      try {
        await webpush.sendNotification(JSON.parse(subscription), payload);
      } catch (err: any) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          console.log(`🗑️ Removing expired push subscription for ${email}`);
          await deletePushSubscription(email, message.room, subscription);
        } else {
          console.error(`Push failed for ${email}:`, err.statusCode, err.body);
        }
      }
    })
  );
}

// ── REST endpoints ────────────────────────────────────────────────────────────

/**
 * GET /ping
 * Lightweight health-check endpoint. The client calls this immediately on load
 * to wake the Render server before the socket connection is established.
 */
app.get('/ping', (_req, res) => {
  res.json({ ok: true });
});

app.get('/vapid-public-key', (_req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY || null });
});

/**
 * POST /auth/google
 * Body: { idToken: string }
 *
 * Verifies the Google id_token, issues a 14-day JWT session token, and
 * stores the user in the DB. No refresh endpoint needed — the JWT lasts
 * long enough that the user won't need to re-authenticate for two weeks.
 */
app.post('/auth/google', async (req, res) => {
  const { idToken } = req.body as { idToken?: string };
  if (!idToken || typeof idToken !== 'string') {
    res.status(400).json({ error: 'Missing idToken' });
    return;
  }

  const googleUser = await verifyGoogleToken(idToken);
  if (!googleUser) {
    res.status(401).json({ error: 'Invalid Google token' });
    return;
  }

  await upsertUserSession(googleUser.email, googleUser.name, idToken);

  const sessionToken = issueSessionToken(googleUser.email, googleUser.name);
  console.log(`🔑 Issued 14-day session token for ${googleUser.email}`);
  res.json({ sessionToken, username: googleUser.name, email: googleUser.email });
});

/**
 * POST /auth/logout
 * Body: { sessionToken: string }
 * Deletes the server-side session record.
 */
app.post('/auth/logout', async (req, res) => {
  const { sessionToken } = req.body as { sessionToken?: string };
  if (!sessionToken) { res.json({ ok: true }); return; }
  try {
    const parts = sessionToken.split('.');
    if (parts.length === 3) {
      const p = JSON.parse(Buffer.from(parts[1]!, 'base64').toString()) as { email?: string };
      if (p.email) await deleteUserSession(p.email);
    }
  } catch { /* ignore */ }
  res.json({ ok: true });
});

app.post('/subscribe', async (req, res) => {
  const { email, room, subscription } = req.body;
  if (!email || !room || !subscription) {
    res.status(400).json({ error: 'Missing email, room or subscription' });
    return;
  }
  await savePushSubscription(email, room, JSON.stringify(subscription));
  console.log(`🔔 Subscription saved: ${email} → #${room}`);
  res.json({ ok: true });
});

app.post('/unsubscribe', async (req, res) => {
  const { email, room } = req.body;
  if (!email || !room) {
    res.status(400).json({ error: 'Missing email or room' });
    return;
  }
  await unsubscribeUserFromRoom(email, room);
  console.log(`🔕 Unsubscribed: ${email} from #${room}`);
  res.json({ ok: true });
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────

io.on('connection', (socket: Socket) => {
  console.log('User connected:', socket.id);

  /**
   * authenticate — accepts our 14-day session JWT.
   */
  socket.on('authenticate', async (token: string) => {
    if (typeof token !== 'string') {
      console.warn(`⚠️  [auth] socket ${socket.id} sent non-string token`);
      socket.emit('auth-error', 'Invalid token');
      return;
    }

    const result = verifyJwtDetailed(token);

    if (result.ok) {
      authenticatedUsers.set(socket.id, { username: result.payload.name, email: result.payload.email, room: '' });
      const rooms = await getRooms();
      socket.emit('auth-success', { username: result.payload.name, email: result.payload.email });
      socket.emit('room-list-update', rooms);
      console.log(`✅ JWT auth: ${result.payload.name} (${result.payload.email})`);
      return;
    }

    console.warn(`⚠️  [auth] socket ${socket.id} — token rejected: ${result.reason}`);
    const msg = result.reason === 'expired'
      ? 'Token expired — please log in again'
      : 'Invalid token — please log in again';
    socket.emit('auth-error', msg);
  });

  socket.on('authenticate-bot', async (secret: string) => {
    if (secret !== BOT_SECRET) { socket.emit('auth-error', 'Invalid bot secret'); return; }
    const botUser = { username: 'GolTomation 🤖', email: 'bot@livechat.test' };
    authenticatedUsers.set(socket.id, { ...botUser, room: '' });
    const rooms = await getRooms();
    socket.emit('auth-success', { username: botUser.username, email: botUser.email });
    socket.emit('room-list-update', rooms);
    console.log(`🤖 Bot connected: ${socket.id}`);
  });

  socket.on('join_room', async (room: string) => {
    const user = authenticatedUsers.get(socket.id);
    if (!user) { socket.emit('auth-error', 'Not authenticated'); return; }
    if (!room || room.trim() === '') return;
    if (user.room) {
      socket.leave(user.room);
      io.to(user.room).emit('users-update', { users: getUsersInRoom(user.room) });
    }
    user.room = room;
    socket.join(room);
    const history = await getRecentMessages(room);
    socket.emit('previous_messages', history);
    io.to(room).emit('users-update', { users: getUsersInRoom(room) });
    console.log(`${user.username} joined room: ${room}`);
  });

  socket.on('send_message', async (text: string) => {
    const user = authenticatedUsers.get(socket.id);
    if (!user || !user.room) return;
    if (!checkRateLimit(socket.id)) {
      socket.emit('rate-limit-error', 'You are sending messages too fast. Please slow down.');
      return;
    }
    if (typeof text !== 'string' || text.trim() === '') return;
    const sanitizedText = text.trim().slice(0, MAX_MESSAGE_LENGTH);
    const message: Message = {
      id: `${Date.now()}-${socket.id}`,
      username: user.username,
      email: user.email,
      text: sanitizedText,
      room: user.room,
      timestamp: Date.now(),
    };
    await saveMessage(message);
    io.to(user.room).emit('new_message', message);
    sendPushToRoom(message, user.email).catch(console.error);
  });

  socket.on('typing', (isTyping: boolean) => {
    const user = authenticatedUsers.get(socket.id);
    if (!user?.room) return;
    socket.to(user.room).emit('user_typing', { username: user.username, isTyping });
  });

  socket.on('create-room', async (roomName: string) => {
    const user = authenticatedUsers.get(socket.id);
    if (!user) return;
    if (typeof roomName !== 'string' || !roomName.trim()) return;
    const name = roomName.trim().slice(0, 30);
    if (await roomExists(name)) { socket.emit('room-creation-error', `חדר "${name}" כבר קיים`); return; }
    const count = await getRoomCount();
    if (count >= MAX_ROOMS) { socket.emit('room-creation-error', 'הגעת למגבלת החדרים'); return; }
    await createRoom(name);
    const rooms = await getRooms();
    io.emit('room-list-update', rooms);
    console.log(`🏠 Room created: ${name} by ${user.username}`);
  });

  // ── Rename room (Issue #26) ──────────────────────────────────────────────────
  socket.on('rename-room', async ({ oldName, newName }: { oldName: string; newName: string }) => {
    const user = authenticatedUsers.get(socket.id);
    if (!user) { socket.emit('room-rename-error', 'לא מחובר'); return; }

    const trimmed = (newName ?? '').trim();
    if (!trimmed || trimmed.length > 30) {
      socket.emit('room-rename-error', 'שם חדר לא תקין');
      return;
    }
    if (!(await roomExists(oldName))) {
      socket.emit('room-rename-error', 'החדר לא קיים');
      return;
    }
    if (trimmed !== oldName && await roomExists(trimmed)) {
      socket.emit('room-rename-error', 'שם זה כבר תפוס');
      return;
    }
    if (trimmed === oldName) return; // no-op

    await renameRoom(oldName, trimmed);
    console.log(`✏️  Room renamed: "${oldName}" → "${trimmed}" by ${user.username}`);

    // Update in-memory room tracking for all connected users
    authenticatedUsers.forEach((u, sid) => {
      if (u.room === oldName) {
        authenticatedUsers.set(sid, { ...u, room: trimmed });
      }
    });

    // Broadcast to everyone
    io.emit('room-renamed', { oldName, newName: trimmed });
    const updatedRooms = await getRooms();
    io.emit('room-list-update', updatedRooms);
  });

  socket.on('disconnect', () => {
    const user = authenticatedUsers.get(socket.id);
    if (user?.room) {
      io.to(user.room).emit('users-update', { users: getUsersInRoom(user.room) });
    }
    authenticatedUsers.delete(socket.id);
    rateLimits.delete(socket.id);
    console.log('User disconnected:', socket.id);
  });
});

// ── Bootstrap ────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

initDb().then(() => {
  httpServer.listen(PORT, () => {
    console.log(`🚀 Server listening on port ${PORT}`);
  });
}).catch((err: unknown) => {
  console.error('Failed to initialize DB:', err);
  process.exit(1);
});

