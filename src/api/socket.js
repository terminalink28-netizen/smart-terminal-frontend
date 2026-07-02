import { io } from 'socket.io-client';

// This safely grabs your Vercel link and removes the "/api" part 
// because Socket.io needs the base URL, not the API route.
const SOCKET_URL = import.meta.env.VITE_API_URL 
  ? import.meta.env.VITE_API_URL.replace('/api', '') 
  : 'http://localhost:5000';

const socket = io(SOCKET_URL, {
  withCredentials: true, // This is mandatory to pass the CORS check!
});

export default socket;