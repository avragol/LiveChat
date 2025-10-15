// types.ts - shared between client and server
export interface User {
  id: string;
  username: string;
  room: string;
}

export interface Message {
  id: string;
  username: string;
  text: string;
  room: string;
  timestamp: number;
}

export interface JoinRoomData {
  username: string;
  room: string;
}

export interface UserJoinedData {
  username: string;
  users: User[];
}

export interface UserLeftData {
  username: string;
  users: User[];
}

export interface TypingData {
  username: string;
  isTyping: boolean;
}

// Available rooms
export const ROOMS = [
  { id: 'general', name: 'כללי', emoji: '💬' },
  { id: 'tech', name: 'טכנולוגיה', emoji: '💻' },
  { id: 'random', name: 'אקראי', emoji: '🎲' },
  { id: 'gaming', name: 'גיימינג', emoji: '🎮' }
] as const;

export type RoomId = typeof ROOMS[number]['id'];