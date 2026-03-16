// server.ts
import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import { OAuth2Client } from 'google-auth-library';
import {
  initDb,
  getRooms,
  createRoom,
  roomExists,
  getRoomCount,
  getRecentMessages,
  saveMessage,
  type Message,
} from './db.js';

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: [
      'http://localhost:5173',
      'https://livechat-0im1.onrender.com',
    ],
    methods: ['GET', 'POST'],
  },
});

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Constants
const MAX_MESSAGE_LENGTH = 500;
const MAX_ROOMS = 50;
const RATE_LIMIT_WINDOW_MS = 5000;
const RATE_LIMIT_MAX_MESSAGES = 5;

// In-memory session store: socket.id -> verified user info
interface AuthenticatedUser {
  username: string;
  email: string;
  room: string;
}

const authenticatedUsers = new Map<string, AuthenticatedUser>();
const rateLimits = new Map<string, { count: number; windowStart: number }>();

// --- Helpers ---

const getUsersInRoom = (room: string) => {
  return Array.from(authenticatedUsers.entries())
    .filter(([, u]) => u.room === room)
    .map(([id, u]) => ({ id, username: u.username, room: u.room }));
};

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

// --- Verify Google ID Token ---
async function verifyGoogleToken(idToken: string): Promise<{ name: string; email: string } | null> {
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload?.name) return null;
    return { name: payload.name, email: payload.email };
  } catch {
    return null;
  }
}

// --- Socket.IO ---
io.on('connection', (socket: Socket) => {
  console.log('User connected:', socket.id);

  // Step 1: Client must authenticate first by sending the Google ID token
  socket.on('authenticate', async (idToken: string) => {
    if (typeof idToken !== 'string') {
      socket.emit('auth-error', 'Invalid token');
      return;
    }

    const googleUser = await verifyGoogleToken(idToken);
    if (!googleUser) {
      socket.emit('auth-error', 'Google token verification failed');
      return;
    }

    // Store verified user in session (not trusting client for username anymore)
    authenticatedUsers.set(socket.id, {
      username: googleUser.name,
      email: googleUser.email,
      room: '',
    });

    // Send room list after successful auth
    const rooms = await getRooms();
    socket.emit('auth-success', { username: googleUser.name });
    socket.emit('room-list-update', rooms);

    console.log(`✅ Authenticated: ${googleUser.name} (${googleUser.email})`);
  });

  // Step 2: Join a room (only allowed after authentication)
  socket.on('join_room', async (room: string) => {
    const user = authenticatedUsers.get(socket.id);
    if (!user) {
      socket.emit('auth-error', 'Not authenticated');
      return;
    }

    if (!room || room.trim() === '') return;

    // Leave previous room
    if (user.room) {
      socket.leave(user.room);
      io.to(user.room).emit('user_left', {
        username: user.username,
        users: getUsersInRoom(user.room),
      });
    }

    user.room = room;
    socket.join(room);

    // Send message history from DB
    const history = await getRecentMessages(room);
    socket.emit('previous_messages', history);

    io.to(room).emit('user_joined', {
      username: user.username,
      users: getUsersInRoom(room),
    });

    console.log(`${user.username} joined room: ${room}`);
  });

  // Send message
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
  });

  // Typing indicator
  socket.on('typing', (isTyping: boolean) => {
    const user = authenticatedUsers.get(socket.id);
    if (!user?.room) return;
    socket.to(user.room).emit('user_typing', { username: user.username, isTyping });
  });

  // Create room
  socket.on('create-room', async (roomName: string) => {
    const user = authenticatedUsers.get(socket.id);
    if (!user) {
      socket.emit('auth-error', 'Not authenticated');
      return;
    }

    if (!roomName || roomName.trim() === '') {
      socket.emit('room-creation-error', 'Room name cannot be empty');
      return;
    }

    const trimmed = roomName.trim();

    if (await roomExists(trimmed)) {
      socket.emit('room-creation-error', 'Room already exists');
      return;
    }

    if (await getRoomCount() >= MAX_ROOMS) {
      socket.emit('room-creation-error', `Maximum number of rooms (${MAX_ROOMS}) reached`);
      return;
    }

    await createRoom(trimmed);
    const rooms = await getRooms();
    io.emit('room-list-update', rooms);
    console.log(`New room created: ${trimmed} by ${user.username}`);
  });

  // Disconnect
  socket.on('disconnect', () => {
    const user = authenticatedUsers.get(socket.id);
    if (user?.room) {
      io.to(user.room).emit('user_left', {
        username: user.username,
        users: getUsersInRoom(user.room),
      });
    }
    authenticatedUsers.delete(socket.id);
    rateLimits.delete(socket.id);
    console.log(`${user?.username ?? socket.id} disconnected`);
  });
});

// --- Start ---
const PORT = process.env.PORT || 3001;

initDb().then(() => {
  httpServer.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize DB:', err);
  process.exit(1);
});
