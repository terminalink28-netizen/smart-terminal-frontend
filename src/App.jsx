import { BrowserRouter as Router, Routes, Route, Navigate, Outlet } from 'react-router-dom';
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

export default function App() {
  return (
    <Router>
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