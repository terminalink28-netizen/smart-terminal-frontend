import { io } from 'socket.io-client';

// Initialize the socket, but don't connect automatically. 
// We only want it to connect when the user turns on "Location Sharing".
export const socket = io('http://localhost:5000', {
  withCredentials: true,
  autoConnect: false, 
});