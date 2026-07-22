import { io } from 'socket.io-client';

// Socket.IO connects directly to Render (cross-origin) since Vercel
// rewrites don't reliably proxy WebSocket upgrades. This is separate
// from VITE_API_URL, which now points at the same-origin /api proxy
// for HTTP requests only.
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:5000';

export const socket = io(SOCKET_URL, {
  withCredentials: true,
});