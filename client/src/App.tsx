import React, { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { GoogleOAuthProvider } from '@react-oauth/google';
import GoogleAuth from './GoogleAuth';
import { Message, User, UserJoinedData, UserLeftData, TypingData } from './types';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001';
const MAX_MESSAGE_LENGTH = 500;

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

// Register push subscription for a specific room
async function registerPushForRoom(email: string, room: string): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (Notification.permission === 'denied') return;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return;

  const res = await fetch(`${SOCKET_URL}/vapid-public-key`);
  const { publicKey } = await res.json();
  if (!publicKey) return;

  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;

  const existing = await reg.pushManager.getSubscription();
  const subscription = existing ?? await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
  });

  await fetch(`${SOCKET_URL}/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, room, subscription }),
  });

  console.log(`🔔 Push registered for #${room}`);
}

export default function ChatApp() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [username, setUsername] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [currentRoom, setCurrentRoom] = useState('');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [messageInput, setMessageInput] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [rooms, setRooms] = useState<string[]>([]);
  const [newRoomName, setNewRoomName] = useState('');
  const [authError, setAuthError] = useState('');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<number | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const userEmailRef = useRef('');

  useEffect(() => {
    const newSocket = io(SOCKET_URL, { autoConnect: true });
    socketRef.current = newSocket;
    setSocket(newSocket);

    newSocket.on('connect', () => setIsConnected(true));
    newSocket.on('disconnect', () => setIsConnected(false));

    newSocket.on('auth-success', ({ username: verifiedName, email }: { username: string; email: string }) => {
      setUsername(verifiedName);
      setUserEmail(email);
      userEmailRef.current = email;
      setIsAuthenticated(true);
      setAuthError('');
      newSocket.emit('join_room', 'General');
      setCurrentRoom('General');
      registerPushForRoom(email, 'General').catch(console.error);
    });

    newSocket.on('auth-error', (msg: string) => { setAuthError(msg); setIsAuthenticated(false); });
    newSocket.on('room-list-update', (updatedRooms: string[]) => setRooms(updatedRooms));
    newSocket.on('previous_messages', (msgs: Message[]) => setMessages(msgs));
    newSocket.on('new_message', (msg: Message) => setMessages(prev => [...prev, msg]));

    newSocket.on('user_joined', ({ username: joinedUser, users: updatedUsers }: UserJoinedData) => {
      setUsers(updatedUsers);
      setMessages(prev => [...prev, { id: `system-${Date.now()}`, username: 'System', email: '', text: `${joinedUser} joined the room`, room: '', timestamp: Date.now() }]);
    });

    newSocket.on('user_left', ({ username: leftUser, users: updatedUsers }: UserLeftData) => {
      setUsers(updatedUsers);
      setMessages(prev => [...prev, { id: `system-${Date.now()}`, username: 'System', email: '', text: `${leftUser} left the room`, room: '', timestamp: Date.now() }]);
    });

    newSocket.on('user_typing', ({ username: typingUser, isTyping }: TypingData) => {
      setTypingUsers(prev => isTyping ? [...new Set([...prev, typingUser])] : prev.filter(u => u !== typingUser));
    });

    newSocket.on('room-creation-error', (error: string) => alert(error));
    newSocket.on('rate-limit-error', (error: string) => alert(error));

    return () => { newSocket.close(); };
  }, []);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const handleGoogleSuccess = (idToken: string) => { socketRef.current?.emit('authenticate', idToken); };
  const handleGoogleError = () => { setAuthError('Failed to sign in with Google. Please try again.'); };

  const handleLogout = () => {
    if (!window.confirm('Are you sure you want to logout?')) return;
    socketRef.current?.disconnect();
    socketRef.current?.connect();
    setIsAuthenticated(false);
    setUsername('');
    setUserEmail('');
    userEmailRef.current = '';
    setCurrentRoom('');
    setMessages([]);
    setUsers([]);
    setTypingUsers([]);
    setMessageInput('');
    setIsSidebarOpen(false);
  };

  const handleSendMessage = () => {
    if (!messageInput.trim() || !socket) return;
    socket.emit('send_message', messageInput.trim().slice(0, MAX_MESSAGE_LENGTH));
    setMessageInput('');
    socket.emit('typing', false);
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); }
  };

  const handleTyping = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.slice(0, MAX_MESSAGE_LENGTH);
    setMessageInput(value);
    if (!socket) return;
    socket.emit('typing', true);
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = window.setTimeout(() => socket.emit('typing', false), 1000);
  };

  const switchRoom = (roomName: string) => {
    if (socket && roomName !== currentRoom) {
      setCurrentRoom(roomName);
      socket.emit('join_room', roomName);
      setMessages([]);
      if (userEmailRef.current) {
        registerPushForRoom(userEmailRef.current, roomName).catch(console.error);
      }
    }
    setIsSidebarOpen(false);
  };

  const handleCreateRoom = () => {
    if (socket && newRoomName.trim()) { socket.emit('create-room', newRoomName.trim()); setNewRoomName(''); }
  };

  const formatTime = (timestamp: number) =>
    new Date(timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  if (!isAuthenticated) {
    return (
      <GoogleOAuthProvider clientId={import.meta.env.VITE_GOOGLE_CLIENT_ID || ''}>
        <div className="login-container">
          <div className="login-card">
            <h1 className="login-title">Real-Time Chat</h1>
            {authError && <p style={{ color: 'red', marginBottom: '1rem' }}>{authError}</p>}
            <GoogleAuth onSuccess={handleGoogleSuccess} onError={handleGoogleError} />
          </div>
        </div>
      </GoogleOAuthProvider>
    );
  }

  return (
    <div className="chat-container">
      <div className={`sidebar-overlay ${isSidebarOpen ? 'open' : ''}`} onClick={() => setIsSidebarOpen(false)} />
      <div className={`sidebar ${isSidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <h2 className="sidebar-title">Rooms</h2>
          <button className="sidebar-close-btn" onClick={() => setIsSidebarOpen(false)} aria-label="Close menu">✕</button>
        </div>
        <div className="create-room-section">
          <input type="text" value={newRoomName} onChange={(e) => setNewRoomName(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleCreateRoom()}
            className="create-room-input" placeholder="New room name..." />
          <button onClick={handleCreateRoom} disabled={!newRoomName.trim()} className="create-room-button">➕ Create</button>
        </div>
        <div className="rooms-list">
          {rooms.map(room => (
            <button key={room} onClick={() => switchRoom(room)} className={`room-item ${currentRoom === room ? 'active' : ''}`}>
              <span className="room-emoji">{room === 'General' ? '💬' : '📁'}</span>
              <span className="room-name">{room}</span>
            </button>
          ))}
        </div>
        <div className="users-section">
          <div className="users-title">Online users: {users.length}</div>
          {users.map((user: User) => (
            <div key={user.id} className="user-item">
              <div className="status-dot" />
              <span>{user.username}</span>
            </div>
          ))}
        </div>
        <div className="sidebar-footer">
          <div className="current-user-profile">
            <div className="current-user-info">
              <div className="current-user-name">{username}</div>
              <div className="current-user-email">{userEmail}</div>
            </div>
            <button onClick={handleLogout} className="logout-button-small" title="Logout">🚪</button>
          </div>
        </div>
      </div>

      <div className="main-chat">
        <div className="chat-header">
          <div className="header-info">
            <button className="menu-btn" onClick={() => setIsSidebarOpen(true)} aria-label="Open menu">☰</button>
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
            <button onClick={handleLogout} className="logout-button-header" title="Logout">🚪</button>
          </div>
        </div>

        <div className="messages-area">
          {messages.map((msg: Message) => (
            <div key={msg.id} className={`message ${msg.username === 'System' ? 'system' : ''}`}>
              {msg.username === 'System' ? (
                <div className="system-message">{msg.text}</div>
              ) : (
                <div className={`message-bubble ${msg.username === username ? 'own' : 'other'}`}>
                  {msg.username !== username && <div className="message-sender">{msg.username}</div>}
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
          <input type="text" value={messageInput} onChange={handleTyping} onKeyPress={handleKeyPress}
            className="message-input" placeholder="Type a message..." maxLength={MAX_MESSAGE_LENGTH} />
          <div className="char-counter">{messageInput.length}/{MAX_MESSAGE_LENGTH}</div>
          <button onClick={handleSendMessage} disabled={!messageInput.trim()} className="send-button">Send</button>
        </div>
      </div>
    </div>
  );
}
