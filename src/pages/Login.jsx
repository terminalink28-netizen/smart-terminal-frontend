import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import apiClient from '../api/axios';

const roleRoutes = {
  ADMIN: '/admin',
  DISPATCHER: '/dispatcher',
  DRIVER: '/driver',
};

// Always store (and read) the role in one normalized form so every
// consumer of localStorage — route guards, headers, etc. — agrees on it.
function normalizeUser(user) {
  if (!user?.role) return null;
  return { ...user, role: user.role.toUpperCase() };
}

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const navigate = useNavigate();

  // Route protection logic
  useEffect(() => {
    const savedUser = localStorage.getItem('user');

    if (!savedUser) return;

    try {
      const user = JSON.parse(savedUser);
      const nextPath = roleRoutes[user?.role?.toUpperCase()];

      if (nextPath) {
        navigate(nextPath, { replace: true });
      } else {
        // Unknown/garbled role — don't leave a bad value sitting around
        localStorage.removeItem('user');
      }
    } catch {
      localStorage.removeItem('user');
    }
  }, [navigate]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');

    if (!email.trim()) {
      setError('Email address is required.');
      return;
    }

    if (!password.trim()) {
      setError('Password is required.');
      return;
    }

    setLoading(true);

    try {
      const response = await apiClient.post('/auth/login', {
        identifier: email.trim(),
        secret: password,
      });

      // Be tolerant of slightly different response shapes
      // (e.g. { user } vs { data: { user } })
      const rawUser = response.data?.user ?? response.data?.data?.user;
      const user = normalizeUser(rawUser);

      if (!user) {
        throw new Error('Invalid login response.');
      }

      const nextPath = roleRoutes[user.role];

      if (!nextPath) {
        throw new Error(`Unrecognized role: ${user.role}`);
      }

      // Store the normalized role so ProtectedRoute (or anything else
      // reading localStorage) sees the same casing this component uses.
      localStorage.setItem('token', response.data.token);
      localStorage.setItem('user', JSON.stringify(user));

      navigate(nextPath, { replace: true });
    } catch (err) {
      setError(
        err?.response?.data?.error ||
          err?.message ||
          'Unable to login. Please try again.'
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-8">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-black text-slate-900">
            TERMINALINK
          </h1>
          <p className="text-sm text-slate-500 mt-2">
            Staff Access Portal
          </p>
        </div>

        {error && (
          <div className="mb-4 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3">
            {error}
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-5">
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">
              Email Address
            </label>

            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="Enter email address"
              className="w-full border border-slate-300 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={loading}
              required
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">
              Password
            </label>

            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="Enter password"
              className="w-full border border-slate-300 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={loading}
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className={`w-full py-3 rounded-lg font-bold text-white transition ${
              loading
                ? 'bg-slate-400 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {loading ? 'Signing In...' : 'Login'}
          </button>
        </form>

        <div className="mt-6 text-center">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="text-sm text-blue-600 hover:text-blue-800 font-medium"
          >
            View Public Tracking
          </button>
        </div>
      </div>
    </div>
  );
}
