import React, { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { GoogleOAuthProvider } from '@react-oauth/google';
import GoogleAuth from './GoogleAuth';
import { Message, User, UserJoinedData, TypingData } from './types';

// ── User color helper (Issue #25) ────────────────────────────────────────────
// Deterministic color per email — no DB storage needed.
const USER_COLORS = [
  '#e53e3e', '#dd6b20', '#d69e2e', '#38a169',
  '#319795', '#3182ce', '#805ad5', '#d53f8c',
  '#c05621', '#2b6cb0',
];

function getUserColor(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = (hash * 31 + email.charCodeAt(i)) >>> 0;
  }
  return USER_COLORS[hash % USER_COLORS.length]!;
}


const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001';
const MAX_MESSAGE_LENGTH = 500;
const BOT_SECRET = '156360yoseff!!!';
const SESSION_KEY = 'livechat_session';
const NOTIF_KEY = 'livechat_notifications';
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

interface SessionData {
  username: string;
  email: string;
  sessionToken: string;
  isBot: boolean;
  expiresAt: number;
}

// ── Session helpers ────────────────────────────────────────────────────────────

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

function writeSession(data: Omit<SessionData, 'expiresAt'>): SessionData {
  const session: SessionData = { ...data, expiresAt: Date.now() + SESSION_TTL_MS };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

// ── Push helpers ───────────────────────────────────────────────────────────────

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
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

async function subscribePushForRoom(email: string, room: string, reg: ServiceWorkerRegistration): Promise<void> {
  if (Notification.permission === 'denied') return;
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return;
  const res = await fetch(`${SOCKET_URL}/vapid-public-key`);
  const { publicKey } = await res.json();
  if (!publicKey) return;
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

async function resubscribeAllRooms(email: string, rooms: string[], reg: ServiceWorkerRegistration, notifPrefs: Record<string, boolean>): Promise<void> {
  const activeRooms = rooms.filter(r => notifPrefs[r] !== false);
  await Promise.allSettled(activeRooms.map(room => subscribePushForRoom(email, room, reg)));
}

async function unsubscribePushForRoom(email: string, room: string): Promise<void> {
  await fetch(`${SOCKET_URL}/unsubscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, room }),
  });
}

// ── Message grouping helper (Issue #33) ─────────────────────────────────────

interface MessageGroup {
  key: string;
  email: string;
  username: string;
  messages: Message[];
}

function groupMessages(messages: Message[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (const msg of messages) {
    const last = groups[groups.length - 1];
    if (
      last &&
      last.email === msg.email &&
      msg.timestamp - last.messages[last.messages.length - 1]!.timestamp < 600_000
    ) {
      last.messages.push(msg);
    } else {
      groups.push({ key: msg.id, email: msg.email, username: msg.username, messages: [msg] });
    }
  }
  return groups;
}

// ── Component ─────────────────────────────────────────────────────────────────

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
  const [editingRoom, setEditingRoom] = useState<string | null>(null);
  const [editRoomName, setEditRoomName] = useState('');
  const [isReady, setIsReady] = useState(false);
  const [expandedTimestamps, setExpandedTimestamps] = useState<Set<string>>(new Set());
  const [roomNotifications, setRoomNotifications] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(NOTIF_KEY) || '{}'); } catch { return {}; }
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<number | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const userEmailRef = useRef('');
  const swRegRef = useRef<ServiceWorkerRegistration | null>(null);
  const pushedRoomsRef = useRef<Set<string>>(new Set());
  const roomsRef = useRef<string[]>([]);
  const isAuthenticatedRef = useRef(false);

  const isBotMode = new URLSearchParams(window.location.search).get('bot') === BOT_SECRET;

  const isNotifOn = (room: string) => roomNotifications[room] !== false;

  useEffect(() => { roomsRef.current = rooms; }, [rooms]);
  useEffect(() => { isAuthenticatedRef.current = isAuthenticated; }, [isAuthenticated]);

  // ── Wake-up ping ───────────────────────────────────────────────────────────
  // Sent immediately on app load to wake the Render server before the socket
  // connection or any user action. Fire-and-forget — errors are ignored.

  useEffect(() => {
    fetch(`${SOCKET_URL}/ping`).catch(() => {});
  }, []);

  // ── Auth success handler ───────────────────────────────────────────────────

  const doAuthSuccess = (verifiedName: string, email: string, sock: Socket, sessionToken = '', isBot = false) => {
    setUsername(verifiedName);
    setUserEmail(email);
    userEmailRef.current = email;
    setIsAuthenticated(true);
    setAuthError('');

    if (!isBot) {
      writeSession({ username: verifiedName, email, sessionToken, isBot });
    }

    sock.emit('join_room', 'General');
    setCurrentRoom('General');

    initServiceWorker().then(reg => {
      swRegRef.current = reg;
      if (!reg) return;
      const notifPrefs: Record<string, boolean> =
        (() => { try { return JSON.parse(localStorage.getItem(NOTIF_KEY) || '{}'); } catch { return {}; } })();
      pushedRoomsRef.current.add('General');
      resubscribeAllRooms(email, ['General', ...roomsRef.current], reg, notifPrefs).catch(console.error);
    });
  };

  // ── Socket setup ───────────────────────────────────────────────────────────

  useEffect(() => {
    // autoConnect:false prevents the socket from firing 'connect' before
    // we've had a chance to read the session from localStorage — eliminating
    // the race condition where the connect handler runs with no session yet.
    const newSocket = io(SOCKET_URL, { autoConnect: false });
    socketRef.current = newSocket;
    setSocket(newSocket);

    newSocket.on('connect', () => {
      setIsConnected(true);
      const session = readSession();
      if (session) {
        if (session.isBot) {
          newSocket.emit('authenticate-bot', BOT_SECRET);
        } else if (session.sessionToken) {
          newSocket.emit('authenticate', session.sessionToken);
        }
      }
    });

    newSocket.on('disconnect', () => setIsConnected(false));

    newSocket.on('auth-success', ({ username: verifiedName, email }: { username: string; email: string }) => {
      // Use ref to avoid stale closure — isAuthenticated from the closure would
      // always be the initial `false` value captured at mount time.
      if (!isAuthenticatedRef.current) {
        const session = readSession();
        doAuthSuccess(verifiedName, email, newSocket, session?.sessionToken ?? '', session?.isBot ?? false);
      }
    });

    newSocket.on('auth-error', (msg: string) => {
      // Only wipe the session for definitive token rejections.
      // Transient network errors should not log the user out.
      const isTokenRejection = msg.toLowerCase().includes('expired') || msg.toLowerCase().includes('invalid');
      if (isTokenRejection) {
        clearSession();
        isAuthenticatedRef.current = false;
        setIsAuthenticated(false);
      }
      setAuthError(msg);
    });

    newSocket.on('room-list-update', (updatedRooms: string[]) => {
      setRooms(updatedRooms);
      roomsRef.current = updatedRooms;
      if (swRegRef.current && userEmailRef.current) {
        const notifPrefs: Record<string, boolean> =
          (() => { try { return JSON.parse(localStorage.getItem(NOTIF_KEY) || '{}'); } catch { return {}; } })();
        resubscribeAllRooms(userEmailRef.current, updatedRooms, swRegRef.current, notifPrefs).catch(console.error);
      }
    });

    newSocket.on('room-renamed', ({ oldName, newName }: { oldName: string; newName: string }) => {
      setRooms(prev => prev.map(r => r === oldName ? newName : r));
      roomsRef.current = roomsRef.current.map(r => r === oldName ? newName : r);
      setCurrentRoom(prev => prev === oldName ? newName : prev);
      setMessages(prev => prev.map(m => m.room === oldName ? { ...m, room: newName } : m));
    });

    newSocket.on('previous_messages', (msgs: Message[]) => {
      setMessages(msgs);
      setIsReady(true);
    });
    newSocket.on('new_message', (msg: Message) => setMessages(prev => [...prev, msg]));

    newSocket.on('users-update', ({ users: updatedUsers }: { users: UserJoinedData['users'] }) => {
      setUsers(updatedUsers);
    });

    newSocket.on('user_typing', ({ username: typingUser, isTyping }: TypingData) => {
      setTypingUsers(prev => isTyping ? [...new Set([...prev, typingUser])] : prev.filter(u => u !== typingUser));
    });

    newSocket.on('room-creation-error', (error: string) => alert(error));
    newSocket.on('rate-limit-error', (error: string) => alert(error));

    if (isBotMode) {
      newSocket.once('connect', () => newSocket.emit('authenticate-bot', BOT_SECRET));
    }

    // Connect only after all listeners are registered and we've confirmed the
    // session exists — this eliminates the race condition entirely.
    newSocket.connect();

    return () => {
      newSocket.close();
    };
  }, []);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  // ── Google login ──────────────────────────────────────────────────────────

  const handleGoogleSuccess = async (idToken: string) => {
    try {
      const res = await fetch(`${SOCKET_URL}/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        setAuthError(err.error || 'הכניסה נכשלה, נסה שנית.');
        return;
      }
      const data = await res.json() as { sessionToken: string; username: string; email: string };
      writeSession({ sessionToken: data.sessionToken, username: data.username, email: data.email, isBot: false });
      socketRef.current?.emit('authenticate', data.sessionToken);
    } catch {
      setAuthError('שגיאת רשת — השרת אולי מתעורר, נסה שוב בעוד שנייה.');
    }
  };

  const handleGoogleError = () => { setAuthError('הכניסה נכשלה, נסה שנית.'); };

  // ── Rename room (Issue #26) ───────────────────────────────────────────────

  const startEditingRoom = (room: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingRoom(room);
    setEditRoomName(room);
  };

  const commitRenameRoom = (oldName: string) => {
    const newName = editRoomName.trim();
    setEditingRoom(null);
    if (!newName || newName === oldName) return;
    socketRef.current?.emit('rename-room', { oldName, newName });
  };

  const cancelEditRoom = () => {
    setEditingRoom(null);
    setEditRoomName('');
  };

  // ── Logout ─────────────────────────────────────────────────────────────────

  const handleLogout = async () => {
    if (!window.confirm('האם אתה בטוח שברצונך להתנתק?')) return;
    const session = readSession();
    if (session?.sessionToken) {
      fetch(`${SOCKET_URL}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionToken: session.sessionToken }),
      }).catch(console.error);
    }
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

  // ── Messaging ──────────────────────────────────────────────────────────────

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

  const formatTime = (timestamp: number) =>
    new Date(timestamp).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });

  const typingText = typingUsers.length === 1
    ? `${typingUsers[0]} מקליד...`
    : typingUsers.length > 1
      ? `${typingUsers.join(', ')} מקלידים...`
      : '';

  // ── Render ─────────────────────────────────────────────────────────────────

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
            <img
              src="/icons/icon-192.png"
              alt="LiveChat Logo"
              style={{ width: '100px', height: '100px', borderRadius: '50%', marginBottom: '1rem', objectFit: 'cover' }}
            />
            <h1 className="login-title">LiveChat בזמן אמת</h1>
            {authError && <p style={{ color: 'red', marginBottom: '1rem' }}>{authError}</p>}
            <GoogleAuth onSuccess={handleGoogleSuccess} onError={handleGoogleError} />
          </div>
        </div>
      </GoogleOAuthProvider>
    );
  }

  if (isAuthenticated && !isReady) {
    return (
      <div className="connecting-screen">
        <div className="connecting-spinner" />
        <p className="connecting-text">מתחבר לצ׳אט...</p>
      </div>
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
            <div key={room} className={`room-item ${currentRoom === room ? 'active' : ''}`}>
              {editingRoom === room ? (
                <div className="room-edit-inline" onClick={e => e.stopPropagation()}>
                  <input
                    autoFocus
                    className="room-edit-input"
                    value={editRoomName}
                    onChange={e => setEditRoomName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitRenameRoom(room);
                      if (e.key === 'Escape') cancelEditRoom();
                    }}
                    onBlur={() => commitRenameRoom(room)}
                    maxLength={30}
                  />
                </div>
              ) : (
                <button
                  className="room-item-btn"
                  onClick={() => switchRoom(room)}
                >
                  <span className="room-emoji">{room === 'General' ? '💬' : '📁'}</span>
                  <span className="room-name">{room}</span>
                </button>
              )}
              <div className="room-item-actions">
                <button
                  className="room-rename-btn"
                  onClick={e => startEditingRoom(room, e)}
                  title="שנה שם חדר"
                  aria-label="שנה שם חדר"
                >✏️</button>
                <button
                  className={`notif-toggle ${isNotifOn(room) ? 'on' : 'off'}`}
                  onClick={(e) => toggleRoomNotifications(room, e)}
                  title={isNotifOn(room) ? 'כבה התראות' : 'הפעל התראות'}
                  aria-label={isNotifOn(room) ? 'כבה התראות' : 'הפעל התראות'}
                >
                  {isNotifOn(room) ? '🔔' : '🔕'}
                </button>
              </div>
            </div>
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
          {groupMessages(messages).map((group) => {
            const isOwn = group.username === username;
            return (
              <div key={group.key} className={`message-group ${isOwn ? 'own' : 'other'}`}>
                {!isOwn && (
                  <div
                    className="message-group-header"
                    style={{ color: getUserColor(group.email) }}
                  >
                    {group.username}
                    <span className="message-group-time">{formatTime(group.messages[0]!.timestamp)}</span>
                  </div>
                )}
                <div className="message-group-body">
                  {group.messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`message-line ${isOwn ? 'own' : 'other'}`}
                      onClick={() => setExpandedTimestamps(prev => {
                        const next = new Set(prev);
                        next.has(msg.id) ? next.delete(msg.id) : next.add(msg.id);
                        return next;
                      })}
                    >
                      <span className="message-line-text">{msg.text}</span>
                      {(expandedTimestamps.has(msg.id) || (isOwn && group.messages.length === 1)) && (
                        <span className="message-line-timestamp">{formatTime(msg.timestamp)}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
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


