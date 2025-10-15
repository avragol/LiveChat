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
      'http://localhost:5173', // Vite default port
      'https://livechat-0im1.onrender.com/' // Added Render address
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

// In-memory storage
const users = new Map<string, User>();
const messages = new Map<string, Message[]>(); // room -> messages
const rooms = new Set<string>(['General']); // Start with General as default room

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

// Broadcast room list to all clients
const updateRoomList = (): void => {
  io.emit('room-list-update', Array.from(rooms));
};

// Socket.IO connection handling
io.on('connection', (socket: Socket) => {
  console.log('User connected:', socket.id);

  // Send current room list to newly connected client
  socket.emit('room-list-update', Array.from(rooms));

  // Join room
  socket.on('join_room', ({ username, room }: JoinRoomData) => {
    // Leave previous room if exists
    const previousUser = users.get(socket.id);
    if (previousUser) {
      socket.leave(previousUser.room);
      io.to(previousUser.room).emit('user_left', {
        username: previousUser.username,
        users: getUsersInRoom(previousUser.room)
      });
    }

    // Join new room
    socket.join(room);

    const user: User = {
      id: socket.id,
      username,
      room
    };
    users.set(socket.id, user);

    // Send previous messages to the user
    socket.emit('previous_messages', getRoomMessages(room));

    // Notify room about new user
    io.to(room).emit('user_joined', {
      username,
      users: getUsersInRoom(room)
    });

    console.log(`${username} joined room: ${room}`);
  });

  // Handle messages
  socket.on('send_message', (text: string) => {
    const user = users.get(socket.id);
    if (!user) return;

    const message: Message = {
      id: `${Date.now()}-${socket.id}`,
      username: user.username,
      text,
      room: user.room,
      timestamp: Date.now()
    };

    addMessage(message);
    io.to(user.room).emit('new_message', message);
  });

  // Handle typing indicator
  socket.on('typing', (isTyping: boolean) => {
    const user = users.get(socket.id);
    if (!user) return;

    socket.to(user.room).emit('user_typing', {
      username: user.username,
      isTyping
    });
  });

  // Handle room creation
  socket.on('create-room', (roomName: string) => {
    // Validate room name
    if (!roomName || roomName.trim() === '') {
      socket.emit('room-creation-error', 'Room name cannot be empty');
      return;
    }

    const trimmedRoomName = roomName.trim();

    // Check if room already exists
    if (rooms.has(trimmedRoomName)) {
      socket.emit('room-creation-error', 'Room already exists');
      return;
    }

    // Add new room
    rooms.add(trimmedRoomName);
    console.log(`New room created: ${trimmedRoomName}`);

    // Broadcast updated room list to all clients
    updateRoomList();
  });

  // Disconnect
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      socket.leave(user.room);
      users.delete(socket.id);

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

