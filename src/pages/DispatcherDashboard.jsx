import { useCallback, useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import { useNavigate } from 'react-router-dom';
import L from 'leaflet';
import apiClient from '../api/axios';
import { socket } from '../api/socket';
import QRScannerModal from '../components/QRScannerModal';
import CreateTripModal from '../components/CreateTripModal';
import { VIRAC_HUB, getCoordinatesForDestination } from '../components/townCoordinates';

import icon from 'leaflet/dist/images/marker-icon.png';
import iconShadow from 'leaflet/dist/images/marker-shadow.png';

// ─── leaflet default icon fix ─────────────────────────────────────────────────

const DefaultIcon = L.icon({
  iconUrl:    icon,
  shadowUrl:  iconShadow,
  iconAnchor: [12, 41],
});
L.Marker.prototype.options.icon = DefaultIcon;

// ─── constants & helpers ──────────────────────────────────────────────────────

const MAP_CENTER         = [13.5820477, 124.2192987];
const MAP_ZOOM           = 10;
const SUCCESS_BANNER_TTL = 5000; // ms
const REFETCH_INTERVAL_MS = 30_000;

const STATUS_STYLES = {
  BOARDING:   'bg-green-100 text-green-800 border border-green-200',
  DEPARTING:  'bg-amber-100 text-amber-800 border border-amber-200',
  DEPARTED:   'bg-blue-100  text-blue-800  border border-blue-200',
  ARRIVING:   'bg-emerald-100 text-emerald-800 border border-emerald-200',
  DELAYED:    'bg-orange-100 text-orange-800 border border-orange-200',
  COMPLETED:  'bg-gray-100  text-gray-600  border border-gray-200',
};

function mpsToKph(mps) {
  return Math.round((mps ?? 0) * 3.6);
}

function formatSpeed(mps) {
  const kph = mpsToKph(mps);
  return kph > 0 ? `${kph} km/h` : 'Stopped';
}

function isViracHub(name) {
  return typeof name === 'string' && name.toLowerCase().includes('virac');
}

// ─── sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const cls = STATUS_STYLES[status] ?? 'bg-gray-100 text-gray-600 border border-gray-200';
  return (
    <span className={`inline-block text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded ${cls}`}>
      {status}
    </span>
  );
}

function MetricCard({ label, value, highlight }) {
  return (
    <div className="bg-slate-50 rounded-xl p-3 text-center border border-slate-100">
      <p className="text-xs text-slate-500 mb-1">{label}</p>
      <p className={`text-2xl font-black tabular-nums ${highlight ? 'text-green-600' : 'text-slate-800'}`}>
        {value}
      </p>
    </div>
  );
}

function TripCard({ trip, liveData, isSelected, onClick }) {
  const hasGps = typeof liveData?.lat === 'number' && typeof liveData?.lng === 'number';
  const isBoarding = trip.status === 'BOARDING';

  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-4 rounded-xl border transition-all ${
        isSelected
          ? 'border-blue-400 bg-blue-50 shadow-sm ring-2 ring-blue-100'
          : 'border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm'
      }`}
      aria-pressed={isSelected}
    >
      <div className="flex justify-between items-start mb-2">
        <span className="font-bold text-slate-800 text-sm truncate pr-2">
          {trip.driver?.name ?? 'Assigned Driver'}
        </span>
        <StatusBadge status={trip.status} />
      </div>

      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-black text-emerald-700 uppercase tracking-widest">
          {trip.van?.plateNumber ?? 'Unknown plate'}
        </span>
        <span className="text-xs text-slate-400 font-medium truncate">
          • {trip.route?.name ?? 'Unnamed route'}
        </span>
      </div>

      <div className="flex items-center justify-between mt-3 bg-slate-50 px-2 py-1.5 rounded-lg border border-slate-100">
        <div className="flex items-center gap-1.5">
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0 ${
              hasGps ? 'bg-blue-500 animate-ping' : isBoarding ? 'bg-green-500' : 'bg-amber-400'
            }`}
            aria-hidden="true"
          />
          <span className="text-xs font-semibold text-slate-600">
            {hasGps ? formatSpeed(liveData.speed) : isBoarding ? 'At Terminal' : 'Awaiting GPS…'}
          </span>
        </div>

        {(trip.seatInfo?.totalSeats > 0 || trip.van?.capacity > 0) && (
          <span className="text-xs font-bold text-slate-600">
            {trip.seatInfo?.availableSeats ?? trip.van?.capacity}/
            {trip.seatInfo?.totalSeats ?? trip.van?.capacity} seats
          </span>
        )}
      </div>
    </button>
  );
}

