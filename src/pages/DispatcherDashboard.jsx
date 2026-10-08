import { useCallback, useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import { useNavigate } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import apiClient from '../api/axios';
import { socket } from '../api/socket';
import QRScannerModal from '../components/QRScannerModal';
import { VIRAC_HUB, getCoordinatesForDestination } from '../components/townCoordinates';

// ─── constants & helpers ──────────────────────────────────────────────────────

const MAP_CENTER          = [13.5820477, 124.2192987];
const MAP_ZOOM            = 10;
const SUCCESS_BANNER_TTL  = 5000; // ms
const REFETCH_INTERVAL_MS = 30_000;

const HOME_TERMINAL_NAME = 'Provincial Integrated Transport Terminal and Business Complex';

// Dynamic viewport height ignores the collapsing mobile address bar.
const FULL_HEIGHT_STYLE = { height: '100dvh' };

function isHomeTerminal(name) {
  return typeof name === 'string' && name.trim().toLowerCase() === HOME_TERMINAL_NAME.toLowerCase();
}

function isDesktopViewport() {
  return typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches;
}

const STATUS_STYLES = {
  BOARDING:   'bg-green-100 text-green-800 border border-green-200',
  DEPARTING:  'bg-amber-100 text-amber-800 border border-amber-200',
  DEPARTED:   'bg-blue-100  text-blue-800  border border-blue-200',
  ARRIVING:   'bg-emerald-100 text-emerald-800 border border-emerald-200',
  QUEUED:     'bg-amber-100 text-amber-800 border border-amber-300',
  DELAYED:    'bg-orange-100 text-orange-800 border border-orange-200',
  COMPLETED:  'bg-gray-100  text-gray-600  border border-gray-200',
};

const STATUS_MARKER_STYLE = {
  BOARDING:  { glyph: '🧍', color: '#16a34a' },
  DEPARTING: { glyph: '🚦', color: '#d97706' },
  DEPARTED:  { glyph: '🚐', color: '#2563eb' },
  ARRIVING:  { glyph: '📍', color: '#059669' },
  QUEUED:    { glyph: '⏳', color: '#d97706' },
  DELAYED:   { glyph: '⏱️', color: '#ea580c' },
};
const DEFAULT_MARKER_STYLE = { glyph: '🚐', color: '#6b7280' };

const statusIconCache = new Map();
function getVanIconForStatus(status) {
  if (statusIconCache.has(status)) return statusIconCache.get(status);
  const { glyph, color } = STATUS_MARKER_STYLE[status] ?? DEFAULT_MARKER_STYLE;
  const markerIcon = L.divIcon({
    className: '',
    html: `
      <div style="
        font-size:18px;
        background:white;
        border-radius:50%;
        padding:4px;
        border:3px solid ${color};
        width:36px;
        height:36px;
        display:flex;
        align-items:center;
        justify-content:center;
        box-shadow:0 4px 12px ${color}59;
      ">${glyph}</div>
    `,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    popupAnchor: [0, -22],
  });
  statusIconCache.set(status, markerIcon);
  return markerIcon;
}

function mpsToKph(mps) {
  return Math.round((mps ?? 0) * 3.6);
}

function formatSpeed(mps) {
  const kph = mpsToKph(mps);
  return kph > 0 ? `${kph} km/h` : 'Stopped';
}

function originPlace(trip) {
  return trip.route?.origin ?? trip.route?.name?.split('→')[0]?.trim() ?? 'origin';
}

// Where a van sits when it has no live GPS fix yet: at its origin
// municipality while boarding the outbound leg, or at the terminal once it
// has been scanned in for the return leg.
function fallbackPositionForTrip(trip) {
  if (trip.direction === 'RETURN') return VIRAC_HUB;
  const name = originPlace(trip);
  return getCoordinatesForDestination(name) ?? (isHomeTerminal(name) ? VIRAC_HUB : null);
}

function directionLabel(trip) {
  return trip.direction === 'RETURN' ? '↩ Return leg' : '↗ Outbound';
}

function cooperativeName(trip) {
  return trip.van?.cooperative?.name ?? 'Unassigned';
}

// Arrived at the terminal on the outbound leg and waiting for the dispatcher's scan.
function isAwaitingScan(trip) {
  return trip.direction !== 'RETURN' && trip.status === 'ARRIVING';
}

function locationHint(trip, hasGps, liveData) {
  if (hasGps) return formatSpeed(liveData.speed);
  if (trip.status === 'BOARDING') {
    return trip.direction === 'RETURN' ? 'Boarding at the terminal' : `Boarding at ${originPlace(trip)}`;
  }
  if (trip.status === 'QUEUED') return 'Waiting in line at the terminal';
  return 'Awaiting GPS…';
}

// ─── map helper ───────────────────────────────────────────────────────────────
// On phones the map is hidden while another tab is active. Leaflet measures
// its container on mount, so it must re-measure when the tab is revealed.

function MapInvalidator({ active }) {
  const map = useMap();
  useEffect(() => {
    if (!active) return undefined;
    const t = setTimeout(() => map.invalidateSize(), 60);
    return () => clearTimeout(t);
  }, [active, map]);
  return null;
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
    <div className="bg-slate-50 rounded-xl p-2 lg:p-3 text-center border border-slate-100 min-w-0">
      <p className="text-[10px] lg:text-xs text-slate-500 mb-0.5 lg:mb-1 truncate">{label}</p>
      <p className={`text-base lg:text-2xl font-black tabular-nums truncate ${highlight ? 'text-green-600' : 'text-slate-800'}`}>
        {value}
      </p>
    </div>
  );
}

