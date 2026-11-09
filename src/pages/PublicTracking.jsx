import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, Popup, Circle, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import apiClient from '../api/axios';
import { socket } from '../api/socket';
import { VIRAC_HUB, getCoordinatesForDestination } from '../components/townCoordinates';

// ─── Trip model (what the public sees) ───────────────────────────────────────
//
// A trip is a round trip of two legs, tracked by `direction`:
//   OUTBOUND  municipality → terminal
//   RETURN    terminal → municipality (after the dispatcher's check-in scan)
//
// There is no "approaching" step any more: a departed OUTBOUND van is simply
// "on the road to the terminal". ARRIVING is legacy and is shown as on the road.
// QUEUED only exists on the RETURN leg, and the queue is per cooperative.
// One driver can run several trips at once, so a van can appear in more than
// one row. The map shows one marker per van and lists its trips in the popup.

const MAP_CENTER = [13.5820477, 124.2192987];
const REFETCH_INTERVAL_MS    = 30_000;
const GPS_STALE_THRESHOLD_MS = 120_000;
const OSRM_BASE_URL          = 'https://router.project-osrm.org/route/v1/driving';

const HOME_TERMINAL_NAME  = 'Provincial Integrated Transport Terminal and Business Complex';
const HOME_TERMINAL_SHORT = 'Terminal';

const BOARDING_STATUSES    = ['BOARDING'];
const QUEUED_STATUSES      = ['QUEUED'];
const DRIVING_STATUSES     = ['DEPARTING', 'DEPARTED', 'ARRIVING', 'DELAYED'];
const ETA_STATUSES         = ['DEPARTING', 'DEPARTED', 'ARRIVING', 'DELAYED'];
const MAP_VISIBLE_STATUSES = [...BOARDING_STATUSES, ...QUEUED_STATUSES, ...DRIVING_STATUSES];
const STATUS_PRIORITY      = ['DEPARTED', 'ARRIVING', 'DEPARTING', 'DELAYED', 'BOARDING', 'QUEUED'];

const STOPPED_THRESHOLD_KMH    = 2;
const MOVING_HEADING_KMH       = 4;
const LOW_ACCURACY_THRESHOLD_M = 75;
const UNUSABLE_ACCURACY_M      = 250;
const ROUTE_RECALC_DISTANCE_M  = 250;

const EMPTY_ROUTE = { tripId: null, coords: [], loading: false, error: '', distanceMeters: null, durationSeconds: null };

// ─── Design primitives (same as DriverDashboard — move to components/ui.jsx) ──

const ICONS = {
  van:     'M3 16V7a1 1 0 011-1h9l5 5h2a1 1 0 011 1v4M3 16h2m12 0h-6M7 18a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM17 18a1.5 1.5 0 100-3 1.5 1.5 0 000 3z',
  pin:     'M12 21c4-4 7-7.2 7-11a7 7 0 10-14 0c0 3.8 3 7 7 11zM12 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z',
  phone:   'M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z',
  clock:   'M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  x:       'M6 6l12 12M18 6L6 18',
  signal:  'M5 19v-3M10 19v-7M15 19V9M20 19V5',
  alert:   'M12 9v4M12 17h.01M10.3 4l-8 14a2 2 0 001.7 3h16a2 2 0 001.7-3l-8-14a2 2 0 00-3.4 0z',
  refresh: 'M20 11a8 8 0 00-14.9-3M4 5v4h4M4 13a8 8 0 0014.9 3M20 19v-4h-4',
  users:   'M16 20v-1a4 4 0 00-4-4H8a4 4 0 00-4 4v1M10 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM20 20v-1a4 4 0 00-3-3.9M16 4.1a3.5 3.5 0 010 6.8',
  building:'M4 21V5a1 1 0 011-1h8a1 1 0 011 1v16M14 9h5a1 1 0 011 1v11M3 21h18M8 8h2M8 12h2M8 16h2',
  lock:    'M7 11V8a5 5 0 0110 0v3M6 11h12a1 1 0 011 1v7a1 1 0 01-1 1H6a1 1 0 01-1-1v-7a1 1 0 011-1z',
};

function Icon({ name, className = 'h-5 w-5' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

const BTN_BASE =
  'inline-flex items-center justify-center gap-2 rounded-xl text-sm font-semibold transition active:scale-[0.98] ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';
const BTN = {
  primary:   `${BTN_BASE} h-12 px-5 bg-teal-700 text-white shadow-sm hover:bg-teal-800`,
  secondary: `${BTN_BASE} h-9 px-3 border border-slate-200 bg-white text-slate-700 hover:bg-slate-50`,
  soft:      `${BTN_BASE} h-8 px-3 bg-slate-100 text-slate-700 hover:bg-slate-200`,
};

// Same colours as the driver app; wording is passenger-facing.
const STATUS_META = {
  BOARDING:  { label: 'Boarding',    hex: '#059669', pill: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20', dot: 'bg-emerald-500' },
  DEPARTING: { label: 'Departing',   hex: '#d97706', pill: 'bg-amber-50 text-amber-700 ring-amber-600/20',       dot: 'bg-amber-500' },
  DEPARTED:  { label: 'On the road', hex: '#2563eb', pill: 'bg-blue-50 text-blue-700 ring-blue-600/20',          dot: 'bg-blue-500' },
  ARRIVING:  { label: 'On the road', hex: '#2563eb', pill: 'bg-blue-50 text-blue-700 ring-blue-600/20',          dot: 'bg-blue-500' },
  QUEUED:    { label: 'In queue',    hex: '#7c3aed', pill: 'bg-violet-50 text-violet-700 ring-violet-600/20',    dot: 'bg-violet-500' },
  DELAYED:   { label: 'Delayed',     hex: '#ea580c', pill: 'bg-orange-50 text-orange-700 ring-orange-600/20',    dot: 'bg-orange-500' },
};
const statusMeta = (s) => STATUS_META[s] ?? STATUS_META.DEPARTED;

function Card({ className = '', children, ...rest }) {
  return (
    <section className={`rounded-2xl border border-slate-200/80 bg-white shadow-sm ${className}`} {...rest}>
      {children}
    </section>
  );
}

function Spinner({ className = 'h-4 w-4' }) {
  return <span className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent ${className}`} role="status" />;
}

function StatusPill({ status }) {
  const m = statusMeta(status);
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${m.pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}

function Notice({ tone = 'error', children, action }) {
  const tones = {
    error: 'border-rose-200 bg-rose-50 text-rose-800',
    warn:  'border-amber-200 bg-amber-50 text-amber-800',
    info:  'border-slate-200 bg-slate-50 text-slate-700',
  };
  return (
    <div role={tone === 'error' ? 'alert' : undefined}
      className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm ${tones[tone]}`}>
      <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 font-medium">{children}</div>
      {action}
    </div>
  );
}

function Stat({ label, children }) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2.5">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-0.5 truncate text-sm font-semibold text-slate-900">{children}</p>
    </div>
  );
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

