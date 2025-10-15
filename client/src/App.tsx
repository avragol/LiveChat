import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { GoogleOAuthProvider } from '@react-oauth/google';
import GoogleAuth from './GoogleAuth';

const SOCKET_URL = 'http://localhost:3001';

const ROOMS = [
  { id: 'general', name: 'General', emoji: '💬' },
  { id: 'tech', name: 'Technology', emoji: '💻' },
  { id: 'random', name: 'Random', emoji: '🎲' },
  { id: 'gaming', name: 'Gaming', emoji: '🎮' }
];

interface GoogleUser {
  name: string;
  email: string;
  picture: string;
}

export default function ChatApp() {
  const [socket, setSocket] = useState<any>(null);
  const [username, setUsername] = useState('');
  const [currentRoom, setCurrentRoom] = useState('');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [googleUser, setGoogleUser] = useState<GoogleUser | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [messageInput, setMessageInput] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const newSocket = io(SOCKET_URL);

    newSocket.on('connect', () => setIsConnected(true));
    newSocket.on('disconnect', () => setIsConnected(false));
    newSocket.on('previous_messages', (msgs: any[]) => setMessages(msgs));
    newSocket.on('new_message', (msg: any) => setMessages(prev => [...prev, msg]));

    newSocket.on('user_joined', ({ username: joinedUser, users: updatedUsers }: any) => {
      setUsers(updatedUsers);
      setMessages(prev => [...prev, {
        id: `system-${Date.now()}`,
        username: 'System',
        text: `${joinedUser} joined the room`,
        timestamp: Date.now()
      }]);
    });

    newSocket.on('user_left', ({ username: leftUser, users: updatedUsers }: any) => {
      setUsers(updatedUsers);
      setMessages(prev => [...prev, {
        id: `system-${Date.now()}`,
        username: 'System',
        text: `${leftUser} left the room`,
        timestamp: Date.now()
      }]);
    });

    newSocket.on('user_typing', ({ username: typingUser, isTyping }: any) => {
      if (isTyping) {
        setTypingUsers(prev => [...new Set([...prev, typingUser])]);
      } else {
        setTypingUsers(prev => prev.filter(u => u !== typingUser));
      }
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
      socket.emit('send_message', messageInput.trim());
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
    setMessageInput(e.target.value);
    if (!socket) return;

    socket.emit('typing', true);
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
    typingTimeoutRef.current = window.setTimeout(() => {
      socket.emit('typing', false);
    }, 1000);
  };

  const switchRoom = (roomId: string) => {
    if (socket && roomId !== currentRoom) {
      setCurrentRoom(roomId);
      socket.emit('join_room', { username, room: roomId });
      setMessages([]);
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
    // מעבר ישר לחדר הראשון אחרי ההתחברות
    setCurrentRoom('general');
  };

  const handleGoogleError = () => {
    alert('Failed to sign in with Google. Please try again.');
  };

  const handleLogout = () => {
    const confirmLogout = window.confirm('Are you sure you want to logout? You will be disconnected from the chat.');

    if (!confirmLogout) {
      return;
    }

    // יציאה מהחדר אם מחובר
    if (socket && currentRoom && username) {
      socket.emit('leave_room');
    }

    // איפוס כל המצבים
    setIsAuthenticated(false);
    setGoogleUser(null);
    setUsername('');
    setCurrentRoom('');
    setMessages([]);
    setUsers([]);
    setTypingUsers([]);
    setMessageInput('');

    // לא סוגרים את הsocket - נשאיר אותו מחובר לחיבור הבא
  };

  if (!isAuthenticated) {
    return (
      <GoogleOAuthProvider clientId={(import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || ''}>
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

  const currentRoomData = ROOMS.find(r => r.id === currentRoom) || ROOMS[0];

  return (
    <div className="chat-container">
      <div className="sidebar">
        <div className="sidebar-header">
          <h2 className="sidebar-title">Rooms</h2>
        </div>

        <div className="rooms-list">
          {ROOMS.map(room => (
            <button
              key={room.id}
              onClick={() => switchRoom(room.id)}
              className={`room-item ${currentRoom === room.id ? 'active' : ''}`}
            >
              <span className="room-emoji">{room.emoji}</span>
              <span className="room-name">{room.name}</span>
            </button>
          ))}
        </div>

        <div className="users-section">
          <div className="users-title">Online users: {users.length}</div>
          <div>
            {users.map((user: any) => (
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
            <span className="room-emoji">{currentRoomData?.emoji}</span>
            <div>
              <h1 className="room-title">{currentRoomData?.name}</h1>
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
          {messages.map((msg: any) => (
            <div
              key={msg.id}
              className={`message ${msg.username === 'System' ? 'system' : ''}`}
            >
              {msg.username === 'System' ? (
                <div className="system-message">
                  {msg.text}
                </div>
              ) : (
                <div className={`message-bubble ${msg.username === username ? 'own' : 'other'}`}>
                  {msg.username !== username && (
                    <div className="message-sender">{msg.username}</div>
                  )}
                  <div className="message-text">{msg.text}</div>
                  <div className="message-time">
                    {formatTime(msg.timestamp)}
                  </div>
                </div>
              )}
            </div>
          ))}
          {typingUsers.length > 0 && (
            <div className="typing-indicator">
              {typingUsers.join(', ')} is typing...
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="message-input-container">
          <input
            type="text"
            value={messageInput}
            onChange={handleTyping}
            onKeyPress={handleKeyPress}
            className="message-input"
            placeholder="Type a message..."
          />
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