function TripCard({ trip, liveData, isSelected, onClick }) {
  const hasGps = typeof liveData?.lat === 'number' && typeof liveData?.lng === 'number';
  const dotClass = hasGps
    ? 'bg-blue-500 animate-ping'
    : trip.status === 'BOARDING'
    ? 'bg-green-500'
    : 'bg-amber-400';

  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-4 rounded-xl border transition-all active:scale-[0.99] ${
        isSelected
          ? 'border-blue-400 bg-blue-50 shadow-sm ring-2 ring-blue-100'
          : 'border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm'
      }`}
      aria-pressed={isSelected}
    >
      <div className="flex justify-between items-start gap-2 mb-2">
        <span className="font-bold text-slate-800 text-sm truncate">
          {trip.driver?.name ?? 'Assigned Driver'}
        </span>
        <StatusBadge status={trip.status} />
      </div>

      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <span className="text-xs font-black text-emerald-700 uppercase tracking-widest">
          {trip.van?.plateNumber ?? 'Unknown plate'}
        </span>
        <span className="text-xs text-slate-400 font-medium truncate max-w-full">
          • {trip.route?.name ?? 'Unnamed route'}
        </span>
        <span
          className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
            trip.direction === 'RETURN' ? 'bg-purple-100 text-purple-700' : 'bg-sky-100 text-sky-700'
          }`}
        >
          {directionLabel(trip)}
        </span>
      </div>

      <div className="text-[11px] font-semibold text-slate-400 mb-2">
        🏢 {cooperativeName(trip)}
      </div>

      {isAwaitingScan(trip) && (
        <div className="text-xs font-bold text-indigo-700 bg-indigo-50 border border-indigo-100 rounded-lg px-2 py-1.5 mb-2">
          📸 Arrived — ready to be scanned
        </div>
      )}

      <div className="flex items-center justify-between gap-2 bg-slate-50 px-2 py-1.5 rounded-lg border border-slate-100">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotClass}`} aria-hidden="true" />
          <span className="text-xs font-semibold text-slate-600 truncate">
            {locationHint(trip, hasGps, liveData)}
          </span>
        </div>

        {(trip.seatInfo?.totalSeats > 0 || trip.van?.capacity > 0) && (
          <span className="text-xs font-bold text-slate-600 shrink-0">
            {trip.seatInfo?.availableSeats ?? trip.availableSeats ?? trip.van?.capacity}/
            {trip.seatInfo?.totalSeats ?? trip.totalSeats ?? trip.van?.capacity} seats
          </span>
        )}
      </div>
    </button>
  );
}

// ─── Terminal line-up ─────────────────────────────────────────────────────────
// A van only appears here AFTER the dispatcher has scanned it at the
// terminal. It is placed straight into its own cooperative's line: the first
// van is "Now boarding", every other van waits behind it in scan order.
// Cooperatives never block each other — each has its own lane.

function LineCard({ entry, kind }) {
  const isBoarding = kind === 'BOARDING';
  const heading = isBoarding
    ? 'Now boarding'
    : entry.queuePosition === 1
    ? 'Next in line'
    : `${entry.queuePosition}${entry.queuePosition === 2 ? 'nd' : entry.queuePosition === 3 ? 'rd' : 'th'} in line`;

  const available = entry.trip?.availableSeats;
  const total = entry.trip?.totalSeats;

  return (
    <div className={`p-3 rounded-xl border ${isBoarding ? 'border-green-200 bg-green-50' : 'border-amber-200 bg-amber-50'}`}>
      <div className="flex items-center gap-3">
        <div
          className={`shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-sm font-black ${
            isBoarding ? 'bg-green-600 text-white' : 'bg-white text-amber-700 border border-amber-300'
          }`}
          aria-hidden="true"
        >
          {isBoarding ? '🧍' : `#${entry.queuePosition}`}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-black text-slate-800 text-sm truncate">
              {entry.driver?.name ?? 'No driver on file'}
            </span>
            <span
              className={`shrink-0 text-[11px] font-bold px-2 py-0.5 rounded border ${
                isBoarding
                  ? 'bg-green-100 text-green-800 border-green-200'
                  : 'bg-amber-100 text-amber-800 border-amber-200'
              }`}
            >
              {heading}
            </span>
          </div>
          <div className="text-xs font-bold text-emerald-700 uppercase tracking-widest mt-0.5">
            {entry.plateNumber}
          </div>
        </div>
      </div>

      <div
        className={`text-xs mt-2 pt-2 border-t flex items-center justify-between gap-2 ${
          isBoarding ? 'border-green-100 text-slate-600' : 'border-amber-100 text-amber-800'
        }`}
      >
        <span className="truncate">
          {entry.trip?.origin ? `Heading to ${entry.trip.origin}` : (entry.trip?.routeName ?? 'Return trip')}
        </span>
        {isBoarding && typeof available === 'number' && typeof total === 'number' && (
          <span className="font-bold shrink-0">🪑 {available}/{total}</span>
        )}
      </div>
    </div>
  );
}