const msToKmh = (mps) => (typeof mps !== 'number' || Number.isNaN(mps) ? null : Math.round(mps * 3.6));

function relativeTime(ts) {
  if (!ts) return null;
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return 'over an hour ago';
}

const isHomeTerminal = (name) =>
  typeof name === 'string' && name.trim().toLowerCase() === HOME_TERMINAL_NAME.toLowerCase();
const shortPlaceName = (name) =>
  (isHomeTerminal(name) ? HOME_TERMINAL_SHORT : (name ?? 'Unknown').replace(/\s*Terminal$/i, ''));

function formatTime(iso) {
  if (!iso) return null;
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch { return null; }
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return null;
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const r = mins % 60;
  return r > 0 ? `${h}h ${r}m` : `${h}h`;
}

function speedLabel(smoothedSpeedMps) {
  const kmh = msToKmh(smoothedSpeedMps);
  if (kmh === null) return 'Speed unavailable';
  if (kmh < STOPPED_THRESHOLD_KMH) return 'Stopped';
  return `${kmh} km/h`;
}

function haversineMeters(a, b) {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function accuracyRing(accuracy) {
  return typeof accuracy === 'number' && accuracy > LOW_ACCURACY_THRESHOLD_M ? '#f59e0b' : '#0f766e';
}

/** Normalises a fix from either HTTP (`liveLocation`) or socket (`van_moved`). */
function normaliseFix(input) {
  if (!input) return null;
  const lat = typeof input.lat === 'number' ? input.lat : null;
  const lng = typeof input.lng === 'number' ? input.lng : null;
  if (lat === null || lng === null) return null;

  const rawSpeed = typeof input.speed === 'number' ? input.speed : null;
  const smoothedSpeed = typeof input.smoothedSpeed === 'number' ? input.smoothedSpeed : rawSpeed;
  const stamp =
    typeof input.timestamp === 'number' ? input.timestamp :
    typeof input.lastSeen === 'number'  ? input.lastSeen  : Date.now();

  return {
    lat, lng,
    speed: rawSpeed,
    smoothedSpeed,
    accuracy: typeof input.accuracy === 'number' ? input.accuracy : null,
    heading: typeof input.heading === 'number' ? input.heading : null,
    positionTrusted: input.positionTrusted !== false,
    lastSeen: Math.min(stamp, Date.now()), // device clocks can run ahead
  };
}

/**
 * Seat count priority: live socket value → persisted trip row → van capacity.
 */
function resolveSeatInfo(trip, liveEntry) {
  const liveAvailable = liveEntry?.availableSeats;
  const liveTotal     = liveEntry?.totalSeats;
  const tripAvailable = typeof trip?.availableSeats === 'number' ? trip.availableSeats : null;
  const tripTotal     = typeof trip?.totalSeats === 'number' ? trip.totalSeats : null;
  const vanCapacity   = trip?.van?.capacity ?? null;

  const available = liveAvailable ?? tripAvailable ?? vanCapacity;
  const total     = liveTotal ?? tripTotal ?? vanCapacity ?? available;
  return { available, total, isLive: typeof liveAvailable === 'number' };
}

function getDriverContacts(driver) {
  if (!driver) return [];
  if (Array.isArray(driver.contactNumbers) && driver.contactNumbers.length > 0) return driver.contactNumbers.filter(Boolean);
  if (typeof driver.contactNumber === 'string' && driver.contactNumber) return [driver.contactNumber];
  return [];
}

const cooperativeName = (trip) => trip?.van?.cooperative?.name ?? null;
const getDirection    = (trip) => (trip?.direction === 'RETURN' ? 'RETURN' : 'OUTBOUND');

// Direction-aware endpoints: OUTBOUND municipality → terminal, RETURN terminal → municipality.
function getTripEndpoints(trip) {
  const originCoords =
    getCoordinatesForDestination(trip.route?.origin) ?? (isHomeTerminal(trip.route?.origin) ? VIRAC_HUB : null);
  const destinationCoords =
    getCoordinatesForDestination(trip.route?.destination) ?? (isHomeTerminal(trip.route?.destination) ? VIRAC_HUB : null);

  if (getDirection(trip) === 'RETURN') return { start: VIRAC_HUB, end: originCoords ?? VIRAC_HUB };
  return { start: originCoords ?? VIRAC_HUB, end: destinationCoords ?? VIRAC_HUB };
}

function tripRouteLabel(trip) {
  const o = shortPlaceName(trip.route?.origin);
  return getDirection(trip) === 'RETURN' ? `${HOME_TERMINAL_SHORT} → ${o}` : `${o} → ${HOME_TERMINAL_SHORT}`;
}

// Where the van is heading on its current leg.
const legDestination = (trip) =>
  (getDirection(trip) === 'RETURN' ? shortPlaceName(trip.route?.origin) : HOME_TERMINAL_SHORT);

function tripDirectionText(trip) {
  const o = shortPlaceName(trip.route?.origin);
  if (getDirection(trip) === 'RETURN') {
    if (trip.status === 'QUEUED')   return 'Checked in at the terminal, waiting to board';
    if (trip.status === 'BOARDING') return `Boarding at the terminal for ${o}`;
    if (trip.status === 'DEPARTING') return `Leaving the terminal for ${o}`;
    return `Heading to ${o}`;
  }
  if (trip.status === 'BOARDING')  return `Boarding at ${o}`;
  if (trip.status === 'DEPARTING') return `Leaving ${o} for the terminal`;
  return 'Heading to the terminal';
}

// ─── Map icons ───────────────────────────────────────────────────────────────

const markerCache = new Map();
function getMarkerIcon(status, heading, selected) {
  const bucket = typeof heading === 'number' ? (Math.round(heading / 30) * 30) % 360 : null;
  const key = `${status}|${bucket ?? 'n'}|${selected}`;
  if (markerCache.has(key)) return markerCache.get(key);

  const { hex } = statusMeta(status);
  const s = selected ? 24 : 18;
  const pointer = bucket === null ? '' : `
    <div style="position:absolute;inset:-7px;transform:rotate(${bucket}deg)">
      <div style="position:absolute;left:50%;top:-2px;margin-left:-5px;width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:9px solid ${hex}"></div>
    </div>`;

  const icon = L.divIcon({
    className: 'van-marker',
    html: `<div style="position:relative;width:${s}px;height:${s}px">${pointer}
      <div style="width:100%;height:100%;border-radius:50%;background:${hex};border:3px solid #fff;box-shadow:${selected ? `0 0 0 4px ${hex}40,` : ''}0 2px 8px rgba(15,23,42,.35)"></div></div>`,
    iconSize: [s, s],
    iconAnchor: [s / 2, s / 2],
    popupAnchor: [0, -s / 2 - 4],
  });
  markerCache.set(key, icon);
  return icon;
}

const hubIcon = L.divIcon({
  className: '',
  html: '<div style="width:26px;height:26px;border-radius:8px;background:#0f172a;border:3px solid #fff;box-shadow:0 2px 8px rgba(15,23,42,.4);display:flex;align-items:center;justify-content:center"><div style="width:8px;height:8px;border-radius:2px;background:#5eead4"></div></div>',
  iconSize: [26, 26],
  iconAnchor: [13, 13],
  popupAnchor: [0, -16],
});

// ─── Map helpers ─────────────────────────────────────────────────────────────

function MapBoundsFitter({ positions }) {
  const map = useMap();
  const fittedRef = useRef(false);
  useEffect(() => {
    if (fittedRef.current || !positions.length) return;
    try {
      map.fitBounds(L.latLngBounds([VIRAC_HUB, ...positions]), { padding: [50, 50], maxZoom: 13 });
      fittedRef.current = true;
    } catch { /* ignore malformed coords */ }
  }, [map, positions]);
  return null;
}

// On selection: pan to the van, then fit its road route once it has loaded.
function SelectionFocus({ tripId, position, routeCoords }) {
  const map = useMap();
  const stateRef = useRef({ tripId: null, fitted: false });
  useEffect(() => {
    if (!tripId) { stateRef.current = { tripId: null, fitted: false }; return; }
    if (stateRef.current.tripId !== tripId) {
      stateRef.current = { tripId, fitted: false };
      if (position) map.panTo(position, { animate: true, duration: 0.6 });
    }
    if (!stateRef.current.fitted && routeCoords.length > 1) {
      try {
        map.fitBounds(L.latLngBounds(routeCoords), { padding: [50, 50], maxZoom: 14, animate: true });
        stateRef.current.fitted = true;
      } catch { /* ignore */ }
    }
  }, [map, tripId, position, routeCoords]);
  return null;
}

async function fetchOsrmRoute(startCoords, endCoords, signal) {
  const [startLat, startLng] = startCoords;
  const [endLat, endLng] = endCoords;
  const url = `${OSRM_BASE_URL}/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=geojson&steps=false`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`OSRM request failed (${res.status})`);
  const data = await res.json();
  const route = data?.routes?.[0];
  if (!route?.geometry?.coordinates?.length) return null;
  return {
    coords: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    distanceMeters: route.distance ?? null,
    durationSeconds: route.duration ?? null,
  };
}

