<div align="center">

# 💬 LiveChat

**אפליקציית צ'אט בזמן אמת** — מבוססת React, Node.js, Socket.IO ו-Turso

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18-61dafb?logo=react&logoColor=black)](https://react.dev/)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-4.x-010101?logo=socket.io)](https://socket.io/)
[![Turso](https://img.shields.io/badge/Turso-libSQL-4ff8d2?logo=sqlite)](https://turso.tech/)
[![Deployed on Render](https://img.shields.io/badge/Deployed%20on-Render-46e3b7?logo=render)](https://livechat-0im1.onrender.com)

</div>

---

## ✨ פיצ'רים

| פיצ'ר | פירוט |
|---|---|
| 🔐 **Google OAuth** | כניסה מאובטחת עם חשבון Google — אימות מתבצע server-side |
| 💾 **Session persistence** | סשן נשמר בצד השרת (Turso) — נשאר מחובר גם אחרי רענון |
| 🏠 **ניהול חדרים** | יצירת חדרים דינמיים, הצטרפות וניתוק בזמן אמת |
| ⚡ **Real-time messaging** | הודעות מועברות מיידית דרך WebSocket (Socket.IO) |
| 📜 **היסטוריית הודעות** | 50 ההודעות האחרונות בכל חדר נטענות מה-DB בכניסה |
| 🔔 **Web Push Notifications** | התראות גם כשהדפדפן סגור — מבוסס VAPID + Service Worker |
| 🔕 **Toggle התראות לפי חדר** | כל משתמש שולט באיזה חדרים הוא מקבל התראות |
| 📱 **PWA** | ניתן להתקין כאפליקציה מקומית על iOS ו-Android |
| ✍️ **Typing indicators** | אינדיקטור "מקליד..." בזמן אמת לכל חדר |
| 🌐 **RTL מלא** | ממשק בעברית עם יישור מימין לשמאל |

---

## 🏗️ ארכיטקטורה

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENT (Vite + React)                │
│                                                             │
│  ┌──────────────┐   ┌────────────────┐   ┌──────────────┐  │
│  │ Google OAuth │   │  Socket.IO     │   │ Service      │  │
│  │ (@react-     │   │  Client        │   │ Worker (PWA) │  │
│  │  oauth/      │   │                │   │ + Web Push   │  │
│  │  google)     │   │                │   │              │  │
│  └──────┬───────┘   └───────┬────────┘   └──────┬───────┘  │
│         │                   │                   │           │
└─────────┼───────────────────┼───────────────────┼───────────┘
          │ HTTPS REST        │ WebSocket         │ Push Event
          ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────────────┐
│                     SERVER (Node.js + Express)              │
│                                                             │
│  ┌─────────────────┐   ┌──────────────────────────────────┐ │
│  │  REST Endpoints │   │        Socket.IO Server          │ │
│  │                 │   │                                  │ │
│  │ POST /auth/...  │   │  join_room   → sync rooms+msgs  │ │
│  │ POST /subscribe │   │  send_message → broadcast+push  │ │
│  │ POST /unsubscribe│  │  create_room → persist to DB    │ │
│  │ GET  /ping      │   │  typing      → forward to room  │ │
│  └────────┬────────┘   └──────────────┬───────────────────┘ │
│           │                           │                      │
│           ▼                           ▼                      │
│  ┌───────────────────────────────────────────────────────┐   │
│  │                  db.ts (Turso / libSQL)               │   │
│  │                                                       │   │
│  │  rooms · messages · push_subscriptions · user_sessions│   │
│  └───────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
          │
          ▼
  ┌───────────────┐
  │  Turso Cloud  │  (SQLite-compatible, edge database)
  └───────────────┘
```

---

## 🗄️ סכמת מסד הנתונים

### `rooms`
| עמודה | סוג | תיאור |
|---|---|---|
| `id` | INTEGER PK | מזהה אוטומטי |
| `name` | TEXT UNIQUE | שם החדר |
| `created_at` | INTEGER | Unix timestamp |

### `messages`
| עמודה | סוג | תיאור |
|---|---|---|
| `id` | TEXT PK | UUID של ההודעה |
| `username` | TEXT | שם המשתמש |
| `email` | TEXT | אימייל (מזהה Google) |
| `text` | TEXT | תוכן ההודעה |
| `room` | TEXT | שם החדר |
| `timestamp` | INTEGER | Unix timestamp |

### `push_subscriptions`
| עמודה | סוג | תיאור |
|---|---|---|
| `email` | TEXT | מזהה משתמש |
| `room` | TEXT | שם החדר |
| `subscription` | TEXT | Web Push subscription object (JSON) |

### `user_sessions`
| עמודה | סוג | תיאור |
|---|---|---|
| `email` | TEXT PK | מזהה משתמש |
| `display_name` | TEXT | שם תצוגה |
| `refresh_token` | TEXT | Google refresh token (מוצפן בצד השרת) |
| `updated_at` | INTEGER | Unix timestamp |

---

## 🔔 Web Push — איך זה עובד

```
1. Client: navigator.serviceWorker.register('sw.js')
2. Client: pushManager.subscribe({ applicationServerKey: VAPID_PUBLIC_KEY })
3. Client: POST /subscribe  { email, room, subscription }
4. Server: saves subscription to Turso (email + room mapping)

--- when a message arrives ---

5. Server: finds all push_subscriptions WHERE room = X AND email != sender
6. Server: webpush.sendNotification(subscription, { title, body, room })
7. Service Worker: receives 'push' event → showNotification(...)
8. User taps notification → app opens / focuses
```

**הגנות:**
- התראה נחסמת אם הדפדפן פתוח ומוצג (מניעת כפילות עם socket)
- כל משתמש יכול להשבית התראות per-room דרך הממשק

---

## 🚀 התקנה מקומית

### דרישות מוקדמות
- Node.js 18+
- חשבון [Turso](https://turso.tech) (חינמי)
- Google Cloud project עם OAuth 2.0 credentials

### 1. שכפול הרפוזיטורי
```bash
git clone https://github.com/avragol/LiveChat.git
cd LiveChat
```

### 2. הגדרת Server
```bash
cd server
npm install
```

צור קובץ `.env`:
```env
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your-turso-token
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
JWT_SECRET=your-random-secret-string
VAPID_PUBLIC_KEY=your-vapid-public-key
VAPID_PRIVATE_KEY=your-vapid-private-key
```

> כדי לייצר VAPID keys: `npx web-push generate-vapid-keys`

### 3. הגדרת Client
```bash
cd ../client
npm install
```

צור קובץ `.env`:
```env
VITE_SOCKET_URL=http://localhost:3001
VITE_GOOGLE_CLIENT_ID=your-google-client-id
VITE_VAPID_PUBLIC_KEY=your-vapid-public-key
```

### 4. הרצה
```bash
# Terminal 1 — Server
cd server && npm run dev

# Terminal 2 — Client
cd client && npm run dev
```

פתח את `http://localhost:5173`

---

## 🌐 Deployment

האפליקציה מופעלת על [Render](https://render.com):

| Service | URL |
|---|---|
| Server (Node.js) | `https://livechat-server-xxxx.onrender.com` |
| Client (Static Site) | `https://livechat-0im1.onrender.com` |

משתני סביבה מוגדרים ב-Render dashboard — לא נשמרים בקוד.

---

## 🛠️ טכנולוגיות

### Frontend
- **React 18** + **TypeScript** — UI ומניהול state
- **Vite** — bundler מהיר לפיתוח ו-production
- **Socket.IO Client** — WebSocket עם fallback אוטומטי
- **@react-oauth/google** — Google One Tap
- **Web Push API** + **Service Worker** — התראות ברקע

### Backend
- **Node.js** + **Express** — HTTP server ו-REST endpoints
- **Socket.IO** — WebSocket server
- **@libsql/client** — Turso (SQLite edge DB)
- **google-auth-library** — אימות Google ID tokens
- **web-push** — שליחת Web Push עם VAPID
- **dotenv** — ניהול משתני סביבה

---

## 📁 מבנה הפרויקט

```
LiveChat/
├── client/                  # Frontend (React + Vite)
│   ├── public/
│   │   ├── icons/           # PWA icons + badge
│   │   ├── manifest.json    # PWA manifest
│   │   └── sw.js            # Service Worker (cache + push)
│   └── src/
│       ├── App.tsx          # Main component — socket logic, UI
│       ├── GoogleAuth.tsx   # Google OAuth component
│       └── types.ts         # Shared TypeScript types
│
└── server/                  # Backend (Node.js + Express)
    ├── server.ts            # Main server — Express + Socket.IO
    └── db.ts                # Turso client + all DB operations
```

---

<div align="center">
  Made with ❤️ · Built on Socket.IO, Turso & React
</div>
