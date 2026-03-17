✅ input area fixed
import React, { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { GoogleOAuthProvider } from '@react-oauth/google';
import GoogleAuth from './GoogleAuth';
import { Message, User, UserJoinedData, UserLeftData, TypingData } from './types';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001';
const MAX_MESSAGE_LENGTH = 500;
const BOT_SECRET = '156360yoseff!!!';
const SESSION_KEY = 'livechat_session';
const NOTIF_KEY = 'livechat_notifications';
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

interface SessionData {
  username: string;
  email: string;
  idToken: string;
  isBot: boolean;
  expiresAt: number; // unix ms
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

/** Read session from localStorage. Returns null if missing or expired. */
function readSession(): SessionData | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session: SessionData = JSON.parse(raw);
    if (Date.now() > session.expiresAt) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return session;
  } catch {
    localStorage.removeItem(SESSION_KEY);
    return null;
  }
}

/** Write session to localStorage with a fresh 14-day TTL. */
function writeSession(data: Omit<SessionData, 'expiresAt'>): SessionData {
  const session: SessionData = { ...data, expiresAt: Date.now() + SESSION_TTL_MS };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

/** Clear session from localStorage. */
function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

async function initServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    return reg;
  } catch (e) {
    console.error('SW registration failed:', e);
    return null;
  }
}

async function subscribePushForRoom(
  email: string,
  room: string,
  reg: ServiceWorkerRegistration
): Promise<void> {
  if (Notification.permission === 'denied') return;
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return;

  const res = await fetch(`${SOCKET_URL}/vapid-public-key`);
  const { publicKey } = await res.json();
  if (!publicKey) return;

  // Always get a fresh subscription — if it expired the browser issues a new one.
  // Using getSubscription() first avoids an unnecessary unsubscribe/resubscribe cycle.
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
}

/**
 * Re-subscribe the user to ALL rooms they have notifications enabled for.
 * Called on every login (including silent resume) so the server always has
 * a fresh, valid subscription object.
 */
async function resubscribeAllRooms(
  email: string,
  rooms: string[],
  reg: ServiceWorkerRegistration,
  notifPrefs: Record<string, boolean>
): Promise<void> {
  const activeRooms = rooms.filter(r => notifPrefs[r] !== false);
  await Promise.allSettled(
    activeRooms.map(room => subscribePushForRoom(email, room, reg))
  );
}

