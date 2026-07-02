import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import apiClient from '../api/axios';

const ENDPOINTS = [
  { group: 'Public Routes', routes: [
    { method: 'GET', path: '/health', description: 'Check if backend is alive' },
    { method: 'GET', path: '/trips/live', description: 'Fetch active trips for map' },
  ]},
  { group: 'Admin Routes (Requires Admin Login)', routes: [
    { method: 'GET', path: '/admin/dashboard', description: 'Fetch system stats & fleet' },
    { method: 'GET', path: '/admin/audit-logs', description: 'Fetch system audit trail' },
  ]},
  { group: 'Dispatcher Routes (Requires Dispatcher Login)', routes: [
    { method: 'GET', path: '/trips/dispatch-resources', description: 'Fetch available vans & drivers' },
  ]},
  { group: 'Driver Routes (Requires Driver Login)', routes: [
    { method: 'GET', path: '/trips/my-trips', description: 'Fetch assigned active trips' },
  ]},
  { group: 'Auth Routes', routes: [
    { method: 'POST', path: '/auth/logout', description: 'Clear secure HTTP cookie' },
  ]}
];

export default function SystemTestPage() {
  // --- API Tester State ---
  const [activeTest, setActiveTest] = useState(null);
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState(null);
  const [status, setStatus] = useState(null);

  // --- Live Map Simulator State ---
  const [simTripId, setSimTripId] = useState('');
  const [isSimulating, setIsSimulating] = useState(false);
  const socketRef = useRef(null);
  const simIntervalRef = useRef(null);

  // ─── API Testing Logic ──────────────────────────────────────────────────────
  const runTest = async (route) => {
    setActiveTest(route.path);
    setLoading(true);
    setResponse(null);
    setStatus(null);

    try {
      let res;
      if (route.method === 'GET') {
        res = await apiClient.get(route.path);
      } else if (route.method === 'POST') {
        res = await apiClient.post(route.path, {});
      }
      
      setStatus({ code: res.status, text: res.statusText, ok: true });
      setResponse(res.data);
    } catch (err) {
      console.error('Test Failed:', err);
      setStatus({ 
        code: err.response?.status || 'Network Error', 
        text: err.response?.statusText || err.message, 
        ok: false 
      });
      setResponse(err.response?.data || { error: err.message });
    } finally {
      setLoading(false);
    }
  };

  // ─── Live Map Simulator Logic ───────────────────────────────────────────────
  const toggleSimulation = () => {
    if (isSimulating) {
      clearInterval(simIntervalRef.current);
      socketRef.current?.disconnect();
      setIsSimulating(false);
      return;
    }

    if (!simTripId.trim()) return alert('Please enter a valid Active Trip ID from your database!');

    // Connect to your live backend socket
    socketRef.current = io(import.meta.env.VITE_API_URL || 'https://smart-terminal-backend.onrender.com');

    // Starting coordinates (Virac Terminal)
    let currentLat = 13.5855;
    let currentLng = 124.2285;

    setIsSimulating(true);

    // Send a new fake GPS coordinate every 3 seconds
    simIntervalRef.current = setInterval(() => {
      // Move the van slightly North-East every tick
      currentLat += 0.0002;
      currentLng += 0.0002;

      // Note: Ensure 'update_location' matches your backend socket listener exactly!
      socketRef.current.emit('update_location', {
        tripId: simTripId.trim(),
        latitude: currentLat,
        longitude: currentLng,
        speed: 45 // Pretend we are driving 45 km/h
      });
      
      console.log(`📡 Emitted Simulated GPS: ${currentLat}, ${currentLng}`);
    }, 3000);
  };

  // Cleanup WebSockets when leaving the page
  useEffect(() => {
    return () => {
      clearInterval(simIntervalRef.current);
      socketRef.current?.disconnect();
    };
  }, []);

  // ─── Component Render ───────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-100 p-6 font-sans flex flex-col lg:flex-row gap-6">
      
      {/* Sidebar: Route List */}
      <div className="w-full lg:w-1/3 space-y-6">
        <div>
          <h1 className="text-2xl font-black text-slate-900">API Test Playground</h1>
          <p className="text-sm text-slate-500 mt-1">Test your Render backend endpoints.</p>
        </div>

        {ENDPOINTS.map((group) => (
          <div key={group.group} className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="bg-slate-50 border-b border-slate-200 px-4 py-2 font-bold text-xs text-slate-500 uppercase tracking-wider">
              {group.group}
            </div>
            <div className="divide-y divide-slate-100">
              {group.routes.map((route) => (
                <button
                  key={route.path}
                  onClick={() => runTest(route)}
                  className={`w-full text-left px-4 py-3 hover:bg-slate-50 transition ${
                    activeTest === route.path ? 'bg-blue-50 border-l-4 border-blue-500' : 'border-l-4 border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-[10px] font-black px-2 py-0.5 rounded uppercase ${
                      route.method === 'GET' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'
                    }`}>
                      {route.method}
                    </span>
                    <span className="font-mono text-sm font-bold text-slate-800">{route.path}</span>
                  </div>
                  <p className="text-xs text-slate-500 ml-1">{route.description}</p>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Main Content Area */}
      <div className="w-full lg:w-2/3 flex flex-col space-y-6">
        
        {/* API Response Viewer */}
        <div className="bg-slate-800 rounded-xl shadow-lg flex-1 flex flex-col overflow-hidden border border-slate-700 min-h-[400px]">
          {/* Viewer Header */}
          <div className="bg-slate-900 px-4 py-3 border-b border-slate-700 flex justify-between items-center">
            <div className="flex items-center gap-3">
              <div className="flex gap-1.5">
                <div className="w-3 h-3 rounded-full bg-red-500"></div>
                <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
                <div className="w-3 h-3 rounded-full bg-green-500"></div>
              </div>
              <span className="text-slate-400 font-mono text-sm ml-2">
                {activeTest ? `Request: ${activeTest}` : 'Select an endpoint to test'}
              </span>
            </div>
            
            {status && (
              <span className={`px-2 py-1 rounded text-xs font-bold font-mono ${
                status.ok ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
              }`}>
                {status.code} {status.text}
              </span>
            )}
          </div>

          {/* Viewer Body */}
          <div className="flex-1 p-4 overflow-y-auto bg-[#0d1117]">
            {loading ? (
              <div className="h-full flex items-center justify-center text-blue-400 font-mono text-sm animate-pulse">
                Sending request to Render...
              </div>
            ) : response ? (
              <pre className="font-mono text-xs text-green-400 whitespace-pre-wrap break-words">
                {JSON.stringify(response, null, 2)}
              </pre>
            ) : (
              <div className="h-full flex items-center justify-center text-slate-600 font-mono text-sm">
                Waiting for request...
              </div>
            )}
          </div>
        </div>

        {/* Live Map Simulator UI */}
        <div className="bg-slate-900 border border-slate-700 rounded-xl p-5 text-white shadow-xl">
          <h2 className="text-lg font-black text-green-400 mb-2">🛰️ Live Map Simulator</h2>
          <p className="text-sm text-slate-400 mb-4">
            Enter an active <strong>Trip ID</strong> and start broadcasting fake GPS coordinates. Open your Public Tracking page in a new window to watch the van move!
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <input 
              type="text" 
              placeholder="e.g. 123e4567-e89b..." 
              value={simTripId}
              onChange={(e) => setSimTripId(e.target.value)}
              disabled={isSimulating}
              className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-green-500 font-mono"
            />
            <button 
              onClick={toggleSimulation}
              className={`px-6 py-2 rounded-lg font-bold text-sm transition whitespace-nowrap ${
                isSimulating ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'
              }`}
            >
              {isSimulating ? 'Stop Driving' : 'Start Engine & Drive'}
            </button>
          </div>
        </div>

        {/* Instructions */}
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800">
          <strong>💡 Pro Tip:</strong> If you get a <code>401 Unauthorized</code> or <code>403 Forbidden</code> on the Admin/Driver routes, it means your HTTP cookie is missing or you have the wrong role. Open your live site in another tab, log in as the correct role, and then come back here to test it!
        </div>

      </div>
    </div>
  );
}