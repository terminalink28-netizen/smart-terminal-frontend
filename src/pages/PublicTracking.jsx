import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import apiClient from "../api/axios";
import { socket } from "../api/socket";
import { VIRAC_HUB, getCoordinatesForDestination } from "../components/townCoordinates";

const MAP_CENTER = [13.5820477, 124.2192987];
const REFETCH_INTERVAL_MS = 30_000;
const GPS_STALE_THRESHOLD_MS = 120_000;
const OSRM_BASE_URL = 'https://router.project-osrm.org/route/v1/driving';

const BOARDING_STATUSES = ['BOARDING'];
const DRIVING_STATUSES = ['DEPARTING', 'DEPARTED', 'ARRIVING', 'DELAYED'];
const MAP_VISIBLE_STATUSES = [...BOARDING_STATUSES, ...DRIVING_STATUSES];

const STATUS_CONFIG = {
  BOARDING: { label: 'Boarding', cls: 'bg-green-100 text-green-800 border-green-200' },
  DEPARTING: { label: 'Departing', cls: 'bg-amber-100 text-amber-800 border-amber-200' },
  DEPARTED: { label: 'En Route', cls: 'bg-blue-100 text-blue-800 border-blue-200' },
  ARRIVING: { label: 'Arriving Soon', cls: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
  DELAYED: { label: 'Delayed', cls: 'bg-orange-100 text-orange-800 border-orange-200' },
};

function msToKmh(mps) {
  return Math.round((mps ?? 0) * 3.6);
}

function relativeTime(ts) {
  if (!ts) return null;
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return 'over an hour ago';
}

function shortPlaceName(name) {
  return (name ?? 'Unknown').replace(/\s*Terminal$/i, '');
}

function isViracHub(name) {
  return typeof name === 'string' && name.toLowerCase().includes('virac');
}

function formatScheduledTime(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return null;
  }
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return null;
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
}

const vanIcon = L.divIcon({
  className: '',
  html: `
    <div style="
      font-size:18px;
      background:white;
      border-radius:50%;
      padding:4px;
      border:3px solid #16a34a;
      width:36px;
      height:36px;
      display:flex;
      align-items:center;
      justify-content:center;
      box-shadow:0 4px 12px rgba(22,163,74,0.35);
    ">🚐</div>
  `,
  iconSize: [36, 36],
  iconAnchor: [18, 18],
  popupAnchor: [0, -22],
});

const hubIcon = L.divIcon({
  className: '',
  html: `
    <div style="
      font-size:16px;
      background:#1e3a2f;
      border-radius:50%;
      padding:5px;
      border:3px solid #6ee7b7;
      width:34px;
      height:34px;
      display:flex;
      align-items:center;
      justify-content:center;
      box-shadow:0 4px 8px rgba(0,0,0,0.3);
    ">🏛️</div>
  `,
  iconSize: [34, 34],
  iconAnchor: [17, 17],
  popupAnchor: [0, -20],
});

function MapBoundsFitter({ positions }) {
  const map = useMap();

  useEffect(() => {
    if (!positions.length) return;

    try {
      const bounds = L.latLngBounds([VIRAC_HUB, ...positions]);
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 13 });
    } catch {
      // ignore malformed coords
    }
  }, [map, positions]);

  return null;
}