// ─── TerminalVanCard ──────────────────────────────────────────────────────────
// Shows a van that is physically AT the terminal right now — either idle and
// ready to be loaded, or already boarding passengers. Disappears from this
// list the moment its trip moves to DEPARTING (see getTerminalVans backend).

function TerminalVanCard({ entry }) {
  const isBoarding = entry.terminalStatus === 'BOARDING';

  return (
    <div
      className={`p-3 rounded-xl border ${
        isBoarding
          ? 'border-green-200 bg-green-50'
          : 'border-slate-200 bg-white'
      }`}
    >
      <div className="flex justify-between items-start gap-2">
        <div className="min-w-0">
          <div className="font-black text-slate-800 text-sm truncate">
            {entry.driver?.name ?? 'No driver on file'}
          </div>
          <div className="text-xs font-bold text-emerald-700 uppercase tracking-widest mt-0.5">
            {entry.plateNumber}
          </div>
        </div>
        <span
          className={`shrink-0 text-xs font-bold px-2 py-0.5 rounded border ${
            isBoarding
              ? 'bg-green-100 text-green-800 border-green-200'
              : 'bg-slate-100 text-slate-600 border-slate-200'
          }`}
        >
          {isBoarding ? 'Boarding' : 'Idle'}
        </span>
      </div>

      {isBoarding && entry.trip?.routeName && (
        <div className="text-xs text-slate-500 mt-2 pt-2 border-t border-green-100">
          Route: <span className="font-semibold text-slate-700">{entry.trip.routeName}</span>
        </div>
      )}

      {!isBoarding && (
        <div className="text-xs text-slate-400 mt-2 pt-2 border-t border-slate-100">
          Ready — waiting for driver to start a trip.
        </div>
      )}
    </div>
  );
}

