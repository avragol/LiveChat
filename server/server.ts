// server.ts
import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: [
      'http://localhost:5173',
      'https://livechat-0im1.onrender.com'
    ],
    methods: ['GET', 'POST']
  }
});

// Types
interface User {
  id: string;
  username: string;
  room: string;
}

interface Message {
  id: string;
  username: string;
  text: string;
  room: string;
  timestamp: number;
}

interface JoinRoomData {
  username: string;
  room: string;
}

// Constants
const MAX_MESSAGE_LENGTH = 500;
const MAX_ROOMS = 50;
const RATE_LIMIT_WINDOW_MS = 5000; // 5 seconds
const RATE_LIMIT_MAX_MESSAGES = 5; // max 5 messages per 5 seconds

// In-memory storage
const users = new Map<string, User>();
const messages = new Map<string, Message[]>();
const rooms = new Set<string>(['General']);

// Rate limiting: socket.id -> { count, windowStart }
const rateLimits = new Map<string, { count: number; windowStart: number }>();

// Helper functions
const getUsersInRoom = (room: string): User[] => {
  return Array.from(users.values()).filter(user => user.room === room);
};

const getRoomMessages = (room: string): Message[] => {
  return messages.get(room) || [];
};

const addMessage = (message: Message): void => {
  const roomMessages = messages.get(message.room) || [];
  roomMessages.push(message);
  messages.set(message.room, roomMessages);
};

const updateRoomList = (): void => {
  io.emit('room-list-update', Array.from(rooms));
};

// Rate limit check: returns true if allowed, false if blocked
const checkRateLimit = (socketId: string): boolean => {
  const now = Date.now();
  const rl = rateLimits.get(socketId);

  if (!rl || now - rl.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(socketId, { count: 1, windowStart: now });
    return true;
  }

  if (rl.count >= RATE_LIMIT_MAX_MESSAGES) {
    return false;
  }

  rl.count += 1;
  return true;
};

// Socket.IO connection handling
io.on('connection', (socket: Socket) => {
  console.log('User connected:', socket.id);

  socket.emit('room-list-update', Array.from(rooms));

  socket.on('join_room', ({ username, room }: JoinRoomData) => {
    // Basic input validation
    if (!username || !room || username.trim() === '' || room.trim() === '') return;

    // TODO: Validate Google ID token here for proper server-side authentication.
    // The client sends the Google OAuth token — verify it using Google's tokeninfo endpoint
    // or the google-auth-library package before trusting the username.
    // Example: const ticket = await googleAuthClient.verifyIdToken({ idToken, audience: CLIENT_ID });

    const previousUser = users.get(socket.id);
    if (previousUser) {
      socket.leave(previousUser.room);
      io.to(previousUser.room).emit('user_left', {
        username: previousUser.username,
        users: getUsersInRoom(previousUser.room)
      });
    }

    socket.join(room);

    const user: User = { id: socket.id, username: username.trim(), room };
    users.set(socket.id, user);

    socket.emit('previous_messages', getRoomMessages(room));

    io.to(room).emit('user_joined', {
      username: username.trim(),
      users: getUsersInRoom(room)
    });

    console.log(`${username} joined room: ${room}`);
  });

  socket.on('send_message', (text: string) => {
    const user = users.get(socket.id);
    if (!user) return;

    // Rate limiting
    if (!checkRateLimit(socket.id)) {
      socket.emit('rate-limit-error', 'You are sending messages too fast. Please slow down.');
      return;
    }

    // Validate and sanitize message
    if (typeof text !== 'string' || text.trim() === '') return;
    const sanitizedText = text.trim().slice(0, MAX_MESSAGE_LENGTH);

    const message: Message = {
      id: `${Date.now()}-${socket.id}`,
      username: user.username,
      text: sanitizedText,
      room: user.room,
      timestamp: Date.now()
    };

    addMessage(message);
    io.to(user.room).emit('new_message', message);
  });

  socket.on('typing', (isTyping: boolean) => {
    const user = users.get(socket.id);
    if (!user) return;

    socket.to(user.room).emit('user_typing', {
      username: user.username,
      isTyping
    });
  });

  socket.on('create-room', (roomName: string) => {
    if (!roomName || roomName.trim() === '') {
      socket.emit('room-creation-error', 'Room name cannot be empty');
      return;
    }

    const trimmedRoomName = roomName.trim();

    if (rooms.has(trimmedRoomName)) {
      socket.emit('room-creation-error', 'Room already exists');
      return;
    }

    if (rooms.size >= MAX_ROOMS) {
      socket.emit('room-creation-error', `Maximum number of rooms (${MAX_ROOMS}) reached`);
      return;
    }

    rooms.add(trimmedRoomName);
    console.log(`New room created: ${trimmedRoomName}`);
    updateRoomList();
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      socket.leave(user.room);
      users.delete(socket.id);
      rateLimits.delete(socket.id);

      io.to(user.room).emit('user_left', {
        username: user.username,
        users: getUsersInRoom(user.room)
      });

      console.log(`${user.username} disconnected from ${user.room}`);
    }
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
