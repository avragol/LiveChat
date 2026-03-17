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
  upsertUserSession, getUserSession, deleteUserSession,
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

const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'postmessage', // used when frontend sends the auth code via credential response
);

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

function verifyJwt(token: string): { email: string; name: string; exp: number } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const expected = b64url(createHmac('sha256', JWT_SECRET!).update(`${header}.${body}`).digest());
    const sigBuf      = Buffer.from(sig,      'base64');
    const expectedBuf = Buffer.from(expected, 'base64');
    if (sigBuf.length !== expectedBuf.length) return null;
    if (!timingSafeEqual(sigBuf, expectedBuf)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64').toString());
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
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

// ── Google Token Refresh ───────────────────────────────────────────────────────
// Uses the stored refresh_token to obtain a fresh access_token from Google.
// We don't actually need the access_token ourselves — we just confirm Google
// still trusts the user, then re-issue our own session_token.

async function refreshGoogleSession(refreshToken: string): Promise<{ email: string; name: string } | null> {
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { id_token?: string };
    if (!data.id_token) return null;
    // Verify the fresh id_token to get user info
    return await verifyGoogleToken(data.id_token);
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
    title: `${message.username} in #${message.room}`,
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

app.get('/vapid-public-key', (_req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY || null });
});

/**
 * POST /auth/google
 * Body: { idToken: string }
 *
 * 1. Verify Google id_token
 * 2. Exchange for access_token + refresh_token using the authorization code flow
 *    NOTE: @react-oauth/google returns an id_token (credential), NOT an auth code,
 *    so we verify the id_token directly. We don't get a refresh_token from this
 *    flow unless the user grants offline access. We store a synthetic refresh marker
 *    and use the id_token verification path for now; full offline flow requires
 *    switching the client to useGoogleLogin with access_type=offline.
 *
 * For now: verify id_token → issue our own 14-day session_token → store in DB.
 * The /auth/refresh endpoint will attempt a re-verify if the user still has
 * an active Google session (by calling tokeninfo endpoint).
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

  // Store user in DB (refresh_token is the id_token itself — see refresh endpoint)
  await upsertUserSession(googleUser.email, googleUser.name, idToken);

  const sessionToken = issueSessionToken(googleUser.email, googleUser.name);
  console.log(`🔑 Issued session token for ${googleUser.email}`);
  res.json({ sessionToken, username: googleUser.name, email: googleUser.email });
});

/**
 * POST /auth/refresh
 * Body: { sessionToken: string }
 *
 * If our JWT is still valid → just re-issue a fresh one (extend TTL).
 * If expired → try to re-verify the stored Google token.
 * Returns: { sessionToken } or 401.
 */
app.post('/auth/refresh', async (req, res) => {
  const { sessionToken } = req.body as { sessionToken?: string };
  if (!sessionToken || typeof sessionToken !== 'string') {
    res.status(400).json({ error: 'Missing sessionToken' });
    return;
  }

  // 1. Try to extend a still-valid session (most common case — called every 50 min)
  const payload = verifyJwt(sessionToken);
  if (payload) {
    // Session still valid — just refresh the TTL
    const newToken = issueSessionToken(payload.email, payload.name);
    res.json({ sessionToken: newToken, username: payload.name, email: payload.email });
    return;
  }

  // 2. Session expired — attempt recovery via stored token
  // Extract email from expired token (without signature check on exp)
  try {
    const parts = sessionToken.split('.');
    if (parts.length !== 3) throw new Error('bad format');
    const expiredPayload = JSON.parse(Buffer.from(parts[1], 'base64').toString()) as { email?: string };
    if (!expiredPayload.email) throw new Error('no email');

    const session = await getUserSession(expiredPayload.email);
    if (!session) {
      res.status(401).json({ error: 'Session not found — please log in again' });
      return;
    }

    // Try using the stored token as a fresh id_token (works if < 1hr old, rare)
    const googleUser = await verifyGoogleToken(session.refreshToken);
    if (googleUser) {
      const newToken = issueSessionToken(googleUser.email, googleUser.name);
      res.json({ sessionToken: newToken, username: googleUser.name, email: googleUser.email });
      return;
    }

    // Fallback: try Google OAuth refresh (works only if we have a real refresh_token)
    const refreshed = await refreshGoogleSession(session.refreshToken);
    if (refreshed) {
      await upsertUserSession(refreshed.email, refreshed.name, session.refreshToken);
      const newToken = issueSessionToken(refreshed.email, refreshed.name);
      res.json({ sessionToken: newToken, username: refreshed.name, email: refreshed.email });
      return;
    }

    // Nothing worked — user must log in again
    await deleteUserSession(expiredPayload.email);
    res.status(401).json({ error: 'Session expired — please log in again' });
  } catch {
    res.status(401).json({ error: 'Invalid session' });
  }
});

