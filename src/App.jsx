import { BrowserRouter as Router, Routes, Route, Navigate, Outlet, Link, useLocation } from 'react-router-dom';
import Login from './pages/Login';
import DriverDashboard from './pages/DriverDashboard';
import DispatcherDashboard from './pages/DispatcherDashboard';
import PublicTracking from './pages/PublicTracking';
import AdminDashboard from './pages/AdminDashboard';
import SystemTestPage from './pages/SystemTestPage';

function getStoredUser() {
  try {
    const raw = localStorage.getItem('user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function ProtectedRoute({ allowedRoles }) {
  const user = getStoredUser();

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (!allowedRoles.includes(user.role)) {
    return <Navigate to="/dashboard" replace />;
  }

  return <Outlet />;
}

function RoleLanding() {
  const user = getStoredUser();

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  switch (user.role) {
    case 'ADMIN':
      return <Navigate to="/admin" replace />;
    case 'DISPATCHER':
      return <Navigate to="/dispatcher" replace />;
    case 'DRIVER':
      return <Navigate to="/driver" replace />;
    default:
      return <Navigate to="/" replace />;
  }
}

// ─── Global Floating Test Button ──────────────────────────────────────────────
function DebugButton() {
  const location = useLocation();
  
  // Hide the button if we are already on the test page
  if (location.pathname === '/test-api') return null;

  return (
    <Link 
      to="/test-api" 
      className="fixed bottom-6 right-6 z-[9999] bg-slate-900 text-green-400 border border-slate-700 px-4 py-2 rounded-full shadow-2xl font-mono text-xs font-bold hover:bg-slate-800 transition-all hover:scale-105 flex items-center gap-2"
    >
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
        <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
      </span>
      API Tester
    </Link>
  );
}
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <Router>
      {/* The button is placed here so it overlays on top of all routes */}
      <DebugButton />
      
      <Routes>
        <Route path="/" element={<PublicTracking />} />
        <Route path="/tracking" element={<PublicTracking />} />
        <Route path="/test-api" element={<SystemTestPage />} />
        <Route path="/login" element={<Login />} />

        <Route path="/dashboard" element={<RoleLanding />} />

        <Route element={<ProtectedRoute allowedRoles={['ADMIN']} />}>
          <Route path="/admin" element={<AdminDashboard />} />
        </Route>

        <Route element={<ProtectedRoute allowedRoles={['DISPATCHER']} />}>
          <Route path="/dispatcher" element={<DispatcherDashboard />} />
        </Route>

        <Route element={<ProtectedRoute allowedRoles={['DRIVER']} />}>
          <Route path="/driver" element={<DriverDashboard />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
}