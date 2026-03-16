// server.ts
import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import { OAuth2Client } from 'google-auth-library';
import webpush from 'web-push';
import {
  initDb, getRooms, createRoom, roomExists, getRoomCount,
  getRecentMessages, saveMessage,
  savePushSubscription, getPushSubscriptionsForRoom, deletePushSubscription,
  type Message,
} from './db.js';

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

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY!;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY!;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.warn('⚠️  VAPID keys not set — push notifications disabled');
} else {
  webpush.setVapidDetails('mailto:admin@livechat.app', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log('🔔 Web Push enabled');
}

const MAX_MESSAGE_LENGTH = 500;
const MAX_ROOMS = 50;
const RATE_LIMIT_WINDOW_MS = 5000;
const RATE_LIMIT_MAX_MESSAGES = 5;

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

async function verifyGoogleToken(idToken: string): Promise<{ name: string; email: string } | null> {
  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload?.name) return null;
    return { name: payload.name, email: payload.email };
  } catch { return null; }
}

// Send push to ALL subscribers of a room (from DB), excluding sender
async function sendPushToRoom(message: Message, senderEmail: string): Promise<void> {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  const subscriptions = await getPushSubscriptionsForRoom(message.room, senderEmail);
  if (subscriptions.length === 0) return;

  const payload = JSON.stringify({
    title: `${message.username} in #${message.room}`,
    body: message.text.length > 80 ? message.text.slice(0, 80) + '…' : message.text,
    room: message.room,
  });

  console.log(`🔔 Sending push to ${subscriptions.length} subscriber(s) in #${message.room}`);

  await Promise.allSettled(
    subscriptions.map(async ({ email, subscription }) => {
      try {
        await webpush.sendNotification(JSON.parse(subscription), payload);
      } catch (err: any) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          console.log(`🗑️ Removing expired subscription for ${email}`);
          await deletePushSubscription(email, message.room, subscription);
        } else {
          console.error(`Push failed for ${email}:`, err.statusCode, err.body);
        }
      }
    })
  );
}

// REST
app.get('/vapid-public-key', (_req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY || null });
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

// Socket.IO
io.on('connection', (socket: Socket) => {
  console.log('User connected:', socket.id);

  socket.on('authenticate', async (idToken: string) => {
    if (typeof idToken !== 'string') { socket.emit('auth-error', 'Invalid token'); return; }
    const googleUser = await verifyGoogleToken(idToken);
    if (!googleUser) { socket.emit('auth-error', 'Google token verification failed'); return; }
    authenticatedUsers.set(socket.id, { username: googleUser.name, email: googleUser.email, room: '' });
    const rooms = await getRooms();
    socket.emit('auth-success', { username: googleUser.name, email: googleUser.email });
    socket.emit('room-list-update', rooms);
    console.log(`✅ Authenticated: ${googleUser.name} (${googleUser.email})`);
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

const PORT = process.env.PORT || 3001;
initDb().then(() => {
  httpServer.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to initialize DB:', err);
  process.exit(1);
});
