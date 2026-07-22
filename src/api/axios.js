import axios from 'axios';

// Ensure your Vercel environment variable VITE_API_URL is set to:
// "https://smart-terminal-backend.onrender.com/api" (NO trailing slash)

const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:5000/api',
  withCredentials: true, // Crucial for passing the authentication cookie
  timeout: 15000,
});

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export default apiClient;