/**
 * POST /auth/logout
 * Body: { sessionToken: string }
 * Deletes the server-side session (refresh token).
 */
app.post('/auth/logout', async (req, res) => {
  const { sessionToken } = req.body as { sessionToken?: string };
  if (!sessionToken) { res.json({ ok: true }); return; }
  try {
    const parts = sessionToken.split('.');
    if (parts.length === 3) {
      const p = JSON.parse(Buffer.from(parts[1], 'base64').toString()) as { email?: string };
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
   * authenticate — accepts our session_token (JWT).
   * Falls back to accepting a raw Google id_token for backwards compatibility
   * (e.g. fresh login before the client calls /auth/google).
   */
  socket.on('authenticate', async (token: string) => {
    if (typeof token !== 'string') { socket.emit('auth-error', 'Invalid token'); return; }

    // 1. Try our JWT first
    const jwtPayload = verifyJwt(token);
    if (jwtPayload) {
      authenticatedUsers.set(socket.id, { username: jwtPayload.name, email: jwtPayload.email, room: '' });
      const rooms = await getRooms();
      socket.emit('auth-success', { username: jwtPayload.name, email: jwtPayload.email });
      socket.emit('room-list-update', rooms);
      console.log(`✅ JWT auth: ${jwtPayload.name} (${jwtPayload.email})`);
      return;
    }

    // 2. Fallback: raw Google id_token (client just logged in, session_token not yet obtained)
    const googleUser = await verifyGoogleToken(token);
    if (googleUser) {
      authenticatedUsers.set(socket.id, { username: googleUser.name, email: googleUser.email, room: '' });
      const rooms = await getRooms();
      socket.emit('auth-success', { username: googleUser.name, email: googleUser.email });
      socket.emit('room-list-update', rooms);
      console.log(`✅ Google id_token auth (legacy): ${googleUser.name}`);
      return;
    }

    socket.emit('auth-error', 'Token verification failed — please log in again');
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
      io.to(user.room).emit('user_left', { username: user.username, users: getUsersInRoom(user.room) });
    }
    user.room = room;
    socket.join(room);
    const history = await getRecentMessages(room);
    socket.emit('previous_messages', history);
    io.to(room).emit('user_joined', { username: user.username, users: getUsersInRoom(room) });
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
    if (!user) { socket.emit('auth-error', 'Not authenticated'); return; }
    if (!roomName || roomName.trim() === '') { socket.emit('room-creation-error', 'Room name cannot be empty'); return; }
    const trimmed = roomName.trim();
    if (await roomExists(trimmed)) { socket.emit('room-creation-error', 'Room already exists'); return; }
    if (await getRoomCount() >= MAX_ROOMS) { socket.emit('room-creation-error', `Maximum number of rooms (${MAX_ROOMS}) reached`); return; }
    await createRoom(trimmed);
    const rooms = await getRooms();
    io.emit('room-list-update', rooms);
    console.log(`New room created: ${trimmed} by ${user.username}`);
  });

  socket.on('disconnect', () => {
    const user = authenticatedUsers.get(socket.id);
    if (user?.room) {
      io.to(user.room).emit('user_left', { username: user.username, users: getUsersInRoom(user.room) });
    }
    authenticatedUsers.delete(socket.id);
    rateLimits.delete(socket.id);
    console.log(`${user?.username ?? socket.id} disconnected`);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
initDb().then(() => {
  httpServer.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to initialize DB:', err);
  process.exit(1);
});
