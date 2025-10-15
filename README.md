# Real-Time Chat Application

A real-time chat application built with React, Node.js, and Socket.IO. Features include Google authentication, dynamic room creation, and live user lists.

---

## Quick Start

1.  **Clone & Install Dependencies:**
    ```bash
    # Install server dependencies
    cd server && npm install

    # Install client dependencies
    cd ../client && npm install
    ```

2.  **Configure Client:**
    *   In the `/client` directory, create a `.env` file.
    *   Add the Google Client ID: `VITE_GOOGLE_CLIENT_ID="YOUR_GOOGLE_CLIENT_ID_HERE"`

3.  **Run the Application:**
    *   **Terminal 1 (Server):** `cd server && npm run dev`
    *   **Terminal 2 (Client):** `cd client && npm run dev`
    *   Open `http://localhost:5173` in your browser.

---

## Architecture Overview

*   **Backend (Node.js / Express / Socket.IO):**
    *   Manages WebSocket connections for real-time event handling (`join_room`, `send_message`, etc.).
    *   All data (messages, users, rooms) is stored **in-memory**, meaning it is cleared on server restart.

*   **Frontend (React / TypeScript / Vite):**
    *   A Single Page Application (SPA) that communicates with the server via the Socket.IO client.
    *   State is managed locally with React Hooks (`useState`, `useEffect`), and the UI updates reactively based on events received from the server.

---