// ─── Small components ────────────────────────────────────────────────────────

function EtaCountdown({ etaIso }) {
  const [label, setLabel] = useState('');
  useEffect(() => {
    if (!etaIso) return undefined;
    const tick = () => {
      const diff = new Date(etaIso).getTime() - Date.now();
      if (diff <= 0) { setLabel('Arriving now'); return; }
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
  return <span className="tabular-nums">{label}</span>;
}

function SeatPill({ available, total, isLive }) {
  if (available === null || available === undefined) return null;
  const full = available === 0;
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${
      full ? 'bg-slate-100 text-slate-500 ring-slate-300/60' : 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'}`}>
      {isLive && !full && (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
        </span>
      )}
      <Icon name="users" className="h-3 w-3" />
      {full ? 'Full' : `${available}${total != null ? ` of ${total}` : ''} free`}
    </span>
  );
}

function DriverContacts({ driver }) {
  const numbers = getDriverContacts(driver);
  if (numbers.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {numbers.map((n) => (
        <a key={n} href={`tel:${n.replace(/\s/g, '')}`} onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 text-xs font-medium tabular-nums text-slate-700 hover:bg-slate-200">
          <Icon name="phone" className="h-3 w-3" /> {n}
        </a>
      ))}
    </div>
  );
}

function CooperativeTag({ trip }) {
  const name = cooperativeName(trip);
  if (!name) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-slate-500">
      <Icon name="building" className="h-3 w-3" /> {name}
    </span>
  );
}

function EmptyState({ text }) {
  return <p className="rounded-xl border border-dashed border-slate-200 px-4 py-5 text-center text-sm text-slate-400">{text}</p>;
}

function SectionHeader({ title, count, hint }) {
  return (
    <div className="mb-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        <span className="rounded-full bg-slate-200/70 px-2 py-0.5 text-xs font-medium tabular-nums text-slate-600">{count}</span>
      </div>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

// One line describing the van's live GPS state.
function GpsLine({ gps, data }) {
  if (gps.isLive) {
    const weak = typeof gps.accuracy === 'number' && gps.accuracy > LOW_ACCURACY_THRESHOLD_M;
    return (
      <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700">
        <span className="flex items-center gap-1.5">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-500 opacity-70" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-teal-600" />
          </span>
          {speedLabel(data?.smoothedSpeed)}
          {weak && <span className="font-normal text-amber-600">· weak GPS</span>}
        </span>
        {data?.lastSeen && <span className="font-normal text-slate-400">{relativeTime(data.lastSeen)}</span>}
      </div>
    );
  }
  if (gps.isStale) {
    return (
      <div className="flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">
        <Icon name="signal" className="h-3.5 w-3.5" /> GPS signal lost. Last seen {relativeTime(data?.lastSeen)}
      </div>
    );
  }
  if (gps.hasFix && !gps.isTrusted) {
    return (
      <div className="flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">
        <Icon name="signal" className="h-3.5 w-3.5" /> GPS fix too weak to plot
        {typeof gps.accuracy === 'number' && ` (±${Math.round(gps.accuracy)} m)`}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs font-medium text-slate-500">
      <Spinner className="h-3 w-3" /> Waiting for the driver's GPS…
    </div>
  );
}

function TripRow({ trip, selected, onSelect, trailing, footer }) {
  return (
    <button type="button" onClick={onSelect} aria-pressed={selected}
      className={`w-full rounded-xl border bg-white p-3 text-left shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 ${
        selected ? 'border-teal-700 ring-1 ring-teal-700' : 'border-slate-200/80 hover:border-slate-300'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className={`truncate text-sm font-semibold ${trip.driver?.name ? 'text-slate-900' : 'italic text-slate-400'}`}>
            {trip.driver?.name ?? 'No driver assigned'}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
            <span className="font-semibold text-slate-700">{trip.van?.plateNumber ?? 'Unknown plate'}</span>
            <CooperativeTag trip={trip} />
          </p>
          <p className="mt-1 text-xs text-slate-500">{tripDirectionText(trip)}</p>
        </div>
        {trailing}
      </div>
      {footer && <div className="mt-2.5">{footer}</div>}
    </button>
  );
}

function CountTile({ value, label, dot }) {
  return (
    <div className="flex-1 rounded-xl bg-white px-3 py-2.5 shadow-sm ring-1 ring-slate-200/80">
      <p className="text-2xl font-semibold tabular-nums tracking-tight text-slate-900">{value}</p>
      <p className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500">
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} /> {label}
      </p>
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function PublicTracking() {
  const navigate = useNavigate();

  const [activeTrips, setActiveTrips]     = useState([]);
  const [liveData, setLiveData]           = useState({});
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState('');
  const [reloadToken, setReloadToken]     = useState(0);
  const [socketStatus, setSocketStatus]   = useState('connecting');
  const [, setTick]                       = useState(0);
  const [liveEtas, setLiveEtas]           = useState({});
  const [selectedTripId, setSelectedTripId] = useState(null);
  const [selectedRoute, setSelectedRoute] = useState(EMPTY_ROUTE);

  const selectedTripIdRef = useRef(selectedTripId);
  const activeTripsRef    = useRef(activeTrips);
  const routeStartRef     = useRef({ tripId: null, direction: null, start: null });
  const routeAbortRef     = useRef(null);
  useEffect(() => { selectedTripIdRef.current = selectedTripId; }, [selectedTripId]);
  useEffect(() => { activeTripsRef.current = activeTrips; }, [activeTrips]);

  // ── HTTP fetch seeds liveData so markers appear without waiting for a socket push ──
  const fetchActiveTrips = useCallback(async (signal) => {
    try {
      const res = await apiClient.get('/trips/live', { signal });
      const trips = Array.isArray(res.data) ? res.data : [];
      setActiveTrips(trips);
      setLiveData((prev) => {
        const next = { ...prev };
        for (const trip of trips) {
          const fix = normaliseFix(trip.liveLocation);
          if (!fix) continue;
          const existing = next[trip.id];
          if (!existing || (fix.lastSeen ?? 0) > (existing.lastSeen ?? 0)) {
            next[trip.id] = { ...fix, availableSeats: existing?.availableSeats, totalSeats: existing?.totalSeats };
          }
        }
        return next;
      });
      setError('');
    } catch (err) {
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
      setError('Unable to load live tracking data. Check your connection.');
      console.error('[PublicTracking] fetchActiveTrips failed', err);
    }
  }, []);

  // ── Socket lifecycle ──
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetchActiveTrips(controller.signal).finally(() => setLoading(false));

    const onConnect = () => { setSocketStatus('connected'); socket.emit('subscribe_to_map'); };
    const onDisconnect = () => setSocketStatus('disconnected');

    const onInitialLocations = (payload = []) => {
      if (!Array.isArray(payload)) return;
      setLiveData((prev) => {
        const next = { ...prev };
        for (const pair of payload) {
          if (!Array.isArray(pair) || pair.length < 2) continue;
          const [tripId, raw] = pair;
          const fix = normaliseFix(raw);
          if (!fix) continue;
          const existing = next[tripId];
          if (!existing || (fix.lastSeen ?? 0) > (existing.lastSeen ?? 0)) {
            next[tripId] = { ...fix, availableSeats: existing?.availableSeats, totalSeats: existing?.totalSeats };
          }
        }
        return next;
      });
    };

    // Only the server's ACCEPTED fixes arrive here, with the device's own fix time.
    const onVanMoved = (data) => {
      if (!data?.tripId) return;
      const fix = normaliseFix(data);
      if (!fix) return;
      setLiveData((prev) => ({ ...prev, [data.tripId]: { ...(prev[data.tripId] ?? {}), ...fix } }));
    };

    const onSeatUpdate = (data) => {
      if (!data?.tripId || typeof data.availableSeats !== 'number') return;
      setLiveData((prev) => ({
        ...prev,
        [data.tripId]: { ...(prev[data.tripId] ?? {}), availableSeats: data.availableSeats, totalSeats: data.totalSeats },
      }));
    };

    const dropTrip = (tripId) => {
      setLiveData((prev) => { if (!(tripId in prev)) return prev; const n = { ...prev }; delete n[tripId]; return n; });
      setLiveEtas((prev) => { if (!(tripId in prev)) return prev; const n = { ...prev }; delete n[tripId]; return n; });
      if (selectedTripIdRef.current === tripId) setSelectedTripId(null);
    };

    const onTripStatusChanged = ({ tripId, trip } = {}) => {
      if (!tripId) return;
      const finished = trip?.status === 'COMPLETED' || trip?.status === 'CANCELLED';

      // A new leg starts with a fresh ETA, so drop the old one.
      const before = activeTripsRef.current.find((t) => t.id === tripId);
      if (before && trip?.direction && before.direction !== trip.direction) {
        setLiveEtas((prev) => { const n = { ...prev }; delete n[tripId]; return n; });
      }

      setActiveTrips((prev) => {
        if (finished) return prev.filter((t) => t.id !== tripId);
        if (prev.some((t) => t.id === tripId)) return prev.map((t) => (t.id === tripId ? { ...t, ...trip } : t));
        return trip ? [...prev, trip] : prev;
      });
      if (finished) dropTrip(tripId);
    };

    const onTripDispatched = ({ trip } = {}) => {
      if (!trip?.id) return;
      setActiveTrips((prev) => (prev.some((t) => t.id === trip.id) ? prev : [...prev, trip]));
    };

    const onTripRemoved = ({ tripId } = {}) => {
      if (!tripId) return;
      setActiveTrips((prev) => prev.filter((t) => t.id !== tripId));
      dropTrip(tripId);
    };

    const onEtaUpdate = ({ tripId, eta, delayMinutes } = {}) => {
      if (!tripId || !eta) return;
      setLiveEtas((prev) => ({ ...prev, [tripId]: { eta, delayMinutes: delayMinutes ?? 0 } }));
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
    socket.on('trip_removed', onTripRemoved);
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
      socket.off('trip_removed', onTripRemoved);
      socket.off('eta_update', onEtaUpdate);
      socket.disconnect();
    };
  }, [fetchActiveTrips, reloadToken]);

  // Poll fallback in case the socket drops silently.
  useEffect(() => {
    const id = setInterval(() => fetchActiveTrips(new AbortController().signal), REFETCH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchActiveTrips]);

  // Re-render so relative-time labels stay fresh.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  // ── Derived lists ──
  const boardingTrips = useMemo(() => activeTrips.filter((t) => BOARDING_STATUSES.includes(t.status)), [activeTrips]);
  const drivingTrips  = useMemo(() => activeTrips.filter((t) => DRIVING_STATUSES.includes(t.status)), [activeTrips]);
  const mapTrips      = useMemo(() => activeTrips.filter((t) => MAP_VISIBLE_STATUSES.includes(t.status)), [activeTrips]);

  const queuedTrips = useMemo(
    () => activeTrips
      .filter((t) => QUEUED_STATUSES.includes(t.status))
      .sort((a, b) => new Date(a.actualArrival ?? a.scheduledTime ?? 0) - new Date(b.actualArrival ?? b.scheduledTime ?? 0)),
    [activeTrips],
  );

  // Each cooperative has its own boarding slot, so position in line is per cooperative.
  const queueGroups = useMemo(() => {
    const groups = new Map();
    for (const trip of queuedTrips) {
      const key = trip.van?.cooperativeId ?? 'unassigned';
      if (!groups.has(key)) groups.set(key, { name: cooperativeName(trip) ?? 'Unassigned', trips: [] });
      groups.get(key).trips.push(trip);
    }
    return Array.from(groups.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [queuedTrips]);

  const resolveTripPosition = useCallback((trip) => {
    const data = liveData[trip.id];
    const hasGps = typeof data?.lat === 'number' && typeof data?.lng === 'number';
    const accuracy = typeof data?.accuracy === 'number' ? data.accuracy : null;
    const isStale = Boolean(hasGps && data.lastSeen && Date.now() - data.lastSeen > GPS_STALE_THRESHOLD_MS);
    const isTrusted = data?.positionTrusted !== false && (accuracy === null || accuracy <= UNUSABLE_ACCURACY_M);
    const isLive = hasGps && !isStale && isTrusted;

    if (isLive) return { position: [data.lat, data.lng], hasFix: true, isStale: false, isTrusted, isLive, accuracy };

    // No usable live fix: stationary vans still appear at their known location.
    if (trip.status === 'BOARDING' || trip.status === 'QUEUED') {
      const fallback = getTripEndpoints(trip).start;
      if (fallback) return { position: fallback, hasFix: hasGps, isStale, isTrusted, isLive: false, accuracy };
    }
    return { position: null, hasFix: hasGps, isStale, isTrusted, isLive: false, accuracy };
  }, [liveData]);

  // One marker per van that has a live fix (a driver's simultaneous trips share it).
  const markerGroups = useMemo(() => {
    const groups = new Map();
    for (const trip of mapTrips) {
      const r = resolveTripPosition(trip);
      if (!r.position) continue;
      const vanKey = trip.van?.id ?? trip.vanId ?? trip.id;
      const key = r.isLive ? `van:${vanKey}` : `trip:${trip.id}`;
      if (!groups.has(key)) groups.set(key, { key, position: r.position, isLive: r.isLive, trips: [] });
      groups.get(key).trips.push(trip);
    }
    return Array.from(groups.values()).map((g) => {
      const primary =
        g.trips.find((t) => t.id === selectedTripId) ??
        [...g.trips].sort((a, b) => STATUS_PRIORITY.indexOf(a.status) - STATUS_PRIORITY.indexOf(b.status))[0];
      return { ...g, primary };
    });
  }, [mapTrips, resolveTripPosition, selectedTripId]);

  const activeVanPositions = useMemo(() => markerGroups.map((g) => g.position), [markerGroups]);

  const selectedTrip     = useMemo(() => activeTrips.find((t) => t.id === selectedTripId) ?? null, [activeTrips, selectedTripId]);
  const selectedLive     = selectedTripId ? liveData[selectedTripId] : null;
  const selectedEta      = selectedTrip && ETA_STATUSES.includes(selectedTrip.status) ? liveEtas[selectedTripId] ?? null : null;
  const selectedSeatInfo = selectedTrip ? resolveSeatInfo(selectedTrip, selectedLive) : null;
  const selectedGps      = useMemo(() => (selectedTrip ? resolveTripPosition(selectedTrip) : null), [selectedTrip, resolveTripPosition]);
  const selectedPosition = selectedGps?.position ?? null;

  // ── Road route for the selected trip ──
  // Depends only on stable primitives, and the in-flight request is only aborted
  // when a NEW request starts, so small GPS updates never cancel a loading route.
  const selectedDirection = selectedTrip?.direction;
  const selectedOrigin    = selectedTrip?.route?.origin;
  const selectedDest      = selectedTrip?.route?.destination;
  const liveLat = selectedLive?.lat;
  const liveLng = selectedLive?.lng;

  useEffect(() => {
    if (!selectedTripId || !selectedTrip) {
      routeAbortRef.current?.abort();
      routeStartRef.current = { tripId: null, direction: null, start: null };
      setSelectedRoute(EMPTY_ROUTE);
      return;
    }

    const endpoints = getTripEndpoints(selectedTrip);
    const hasLive = Number.isFinite(liveLat) && Number.isFinite(liveLng);
    const start = hasLive ? [liveLat, liveLng] : endpoints.start;
    const end = endpoints.end;

    if (!start || !end) {
      setSelectedRoute({ ...EMPTY_ROUTE, tripId: selectedTripId, error: 'Route coordinates are unavailable.' });
      return;
    }

    const prev = routeStartRef.current;
    const sameRoute = prev.tripId === selectedTripId && prev.direction === selectedDirection;
    const moved =
      !prev.start ||
      haversineMeters({ lat: prev.start[0], lng: prev.start[1] }, { lat: start[0], lng: start[1] }) > ROUTE_RECALC_DISTANCE_M;
    if (sameRoute && !moved) return;

    routeStartRef.current = { tripId: selectedTripId, direction: selectedDirection, start };

    routeAbortRef.current?.abort();
    const controller = new AbortController();
    routeAbortRef.current = controller;

    setSelectedRoute((p) => (p.tripId === selectedTripId
      ? { ...p, loading: true, error: '' }
      : { ...EMPTY_ROUTE, tripId: selectedTripId, loading: true }));

    fetchOsrmRoute(start, end, controller.signal)
      .then((route) => {
        if (controller.signal.aborted) return;
        if (!route) {
          setSelectedRoute({ ...EMPTY_ROUTE, tripId: selectedTripId, error: 'Unable to build a road route for this trip.' });
          return;
        }
        setSelectedRoute({ tripId: selectedTripId, coords: route.coords, loading: false, error: '', distanceMeters: route.distanceMeters, durationSeconds: route.durationSeconds });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        console.error('[PublicTracking] route fetch failed', err);
        setSelectedRoute({ ...EMPTY_ROUTE, tripId: selectedTripId, error: 'Unable to load the road route.' });
      });
    // selectedTrip is read for its endpoints; the primitives below cover every change that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTripId, selectedDirection, selectedOrigin, selectedDest, liveLat, liveLng]);

  useEffect(() => () => routeAbortRef.current?.abort(), []);

  const routeCoords = selectedRoute.tripId === selectedTripId ? selectedRoute.coords : [];
  const mapFocusPositions = routeCoords.length > 0 ? routeCoords : activeVanPositions;

  // ── Loading / error screens ──
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-3 text-slate-500">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-teal-700 text-white"><Icon name="van" className="h-6 w-6" /></span>
          <p className="flex items-center gap-2 text-sm font-medium"><Spinner className="h-4 w-4 text-teal-700" /> Loading live tracking…</p>
        </div>
      </div>
    );
  }

  if (error && activeTrips.length === 0) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50 p-4">
        <Card className="w-full max-w-md space-y-4 p-6 text-center">
          <h1 className="text-lg font-semibold text-slate-900">Can't reach live tracking</h1>
          <Notice>{error}</Notice>
          <button className={`${BTN.primary} w-full`} onClick={() => setReloadToken((n) => n + 1)}>Try again</button>
        </Card>
      </div>
    );
  }

  const socketChip =
    socketStatus === 'connected'
      ? { text: 'Live', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20', dot: 'bg-emerald-500', ping: true }
      : socketStatus === 'disconnected'
      ? { text: 'Offline', cls: 'bg-rose-50 text-rose-700 ring-rose-600/20', dot: 'bg-rose-500', ping: false }
      : { text: 'Connecting', cls: 'bg-amber-50 text-amber-700 ring-amber-600/20', dot: 'bg-amber-500', ping: false };

  const etaTarget = selectedTrip ? legDestination(selectedTrip) : HOME_TERMINAL_SHORT;

  return (
    <div className="flex h-screen flex-col bg-slate-50 font-sans text-slate-900 antialiased">
      {/* Smooth marker glide between GPS updates; leaflet's own zoom animation still wins. */}
      <style>{`.van-marker{transition:transform 1.2s linear}`}</style>

      <header className="z-20 shrink-0 border-b border-slate-200/80 bg-white/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-teal-700 text-white"><Icon name="van" /></span>
            <div className="min-w-0">
              <h1 className="text-base font-semibold leading-tight tracking-tight">Terminalink</h1>
              <p className="truncate text-xs text-slate-500">Live van tracking from the driver's phone</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset sm:inline-flex ${socketChip.cls}`}>
              <span className="relative flex h-1.5 w-1.5">
                {socketChip.ping && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />}
                <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${socketChip.dot}`} />
              </span>
              {socketChip.text}
            </span>
            <button className={BTN.secondary} onClick={() => navigate('/login')}>
              <Icon name="lock" className="h-4 w-4" /> Staff access
            </button>
          </div>
        </div>
      </header>

      {socketStatus === 'disconnected' && (
        <div className="z-10 shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm font-medium text-amber-800">
          Live updates paused. Reconnecting…{' '}
          <button onClick={() => setReloadToken((n) => n + 1)} className="ml-1 font-semibold underline underline-offset-2">Reload</button>
        </div>
      )}
      {error && activeTrips.length > 0 && (
        <div className="z-10 shrink-0 border-b border-rose-200 bg-rose-50 px-4 py-2 text-center text-sm font-medium text-rose-700">{error}</div>
      )}

      <div className="relative z-0 flex flex-1 flex-col overflow-hidden md:flex-row">
        {/* ── Map ── */}
        <div className="relative z-0 h-[42vh] shrink-0 md:h-auto md:flex-1">
          <MapContainer center={MAP_CENTER} zoom={11} className="h-full w-full">
            <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <MapBoundsFitter positions={mapFocusPositions} />
            <SelectionFocus tripId={selectedTripId} position={selectedPosition} routeCoords={routeCoords} />

            <Marker position={VIRAC_HUB} icon={hubIcon}>
              <Popup>
                <div className="min-w-[180px] space-y-1">
                  <p className="text-sm font-semibold leading-snug text-slate-900">{HOME_TERMINAL_NAME}</p>
                  <p className="text-xs text-slate-500">
                    {boardingTrips.length} boarding · {queuedTrips.length} in queue · {drivingTrips.length} on the road
                  </p>
                </div>
              </Popup>
            </Marker>

            {selectedTrip && selectedGps?.isLive && typeof selectedGps.accuracy === 'number' && selectedGps.accuracy > 0 && (
              <Circle center={selectedPosition} radius={selectedGps.accuracy}
                pathOptions={{ color: accuracyRing(selectedGps.accuracy), fillColor: accuracyRing(selectedGps.accuracy), fillOpacity: 0.08, weight: 1 }} />
            )}

            {routeCoords.length > 1 && (
              <Polyline positions={routeCoords}
                pathOptions={{ color: '#0f766e', weight: 5, opacity: 0.85, lineCap: 'round', lineJoin: 'round' }} />
            )}

            {markerGroups.map((group) => {
              const trip = group.primary;
              const data = liveData[trip.id];
              const moving = (msToKmh(data?.smoothedSpeed) ?? 0) >= MOVING_HEADING_KMH;
              const heading = group.isLive && moving && typeof data?.heading === 'number' ? data.heading : null;
              const isSelected = group.trips.some((t) => t.id === selectedTripId);

              return (
                <Marker key={group.key} position={group.position} icon={getMarkerIcon(trip.status, heading, isSelected)}
                  eventHandlers={{ click: () => setSelectedTripId(trip.id) }}>
                  <Popup minWidth={230}>
                    <div className="space-y-2 py-0.5">
                      <div>
                        <p className="text-sm font-semibold leading-snug text-slate-900">{trip.driver?.name || 'Assigned driver'}</p>
                        <p className="mt-0.5 text-xs text-slate-500">
                          <span className="font-semibold text-slate-700">{trip.van?.plateNumber ?? '—'}</span>
                          {cooperativeName(trip) && <> · {cooperativeName(trip)}</>}
                        </p>
                      </div>
                      <DriverContacts driver={trip.driver} />
                      {group.isLive && (
                        <p className="text-xs font-medium text-slate-700">
                          {speedLabel(data?.smoothedSpeed)}
                          <span className="font-normal text-slate-400"> · updated {relativeTime(data?.lastSeen) ?? 'just now'}</span>
                        </p>
                      )}
                      <ul className="space-y-1.5 border-t border-slate-100 pt-2">
                        {group.trips.map((t) => {
                          const seat = resolveSeatInfo(t, liveData[t.id]);
                          return (
                            <li key={t.id} className="flex items-center justify-between gap-2">
                              <div className="min-w-0">
                                <p className="truncate text-xs font-semibold text-slate-800">{tripRouteLabel(t)}</p>
                                <div className="mt-1 flex flex-wrap items-center gap-1">
                                  <StatusPill status={t.status} />
                                  <SeatPill available={seat.available} total={seat.total} isLive={seat.isLive} />
                                </div>
                              </div>
                              <button type="button" onClick={() => setSelectedTripId(t.id)}
                                className={`${BTN.soft} shrink-0 ${t.id === selectedTripId ? 'bg-teal-700 text-white hover:bg-teal-800' : ''}`}>
                                {t.id === selectedTripId ? 'Selected' : 'Details'}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  </Popup>
                </Marker>
              );
            })}
          </MapContainer>
        </div>

        {/* ── Side panel ── */}
        <aside className="z-10 flex-1 space-y-5 overflow-y-auto border-t border-slate-200 bg-slate-50 p-4 md:w-[26rem] md:flex-none md:border-l md:border-t-0">
          <div className="flex gap-2">
            <CountTile value={boardingTrips.length} label="Boarding" dot="bg-emerald-500" />
            <CountTile value={queuedTrips.length} label="In queue" dot="bg-violet-500" />
            <CountTile value={drivingTrips.length} label="On the road" dot="bg-blue-500" />
          </div>

          {/* Selected van */}
          {selectedTrip && (
            <Card aria-label="Selected van">
              <div className="flex items-start justify-between gap-3 px-4 pt-4">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold tracking-tight text-slate-900">{selectedTrip.driver?.name || 'Assigned driver'}</h2>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                    <span className="font-semibold text-slate-700">{selectedTrip.van?.plateNumber ?? 'Unknown plate'}</span>
                    <CooperativeTag trip={selectedTrip} />
                  </p>
                </div>
                <button onClick={() => setSelectedTripId(null)} aria-label="Clear selection"
                  className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                  <Icon name="x" className="h-4 w-4" />
                </button>
              </div>

              <div className="space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill status={selectedTrip.status} />
                  <SeatPill available={selectedSeatInfo.available} total={selectedSeatInfo.total} isLive={selectedSeatInfo.isLive} />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <Stat label="Route">{tripRouteLabel(selectedTrip)}</Stat>
                  <Stat label="Speed">{selectedGps?.isLive ? speedLabel(selectedLive?.smoothedSpeed) : '—'}</Stat>
                  {typeof selectedLive?.accuracy === 'number' && (
                    <Stat label="GPS accuracy">
                      ±{Math.round(selectedLive.accuracy)} m
                      {selectedLive.accuracy > LOW_ACCURACY_THRESHOLD_M && <span className="ml-1 text-xs font-medium text-amber-600">weak</span>}
                    </Stat>
                  )}
                  {formatTime(selectedTrip.scheduledTime) && <Stat label="Trip started">{formatTime(selectedTrip.scheduledTime)}</Stat>}
                </div>

                <p className="text-xs text-slate-500">{tripDirectionText(selectedTrip)}</p>

                <GpsLine gps={selectedGps} data={selectedLive} />

                {selectedEta && (
                  <div className="flex items-end justify-between rounded-xl bg-teal-50 px-4 py-3">
                    <div>
                      <p className="text-xs text-teal-800">Estimated arrival at {etaTarget}</p>
                      <p className="mt-0.5 text-2xl font-semibold tabular-nums tracking-tight text-teal-900">{formatTime(selectedEta.eta)}</p>
                    </div>
                    <div className="text-right text-xs font-medium text-teal-800">
                      <EtaCountdown etaIso={selectedEta.eta} />
                      {selectedEta.delayMinutes > 0 && <p className="text-amber-600">+{selectedEta.delayMinutes} min delay</p>}
                    </div>
                  </div>
                )}

                {getDriverContacts(selectedTrip.driver).length > 0 && (
                  <div>
                    <p className="mb-1.5 text-xs text-slate-500">Call the driver</p>
                    <DriverContacts driver={selectedTrip.driver} />
                  </div>
                )}

                {selectedRoute.tripId === selectedTripId && selectedRoute.loading && (
                  <p className="flex items-center gap-2 text-xs text-slate-500"><Spinner className="h-3 w-3" /> Building road route…</p>
                )}
                {selectedRoute.tripId === selectedTripId && selectedRoute.error && !selectedRoute.loading && (
                  <Notice tone="warn">{selectedRoute.error}</Notice>
                )}
                {routeCoords.length > 1 && selectedRoute.distanceMeters != null && selectedRoute.durationSeconds != null && (
                  <p className="text-xs text-slate-500">
                    Road route: {Math.round(selectedRoute.distanceMeters / 1000)} km, about {formatDuration(selectedRoute.durationSeconds)}
                  </p>
                )}
              </div>
            </Card>
          )}

          {/* Boarding */}
          <section>
            <SectionHeader title="Boarding now" count={boardingTrips.length} />
            {boardingTrips.length === 0 ? (
              <EmptyState text="No vans are boarding right now." />
            ) : (
              <div className="space-y-2">
                {boardingTrips.map((trip) => {
                  const data = liveData[trip.id];
                  const seat = resolveSeatInfo(trip, data);
                  const full = seat.available === 0;
                  return (
                    <TripRow key={trip.id} trip={trip} selected={selectedTripId === trip.id}
                      onSelect={() => setSelectedTripId(trip.id)}
                      trailing={
                        <div className={`shrink-0 rounded-xl px-3 py-1.5 text-center ${full ? 'bg-slate-100 text-slate-500' : 'bg-emerald-50 text-emerald-700'}`}>
                          <p className="text-xl font-semibold leading-none tabular-nums">{seat.available ?? '—'}</p>
                          <p className="mt-0.5 text-[11px]">{full ? 'Full' : 'seats free'}</p>
                        </div>
                      }
                      footer={<GpsLine gps={resolveTripPosition(trip)} data={data} />} />
                  );
                })}
              </div>
            )}
          </section>

          {/* Queue */}
          <section>
            <SectionHeader title="Queued at the terminal" count={queuedTrips.length}
              hint="Each cooperative has its own boarding line, so a position only counts vans from the same cooperative." />
            {queuedTrips.length === 0 ? (
              <EmptyState text="No vans are waiting in the terminal queue." />
            ) : (
              <div className="space-y-4">
                {queueGroups.map((group) => (
                  <div key={group.name} className="space-y-2">
                    <p className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
                      <Icon name="building" className="h-3.5 w-3.5" /> {group.name}
                    </p>
                    {group.trips.map((trip, index) => (
                      <TripRow key={trip.id} trip={trip} selected={selectedTripId === trip.id}
                        onSelect={() => setSelectedTripId(trip.id)}
                        trailing={
                          <div className="shrink-0 rounded-xl bg-violet-50 px-3 py-1.5 text-center text-violet-700">
                            <p className="text-xl font-semibold leading-none tabular-nums">#{index + 1}</p>
                            <p className="mt-0.5 text-[11px]">in line</p>
                          </div>
                        } />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* On the road */}
          <section>
            <SectionHeader title="On the road" count={drivingTrips.length} />
            {drivingTrips.length === 0 ? (
              <EmptyState text="No vans are in transit right now." />
            ) : (
              <div className="space-y-2">
                {drivingTrips.map((trip) => {
                  const data = liveData[trip.id];
                  const seat = resolveSeatInfo(trip, data);
                  return (
                    <TripRow key={trip.id} trip={trip} selected={selectedTripId === trip.id}
                      onSelect={() => setSelectedTripId(trip.id)}
                      trailing={<StatusPill status={trip.status} />}
                      footer={
                        <div className="space-y-2">
                          <SeatPill available={seat.available} total={seat.total} isLive={seat.isLive} />
                          <GpsLine gps={resolveTripPosition(trip)} data={data} />
                        </div>
                      } />
                  );
                })}
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