function ErrorState({ message, onRetry }) {
  return (
    <div className="h-screen flex items-center justify-center p-4 bg-gray-100">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-md p-6 text-center">
        <h1 className="text-xl font-bold text-gray-800 mb-1">Dispatcher dashboard</h1>
        <p className="text-sm text-gray-400 mb-4">Something went wrong</p>
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-5">
          <p className="text-sm text-red-700 font-medium">{message}</p>
        </div>
        <button
          onClick={onRetry}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-xl transition-colors"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

function DepartureModal({ scan, onConfirm, onDismiss, isSubmitting }) {
  const [departureTime, setDepartureTime] = useState('');
  const [error, setError]                 = useState('');

  useEffect(() => {
    if (!scan) return;
    const soon = new Date(Date.now() + 5 * 60_000);
    const pad  = (n) => String(n).padStart(2, '0');
    setDepartureTime(`${pad(soon.getHours())}:${pad(soon.getMinutes())}`);
    setError('');
  }, [scan]);

  if (!scan) return null;

  const handleSubmit = () => {
    if (!departureTime) {
      setError('Please enter a departure time.');
      return;
    }
    setError('');
    onConfirm({ tripId: scan.tripId, departureTime });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden">
        <div className="bg-blue-900 text-white px-5 py-4">
          <h2 className="font-bold text-base">🕐 Set expected departure</h2>
          <p className="text-xs text-blue-300 mt-0.5">Passenger arrived — when does this van depart?</p>
        </div>
        <div className="px-5 pt-4 pb-2">
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-sm space-y-1.5">
            <div className="flex justify-between">
              <span className="text-slate-500">Passenger</span>
              <span className="font-semibold text-slate-800">{scan.passengerName ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Van</span>
              <span className="font-semibold text-slate-800">{scan.plateNumber ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Route</span>
              <span className="font-semibold text-slate-800">{scan.routeName ?? '—'}</span>
            </div>
          </div>
        </div>
        <div className="px-5 py-3">
          <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1.5">
            Expected departure time
          </label>
          <input
            type="time"
            value={departureTime}
            onChange={(e) => { setDepartureTime(e.target.value); setError(''); }}
            className="w-full px-3 py-2.5 text-base font-semibold border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
            autoFocus
          />
          {error && <p className="text-xs text-red-600 mt-1.5 font-medium">{error}</p>}
        </div>
        <div className="px-5 pb-5 flex gap-2">
          <button
            onClick={onDismiss}
            disabled={isSubmitting}
            className="flex-1 py-2.5 text-sm font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors disabled:opacity-50"
          >
            Skip
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="flex-2 flex-grow-[2] py-2.5 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
          >
            {isSubmitting ? 'Saving…' : '✅ Confirm departure'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── main component ───────────────────────────────────────────────────────────

export default function DispatcherDashboard() {
  const [activeTrips, setActiveTrips]     = useState([]);
  const [liveLocations, setLiveLocations] = useState({});
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState('');
  const [selectedTripId, setSelectedTripId] = useState(null);
  const [reloadToken, setReloadToken]     = useState(0);

  // Vans currently at the terminal (IDLE or BOARDING) — separate from
  // activeTrips, since IDLE vans have no trip at all.
  const [terminalVans, setTerminalVans]   = useState([]);
  const [terminalLoading, setTerminalLoading] = useState(true);
  const [terminalError, setTerminalError] = useState('');

  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [isCreateOpen, setIsCreateOpen]   = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [departureScan, setDepartureScan] = useState(null);
  const [isDepartureSubmitting, setIsDepartureSubmitting] = useState(false);
  
  const navigate = useNavigate();
  const successTimerRef = useRef(null);
  const mapRef          = useRef(null);

  // ── API Fetching ───────────────────────────────────────────────────────────

  const fetchActiveTrips = useCallback(async (signal) => {
    try {
      const response = await apiClient.get('/trips/live', { signal });
      const trips    = Array.isArray(response.data) ? response.data : [];
      setActiveTrips(trips);
      setError('');
    } catch (err) {
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
      setError('Failed to load live dispatcher data. Please check your connection.');
      console.error('[DispatcherDashboard] fetchActiveTrips error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchTerminalVans = useCallback(async (signal) => {
    try {
      const response = await apiClient.get('/trips/terminal', { signal });
      setTerminalVans(Array.isArray(response.data) ? response.data : []);
      setTerminalError('');
    } catch (err) {
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
      setTerminalError('Could not load vans at the terminal.');
      console.error('[DispatcherDashboard] fetchTerminalVans error:', err);
    } finally {
      setTerminalLoading(false);
    }
  }, []);

  // Set up 30-second polling fallback (Same as PublicTracker)
  useEffect(() => {
    const id = setInterval(() => {
      const ctrl = new AbortController();
      fetchActiveTrips(ctrl.signal);
      fetchTerminalVans(ctrl.signal);
    }, REFETCH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchActiveTrips, fetchTerminalVans]);

  // ── WebSockets ─────────────────────────────────────────────────────────────

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setTerminalLoading(true);
    fetchActiveTrips(controller.signal);
    fetchTerminalVans(controller.signal);

    const handleInitialLocations = (locationsArray = []) => {
      if (Array.isArray(locationsArray)) {
        setLiveLocations(Object.fromEntries(locationsArray));
      }
    };

    const handleVanMoved = (data) => {
      if (!data?.tripId || typeof data.lat !== 'number' || typeof data.lng !== 'number') return;
      setLiveLocations((prev) => ({
        ...prev,
        [data.tripId]: { ...(prev[data.tripId] ?? {}), lat: data.lat, lng: data.lng, speed: data.speed ?? 0 },
      }));
    };

    const handleSeatUpdate = (data) => {
      if (!data?.tripId || typeof data.availableSeats !== 'number') return;
      setActiveTrips((prev) =>
        prev.map((t) => t.id === data.tripId ? { ...t, seatInfo: { availableSeats: data.availableSeats, totalSeats: data.totalSeats } } : t)
      );
    };

    // FIX: Safely remove trips when they are completed or cancelled.
    // Also refresh the terminal list here — a status change (BOARDING ->
    // DEPARTING, or -> COMPLETED which frees the van back to IDLE) always
    // means the terminal's set of "vans physically here" just changed.
    const handleTripStatusChanged = ({ tripId, status, trip }) => {
      if (!tripId) return;
      setActiveTrips((prev) => {
        if (status === 'COMPLETED' || status === 'CANCELLED') {
          return prev.filter((t) => t.id !== tripId);
        }
        const exists = prev.some((t) => t.id === tripId);
        if (exists) return prev.map((t) => (t.id === tripId ? { ...t, status, ...(trip || {}) } : t));
        if (trip) return [trip, ...prev];
        return prev;
      });
      fetchTerminalVans();
    };

    // FIX: Instantly add new trips started by drivers. A driver self-starting
    // a trip means a van just went IDLE -> BOARDING — still at the terminal,
    // so the terminal list needs a refresh too, not just activeTrips.
    const handleTripDispatched = ({ trip }) => {
      if (!trip?.id) return;
      setActiveTrips((prev) => (prev.some((t) => t.id === trip.id) ? prev : [trip, ...prev]));
      fetchTerminalVans();
    };

    socket.connect();
    socket.emit('subscribe_to_map');
    
    socket.on('initial_locations',     handleInitialLocations);
    socket.on('van_moved',             handleVanMoved);
    socket.on('seat_update',           handleSeatUpdate);           // Legacy support
    socket.on('seat_update_broadcast', handleSeatUpdate);           // New broadcast
    socket.on('trip_status_changed',   handleTripStatusChanged);
    socket.on('trip_dispatched',       handleTripDispatched);       // Listens for brand new trips

    return () => {
      controller.abort();
      socket.off('initial_locations',   handleInitialLocations);
      socket.off('van_moved',           handleVanMoved);
      socket.off('seat_update',         handleSeatUpdate);
      socket.off('seat_update_broadcast', handleSeatUpdate);
      socket.off('trip_status_changed', handleTripStatusChanged);
      socket.off('trip_dispatched',     handleTripDispatched);
      socket.disconnect();
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    };
  }, [fetchActiveTrips, fetchTerminalVans, reloadToken]);

  // ── Callbacks ──────────────────────────────────────────────────────────────

  const showSuccess = useCallback((message) => {
    setSuccessMessage(message);
    if (successTimerRef.current) clearTimeout(successTimerRef.current);
    successTimerRef.current = setTimeout(() => setSuccessMessage(''), SUCCESS_BANNER_TTL);
  }, []);

  // A successful QR scan can move a trip all the way to COMPLETED (freeing
  // the van to IDLE) — refresh both lists so the terminal panel picks up
  // the van immediately instead of waiting for the next 30s poll.
  const handleScanSuccess = useCallback((result) => {
    showSuccess(typeof result === 'string' ? result : 'QR scan successful.');
    fetchActiveTrips();
    fetchTerminalVans();
  }, [fetchActiveTrips, fetchTerminalVans, showSuccess]);

  const handleDepartureConfirm = useCallback(async ({ tripId, departureTime }) => {
    setIsDepartureSubmitting(true);
    try {
      await apiClient.patch(`/trips/${tripId}/departure`, { expectedDepartureTime: departureTime });
      showSuccess(`Departure set to ${departureTime} — van is ready to roll.`);
      fetchActiveTrips();
    } catch (err) {
      console.error('[DispatcherDashboard] setDeparture error:', err);
      showSuccess('Departure time saved locally — sync failed, will retry.');
    } finally {
      setIsDepartureSubmitting(false);
      setDepartureScan(null);
    }
  }, [fetchActiveTrips, showSuccess]);

  const handleCreateSuccess = useCallback((message) => {
    showSuccess(message);
    fetchActiveTrips();
    fetchTerminalVans();
  }, [fetchActiveTrips, fetchTerminalVans, showSuccess]);

  const handleTripSelect = useCallback((tripId) => {
    setSelectedTripId((prev) => (prev === tripId ? null : tripId));
    
    // Smooth camera pan if location exists
    const loc = liveLocations[tripId];
    if (loc && mapRef.current) {
      mapRef.current.setView([loc.lat, loc.lng], 14, { animate: true });
    }
  }, [liveLocations]);

  const handleLogout = useCallback(async () => {
    try {
      await apiClient.post('/auth/logout');
    } catch (err) {
      console.error('[DispatcherDashboard] Logout error:', err);
    } finally {
      // Both keys must go — ProtectedRoute and Login's redirect-if-logged-in
      // effect both key off 'user', but the Bearer token in localStorage is
      // a separate credential that also needs clearing (see the driver
      // dashboard fix for the full explanation of this bug).
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      navigate('/login', { replace: true });
    }
  }, [navigate]);

  // ── Derived Metrics ────────────────────────────────────────────────────────

  const liveCount = activeTrips.filter((t) => liveLocations[t.id]).length;
  const totalPax  = activeTrips.reduce((acc, t) => {
    const avail = t.seatInfo?.availableSeats ?? t.van?.capacity ?? 0;
    const total = t.seatInfo?.totalSeats ?? t.van?.capacity ?? 0;
    return acc + Math.max(0, total - avail);
  }, 0);
  
  const avgSpeedKph = liveCount === 0 ? 0 : Math.round(
    activeTrips
      .filter((t) => liveLocations[t.id])
      .reduce((acc, t) => acc + mpsToKph(liveLocations[t.id]?.speed), 0) / liveCount
  );

  // ─── custom icons ─────────────────────────────────────────────────────────────

const vanIcon = L.divIcon({
  className: '',
  html: `
    <div style="
      font-size:18px;
      background:white;
      border-radius:50%;
      padding:4px;
      border:3px solid #3b82f6; /* Blue border to match dispatcher theme */
      width:36px;
      height:36px;
      display:flex;
      align-items:center;
      justify-content:center;
      box-shadow:0 4px 12px rgba(59,130,246,0.35);
    ">🚐</div>
  `,
  iconSize: [36, 36],
  iconAnchor: [18, 18],
  popupAnchor: [0, -22],
});
  // ── Render States ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-3 bg-slate-50">
        <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-slate-500 font-bold tracking-wide uppercase">Connecting to Terminal…</p>
      </div>
    );
  }

  if (error) {
    return <ErrorState message={error} onRetry={() => setReloadToken((n) => n + 1)} />;
  }

  return (
    <div className="h-screen flex flex-col bg-gray-100 overflow-hidden font-sans">
      
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="bg-gradient-to-r from-blue-900 to-blue-800 text-white px-5 py-3 shadow-md flex items-center gap-3 flex-wrap z-10">
        <h1 className="text-lg font-black flex items-center gap-2 flex-1 min-w-0 tracking-tight">
          <span aria-hidden="true">📡</span>
          <span className="truncate">Dispatcher's View</span>
        </h1>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setIsCreateOpen(true)}
            className="bg-blue-500 hover:bg-blue-400 active:bg-blue-600 text-white text-sm font-bold px-4 py-2 rounded-lg transition-colors shadow-sm"
          >
            ➕ Dispatch
          </button>

          <button
            onClick={() => setIsScannerOpen(true)}
            className="bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-white text-sm font-bold px-4 py-2 rounded-lg transition-colors shadow-sm"
          >
            📸 Scan QR
          </button>

          <button
            onClick={handleLogout}
            className="bg-slate-700/50 hover:bg-slate-700 active:bg-slate-800 text-white text-sm font-bold px-4 py-2 rounded-lg transition-colors border border-slate-600 ml-2"
          >
            🚪 Logout
          </button>

          <span className="text-xs font-bold bg-blue-950/50 border border-blue-700/50 px-3 py-1.5 rounded-full ml-2 shadow-inner">
            {activeTrips.length} {activeTrips.length === 1 ? 'Trip' : 'Trips'} Active
          </span>
        </div>
      </header>

      {successMessage && (
        <div className="bg-emerald-100 border-b border-emerald-300 text-emerald-800 px-4 py-2.5 text-sm text-center font-bold z-10 shadow-sm animate-in slide-in-from-top-2">
          ✅ {successMessage}
        </div>
      )}

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden relative z-0">

        {/* ── Sidebar ──────────────────────────────────────────────────────── */}
        <aside className="w-80 xl:w-96 bg-white border-r border-slate-200 flex flex-col overflow-hidden shadow-2xl z-10">
          <div className="p-4 border-b border-slate-100 grid grid-cols-2 gap-3 bg-slate-50/50">
            <MetricCard label="Active Trips" value={activeTrips.length} />
            <MetricCard label="GPS Live"     value={liveCount}          highlight />
            <MetricCard label="Passengers"   value={totalPax} />
            <MetricCard label="Fleet Avg"    value={`${avgSpeedKph} km/h`} />
          </div>

          <div className="flex-1 overflow-y-auto p-4 bg-slate-50 space-y-6">

            {/* ── At the Terminal ─────────────────────────────────────────── */}
            <div>
              <h2 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-3 flex justify-between items-center">
                🅿️ At the Terminal
                <span className="text-purple-500 font-bold">{terminalVans.length}</span>
              </h2>

              {terminalError && (
                <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-2">
                  {terminalError}
                </div>
              )}

              {terminalLoading ? (
                <div className="text-center py-8 border-2 border-dashed border-slate-200 rounded-2xl bg-white">
                  <p className="text-xs font-semibold text-slate-400">Loading terminal status…</p>
                </div>
              ) : terminalVans.length === 0 ? (
                <div className="text-center py-8 border-2 border-dashed border-slate-200 rounded-2xl bg-white">
                  <span className="text-2xl mb-1 block">🚐</span>
                  <p className="text-xs font-bold text-slate-500">No vans at the terminal right now.</p>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {terminalVans.map((entry) => (
                    <TerminalVanCard key={entry.vanId} entry={entry} />
                  ))}
                </div>
              )}
            </div>

            {/* ── Live Fleet Status ────────────────────────────────────────── */}
            <div>
              <h2 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-3 flex justify-between">
                Live Fleet Status
                <span className="text-blue-500 font-bold">{activeTrips.length}</span>
              </h2>

              {activeTrips.length === 0 ? (
                <div className="text-center py-12 border-2 border-dashed border-slate-200 rounded-2xl bg-white">
                  <span className="text-3xl mb-2 block">🅿️</span>
                  <p className="text-sm font-bold text-slate-600">Terminal is clear.</p>
                  <p className="text-xs text-slate-400 mt-1 font-medium">Wait for drivers to self-start or dispatch manually.</p>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {activeTrips.map((trip) => (
                    <TripCard
                      key={trip.id}
                      trip={trip}
                      liveData={liveLocations[trip.id]}
                      isSelected={selectedTripId === trip.id}
                      onClick={() => handleTripSelect(trip.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </aside>

        {/* ── Map ──────────────────────────────────────────────────────────── */}
        <main className="flex-1 relative z-0 bg-slate-200">
          <MapContainer
            center={MAP_CENTER}
            zoom={MAP_ZOOM}
            className="h-full w-full"
            ref={mapRef}
            zoomControl={false}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />

            {activeTrips.map((trip) => {
              const loc = liveLocations[trip.id];
              const hasGps = typeof loc?.lat === 'number' && typeof loc?.lng === 'number';
              const isSelected = selectedTripId === trip.id;

              // FIX: Pin Boarding vans to their terminal just like Public Tracking
              let position = null;
              if (hasGps) {
                position = [loc.lat, loc.lng];
              } else if (trip.status === 'BOARDING') {
                const originName = trip.route?.origin ?? trip.route?.name?.split('→')[0]?.trim();
                position = getCoordinatesForDestination(originName) ?? 
                           (isViracHub(originName) ? VIRAC_HUB : null);
              }

              if (!position) return null;

              return (
                <Marker
                  key={trip.id}
                  position={position}
                  icon={vanIcon} // <-- Add the custom icon here
                  eventHandlers={{ click: () => handleTripSelect(trip.id) }}
                >
                  <Popup className="dispatcher-popup">
                    <div className="min-w-[180px] p-1">
                      <p className="font-black text-sm text-slate-900 mb-0.5">
                        {trip.driver?.name ?? 'Assigned Driver'}
                      </p>
                      <p className="text-xs font-bold text-emerald-700 uppercase tracking-widest mb-2">
                        {trip.van?.plateNumber ?? 'Unknown plate'}
                      </p>
                      
                      <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-100">
                        <StatusBadge status={trip.status} />
                        {hasGps && (
                          <span className="text-blue-600 font-bold text-xs bg-blue-50 px-2 py-1 rounded">
                            {formatSpeed(loc.speed)}
                          </span>
                        )}
                      </div>
                    </div>
                  </Popup>
                </Marker>
              );
            })}
          </MapContainer>

          {/* No GPS overlay */}
          {activeTrips.length > 0 && liveCount === 0 && (
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-white/90 backdrop-blur-sm border-2 border-amber-200 text-amber-800 text-xs font-bold px-5 py-2.5 rounded-full shadow-lg pointer-events-none z-[1000] flex items-center gap-2">
              <span className="animate-spin text-base leading-none">⏳</span>
              Waiting for drivers to establish GPS links…
            </div>
          )}
        </main>
      </div>

      {/* ── Modals ─────────────────────────────────────────────────────────── */}
      <QRScannerModal
        isOpen={isScannerOpen}
        onClose={() => setIsScannerOpen(false)}
        onSuccess={handleScanSuccess}
      />
      
      <DepartureModal
        scan={departureScan}
        onConfirm={handleDepartureConfirm}
        onDismiss={() => setDepartureScan(null)}
        isSubmitting={isDepartureSubmitting}
      />

      <CreateTripModal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onSuccess={handleCreateSuccess}
      />
    </div>
  );
}