function CooperativeLane({ group }) {
  const total = group.boarding.length + group.queued.length;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-sm">
      <div className="bg-slate-800 text-white text-xs font-black uppercase tracking-wide px-3 py-2.5 flex items-center justify-between">
        <span className="truncate">🏢 {group.cooperativeName}</span>
        <span className="text-slate-300 font-normal normal-case shrink-0 ml-2">
          {total} in line
        </span>
      </div>
      <div className="p-2 flex flex-col gap-2">
        {group.boarding.map((entry) => (
          <LineCard key={entry.vanId} entry={entry} kind="BOARDING" />
        ))}
        {group.queued.map((entry) => (
          <LineCard key={entry.vanId} entry={entry} kind="QUEUED" />
        ))}
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }) {
  return (
    <div className="h-screen flex items-center justify-center p-4 bg-gray-100" style={FULL_HEIGHT_STYLE}>
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

// Bottom tab bar — phones/tablets only. Desktop shows sidebar + map together.
function MobileTabBar({ activeTab, onChange, terminalCount, fleetCount }) {
  const tabs = [
    { key: 'terminal', icon: '🚏', label: 'Terminal', count: terminalCount },
    { key: 'fleet',    icon: '🚐', label: 'Fleet',    count: fleetCount },
    { key: 'map',      icon: '🗺️', label: 'Map',      count: null },
  ];

  return (
    <nav
      className="lg:hidden shrink-0 bg-white border-t border-slate-200 grid grid-cols-3 pb-[env(safe-area-inset-bottom)] z-20"
      aria-label="Dispatcher views"
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.key;
        return (
          <button
            key={tab.key}
            onClick={() => onChange(tab.key)}
            aria-current={isActive ? 'page' : undefined}
            className={`relative flex flex-col items-center justify-center gap-0.5 min-h-[56px] py-1.5 text-[11px] font-bold transition-colors active:bg-slate-100 ${
              isActive ? 'text-blue-700' : 'text-slate-500'
            }`}
          >
            {isActive && <span className="absolute top-0 inset-x-6 h-0.5 bg-blue-600 rounded-b" aria-hidden="true" />}
            <span className="text-xl leading-none" aria-hidden="true">{tab.icon}</span>
            <span className="flex items-center gap-1">
              {tab.label}
              {tab.count != null && tab.count > 0 && (
                <span
                  className={`min-w-[18px] px-1 rounded-full text-[10px] leading-[18px] text-center ${
                    isActive ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-700'
                  }`}
                >
                  {tab.count}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

// ─── main component ───────────────────────────────────────────────────────────

export default function DispatcherDashboard() {
  const [activeTrips, setActiveTrips]       = useState([]);
  const [liveLocations, setLiveLocations]   = useState({});
  const [loading, setLoading]               = useState(true);
  const [error, setError]                   = useState('');
  const [selectedTripId, setSelectedTripId] = useState(null);
  const [reloadToken, setReloadToken]       = useState(0);

  const [terminalGroups, setTerminalGroups]   = useState([]);
  const [terminalLoading, setTerminalLoading] = useState(true);
  const [terminalError, setTerminalError]     = useState('');

  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');

  // Phones only: which full-screen view is showing. On lg+ everything is
  // visible at once, so this has no effect there.
  const [activeTab, setActiveTab] = useState('terminal');

  const navigate        = useNavigate();
  const successTimerRef = useRef(null);
  const mapRef          = useRef(null);

  // ── API fetching ───────────────────────────────────────────────────────────

  const fetchActiveTrips = useCallback(async (signal) => {
    try {
      const response = await apiClient.get('/trips/live', { signal });
      setActiveTrips(Array.isArray(response.data) ? response.data : []);
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
      setTerminalGroups(Array.isArray(response.data) ? response.data : []);
      setTerminalError('');
    } catch (err) {
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
      setTerminalError('Could not load the terminal line-up.');
      console.error('[DispatcherDashboard] fetchTerminalVans error:', err);
    } finally {
      setTerminalLoading(false);
    }
  }, []);

  // Safety-net poll in case a socket event is missed.
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
        prev.map((t) =>
          t.id === data.tripId
            ? { ...t, seatInfo: { availableSeats: data.availableSeats, totalSeats: data.totalSeats } }
            : t
        )
      );
      // Boarding vans in the line-up show their seats too.
      fetchTerminalVans();
    };

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
      // A scan, a departure from the boarding slot, or a queue promotion
      // all change the line-up.
      fetchTerminalVans();
    };

    const handleTripDispatched = ({ trip }) => {
      if (!trip?.id) return;
      setActiveTrips((prev) => (prev.some((t) => t.id === trip.id) ? prev : [trip, ...prev]));
    };

    socket.connect();
    socket.emit('subscribe_to_map');

    socket.on('initial_locations',     handleInitialLocations);
    socket.on('van_moved',             handleVanMoved);
    socket.on('seat_update_broadcast', handleSeatUpdate);
    socket.on('trip_status_changed',   handleTripStatusChanged);
    socket.on('trip_dispatched',       handleTripDispatched);

    return () => {
      controller.abort();
      socket.off('initial_locations',     handleInitialLocations);
      socket.off('van_moved',             handleVanMoved);
      socket.off('seat_update_broadcast', handleSeatUpdate);
      socket.off('trip_status_changed',   handleTripStatusChanged);
      socket.off('trip_dispatched',       handleTripDispatched);
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

  // After a scan the van is already in its cooperative's line — on a phone,
  // jump to the Terminal tab so the dispatcher sees it lined up.
  const handleScanSuccess = useCallback((result) => {
    showSuccess(typeof result === 'string' ? result : 'QR scan successful.');
    fetchActiveTrips();
    fetchTerminalVans();
    if (!isDesktopViewport()) setActiveTab('terminal');
  }, [fetchActiveTrips, fetchTerminalVans, showSuccess]);

  // `focusMap` is used by list cards: on phones, tapping a van jumps to the
  // Map tab and centers on it. On desktop the map is already visible, so a
  // second tap simply deselects.
  const handleTripSelect = useCallback((tripId, { focusMap = false } = {}) => {
    const onPhone = !isDesktopViewport();

    if (focusMap && onPhone) {
      setSelectedTripId(tripId);
      setActiveTab('map');
    } else {
      setSelectedTripId((prev) => (prev === tripId ? null : tripId));
    }

    const loc = liveLocations[tripId];
    if (loc) {
      // Delay so the map is revealed and resized before re-centering.
      setTimeout(() => {
        mapRef.current?.setView([loc.lat, loc.lng], 14, { animate: true });
      }, focusMap && onPhone ? 140 : 0);
    }
  }, [liveLocations]);

  const handleLogout = useCallback(async () => {
    try {
      await apiClient.post('/auth/logout');
    } catch (err) {
      console.error('[DispatcherDashboard] Logout error:', err);
    } finally {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      navigate('/login', { replace: true });
    }
  }, [navigate]);

  // ── Derived data ───────────────────────────────────────────────────────────

  // Only cooperatives that actually have a scanned van in line. Anything the
  // backend still sends about idle or not-yet-scanned vans is ignored here.
  const lanes = terminalGroups
    .map((g) => ({
      ...g,
      boarding: Array.isArray(g.boarding) ? g.boarding : [],
      queued: Array.isArray(g.queued) ? g.queued : [],
    }))
    .filter((g) => g.boarding.length + g.queued.length > 0);

  const boardingCount = lanes.reduce((acc, g) => acc + g.boarding.length, 0);
  const queuedCount   = lanes.reduce((acc, g) => acc + g.queued.length, 0);
  const lineUpCount   = boardingCount + queuedCount;

  const liveCount          = activeTrips.filter((t) => liveLocations[t.id]).length;
  const awaitingScanCount  = activeTrips.filter(isAwaitingScan).length;

  // ── Render states ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-3 bg-slate-50" style={FULL_HEIGHT_STYLE}>
        <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-slate-500 font-bold tracking-wide uppercase">Connecting to Terminal…</p>
      </div>
    );
  }

  if (error) {
    return <ErrorState message={error} onRetry={() => setReloadToken((n) => n + 1)} />;
  }

  return (
    <div className="h-screen flex flex-col bg-gray-100 overflow-hidden font-sans" style={FULL_HEIGHT_STYLE}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="bg-gradient-to-r from-blue-900 to-blue-800 text-white px-3 sm:px-5 py-2.5 shadow-md z-10 shrink-0 pt-[max(0.625rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-2 sm:gap-3">
          <h1 className="text-base sm:text-lg font-black flex items-center gap-2 flex-1 min-w-0 tracking-tight">
            <span aria-hidden="true">📡</span>
            <span className="truncate">Dispatcher's View</span>
          </h1>

          <span className="text-[11px] sm:text-xs font-bold bg-blue-950/50 border border-blue-700/50 px-2.5 py-1 rounded-full shadow-inner whitespace-nowrap">
            {activeTrips.length} {activeTrips.length === 1 ? 'Trip' : 'Trips'}
          </span>

          <button
            onClick={handleLogout}
            aria-label="Log out"
            className="bg-slate-700/50 hover:bg-slate-700 active:bg-slate-800 text-white text-sm font-bold h-10 px-3 rounded-lg transition-colors border border-slate-600 flex items-center gap-1.5"
          >
            <span aria-hidden="true">🚪</span>
            <span className="hidden sm:inline">Logout</span>
          </button>
        </div>

        {/* The dispatcher's one job: scan vans in. Big thumb target on phones. */}
        <button
          onClick={() => setIsScannerOpen(true)}
          className="mt-2.5 w-full sm:w-auto sm:ml-auto bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-white text-sm font-bold min-h-[44px] px-5 rounded-xl transition-colors shadow-sm flex items-center justify-center gap-2"
        >
          📸 Scan QR
          {awaitingScanCount > 0 && (
            <span
              className="px-2 h-5 rounded-full bg-white text-emerald-700 text-[11px] font-black flex items-center justify-center"
              title="Vans that have arrived and are waiting to be scanned"
            >
              {awaitingScanCount} waiting
            </span>
          )}
        </button>
      </header>

      {successMessage && (
        <div
          role="status"
          className="bg-emerald-100 border-b border-emerald-300 text-emerald-800 px-4 py-2.5 text-sm text-center font-bold z-10 shadow-sm shrink-0"
        >
          ✅ {successMessage}
        </div>
      )}

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden relative z-0">

        {/* ── Sidebar (phones: full-screen Terminal / Fleet tabs) ──────────── */}
        <aside
          className={`${activeTab === 'map' ? 'hidden' : 'flex'} lg:flex w-full lg:w-80 xl:w-96 bg-white lg:border-r border-slate-200 flex-col overflow-hidden lg:shadow-2xl z-10`}
        >
          <div className="p-3 lg:p-4 border-b border-slate-100 grid grid-cols-4 lg:grid-cols-2 gap-2 lg:gap-3 bg-slate-50/50 shrink-0">
            <MetricCard label="Active"   value={activeTrips.length} />
            <MetricCard label="Boarding" value={boardingCount} highlight />
            <MetricCard label="In line"  value={queuedCount} />
            <MetricCard label="GPS live" value={liveCount} />
          </div>

          <div className="flex-1 overflow-y-auto overscroll-contain p-3 lg:p-4 bg-slate-50 space-y-6">

            {/* ── Terminal line-up, one lane per cooperative ───────────────── */}
            <div className={activeTab === 'terminal' ? 'block' : 'hidden lg:block'}>
              <h2 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-3 flex justify-between items-center">
                🚏 Terminal Line-up
                <span className="text-purple-500 font-bold">{lineUpCount}</span>
              </h2>

              {terminalError && (
                <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-2">
                  {terminalError}
                </div>
              )}

              {terminalLoading ? (
                <div className="text-center py-8 border-2 border-dashed border-slate-200 rounded-2xl bg-white">
                  <p className="text-xs font-semibold text-slate-400">Loading line-up…</p>
                </div>
              ) : lanes.length === 0 ? (
                <div className="text-center py-8 px-4 border-2 border-dashed border-slate-200 rounded-2xl bg-white">
                  <span className="text-2xl mb-1 block">📸</span>
                  <p className="text-xs font-bold text-slate-500">No scanned vans yet.</p>
                  <p className="text-xs text-slate-400 mt-1">
                    A van joins its cooperative's line here as soon as you scan its QR at the terminal.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  {lanes.map((group) => (
                    <CooperativeLane key={group.cooperativeId ?? 'unassigned'} group={group} />
                  ))}
                </div>
              )}
            </div>

            {/* ── Live fleet ───────────────────────────────────────────────── */}
            <div className={activeTab === 'fleet' ? 'block' : 'hidden lg:block'}>
              <h2 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-3 flex justify-between">
                Live Fleet
                <span className="text-blue-500 font-bold">{activeTrips.length}</span>
              </h2>

              {activeTrips.length === 0 ? (
                <div className="text-center py-12 border-2 border-dashed border-slate-200 rounded-2xl bg-white">
                  <span className="text-3xl mb-2 block">🚐</span>
                  <p className="text-sm font-bold text-slate-600">No active trips.</p>
                  <p className="text-xs text-slate-400 mt-1 font-medium">Trips appear here when drivers start them.</p>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {activeTrips.map((trip) => (
                    <TripCard
                      key={trip.id}
                      trip={trip}
                      liveData={liveLocations[trip.id]}
                      isSelected={selectedTripId === trip.id}
                      onClick={() => handleTripSelect(trip.id, { focusMap: true })}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </aside>

        {/* ── Map (phones: its own tab) ────────────────────────────────────── */}
        <main className={`${activeTab === 'map' ? 'block' : 'hidden'} lg:block flex-1 relative z-0 bg-slate-200`}>
          <MapContainer
            center={MAP_CENTER}
            zoom={MAP_ZOOM}
            className="h-full w-full"
            ref={mapRef}
            zoomControl={false}
          >
            <MapInvalidator active={activeTab === 'map'} />

            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />

            {activeTrips.map((trip) => {
              const loc = liveLocations[trip.id];
              const hasGps = typeof loc?.lat === 'number' && typeof loc?.lng === 'number';

              let position = null;
              if (hasGps) {
                position = [loc.lat, loc.lng];
              } else if (trip.status === 'BOARDING' || trip.status === 'QUEUED') {
                position = fallbackPositionForTrip(trip);
              }

              if (!position) return null;

              return (
                <Marker
                  key={trip.id}
                  position={position}
                  icon={getVanIconForStatus(trip.status)}
                  eventHandlers={{ click: () => handleTripSelect(trip.id) }}
                >
                  <Popup className="dispatcher-popup">
                    <div className="min-w-[160px] p-1">
                      <p className="font-black text-sm text-slate-900 mb-0.5">
                        {trip.driver?.name ?? 'Assigned Driver'}
                      </p>
                      <p className="text-xs font-bold text-emerald-700 uppercase tracking-widest mb-1">
                        {trip.van?.plateNumber ?? 'Unknown plate'}
                      </p>
                      <p className="text-[11px] font-semibold text-slate-500">
                        {directionLabel(trip)}
                      </p>
                      <p className="text-[11px] font-semibold text-slate-400 mb-2">
                        🏢 {cooperativeName(trip)}
                      </p>

                      <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-slate-100">
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

          {activeTrips.length > 0 && liveCount === 0 && (
            <div className="absolute bottom-4 lg:bottom-6 left-1/2 -translate-x-1/2 w-[calc(100%-2rem)] max-w-sm bg-white/90 backdrop-blur-sm border-2 border-amber-200 text-amber-800 text-xs font-bold px-4 py-2.5 rounded-full shadow-lg pointer-events-none z-[1000] flex items-center justify-center gap-2 text-center">
              <span className="animate-spin text-base leading-none">⏳</span>
              Waiting for drivers to establish GPS links…
            </div>
          )}
        </main>
      </div>

      {/* ── Mobile bottom tabs ─────────────────────────────────────────────── */}
      <MobileTabBar
        activeTab={activeTab}
        onChange={setActiveTab}
        terminalCount={lineUpCount}
        fleetCount={activeTrips.length}
      />

      {/* ── Modal ──────────────────────────────────────────────────────────── */}
      <QRScannerModal
        isOpen={isScannerOpen}
        onClose={() => setIsScannerOpen(false)}
        onSuccess={handleScanSuccess}
      />
    </div>
  );
}