function ETACountdown({ etaIso }) {
  const [label, setLabel] = useState('');

  useEffect(() => {
    if (!etaIso) return;

    const tick = () => {
      const diff = new Date(etaIso).getTime() - Date.now();
      if (diff <= 0) {
        setLabel('Arriving now');
        return;
      }

      const h = Math.floor(diff / 3_600_000);
      const m = Math.floor((diff % 3_600_000) / 60_000);
      const s = Math.floor((diff % 60_000) / 1_000);

      setLabel(h > 0 ? `${h}h ${m}m away` : m > 0 ? `${m}m ${s}s away` : `${s}s away`);
    };

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [etaIso]);

  if (!etaIso || !label) return null;

  return <span className="tabular-nums font-bold text-indigo-700">{label}</span>;
}

function EmptyState({ icon, text }) {
  return (
    <div className="text-center py-5 rounded-xl border-2 border-dashed border-gray-100">
      <div className="text-2xl mb-1" aria-hidden="true">
        {icon}
      </div>
      <p className="text-sm text-gray-400 font-medium">{text}</p>
    </div>
  );
}

async function fetchOsrmRoute(startCoords, endCoords, signal) {
  const [startLat, startLng] = startCoords;
  const [endLat, endLng] = endCoords;

  const url = `${OSRM_BASE_URL}/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=geojson&steps=false`;
  const res = await fetch(url, { signal });

  if (!res.ok) {
    throw new Error(`OSRM request failed (${res.status})`);
  }

  const data = await res.json();
  const route = data?.routes?.[0];

  if (!route?.geometry?.coordinates?.length) {
    return null;
  }

  return {
    coords: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    distanceMeters: route.distance ?? null,
    durationSeconds: route.duration ?? null,
  };
}

export default function PublicTracking() {
  const navigate = useNavigate();

  const [activeTrips, setActiveTrips] = useState([]);
  const [liveData, setLiveData] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [socketStatus, setSocketStatus] = useState('connecting');
  const [tick, setTick] = useState(0);
  const [liveEtas, setLiveEtas] = useState({});
  const [selectedTripId, setSelectedTripId] = useState(null);
  const [selectedRoute, setSelectedRoute] = useState({
    coords: [],
    loading: false,
    error: '',
    distanceMeters: null,
    durationSeconds: null,
  });

  const fetchActiveTrips = useCallback(async (signal) => {
    try {
      const res = await apiClient.get('/trips/live', { signal }); 
      setActiveTrips(Array.isArray(res.data) ? res.data : []);
      setError('');
    } catch (err) {
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
      setError('Unable to load live tracking data. Check your connection.');
      console.error('[PublicTracking] fetchActiveTrips failed', err);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);

    fetchActiveTrips(controller.signal).finally(() => setLoading(false));

    const onConnect = () => setSocketStatus('connected');
    const onDisconnect = () => setSocketStatus('disconnected');

    const onInitialLocations = (payload = []) => {
      if (!Array.isArray(payload)) return;

      try {
        setLiveData(Object.fromEntries(payload));
      } catch {
        // ignore malformed payloads
      }
    };

    const onVanMoved = (data) => {
      if (!data?.tripId || typeof data.lat !== 'number' || typeof data.lng !== 'number') return;

      setLiveData((prev) => ({
        ...prev,
        [data.tripId]: {
          ...(prev[data.tripId] ?? {}),
          lat: data.lat,
          lng: data.lng,
          speed: data.speed ?? 0,
          lastSeen: Date.now(),
        },
      }));
    };

    const onSeatUpdate = (data) => {
      if (!data?.tripId || typeof data.availableSeats !== 'number') return;

      setLiveData((prev) => ({
        ...prev,
        [data.tripId]: {
          ...(prev[data.tripId] ?? {}),
          availableSeats: data.availableSeats,
          totalSeats: data.totalSeats,
        },
      }));
    };

    const onTripStatusChanged = ({ tripId, trip } = {}) => {
      if (!tripId) return;

      setActiveTrips((prev) => {
        if (trip?.status === 'COMPLETED' || trip?.status === 'CANCELLED') {
          return prev.filter((t) => t.id !== tripId);
        }

        const exists = prev.some((t) => t.id === tripId);
        if (exists) return prev.map((t) => (t.id === tripId ? { ...t, ...trip } : t));
        if (trip) return [...prev, trip];
        return prev;
      });
    };

    const onTripDispatched = ({ trip } = {}) => {
      if (!trip?.id) return;
      setActiveTrips((prev) => (prev.some((t) => t.id === trip.id) ? prev : [...prev, trip]));
    };

    const onEtaUpdate = ({ tripId, eta, delayMinutes } = {}) => {
      if (!tripId || !eta) return;
      setLiveEtas((prev) => ({
        ...prev,
        [tripId]: { eta, delayMinutes: delayMinutes ?? 0 },
      }));
    };

    socket.connect();
    socket.emit('subscribe_to_map');
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('initial_locations', onInitialLocations);
    socket.on('van_moved', onVanMoved);
    socket.on('seat_update_broadcast', onSeatUpdate);
    socket.on('trip_status_changed', onTripStatusChanged);
    socket.on('trip_dispatched', onTripDispatched);
    socket.on('eta_update', onEtaUpdate);

    return () => {
      controller.abort();
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('initial_locations', onInitialLocations);
      socket.off('van_moved', onVanMoved);
      socket.off('seat_update_broadcast', onSeatUpdate);
      socket.off('trip_status_changed', onTripStatusChanged);
      socket.off('trip_dispatched', onTripDispatched);
      socket.off('eta_update', onEtaUpdate);
      socket.disconnect();
    };
  }, [fetchActiveTrips, reloadToken]);

  useEffect(() => {
    const id = setInterval(() => {
      const ctrl = new AbortController();
      fetchActiveTrips(ctrl.signal);
    }, REFETCH_INTERVAL_MS);

    return () => clearInterval(id);
  }, [fetchActiveTrips]);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  const boardingTrips = useMemo(
    () => activeTrips.filter((t) => BOARDING_STATUSES.includes(t.status)),
    [activeTrips]
  );

  const drivingTrips = useMemo(
    () => activeTrips.filter((t) => DRIVING_STATUSES.includes(t.status)),
    [activeTrips]
  );

  const mapTrips = useMemo(
    () => activeTrips.filter((t) => MAP_VISIBLE_STATUSES.includes(t.status)),
    [activeTrips]
  );

  // Updated to include boarding vans at their terminals
  const activeVanPositions = useMemo(() => {
    return mapTrips
      .map((trip) => {
        const data = liveData[trip.id];
        // 1. Use live GPS if we have it
        if (typeof data?.lat === 'number' && typeof data?.lng === 'number') {
          return [data.lat, data.lng];
        }
        // 2. Fallback to the terminal's coordinates if they are boarding
        if (trip.status === 'BOARDING') {
          const originName = trip.route?.origin;
          return getCoordinatesForDestination(originName) ?? 
                 (isViracHub(originName) ? VIRAC_HUB : null);
        }
        return null;
      })
      .filter(Boolean);
  }, [mapTrips, liveData]);

  const selectedTrip = useMemo(
    () => activeTrips.find((t) => t.id === selectedTripId) ?? null,
    [activeTrips, selectedTripId]
  );

  const selectedTripLive = selectedTripId ? liveData[selectedTripId] : null;
  const selectedTripEta = selectedTripId ? liveEtas[selectedTripId] ?? null : null;
  const selectedStatusCfg = selectedTrip ? STATUS_CONFIG[selectedTrip.status] ?? STATUS_CONFIG.DEPARTED : null;

  useEffect(() => {
    if (!selectedTripId) {
      setSelectedRoute({
        coords: [],
        loading: false,
        error: '',
        distanceMeters: null,
        durationSeconds: null,
      });
      return;
    }

    if (!selectedTrip) {
      setSelectedRoute({
        coords: [],
        loading: false,
        error: '',
        distanceMeters: null,
        durationSeconds: null,
      });
      return;
    }

    const destCoords = getCoordinatesForDestination(selectedTrip.route?.destination);
    const liveStart =
      typeof selectedTripLive?.lat === 'number' && typeof selectedTripLive?.lng === 'number'
        ? [selectedTripLive.lat, selectedTripLive.lng]
        : null;

    const plannedStart =
      getCoordinatesForDestination(selectedTrip.route?.origin) ??
      (isViracHub(selectedTrip.route?.origin) ? VIRAC_HUB : null) ??
      VIRAC_HUB;

    const startCoords = liveStart ?? plannedStart;
    const endCoords = destCoords ?? VIRAC_HUB;

    if (!startCoords || !endCoords) {
      setSelectedRoute({
        coords: [],
        loading: false,
        error: 'Route coordinates are unavailable.',
        distanceMeters: null,
        durationSeconds: null,
      });
      return;
    }

    const controller = new AbortController();

    setSelectedRoute((prev) => ({
      ...prev,
      loading: true,
      error: '',
    }));

    fetchOsrmRoute(startCoords, endCoords, controller.signal)
      .then((route) => {
        if (controller.signal.aborted) return;

        if (!route) {
          setSelectedRoute({
            coords: [],
            loading: false,
            error: 'Unable to build road route for this trip.',
            distanceMeters: null,
            durationSeconds: null,
          });
          return;
        }

        setSelectedRoute({
          coords: route.coords,
          loading: false,
          error: '',
          distanceMeters: route.distanceMeters,
          durationSeconds: route.durationSeconds,
        });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        console.error('[PublicTracking] route fetch failed', err);
        setSelectedRoute({
          coords: [],
          loading: false,
          error: 'Unable to load road route.',
          distanceMeters: null,
          durationSeconds: null,
        });
      });

    return () => controller.abort();
  }, [
    selectedTripId,
    selectedTrip,
    selectedTripLive?.lat,
    selectedTripLive?.lng,
  ]);

  const selectedRoutePositions = selectedRoute.coords;
  const mapFocusPositions = selectedRoutePositions.length > 0 ? selectedRoutePositions : activeVanPositions;

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center">
          <div className="text-3xl font-black text-emerald-800">TERMINALINK</div>
          <p className="mt-2 text-sm text-gray-500">Loading live tracking…</p>
        </div>
      </div>
    );
  }

  if (error && activeTrips.length === 0) {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-50 p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-lg p-6 text-center">
          <div className="text-4xl">📡</div>
          <h1 className="text-xl font-black text-gray-800">Connection Error</h1>
          <p className="mt-3 text-sm text-red-700 bg-red-50 border border-red-100 rounded-lg p-3 leading-relaxed">
            {error}
          </p>
          <button
            onClick={() => setReloadToken((n) => n + 1)}
            className="mt-4 w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-3 rounded-xl transition-colors"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-slate-50 font-sans">
      <header className="bg-gradient-to-r from-emerald-900 to-emerald-700 text-white px-4 py-3 shadow-lg z-10 relative shrink-0">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-black tracking-tight leading-none">TERMINALINK</h1>
            <p className="text-emerald-200 text-xs font-medium mt-0.5">
              Real-time GPS & Passenger Tracking
            </p>
          </div>

          <div className="flex items-center gap-3">
            <div
              className={`hidden sm:flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full border ${
                socketStatus === 'connected'
                  ? 'bg-emerald-500/20 border-emerald-400/40 text-emerald-100'
                  : socketStatus === 'disconnected'
                  ? 'bg-red-500/20 border-red-400/40 text-red-200'
                  : 'bg-yellow-500/20 border-yellow-400/40 text-yellow-200'
              }`}
            >
              {socketStatus === 'connected' && (
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-300 opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-300" />
                </span>
              )}
              {socketStatus === 'connected'
                ? 'LIVE'
                : socketStatus === 'disconnected'
                ? '✕ Offline'
                : '○ Connecting'}
            </div>

            <button
              onClick={() => navigate('/login')}
              className="bg-white/15 hover:bg-white/25 active:bg-white/35 border border-white/20 px-3 py-1.5 rounded-lg text-sm font-bold transition"
            >
              Staff Access
            </button>
          </div>
        </div>
      </header>

      {socketStatus === 'disconnected' && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-center text-sm text-amber-800 font-medium z-10 shrink-0">
          ⚠️ Live updates paused — reconnecting…{' '}
          <button
            onClick={() => setReloadToken((n) => n + 1)}
            className="ml-1 underline font-bold hover:text-amber-900"
          >
            Reload
          </button>
        </div>
      )}

      {error && activeTrips.length > 0 && (
        <div className="bg-red-50 border-b border-red-200 px-4 py-2 text-center text-sm text-red-700 z-10 shrink-0">
          ⚠️ {error}
        </div>
      )}

      <div className="flex flex-col md:flex-row flex-1 overflow-hidden relative z-0">
        <div className="flex-1 md:w-2/3 h-[45vh] md:h-full relative z-0">
          <MapContainer center={MAP_CENTER} zoom={11} className="h-full w-full">
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />

            <MapBoundsFitter positions={mapFocusPositions} />

            <Marker position={VIRAC_HUB} icon={hubIcon}>
              <Popup>
                <div className="min-w-[160px] space-y-1">
                  <p className="font-bold text-gray-800 text-sm">Virac Central Terminal</p>
                  <p className="text-xs text-gray-500">
                    {boardingTrips.length} boarding · {drivingTrips.length} on road
                  </p>
                </div>
              </Popup>
            </Marker>

            {mapTrips.map((trip) => {
              const data = liveData[trip.id];
              const hasGps = typeof data?.lat === 'number' && typeof data?.lng === 'number';
              const isSelected = selectedTripId === trip.id;

              // Updated to pin boarding vans if GPS isn't live
              let position = null;
              if (hasGps) {
                position = [data.lat, data.lng];
              } else if (trip.status === 'BOARDING') {
                const originName = trip.route?.origin;
                position = getCoordinatesForDestination(originName) ?? 
                           (isViracHub(originName) ? VIRAC_HUB : null);
              }

              if (!position) return null;

              return (
                <Marker
                  key={trip.id}
                  position={position}
                  icon={vanIcon}
                  eventHandlers={{
                    click: () => setSelectedTripId(trip.id),
                  }}
                >
                  <Popup minWidth={200}>
                    <div className="space-y-1.5 py-0.5">
                      <div className="font-bold text-gray-900 text-sm leading-snug">
                        {trip.driver?.name || 'Assigned Driver'}
                      </div>
                      <div className="text-xs text-gray-500 font-semibold uppercase tracking-wide truncate">
                        <span className="text-emerald-700">{trip.van?.plateNumber ?? '—'}</span>
                        {trip.status === 'BOARDING'
                          ? ' · Loading passengers'
                          : trip.status === 'DEPARTED'
                          ? ' · En route'
                          : ` · ${STATUS_CONFIG[trip.status]?.label ?? trip.status}`}
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className={`text-xs font-bold px-2 py-0.5 rounded border ${STATUS_CONFIG[trip.status]?.cls ?? STATUS_CONFIG.DEPARTED.cls}`}>
                          {STATUS_CONFIG[trip.status]?.label ?? trip.status}
                        </span>
                        <button
                          type="button"
                          onClick={() => setSelectedTripId(trip.id)}
                          className={`text-xs font-bold px-2 py-0.5 rounded border transition ${
                            isSelected
                              ? 'bg-emerald-600 text-white border-emerald-600'
                              : 'bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50'
                          }`}
                        >
                          View details
                        </button>
                      </div>
                    </div>
                  </Popup>
                </Marker>
              );
            })}

            {selectedTripId && selectedRoutePositions.length > 1 && (
              <Polyline
                positions={selectedRoutePositions}
                pathOptions={{
                  color: '#059669',
                  weight: 5,
                  opacity: 0.9,
                  lineCap: 'round',
                  lineJoin: 'round',
                }}
              />
            )}
          </MapContainer>
        </div>

        <div className="h-[55vh] md:h-full md:w-1/3 bg-white overflow-hidden shadow-2xl flex flex-col z-10">
          <div className="flex border-b border-gray-100 divide-x divide-gray-100 bg-slate-50 shrink-0">
            {[
              { count: boardingTrips.length, label: 'Boarding', color: 'text-emerald-700' },
              { count: drivingTrips.length, label: 'On Road', color: 'text-blue-700' },
              { count: Object.keys(liveEtas).length, label: 'ETA Live', color: 'text-indigo-700' },
            ].map(({ count, label, color }) => (
              <div key={label} className="flex-1 py-3 text-center">
                <div className={`text-2xl font-black ${color}`}>{count}</div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mt-0.5">
                  {label}
                </div>
              </div>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-4 md:p-5 space-y-5">
            <section>
              <h2 className="font-black text-emerald-800 text-sm uppercase tracking-widest flex items-center gap-2 mb-3">
                🎟️ Boarding Now
                {boardingTrips.length > 0 && (
                  <span className="ml-auto text-xs font-bold bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">
                    {boardingTrips.length}
                  </span>
                )}
              </h2>

              {boardingTrips.length === 0 ? (
                <EmptyState icon="🅿️" text="No vans boarding right now" />
              ) : (
                <div className="space-y-3">
                  {boardingTrips.map((trip) => {
                    const data = liveData[trip.id];
                    const seatsLeft = data?.availableSeats ?? trip.van?.capacity ?? 0;
                    const isFull = seatsLeft === 0;
                    const isSelected = selectedTripId === trip.id;

                    return (
                      <button
                        key={trip.id}
                        type="button"
                        onClick={() => setSelectedTripId(trip.id)}
                        className={`w-full text-left p-4 rounded-xl border-2 shadow-sm transition-all ${
                          isSelected
                            ? 'bg-emerald-100 border-emerald-400 ring-2 ring-emerald-200'
                            : isFull
                            ? 'bg-gray-50 border-gray-200'
                            : 'bg-emerald-50 border-emerald-200 hover:shadow-md'
                        }`}
                      >
                        <div className="flex justify-between items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <div
                              className={`text-base leading-tight ${
                                trip.driver?.name ? 'font-black text-gray-900' : 'font-medium italic text-gray-400'
                              }`}
                            >
                              {trip.driver?.name ?? 'No driver assigned'}
                            </div>

                            <div className="text-xs text-gray-500 uppercase tracking-widest mt-1 truncate">
                              <span className="text-emerald-700 font-black">
                                {trip.van?.plateNumber ?? 'Unknown plate'}
                              </span>
                            </div>
                          </div>

                          <div
                            className={`shrink-0 text-center px-3 py-2 rounded-lg min-w-[56px] ${
                              isFull
                                ? 'bg-gray-200 text-gray-500'
                                : seatsLeft === 0
                                ? 'bg-gray-100 text-gray-400'
                                : 'bg-white shadow-sm border border-emerald-100 text-emerald-700'
                            }`}
                          >
                            <div className="text-xl font-black leading-none">{seatsLeft}</div>
                            <div className="text-[9px] font-bold uppercase mt-0.5">
                              {isFull ? 'Full' : 'Left'}
                            </div>
                          </div>
                        </div>

                        <div className="mt-2 text-xs text-gray-500 font-medium">
                          Tap to view details
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="border-t border-gray-100 pt-4">
              <h2 className="font-black text-blue-900 text-sm uppercase tracking-widest flex items-center gap-2 mb-3">
                🚐 On the Road
                {drivingTrips.length > 0 && (
                  <span className="ml-auto text-xs font-bold bg-blue-100 text-blue-800 px-2 py-0.5 rounded-full">
                    {drivingTrips.length}
                  </span>
                )}
              </h2>

              {drivingTrips.length === 0 ? (
                <EmptyState icon="🛣️" text="No vans currently in transit" />
              ) : (
                <div className="space-y-3">
                  {drivingTrips.map((trip) => {
                    const data = liveData[trip.id];
                    const hasGps = typeof data?.lat === 'number' && typeof data?.lng === 'number';
                    const isStale = hasGps && data?.lastSeen && Date.now() - data.lastSeen > GPS_STALE_THRESHOLD_MS;
                    const isSelected = selectedTripId === trip.id;

                    return (
                      <button
                        key={trip.id}
                        type="button"
                        onClick={() => setSelectedTripId(trip.id)}
                        className={`w-full text-left p-4 border rounded-xl shadow-sm transition-shadow ${
                          isSelected
                            ? 'bg-blue-50 border-blue-300 ring-2 ring-blue-100'
                            : 'bg-white border-gray-100 hover:shadow-md'
                        }`}
                      >
                        <div className="flex justify-between items-start gap-2 mb-2.5">
                          <div className="min-w-0">
                            <div className="font-bold text-gray-900 text-base leading-tight truncate">
                              {trip.driver?.name || 'Assigned Driver'}
                            </div>
                            <div className="text-xs text-gray-400 font-bold uppercase tracking-widest mt-0.5 truncate">
                              <span className="text-blue-700">{trip.van?.plateNumber ?? '—'}</span>
                            </div>
                          </div>

                          <span className={`shrink-0 text-xs font-bold px-2 py-1 rounded border ${STATUS_CONFIG[trip.status]?.cls ?? STATUS_CONFIG.DEPARTED.cls}`}>
                            {STATUS_CONFIG[trip.status]?.label ?? trip.status}
                          </span>
                        </div>

                        {hasGps && !isStale ? (
                          <div className="text-xs flex items-center justify-between bg-blue-50 text-blue-700 px-3 py-2 rounded-lg font-semibold">
                            <span className="flex items-center gap-1.5">
                              <span className="relative flex h-1.5 w-1.5">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500" />
                              </span>
                              {msToKmh(data?.speed) > 0 ? `${msToKmh(data.speed)} km/h` : 'Stopped'}
                            </span>
                            {data?.lastSeen && (
                              <span className="text-[10px] text-blue-400 font-normal" key={tick}>
                                {relativeTime(data.lastSeen)}
                              </span>
                            )}
                          </div>
                        ) : isStale ? (
                          <div className="text-xs flex items-center gap-1.5 bg-amber-50 text-amber-700 px-3 py-2 rounded-lg font-semibold">
                            ⚠️ GPS signal lost · last seen {relativeTime(data?.lastSeen)}
                          </div>
                        ) : (
                          <div className="text-xs flex items-center gap-1.5 bg-yellow-50 text-yellow-700 px-3 py-2 rounded-lg font-semibold">
                            <span className="animate-spin inline-block" aria-hidden="true">
                              ⏳
                            </span>
                            Establishing GPS link…
                          </div>
                        )}

                        <div className="mt-2 text-xs text-gray-500 font-medium">
                          Tap to view details
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="border-t border-gray-100 pt-4">
              <h2 className="font-black text-gray-900 text-sm uppercase tracking-widest mb-3">
                Selected Van
              </h2>

              {!selectedTrip ? (
                <EmptyState icon="👆" text="Tap a van on the map or in the list to view details" />
              ) : (
                <div className="p-4 rounded-xl border-2 border-gray-200 bg-white shadow-sm space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-lg font-black text-gray-900 truncate">
                        {selectedTrip.driver?.name || 'Assigned Driver'}
                      </div>
                      <div className="text-xs text-gray-500 uppercase tracking-widest mt-1">
                        {selectedTrip.van?.plateNumber ?? 'Unknown plate'}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => setSelectedTripId(null)}
                      className="text-xs font-bold text-gray-500 hover:text-gray-700"
                    >
                      Clear
                    </button>
                  </div>

                  <div className={`inline-flex text-xs font-bold px-2 py-1 rounded border ${selectedStatusCfg.cls}`}>
                    {selectedStatusCfg.label}
                  </div>

                  <div className="text-sm text-gray-600 space-y-1">
                    <p>
                      <span className="font-semibold text-gray-900">Route:</span>{' '}
                      {shortPlaceName(selectedTrip.route?.origin)} → {shortPlaceName(selectedTrip.route?.destination)}
                    </p>
                    <p>
                      <span className="font-semibold text-gray-900">Direction:</span>{' '}
                      {selectedTrip.status === 'BOARDING'
                        ? 'Loading at terminal'
                        : isViracHub(selectedTrip.route?.destination)
                        ? 'Returning to Virac'
                        : 'Heading out'}
                    </p>
                    {selectedTripLive?.lat === undefined || selectedTripLive?.lng === undefined ? null : (
                      <p>
                        <span className="font-semibold text-gray-900">Current speed:</span>{' '}
                        {msToKmh(selectedTripLive.speed)} km/h
                      </p>
                    )}
                    {selectedTripLive?.availableSeats !== undefined && (
                      <p>
                        <span className="font-semibold text-gray-900">Seats:</span>{' '}
                        {selectedTripLive.availableSeats}/{selectedTripLive.totalSeats ?? selectedTrip.van?.capacity ?? '?'} available
                      </p>
                    )}
                  </div>

                  {selectedTripEta && (
                    <div className="pt-2 border-t border-gray-100 space-y-1">
                      <p className="text-xs font-bold text-indigo-700">
                        🕒 ETA Virac:{' '}
                        {new Date(selectedTripEta.eta).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </p>
                      <p className="text-xs text-indigo-500">
                        <ETACountdown etaIso={selectedTripEta.eta} />
                      </p>
                      {selectedTripEta.delayMinutes > 0 && (
                        <p className="text-xs text-amber-600 font-semibold">
                          +{selectedTripEta.delayMinutes}m delay reported
                        </p>
                      )}
                    </div>
                  )}

                  {selectedRoute.loading && (
                    <div className="text-xs text-gray-500 bg-gray-50 px-3 py-2 rounded-lg">
                      Building road route…
                    </div>
                  )}

                  {selectedRoute.error && !selectedRoute.loading && (
                    <div className="text-xs text-red-700 bg-red-50 border border-red-100 px-3 py-2 rounded-lg">
                      {selectedRoute.error}
                    </div>
                  )}

                  {selectedRoute.coords.length > 1 && (
                    <div className="text-xs text-emerald-700 bg-emerald-50 px-3 py-2 rounded-lg">
                      Road route loaded
                      {selectedRoute.distanceMeters != null && selectedRoute.durationSeconds != null && (
                        <>
                          {' '}
                          · {Math.round(selectedRoute.distanceMeters / 1000)} km ·{' '}
                          {formatDuration(selectedRoute.durationSeconds)}
                        </>
                      )}
                    </div>
                  )}

                  {formatScheduledTime(selectedTrip.scheduledAt) && (
                    <div className="text-xs text-gray-500">
                      Scheduled departure: {formatScheduledTime(selectedTrip.scheduledAt)}
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}