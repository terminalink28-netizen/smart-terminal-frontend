import axios from 'axios';

// With the Vercel rewrite in vercel.json, /api/* is proxied to the Render
// backend on the SAME origin as the frontend. This makes the auth cookie
// first-party instead of cross-site, so browsers (Safari ITP, Chrome's
// third-party cookie phase-out, etc.) stop silently dropping it.
//
// VITE_API_URL should now be unset or just "/api" — do NOT point it at
// the full https://smart-terminal-backend.onrender.com/api URL anymore,
// or you'll be back to cross-site cookies.

const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  withCredentials: true,
  timeout: 15000,
});

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export default apiClient;