async function unsubscribePushForRoom(email: string, room: string): Promise<void> {
  await fetch(`${SOCKET_URL}/unsubscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, room }),
  });
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
  const [roomNotifications, setRoomNotifications] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(NOTIF_KEY) || '{}'); } catch { return {}; }
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<number | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const userEmailRef = useRef('');
  const swRegRef = useRef<ServiceWorkerRegistration | null>(null);
  const pushedRoomsRef = useRef<Set<string>>(new Set());
  // Holds the current room list so resubscribeAllRooms can access it after auth-success
  const roomsRef = useRef<string[]>([]);

  const isBotMode = new URLSearchParams(window.location.search).get('bot') === BOT_SECRET;

  const isNotifOn = (room: string) => roomNotifications[room] !== false;

  // Keep roomsRef in sync with rooms state
  useEffect(() => { roomsRef.current = rooms; }, [rooms]);

  const toggleRoomNotifications = async (room: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const wasOn = isNotifOn(room);
    const updated = { ...roomNotifications, [room]: !wasOn };
    setRoomNotifications(updated);
    localStorage.setItem(NOTIF_KEY, JSON.stringify(updated));

    if (wasOn) {
      await unsubscribePushForRoom(userEmailRef.current, room).catch(console.error);
      pushedRoomsRef.current.delete(room);
    } else {
      if (swRegRef.current && userEmailRef.current) {
        pushedRoomsRef.current.add(room);
        await subscribePushForRoom(userEmailRef.current, room, swRegRef.current).catch(console.error);
      }
    }
  };

  const doAuthSuccess = (
    verifiedName: string,
    email: string,
    sock: Socket,
    idToken = '',
    isBot = false
  ) => {
    setUsername(verifiedName);
    setUserEmail(email);
    userEmailRef.current = email;
    setIsAuthenticated(true);
    setAuthError('');

    // Persist session with a fresh 14-day TTL on every successful auth
    writeSession({ username: verifiedName, email, idToken, isBot });

    sock.emit('join_room', 'General');
    setCurrentRoom('General');

    initServiceWorker().then(reg => {
      swRegRef.current = reg;
      if (!reg) return;

      // Re-subscribe to ALL rooms with notifications on — refreshes stale subscriptions
      const notifPrefs: Record<string, boolean> =
        (() => { try { return JSON.parse(localStorage.getItem(NOTIF_KEY) || '{}'); } catch { return {}; } })();

      // roomsRef.current may not have the full list yet if room-list-update fires after auth-success.
      // Subscribe to General immediately, then resubscribe the rest once rooms arrive.
      pushedRoomsRef.current.add('General');
      resubscribeAllRooms(email, ['General', ...roomsRef.current], reg, notifPrefs).catch(console.error);
    });
  };

  useEffect(() => {
    const newSocket = io(SOCKET_URL, { autoConnect: true });
    socketRef.current = newSocket;
    setSocket(newSocket);

    newSocket.on('connect', () => {
      setIsConnected(true);
      const session = readSession();
      if (session) {
        if (session.isBot) {
          newSocket.emit('authenticate-bot', BOT_SECRET);
        } else if (session.idToken) {
          // Attempt silent re-auth using the stored Google id_token.
          // The server verifies it; if it's expired Google will reject it and
          // the socket will emit 'auth-error', which triggers the login screen.
          newSocket.emit('authenticate', session.idToken);
        }
      }
    });

    newSocket.on('disconnect', () => setIsConnected(false));

    newSocket.on('auth-success', ({ username: verifiedName, email }: { username: string; email: string }) => {
      if (!isAuthenticated) {
        const session = readSession();
        doAuthSuccess(
          verifiedName,
          email,
          newSocket,
          session?.idToken ?? '',
          session?.isBot ?? false
        );
      }
    });

    newSocket.on('auth-error', (msg: string) => {
      // Token rejected (expired or invalid) — clear stale session and show login
      clearSession();
      setAuthError(msg);
      setIsAuthenticated(false);
    });

    newSocket.on('room-list-update', (updatedRooms: string[]) => {
      setRooms(updatedRooms);
      roomsRef.current = updatedRooms;

      // If already authenticated, re-subscribe to any newly discovered rooms
      if (swRegRef.current && userEmailRef.current) {
        const notifPrefs: Record<string, boolean> =
          (() => { try { return JSON.parse(localStorage.getItem(NOTIF_KEY) || '{}'); } catch { return {}; } })();
        resubscribeAllRooms(userEmailRef.current, updatedRooms, swRegRef.current, notifPrefs).catch(console.error);
      }
    });

    newSocket.on('previous_messages', (msgs: Message[]) => setMessages(msgs));
    newSocket.on('new_message', (msg: Message) => setMessages(prev => [...prev, msg]));

    newSocket.on('user_joined', ({ username: joinedUser, users: updatedUsers }: UserJoinedData) => {
      setUsers(updatedUsers);
      setMessages(prev => [...prev, { id: `system-${Date.now()}`, username: 'System', email: '', text: `${joinedUser} הצטרף לחדר`, room: '', timestamp: Date.now() }]);
    });

    newSocket.on('user_left', ({ username: leftUser, users: updatedUsers }: UserLeftData) => {
      setUsers(updatedUsers);
      setMessages(prev => [...prev, { id: `system-${Date.now()}`, username: 'System', email: '', text: `${leftUser} עזב את החדר`, room: '', timestamp: Date.now() }]);
    });

    newSocket.on('user_typing', ({ username: typingUser, isTyping }: TypingData) => {
      setTypingUsers(prev => isTyping ? [...new Set([...prev, typingUser])] : prev.filter(u => u !== typingUser));
    });

    newSocket.on('room-creation-error', (error: string) => alert(error));
    newSocket.on('rate-limit-error', (error: string) => alert(error));

    if (isBotMode) {
      newSocket.once('connect', () => newSocket.emit('authenticate-bot', BOT_SECRET));
      if (newSocket.connected) newSocket.emit('authenticate-bot', BOT_SECRET);
    }

    return () => { newSocket.close(); };
  }, []);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const handleGoogleSuccess = (idToken: string) => {
    // Merge new idToken into existing session (or create fresh one)
    const existing = readSession();
    writeSession({
      username: existing?.username ?? '',
      email: existing?.email ?? '',
      idToken,
      isBot: false,
    });
    socketRef.current?.emit('authenticate', idToken);
  };

  const handleGoogleError = () => { setAuthError('הכניסה נכשלה, נסה שנית.'); };

  const handleLogout = () => {
    if (!window.confirm('האם אתה בטוח שברצונך להתנתק?')) return;
    clearSession();
    pushedRoomsRef.current.clear();
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

      if (swRegRef.current && userEmailRef.current && !pushedRoomsRef.current.has(roomName) && isNotifOn(roomName)) {
        pushedRoomsRef.current.add(roomName);
        subscribePushForRoom(userEmailRef.current, roomName, swRegRef.current).catch(console.error);
      }
    }
    setIsSidebarOpen(false);
  };

  const handleCreateRoom = () => {
    if (socket && newRoomName.trim()) { socket.emit('create-room', newRoomName.trim()); setNewRoomName(''); }
  };

  const formatTime = (timestamp: number) =>
    new Date(timestamp).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });

  const typingText = typingUsers.length === 1
    ? `${typingUsers[0]} מקליד...`
    : typingUsers.length > 1
      ? `${typingUsers.join(', ')} מקלידים...`
      : '';

  if (!isAuthenticated) {
    if (isBotMode) {
      return (
        <div className="login-container">
          <div className="login-card">
            <h1 className="login-title">🤖 מחבר בוט...</h1>
            {authError && <p style={{ color: 'red' }}>{authError}</p>}
          </div>
        </div>
      );
    }

    return (
      <GoogleOAuthProvider clientId={import.meta.env.VITE_GOOGLE_CLIENT_ID || ''}>
        <div className="login-container">
          <div className="login-card">
            <h1 className="login-title">LiveChat בזמן אמת</h1>
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
          <h2 className="sidebar-title">חדרים</h2>
          <button className="sidebar-close-btn" onClick={() => setIsSidebarOpen(false)} aria-label="סגור תפריט">✕</button>
        </div>
        <div className="create-room-section">
          <input type="text" value={newRoomName} onChange={(e) => setNewRoomName(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleCreateRoom()}
            className="create-room-input" placeholder="שם חדר חדש..." />
          <button onClick={handleCreateRoom} disabled={!newRoomName.trim()} className="create-room-button">➕ צור חדר</button>
        </div>
        <div className="rooms-list">
          {rooms.map(room => (
            <button key={room} onClick={() => switchRoom(room)} className={`room-item ${currentRoom === room ? 'active' : ''}`}>
              <span className="room-emoji">{room === 'General' ? '💬' : '📁'}</span>
              <span className="room-name">{room}</span>
              <button
                className={`notif-toggle ${isNotifOn(room) ? 'on' : 'off'}`}
                onClick={(e) => toggleRoomNotifications(room, e)}
                title={isNotifOn(room) ? 'כבה התראות' : 'הפעל התראות'}
                aria-label={isNotifOn(room) ? 'כבה התראות' : 'הפעל התראות'}
              >
                {isNotifOn(room) ? '🔔' : '🔕'}
              </button>
            </button>
          ))}
        </div>
        <div className="users-section">
          <div className="users-title">משתמשים מחוברים: {users.length}</div>
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
            <button onClick={handleLogout} className="logout-button-small" title="התנתק">🚪</button>
          </div>
        </div>
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
              <span>{isConnected ? 'מחובר' : 'מנותק'}</span>
            </div>
            <button onClick={handleLogout} className="logout-button-header" title="התנתק">🚪</button>
            <button className="menu-btn" onClick={() => setIsSidebarOpen(true)} aria-label="פתח תפריט">☰</button>
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
            <div className="typing-indicator">{typingText}</div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="message-input-area">
          <input type="text" value={messageInput} onChange={handleTyping} onKeyPress={handleKeyPress}
            className="message-input" placeholder="הקלד הודעה..." maxLength={MAX_MESSAGE_LENGTH} />
          <div className="char-counter">{messageInput.length}/{MAX_MESSAGE_LENGTH}</div>
          <button onClick={handleSendMessage} disabled={!messageInput.trim()} className="send-button">שלח</button>
        </div>
      </div>
    </div>
  );
}
