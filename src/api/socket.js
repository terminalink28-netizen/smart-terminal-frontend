import { io } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_API_URL 
  ? import.meta.env.VITE_API_URL.replace('/api', '') 
  : 'http://localhost:5000';

// FIX: We changed "const socket" to "export const socket" 
// and removed the "export default socket" at the bottom!
export const socket = io(SOCKET_URL, {
  withCredentials: true,
});