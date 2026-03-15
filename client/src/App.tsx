import React, { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { GoogleOAuthProvider } from '@react-oauth/google';
import GoogleAuth from './GoogleAuth';
import { Message, User, UserJoinedData, UserLeftData, TypingData } from './types';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001';
const MAX_MESSAGE_LENGTH = 500;

interface GoogleUser {
  name: string;
  email: string;
  picture: string;
}

export default function ChatApp() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [username, setUsername] = useState('');
  const [currentRoom, setCurrentRoom] = useState('');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [googleUser, setGoogleUser] = useState<GoogleUser | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [messageInput, setMessageInput] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [rooms, setRooms] = useState<string[]>([]);
  const [newRoomName, setNewRoomName] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const newSocket = io(SOCKET_URL);

    newSocket.on('connect', () => setIsConnected(true));
    newSocket.on('disconnect', () => setIsConnected(false));
    newSocket.on('previous_messages', (msgs: Message[]) => setMessages(msgs));
    newSocket.on('new_message', (msg: Message) => setMessages(prev => [...prev, msg]));

    newSocket.on('user_joined', ({ username: joinedUser, users: updatedUsers }: UserJoinedData) => {
      setUsers(updatedUsers);
      setMessages(prev => [...prev, {
        id: `system-${Date.now()}`,
        username: 'System',
        text: `${joinedUser} joined the room`,
        room: currentRoom,
        timestamp: Date.now()
      }]);
    });

    newSocket.on('user_left', ({ username: leftUser, users: updatedUsers }: UserLeftData) => {
      setUsers(updatedUsers);
      setMessages(prev => [...prev, {
        id: `system-${Date.now()}`,
        username: 'System',
        text: `${leftUser} left the room`,
        room: currentRoom,
        timestamp: Date.now()
      }]);
    });

    newSocket.on('user_typing', ({ username: typingUser, isTyping }: TypingData) => {
      if (isTyping) {
        setTypingUsers(prev => [...new Set([...prev, typingUser])]);
      } else {
        setTypingUsers(prev => prev.filter(u => u !== typingUser));
      }
    });

    newSocket.on('room-list-update', (updatedRooms: string[]) => {
      setRooms(updatedRooms);
    });

    newSocket.on('room-creation-error', (error: string) => {
      alert(error);
    });

    setSocket(newSocket);

    return () => {
      newSocket.close();
    };
  }, []);

  // התחברות אוטומטית לחדר כשמתחברים
  useEffect(() => {
    if (socket && isAuthenticated && currentRoom && username) {
      socket.emit('join_room', { username: username.trim(), room: currentRoom });
    }
  }, [socket, isAuthenticated, currentRoom, username]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSendMessage = () => {
    if (messageInput.trim() && socket) {
      const trimmed = messageInput.trim().slice(0, MAX_MESSAGE_LENGTH);
      socket.emit('send_message', trimmed);
      setMessageInput('');
      socket.emit('typing', false);
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleTyping = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.slice(0, MAX_MESSAGE_LENGTH);
    setMessageInput(value);
    if (!socket) return;

    socket.emit('typing', true);
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
    typingTimeoutRef.current = window.setTimeout(() => {
      socket.emit('typing', false);
    }, 1000);
  };

  const switchRoom = (roomName: string) => {
    if (socket && roomName !== currentRoom) {
      setCurrentRoom(roomName);
      socket.emit('join_room', { username, room: roomName });
      setMessages([]);
    }
  };

  const handleCreateRoom = () => {
    if (socket && newRoomName.trim()) {
      socket.emit('create-room', newRoomName.trim());
      setNewRoomName('');
    }
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  };

  // Google Auth Handlers
  const handleGoogleSuccess = (user: GoogleUser) => {
    setGoogleUser(user);
    setUsername(user.name);
    setIsAuthenticated(true);
    setCurrentRoom('General');
  };

  const handleGoogleError = () => {
    alert('Failed to sign in with Google. Please try again.');
  };

  const handleLogout = () => {
    const confirmLogout = window.confirm('Are you sure you want to logout? You will be disconnected from the chat.');
    if (!confirmLogout) return;

    if (socket && currentRoom && username) {
      socket.emit('leave_room');
    }

    setIsAuthenticated(false);
    setGoogleUser(null);
    setUsername('');
    setCurrentRoom('');
    setMessages([]);
    setUsers([]);
    setTypingUsers([]);
    setMessageInput('');
  };

  if (!isAuthenticated) {
    return (
      <GoogleOAuthProvider clientId={import.meta.env.VITE_GOOGLE_CLIENT_ID || ''}>
        <div className="login-container">
          <div className="login-card">
            <h1 className="login-title">Real-Time Chat</h1>
            <GoogleAuth
              onSuccess={handleGoogleSuccess}
              onError={handleGoogleError}
            />
          </div>
        </div>
      </GoogleOAuthProvider>
    );
  }

  return (
    <div className="chat-container">
      <div className="sidebar">
        <div className="sidebar-header">
          <h2 className="sidebar-title">Rooms</h2>
        </div>

        <div className="create-room-section">
          <input
            type="text"
            value={newRoomName}
            onChange={(e) => setNewRoomName(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleCreateRoom()}
            className="create-room-input"
            placeholder="New room name..."
          />
          <button
            onClick={handleCreateRoom}
            disabled={!newRoomName.trim()}
            className="create-room-button"
          >
            ➕ Create
          </button>
        </div>

        <div className="rooms-list">
          {rooms.map(room => (
            <button
              key={room}
              onClick={() => switchRoom(room)}
              className={`room-item ${currentRoom === room ? 'active' : ''}`}
            >
              <span className="room-emoji">{room === 'General' ? '💬' : '📁'}</span>
              <span className="room-name">{room}</span>
            </button>
          ))}
        </div>

        <div className="users-section">
          <div className="users-title">Online users: {users.length}</div>
          <div>
            {users.map((user: User) => (
              <div key={user.id} className="user-item">
                <div className="status-dot" />
                <span>{user.username}</span>
              </div>
            ))}
          </div>
        </div>

        {googleUser && (
          <div className="sidebar-footer">
            <div className="current-user-profile">
              <img
                src={googleUser.picture}
                alt={googleUser.name}
                className="current-user-avatar"
              />
              <div className="current-user-info">
                <div className="current-user-name">{googleUser.name}</div>
                <div className="current-user-email">{googleUser.email}</div>
              </div>
              <button
                onClick={handleLogout}
                className="logout-button-small"
                title="Logout"
              >
                🚪
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="main-chat">
        <div className="chat-header">
          <div className="header-info">
            <span className="room-emoji">{currentRoom === 'General' ? '💬' : '📁'}</span>
            <div>
              <h1 className="room-title">{currentRoom}</h1>
              <p className="username">@{username}</p>
            </div>
          </div>
          <div className="header-actions">
            <div className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
              <div className={`status-dot ${!isConnected ? 'disconnected' : ''}`} />
              <span>{isConnected ? 'Connected' : 'Disconnected'}</span>
            </div>
            <button
              onClick={handleLogout}
              className="logout-button-header"
              title="Logout"
            >
              🚪
            </button>
          </div>
        </div>

        <div className="messages-area">
          {messages.map((msg: Message) => (
            <div
              key={msg.id}
              className={`message ${msg.username === 'System' ? 'system' : ''}`}
            >
              {msg.username === 'System' ? (
                <div className="system-message">{msg.text}</div>
              ) : (
                <div className={`message-bubble ${msg.username === username ? 'own' : 'other'}`}>
                  {msg.username !== username && (
                    <div className="message-sender">{msg.username}</div>
                  )}
                  <div className="message-text">{msg.text}</div>
                  <div className="message-time">{formatTime(msg.timestamp)}</div>
                </div>
              )}
            </div>
          ))}
          {typingUsers.length > 0 && (
            <div className="typing-indicator">
              {typingUsers.join(', ')} {typingUsers.length === 1 ? 'is' : 'are'} typing...
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="message-input-area">
          <input
            type="text"
            value={messageInput}
            onChange={handleTyping}
            onKeyPress={handleKeyPress}
            className="message-input"
            placeholder="Type a message..."
            maxLength={MAX_MESSAGE_LENGTH}
          />
          <div className="char-counter">{messageInput.length}/{MAX_MESSAGE_LENGTH}</div>
          <button
            onClick={handleSendMessage}
            disabled={!messageInput.trim()}
            className="send-button"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
