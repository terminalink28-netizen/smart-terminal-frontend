import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import apiClient from '../api/axios';
import { socket } from '../api/socket';
import { VIRAC_HUB } from '../components/townCoordinates';

// ─── Trip model ───────────────────────────────────────────────────────────────
//
// A trip is a ROUND TRIP made of two legs, tracked by `trip.direction`:
//
//   OUTBOUND  municipality → terminal
//     BOARDING → DEPARTING → DEPARTED
//     There is NO driver "approaching" step. Once DEPARTED the driver shows
//     a QR code; the dispatcher's scan checks the van into its cooperative's
//     terminal line (BOARDING if the slot is free, otherwise QUEUED).
//
//   RETURN    terminal → municipality
//     (QUEUED →) BOARDING → DEPARTING → DEPARTED
//     At DEPARTING the driver shows a QR code again; the dispatcher's exit
//     scan releases the van (DEPARTED). The driver taps "Finish trip" at the
//     municipality.
//
// A driver can run SEVERAL trips at once, one per municipality. Location
// sharing is driver-level: one GPS watch feeds every active trip.

// ─── Constants ────────────────────────────────────────────────────────────────

const HOME_TERMINAL_NAME  = 'Provincial Integrated Transport Terminal and Business Complex';
const HOME_TERMINAL_SHORT = 'Terminal';

// Route that receives buffered / batched GPS fixes when the socket is down.
// Must point at the backend's updateDriverLocation handler.
const LOCATION_ENDPOINT = '/trips/location';

const PHONE_RE            = /^[+\d][\d\s-]{6,14}$/;
const MAX_CONTACT_NUMBERS = 5;
const SEAT_PERSIST_DEBOUNCE_MS = 500;
const META_KEY            = 'driver_trip_meta';

const GPS_LOCKED_STATUSES = ['SCHEDULED', 'COMPLETED', 'CANCELLED'];
const ETA_STATUSES        = ['DEPARTING', 'DEPARTED', 'ARRIVING', 'DELAYED'];
const DELAY_STATUSES      = ['DEPARTING', 'DEPARTED', 'ARRIVING', 'DELAYED'];
const MAP_VISIBLE_STATUSES = ['BOARDING', 'QUEUED', 'DEPARTING', 'DEPARTED', 'ARRIVING', 'DELAYED'];
const DELAY_OPTIONS       = [5, 10, 15, 30];

const MUNICIPALITIES = [
  { name: 'Bato',       minutes: 30 },
  { name: 'Baras',      minutes: 25 },
  { name: 'San Andres', minutes: 45 },
  { name: 'Gigmoto',    minutes: 90 },
  { name: 'Panganiban', minutes: 55 },
  { name: 'Caramoran',  minutes: 100 },
  { name: 'Bagamanoc',  minutes: 110 },
  { name: 'Viga',       minutes: 130 },
  { name: 'Pandan',     minutes: 145 },
];
const DEFAULT_ROUTE_DURATION = 60;

// GPS tuning — built for a moving vehicle
const GPS_OPTIONS          = { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 };
const MIN_SEND_INTERVAL_MS = 2500;   // never flood the server
const MIN_SEND_MOVE_M      = 12;     // …unless the van moved this far
const HEARTBEAT_MS         = 8000;   // re-send last position while stationary
const WEAK_SIGNAL_MS       = 15000;  // no fix for this long → "weak signal"
const STALE_FIX_MS         = 60000;  // don't heartbeat a fix older than this
const MAX_BUFFER           = 100;    // offline fixes kept for later
const FLUSH_BATCH          = 50;
const MAX_PLAUSIBLE_SPEED_MPS     = 55;
const MIN_DT_FOR_FALLBACK_SECONDS = 2;
const MIN_DISTANCE_FOR_FALLBACK_M = 3;

const FLEET_REFETCH_INTERVAL_MS    = 30_000;
const FLEET_GPS_STALE_THRESHOLD_MS = 120_000;

const GPS_STATE = { IDLE: 'IDLE', ACQUIRING: 'ACQUIRING', LIVE: 'LIVE', ERROR: 'ERROR' };

// ─── Design tokens (lift this block into components/ui.jsx to reuse) ─────────
//
// Palette  ink #0F172A · canvas #F6F7F9 · line slate-200 · brand teal-700
// Type     system sans, sentence case, weight carries hierarchy
// Shape    cards rounded-2xl, controls rounded-xl, one soft shadow

const ICONS = {
  van:     'M3 16V7a1 1 0 011-1h9l5 5h2a1 1 0 011 1v4M3 16h2m12 0h-6M7 18a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM17 18a1.5 1.5 0 100-3 1.5 1.5 0 000 3z',
  pin:     'M12 21c4-4 7-7.2 7-11a7 7 0 10-14 0c0 3.8 3 7 7 11zM12 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z',
  phone:   'M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z',
  plus:    'M12 5v14M5 12h14',
  check:   'M5 13l4 4L19 7',
  clock:   'M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  qr:      'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v6h-4M14 18h2v2h-2z',
  flag:    'M5 21V4M5 4h11l-2 4 2 4H5',
  chevron: 'M6 9l6 6 6-6',
  x:       'M6 6l12 12M18 6L6 18',
  logout:  'M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 8l-4 4 4 4M6 12h10',
  signal:  'M5 19v-3M10 19v-7M15 19V9M20 19V5',
  alert:   'M12 9v4M12 17h.01M10.3 4l-8 14a2 2 0 001.7 3h16a2 2 0 001.7-3l-8-14a2 2 0 00-3.4 0z',
  refresh: 'M20 11a8 8 0 00-14.9-3M4 5v4h4M4 13a8 8 0 0014.9 3M20 19v-4h-4',
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
  dark:      `${BTN_BASE} h-12 px-5 bg-slate-900 text-white shadow-sm hover:bg-slate-800`,
  secondary: `${BTN_BASE} h-11 px-4 border border-slate-200 bg-white text-slate-700 hover:bg-slate-50`,
  soft:      `${BTN_BASE} h-9 px-3 bg-slate-100 text-slate-700 hover:bg-slate-200`,
  danger:    `${BTN_BASE} h-9 px-3 bg-rose-50 text-rose-700 hover:bg-rose-100`,
};

const STATUS_META = {
  BOARDING:  { label: 'Boarding',     hex: '#059669', pill: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20', dot: 'bg-emerald-500' },
  DEPARTING: { label: 'Ready to go',  hex: '#d97706', pill: 'bg-amber-50 text-amber-700 ring-amber-600/20',       dot: 'bg-amber-500' },
  DEPARTED:  { label: 'On the road',  hex: '#2563eb', pill: 'bg-blue-50 text-blue-700 ring-blue-600/20',          dot: 'bg-blue-500' },
  ARRIVING:  { label: 'On the road',  hex: '#2563eb', pill: 'bg-blue-50 text-blue-700 ring-blue-600/20',          dot: 'bg-blue-500' },
  QUEUED:    { label: 'In queue',     hex: '#7c3aed', pill: 'bg-violet-50 text-violet-700 ring-violet-600/20',    dot: 'bg-violet-500' },
  DELAYED:   { label: 'Delayed',      hex: '#ea580c', pill: 'bg-orange-50 text-orange-700 ring-orange-600/20',    dot: 'bg-orange-500' },
  SCHEDULED: { label: 'Scheduled',    hex: '#64748b', pill: 'bg-slate-100 text-slate-600 ring-slate-500/20',      dot: 'bg-slate-400' },
  COMPLETED: { label: 'Completed',    hex: '#64748b', pill: 'bg-slate-100 text-slate-600 ring-slate-500/20',      dot: 'bg-slate-400' },
  CANCELLED: { label: 'Cancelled',    hex: '#e11d48', pill: 'bg-rose-50 text-rose-700 ring-rose-600/20',          dot: 'bg-rose-500' },
};
const statusMeta = (s) => STATUS_META[s] ?? STATUS_META.SCHEDULED;

function Card({ className = '', children, ...rest }) {
  return (
    <section className={`rounded-2xl border border-slate-200/80 bg-white shadow-sm ${className}`} {...rest}>
      {children}
    </section>
  );
}

function CardHeader({ title, subtitle, right }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {subtitle && <p className="mt-0.5 truncate text-xs text-slate-500">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

function Spinner({ className = 'h-4 w-4' }) {
  return <span className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent ${className}`} role="status" />;
}

function StatusPill({ status }) {
  const m = statusMeta(status);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${m.pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}

function Notice({ tone = 'error', children }) {
  const tones = {
    error: 'border-rose-200 bg-rose-50 text-rose-800',
    warn:  'border-amber-200 bg-amber-50 text-amber-800',
    info:  'border-slate-200 bg-slate-50 text-slate-700',
  };
  return (
    <div role={tone === 'error' ? 'alert' : undefined}
      className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm ${tones[tone]}`}>
      <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 font-medium">{children}</div>
    </div>
  );
}

// ─── Map icons ────────────────────────────────────────────────────────────────

const markerCache = new Map();
function getMarkerIcon(status, isOwn) {
  const key = `${status}-${isOwn}`;
  if (markerCache.has(key)) return markerCache.get(key);
  const { hex } = statusMeta(status);
  const s = isOwn ? 22 : 16;
  const icon = L.divIcon({
    className: '',
    html: `<div style="width:${s}px;height:${s}px;border-radius:50%;background:${hex};border:3px solid #fff;box-shadow:${isOwn ? `0 0 0 4px ${hex}40,` : ''}0 2px 8px rgba(15,23,42,.35)"></div>`,
    iconSize: [s, s],
    iconAnchor: [s / 2, s / 2],
    popupAnchor: [0, -s / 2 - 2],
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readStoredUser() {
  try {
    const raw = localStorage.getItem('user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
const getStoredUserId   = () => { const u = readStoredUser(); return u?.id ?? u?.userId ?? null; };
const getStoredUserName = () => readStoredUser()?.name ?? null;

function getStoredContactNumbers() {
  const u = readStoredUser();
  if (Array.isArray(u?.contactNumbers) && u.contactNumbers.length) return u.contactNumbers;
  if (typeof u?.contactNumber === 'string' && u.contactNumber) return [u.contactNumber];
  return [];
}

function persistContactNumbersLocally(numbers) {
  try {
    const u = readStoredUser();
    if (!u) return;
    u.contactNumbers = numbers;
    localStorage.setItem('user', JSON.stringify(u));
  } catch { /* ignore */ }
}

function loadMeta() {
  try {
    const raw = localStorage.getItem(META_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function geolocationErrorMessage(err) {
  switch (err?.code) {
    case 1:  return 'Location permission is blocked. Allow location access in your browser settings, then tap Share location.';
    case 2:  return 'GPS signal unavailable. Move to an open area and try again.';
    case 3:  return 'GPS timed out. Try again.';
    default: return 'GPS error. Try again.';
  }
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const msToKmh = (mps) => (typeof mps !== 'number' || Number.isNaN(mps) ? null : Math.round(mps * 3.6));
const fmtTime = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const isHomeTerminal = (name) =>
  typeof name === 'string' && name.trim().toLowerCase() === HOME_TERMINAL_NAME.toLowerCase();
const shortPlace = (name) => (isHomeTerminal(name) ? HOME_TERMINAL_SHORT : (name ?? 'Unknown').replace(/\s*Terminal$/i, ''));
const getDirection = (trip) => (trip?.direction === 'RETURN' ? 'RETURN' : 'OUTBOUND');
const originName = (trip) => trip?.route?.origin ?? trip?.route?.name?.split('→')[0]?.trim() ?? 'Unknown';
const legDestination = (trip) => (getDirection(trip) === 'RETURN' ? shortPlace(originName(trip)) : HOME_TERMINAL_SHORT);
const legOrigin = (trip) => (getDirection(trip) === 'RETURN' ? HOME_TERMINAL_SHORT : shortPlace(originName(trip)));
const isOnTheRoad = (trip) => trip?.status === 'DEPARTED' || trip?.status === 'ARRIVING'; // ARRIVING = legacy

function routeMinutes(trip) {
  const name = trip?.route?.name ?? trip?.route?.origin;
  if (!name) return DEFAULT_ROUTE_DURATION;
  const lower = name.toLowerCase();
  return MUNICIPALITIES.find((m) => lower.includes(m.name.toLowerCase()))?.minutes ?? DEFAULT_ROUTE_DURATION;
}

function getDeparture(trip, meta) {
  if (meta?.dep) return new Date(meta.dep);
  if (getDirection(trip) === 'RETURN' && trip.status === 'DEPARTED' && trip.actualDeparture) {
    return new Date(trip.actualDeparture);
  }
  return null;
}

function getEta(trip, meta) {
  const dep = getDeparture(trip, meta);
  if (!dep) return null;
  return new Date(dep.getTime() + (routeMinutes(trip) + (meta?.delay ?? 0)) * 60_000);
}

function getSeats(trip, seatMap) {
  if (seatMap[trip.id]) return seatMap[trip.id];
  const total = trip.totalSeats ?? trip.van?.capacity ?? 14;
  return { total, available: trip.availableSeats ?? total };
}

// What the driver can tap right now (null = nothing to tap).
function getAdvanceStep(trip) {
  switch (trip?.status) {
    case 'BOARDING':
      return { next: 'DEPARTING', label: 'Ready to depart', hint: 'Tap once all passengers are seated.' };
    case 'DEPARTING':
      if (getDirection(trip) === 'RETURN') return null; // dispatcher's exit scan
      return { next: 'DEPARTED', label: 'Confirm departure', hint: 'Tap the moment you pull out.' };
    default:
      return null;
  }
}

function getStepperSteps(trip) {
  return [
    { key: 'BOARDING',  label: 'Boarding' },
    { key: 'DEPARTING', label: 'Ready' },
    { key: 'DEPARTED',  label: 'On road' },
    getDirection(trip) === 'RETURN'
      ? { key: 'COMPLETED', label: 'Done' }
      : { key: 'CHECKIN',   label: 'Check-in' },
  ];
}

// Keeps the van's QR token when a socket broadcast (which lacks it) replaces the trip.
function mergeTrip(prev, updated) {
  if (!prev || prev.id !== updated.id) return updated;
  return {
    ...prev,
    ...updated,
    van: {
      ...(prev.van ?? {}),
      ...(updated.van ?? {}),
      qrToken: updated.van?.qrToken ?? prev.van?.qrToken,
    },
  };
}

const sortTrips = (list) =>
  [...list].sort((a, b) => new Date(a.scheduledTime ?? 0) - new Date(b.scheduledTime ?? 0));

// ─── Sub-components ───────────────────────────────────────────────────────────

function Stepper({ trip }) {
  const steps = getStepperSteps(trip);
  const status = trip.status === 'ARRIVING' ? 'DEPARTED' : trip.status;
  const idx = steps.findIndex((s) => s.key === status);
  if (idx === -1) return null;
  return (
    <ol className="flex items-start" aria-label="Trip progress">
      {steps.map((step, i) => {
        const done = i < idx;
        const current = i === idx;
        return (
          <li key={step.key} className="flex flex-1 flex-col items-center last:flex-none" aria-current={current ? 'step' : undefined}>
            <div className="flex w-full items-center">
              <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ring-2 transition-colors ${
                done ? 'bg-teal-700 text-white ring-teal-700'
                : current ? 'bg-white text-teal-700 ring-teal-700'
                : 'bg-white text-slate-300 ring-slate-200'}`}>
                {done ? <Icon name="check" className="h-3.5 w-3.5" /> : i + 1}
              </span>
              {i < steps.length - 1 && <span className={`mx-1 h-0.5 flex-1 rounded ${done ? 'bg-teal-700' : 'bg-slate-200'}`} />}
            </div>
            <span className={`mt-1.5 self-start text-[11px] ${current ? 'font-semibold text-slate-900' : 'text-slate-400'}`}>{step.label}</span>
          </li>
        );
      })}
    </ol>
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

function TripManifest({ trip, eta, delayMinutes }) {
  const direction = getDirection(trip);
  const coop = trip.van?.cooperative?.name;
  return (
    <Card>
      <div className="flex items-center justify-between gap-3 px-4 pt-4">
        <div className="min-w-0">
          <p className="text-xs text-slate-500">{direction === 'RETURN' ? 'Return leg' : 'Outbound leg'}</p>
          <h2 className="mt-0.5 truncate text-lg font-semibold tracking-tight text-slate-900">
            {legOrigin(trip)} <span className="mx-1 text-slate-300">→</span> {legDestination(trip)}
          </h2>
        </div>
        <StatusPill status={trip.status} />
      </div>
      <div className="grid grid-cols-2 gap-2 p-4">
        <Stat label="Van plate">{trip.van?.plateNumber ?? 'Unknown'}</Stat>
        <Stat label="Capacity">{trip.van?.capacity ?? '—'} seats</Stat>
        {coop && <Stat label="Cooperative">{coop}</Stat>}
        <Stat label="Trip started">{trip.scheduledTime ? fmtTime(new Date(trip.scheduledTime)) : '—'}</Stat>
        {eta && (
          <Stat label="Estimated arrival">
            <span className="text-teal-700">{fmtTime(eta)}</span>
            {delayMinutes > 0 && <span className="ml-1 text-xs font-medium text-amber-600">+{delayMinutes}m</span>}
          </Stat>
        )}
      </div>
    </Card>
  );
}

function SeatPanel({ seats, saving, onChange }) {
  const pct = seats.total === 0 ? 0 : Math.round((seats.available / seats.total) * 100);
  const bar = pct > 50 ? 'bg-emerald-500' : pct > 25 ? 'bg-amber-400' : 'bg-rose-500';
  const roundBtn = 'flex h-12 w-12 items-center justify-center rounded-full text-2xl font-semibold transition active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600';
  return (
    <Card aria-label="Seat availability">
      <CardHeader
        title="Seat availability"
        subtitle="Saved automatically"
        right={saving ? <span className="flex items-center gap-1.5 text-xs text-slate-500"><Spinner className="h-3 w-3" />Saving</span> : null}
      />
      <div className="px-4 py-5">
        <div className="flex items-center justify-center gap-6">
          <button className={`${roundBtn} bg-slate-100 text-slate-700 hover:bg-slate-200`} aria-label="Mark one seat taken"
            onClick={() => onChange((s) => ({ ...s, available: Math.max(0, s.available - 1) }))}>−</button>
          <div className="w-24 text-center" aria-live="polite" aria-atomic="true">
            <span className="text-5xl font-semibold tabular-nums tracking-tight text-slate-900">{seats.available}</span>
            <p className="mt-1 text-xs text-slate-500">of {seats.total} free</p>
          </div>
          <button className={`${roundBtn} bg-teal-700 text-white hover:bg-teal-800`} aria-label="Free up one seat"
            onClick={() => onChange((s) => ({ ...s, available: Math.min(s.total, s.available + 1) }))}>+</button>
        </div>
        <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-slate-100">
          <div className={`h-full rounded-full transition-all duration-300 ${bar}`} style={{ width: `${pct}%` }} />
        </div>
        {seats.available === 0 && <p className="mt-2 text-center text-xs font-medium text-rose-600">Van is full</p>}
        <div className="mt-4 flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2">
          <span className="text-sm text-slate-600">Total capacity</span>
          <div className="flex items-center gap-2">
            <button className={BTN.soft} aria-label="Decrease total capacity"
              onClick={() => onChange((s) => { const t = Math.max(1, s.total - 1); return { total: t, available: Math.min(s.available, t) }; })}>−</button>
            <span className="w-6 text-center text-sm font-semibold tabular-nums">{seats.total}</span>
            <button className={BTN.soft} aria-label="Increase total capacity"
              onClick={() => onChange((s) => ({ ...s, total: Math.min(100, s.total + 1) }))}>+</button>
          </div>
        </div>
        <p className="mt-3 text-center text-xs text-slate-400">Resets to full when the return trip begins.</p>
      </div>
    </Card>
  );
}

function EtaCountdown({ eta }) {
  const [label, setLabel] = useState('');
  useEffect(() => {
    if (!eta) return undefined;
    const tick = () => {
      const diff = eta.getTime() - Date.now();
      if (diff <= 0) { setLabel('Due now'); return; }
      const h = Math.floor(diff / 3_600_000);
      const m = Math.floor((diff % 3_600_000) / 60_000);
      const s = Math.floor((diff % 60_000) / 1_000);
      setLabel(h > 0 ? `${h}h ${m}m left` : m > 0 ? `${m}m ${s}s left` : `${s}s left`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [eta]);
  if (!eta) return null;
  return <span className="tabular-nums" aria-live="off">{label}</span>;
}

function TripQr({ trip, mode, onRefresh }) {
  const van = trip?.van;
  const isExit = mode === 'EXIT';
  if (!van?.qrToken) {
    return (
      <Notice tone="warn">
        QR code unavailable.{' '}
        <button onClick={onRefresh} className="underline underline-offset-2">Refresh</button>{' '}
        or ask the dispatcher to {isExit ? 'release' : 'check in'} your van manually.
      </Notice>
    );
  }
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 text-center" aria-label={isExit ? 'Terminal exit QR code' : 'Terminal check-in QR code'}>
      <p className="text-sm font-semibold text-slate-900">
        {isExit ? 'Show this to leave the terminal' : 'Show this at the terminal'}
      </p>
      <p className="mx-auto mt-1 max-w-xs text-xs text-slate-500">
        {isExit
          ? `Once scanned, your trip to ${legDestination(trip)} starts.`
          : "Scanning checks you into your cooperative's line. If the boarding slot is free you board right away, otherwise you're queued."}
      </p>
      <div className="mx-auto mt-4 inline-block rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
        <QRCodeSVG value={van.qrToken} size={176} />
      </div>
      <p className="mt-3 font-mono text-xs text-slate-500">{van.plateNumber}</p>
      <button onClick={onRefresh} className="mt-2 text-xs font-medium text-teal-700 underline underline-offset-2">
        Already scanned? Refresh
      </button>
    </div>
  );
}

function StatusPanel({ trip, eta, delayMinutes, busy, error, onAdvance, onAddDelay, onRefresh }) {
  const direction = getDirection(trip);
  const step = getAdvanceStep(trip);
  const onRoad = isOnTheRoad(trip);
  const awaitingCheckIn = direction === 'OUTBOUND' && onRoad;
  const awaitingExit    = direction === 'RETURN' && trip.status === 'DEPARTING';
  const canFinish       = direction === 'RETURN' && onRoad;
  const isQueued        = trip.status === 'QUEUED';

  return (
    <Card aria-label="Trip status">
      <CardHeader title="Trip progress" subtitle={`${legOrigin(trip)} to ${legDestination(trip)}`} />
      <div className="space-y-4 p-4">
        {!isQueued && <Stepper trip={trip} />}

        {isQueued && (
          <div className="rounded-xl border border-violet-200 bg-violet-50 p-4 text-center">
            <p className="text-sm font-semibold text-violet-900">You're checked in and in the queue</p>
            <p className="mt-1 text-xs text-violet-700">
              Another van from your cooperative is boarding. You'll start boarding automatically when it leaves.
            </p>
          </div>
        )}

        {trip.status === 'DELAYED' && <Notice tone="warn">Trip marked as delayed. Contact your dispatcher to resume.</Notice>}

        {ETA_STATUSES.includes(trip.status) && (
          <div className="flex items-end justify-between rounded-xl bg-slate-50 px-4 py-3">
            <div>
              <p className="text-xs text-slate-500">Estimated arrival at {legDestination(trip)}</p>
              <p className="mt-0.5 text-3xl font-semibold tabular-nums tracking-tight text-slate-900">{eta ? fmtTime(eta) : '—'}</p>
            </div>
            <div className="text-right text-xs font-medium text-teal-700">
              <EtaCountdown eta={eta} />
              {delayMinutes > 0 && <p className="text-amber-600">+{delayMinutes} min delay</p>}
            </div>
          </div>
        )}

        {step && (
          <div>
            <button className={`${BTN.primary} w-full`} disabled={busy} onClick={() => onAdvance(step.next)}>
              {busy ? <><Spinner /> Updating…</> : step.label}
            </button>
            <p className="mt-2 text-center text-xs text-slate-500">{step.hint}</p>
          </div>
        )}

        {awaitingCheckIn && (
          <>
            <Notice tone="info">On the way. Show your QR code to the dispatcher when you reach the terminal.</Notice>
            <TripQr trip={trip} mode="CHECK_IN" onRefresh={onRefresh} />
          </>
        )}

        {awaitingExit && <TripQr trip={trip} mode="EXIT" onRefresh={onRefresh} />}

        {canFinish && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-center">
            <p className="text-sm font-semibold text-emerald-900">Heading to {legDestination(trip)}</p>
            <p className="mt-1 text-xs text-emerald-700">No scan needed. Finish the trip once passengers are off.</p>
            <button className={`${BTN.primary} mt-3 w-full bg-emerald-600 hover:bg-emerald-700`} disabled={busy} onClick={() => onAdvance('COMPLETED')}>
              {busy ? <><Spinner /> Finishing…</> : <><Icon name="flag" className="h-4 w-4" /> Finish trip</>}
            </button>
          </div>
        )}

        {error && <Notice>{error}</Notice>}

        {DELAY_STATUSES.includes(trip.status) && (
          <div className="border-t border-slate-100 pt-4">
            <p className="text-center text-xs text-slate-500">Running behind? Add a delay. Passengers see the new ETA.</p>
            <div className="mt-2 flex justify-center gap-2" role="group" aria-label="Add delay minutes">
              {DELAY_OPTIONS.map((m) => (
                <button key={m} className={BTN.soft} onClick={() => onAddDelay(m)} aria-label={`Add ${m} minute delay`}>+{m} min</button>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

// Driver-level sharing card: one GPS watch feeds every active trip.
function LiveLocationCard({ gpsState, gpsError, lastCoords, maxSpeedKmh, signalWeak, tripCount, onStart, onStop }) {
  if (gpsState === GPS_STATE.ACQUIRING) {
    return (
      <Card className="flex items-center gap-3 p-4">
        <Spinner className="h-5 w-5 text-teal-700" />
        <div>
          <p className="text-sm font-semibold text-slate-900">Finding your GPS signal…</p>
          <p className="text-xs text-slate-500">Can take a few seconds outdoors, longer indoors.</p>
        </div>
      </Card>
    );
  }

  if (gpsState === GPS_STATE.LIVE) {
    const kmh = msToKmh(lastCoords?.speed);
    return (
      <section className="overflow-hidden rounded-2xl bg-slate-900 text-white shadow-sm" aria-label="Live location sharing">
        <div className="flex items-center justify-between px-4 pt-4">
          <span className="flex items-center gap-2 text-sm font-medium">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
            </span>
            Sharing live location
          </span>
          <span className="text-xs text-slate-400">{tripCount} active trip{tripCount === 1 ? '' : 's'}</span>
        </div>
        <div className="flex items-end justify-between px-4 pb-4 pt-3">
          <div>
            <span className="text-5xl font-semibold tabular-nums tracking-tight">{kmh === null ? '—' : kmh}</span>
            <span className="ml-1.5 text-sm text-slate-400">km/h</span>
          </div>
          <div className="text-right text-xs text-slate-400">
            <p>Peak {maxSpeedKmh} km/h</p>
            <p className="mt-0.5">{lastCoords?.accuracy != null ? `±${Math.round(lastCoords.accuracy)} m accuracy` : 'Accuracy unknown'}</p>
          </div>
        </div>
        {signalWeak && (
          <div className="mx-4 mb-3 flex items-center gap-2 rounded-lg bg-amber-400/15 px-3 py-2 text-xs font-medium text-amber-200">
            <Icon name="signal" className="h-4 w-4" /> Weak GPS signal. Your last known position stays visible.
          </div>
        )}
        <button onClick={onStop}
          className="w-full border-t border-white/10 py-3 text-sm font-medium text-slate-300 transition hover:bg-white/5 focus:outline-none focus-visible:bg-white/10">
          Stop sharing
        </button>
      </section>
    );
  }

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-teal-700"><Icon name="pin" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-900">Share your live location</p>
          <p className="mt-0.5 text-xs text-slate-500">
            Starts automatically when a trip begins boarding. One signal covers all {tripCount} of your active trip{tripCount === 1 ? '' : 's'}.
          </p>
        </div>
      </div>
      {gpsError && <div className="mt-3"><Notice>{gpsError}</Notice></div>}
      <button className={`${BTN.primary} mt-3 w-full`} onClick={onStart}>Share location now</button>
    </Card>
  );
}

function TripStrip({ trips, selectedId, onSelect, onNew, creating }) {
  return (
    <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" role="tablist" aria-label="Your active trips">
      {trips.map((t) => {
        const active = t.id === selectedId && !creating;
        const m = statusMeta(t.status);
        return (
          <button key={t.id} role="tab" aria-selected={active} onClick={() => onSelect(t.id)}
            className={`min-w-[10.5rem] shrink-0 rounded-xl border px-3 py-2.5 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 ${
              active ? 'border-slate-900 bg-slate-900 text-white shadow-sm' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'}`}>
            <span className="flex items-center gap-1.5 text-sm font-semibold">
              <span className={`h-2 w-2 rounded-full ${m.dot}`} />
              {legOrigin(t)} <span className={active ? 'text-slate-500' : 'text-slate-300'}>→</span> {legDestination(t)}
            </span>
            <span className={`mt-0.5 block text-xs ${active ? 'text-slate-300' : 'text-slate-500'}`}>{m.label}</span>
          </button>
        );
      })}
      <button onClick={onNew} aria-label="Start another trip"
        className={`flex min-w-[7rem] shrink-0 items-center justify-center gap-1.5 rounded-xl border border-dashed px-3 py-2.5 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 ${
          creating ? 'border-teal-700 bg-teal-50 text-teal-800' : 'border-slate-300 text-slate-600 hover:border-teal-600 hover:text-teal-700'}`}>
        <Icon name="plus" className="h-4 w-4" /> New trip
      </button>
    </div>
  );
}

function ContactPanel({ numbers, newNumber, onNewNumberChange, onAdd, onRemove, saving, error }) {
  const atCap  = numbers.length >= MAX_CONTACT_NUMBERS;
  const canAdd = newNumber.trim().length > 0 && PHONE_RE.test(newNumber.trim()) && !atCap;
  return (
    <div className="space-y-3 border-t border-slate-100 px-4 py-4">
      {numbers.length === 0 ? (
        <p className="text-xs text-slate-500">No numbers yet. Passengers see these on the public tracking page.</p>
      ) : (
        <ul className="space-y-1.5">
          {numbers.map((n) => (
            <li key={n} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2">
              <span className="text-sm font-medium tabular-nums text-slate-800">{n}</span>
              <button className={BTN.danger} onClick={() => onRemove(n)} aria-label={`Remove ${n}`}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {!atCap ? (
        <div className="flex gap-2">
          <input type="tel" inputMode="tel" placeholder="09XXXXXXXXX" value={newNumber} maxLength={15}
            onChange={(e) => onNewNumberChange(e.target.value)} aria-label="New contact number"
            className="h-11 min-w-0 flex-1 rounded-xl border border-slate-200 px-3 text-sm focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20" />
          <button className={`${BTN.dark} h-11`} onClick={onAdd} disabled={!canAdd}>Add</button>
        </div>
      ) : (
        <p className="text-xs text-slate-500">Maximum of {MAX_CONTACT_NUMBERS} numbers. Remove one to add another.</p>
      )}
      {saving && <p className="flex items-center gap-1.5 text-xs text-slate-500"><Spinner className="h-3 w-3" />Saving…</p>}
      {error && <Notice>{error}</Notice>}
    </div>
  );
}

function FleetMap({ fleetTrips, fleetLiveData, ownTripIds }) {
  const now = Date.now();
  const markers = fleetTrips
    .filter((t) => MAP_VISIBLE_STATUSES.includes(t.status))
    .map((t) => {
      const live = fleetLiveData[t.id];
      const hasGps = typeof live?.lat === 'number' && typeof live?.lng === 'number';
      const stale = hasGps && live?.lastSeen && now - live.lastSeen > FLEET_GPS_STALE_THRESHOLD_MS;
      if (!hasGps || stale) return null;
      return {
        tripId: t.id, position: [live.lat, live.lng], status: t.status,
        plate: t.van?.plateNumber, driver: t.driver?.name, kmh: msToKmh(live?.speed), isOwn: ownTripIds.has(t.id),
      };
    })
    .filter(Boolean);

  return (
    <Card className="overflow-hidden" aria-label="Live fleet map">
      <CardHeader title="Fleet map" subtitle={`${markers.length} van${markers.length === 1 ? '' : 's'} sharing live location`} />
      <div style={{ height: 240 }}>
        <MapContainer center={VIRAC_HUB} zoom={11} style={{ height: '100%', width: '100%' }} scrollWheelZoom={false}>
          <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          <Marker position={VIRAC_HUB} icon={hubIcon}>
            <Popup><div className="text-xs font-semibold">{HOME_TERMINAL_NAME}</div></Popup>
          </Marker>
          {markers.map((m) => (
            <Marker key={m.tripId} position={m.position} icon={getMarkerIcon(m.status, m.isOwn)}>
              <Popup>
                <div className="space-y-0.5 text-xs">
                  <div className="font-semibold">{m.plate ?? 'Unknown plate'}{m.isOwn ? ' (you)' : ''}</div>
                  {m.driver && <div className="text-slate-500">{m.driver}</div>}
                  <div>{statusMeta(m.status).label}</div>
                  {m.kmh != null && <div>{m.kmh} km/h</div>}
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>
      {markers.length === 0 && <p className="border-t border-slate-100 bg-slate-50 py-2 text-center text-xs text-slate-500">No vans are sharing live location yet.</p>}
    </Card>
  );
}

function TripStarter({ takenOrigins, onStarted, onCancel, onRefresh, hasTrips }) {
  const [selected, setSelected]     = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const chosen = MUNICIPALITIES.find((m) => m.name === selected) ?? null;

  const extractErrorMessage = (err) => {
    const serverMsg = err?.response?.data?.message ?? err?.response?.data?.error;
    if (serverMsg) return Array.isArray(serverMsg) ? serverMsg.join('. ') : String(serverMsg);
    const status = err?.response?.status;
    if (status === 401) return 'Your session expired. Log in again.';
    if (status === 403) return 'You are not authorised to start a trip.';
    if (status === 404) return 'Trip start endpoint not found. Contact your administrator.';
    if (status >= 500)  return `Server error (${status}). Try again in a moment.`;
    if (err?.code === 'ECONNABORTED') return 'Request timed out. Check your mobile data and try again.';
    if (err?.message?.toLowerCase().includes('network')) return 'Network error. Check your connection and try again.';
    return `Could not start your trip: ${err?.message ?? 'unknown error'}`;
  };

  const handleStart = async () => {
    if (!chosen || submitting) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const response = await apiClient.post('/trips/self-start', {
        origin: chosen.name,
        destination: HOME_TERMINAL_NAME,
        routeName: `${chosen.name} → ${HOME_TERMINAL_NAME}`,
      });
      const tripData = response.data?.trip ?? response.data;
      if (!tripData?.id) throw new Error('Server response is missing the trip id.');
      onStarted(tripData);
    } catch (err) {
      console.error('[TripStarter] start trip error:', err);
      setSubmitError(extractErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title={hasTrips ? 'Start another trip' : 'Start a trip'}
        subtitle={`Pick where you're departing from. You'll drive to the ${HOME_TERMINAL_SHORT.toLowerCase()} and back.`}
        right={hasTrips && (
          <button onClick={onCancel} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Cancel">
            <Icon name="x" className="h-4 w-4" />
          </button>
        )}
      />
      <div className="space-y-4 p-4">
        <div className="grid grid-cols-2 gap-2" role="listbox" aria-label="Departure municipality">
          {MUNICIPALITIES.map((m) => {
            const taken = takenOrigins.has(m.name.toLowerCase());
            const isSel = selected === m.name;
            return (
              <button key={m.name} role="option" aria-selected={isSel} disabled={taken}
                onClick={() => setSelected(m.name)}
                className={`rounded-xl border px-3 py-2.5 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 ${
                  taken ? 'cursor-not-allowed border-slate-100 bg-slate-50 text-slate-300'
                  : isSel ? 'border-teal-700 bg-teal-50 ring-1 ring-teal-700'
                  : 'border-slate-200 bg-white hover:border-slate-300'}`}>
                <span className={`block text-sm font-semibold ${isSel ? 'text-teal-900' : taken ? '' : 'text-slate-800'}`}>{m.name}</span>
                <span className="block text-xs text-slate-500">{taken ? 'Trip in progress' : `About ${m.minutes} min`}</span>
              </button>
            );
          })}
        </div>

        {submitError && <Notice>{submitError}</Notice>}

        <button className={`${BTN.primary} w-full`} onClick={handleStart} disabled={!chosen || submitting}>
          {submitting ? <><Spinner /> Starting trip…</> : chosen ? `Start trip from ${chosen.name}` : 'Select a municipality'}
        </button>
        <button onClick={onRefresh} className="mx-auto flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-teal-700">
          <Icon name="refresh" className="h-3.5 w-3.5" /> Check if the dispatcher assigned a trip
        </button>
      </div>
    </Card>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function DriverDashboard() {
  const [trips, setTrips]               = useState([]);
  const [selectedId, setSelectedId]     = useState(null);
  const [creating, setCreating]         = useState(false);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState('');

  const [seatMap, setSeatMap]           = useState({});
  const [seatSaving, setSeatSaving]     = useState(false);
  const [tripMeta, setTripMeta]         = useState(loadMeta);
  const [busyTripId, setBusyTripId]     = useState(null);
  const [statusError, setStatusError]   = useState('');

  const [gpsState, setGpsState]         = useState(GPS_STATE.IDLE);
  const [gpsError, setGpsError]         = useState('');
  const [lastCoords, setLastCoords]     = useState(null);
  const [maxSpeedKmh, setMaxSpeedKmh]   = useState(0);
  const [signalWeak, setSignalWeak]     = useState(false);
  const [pendingAutoStart, setPendingAutoStart] = useState(null);

  const [fleetTrips, setFleetTrips]       = useState([]);
  const [fleetLiveData, setFleetLiveData] = useState({});

  const [contactNumbers, setContactNumbers]       = useState(getStoredContactNumbers);
  const [newContactNumber, setNewContactNumber]   = useState('');
  const [contactsSaving, setContactsSaving]       = useState(false);
  const [contactsError, setContactsError]         = useState('');
  const [showContactEditor, setShowContactEditor] = useState(false);

  const tripsRef          = useRef([]);
  const seatMapRef        = useRef({});
  const activeIdsRef      = useRef([]);
  const userIdRef         = useRef(getStoredUserId());
  const watchIdRef        = useRef(null);
  const heartbeatRef      = useRef(null);
  const wakeLockRef       = useRef(null);
  const lastFixRef        = useRef(null);   // last raw fix from the device
  const lastSentFixRef    = useRef(null);   // last fix we actually sent
  const lastSentAtRef     = useRef(0);
  const bufferRef         = useRef([]);     // fixes waiting for a connection
  const flushingRef       = useRef(false);
  const seatTimersRef     = useRef({});
  const lastEtaRef        = useRef({});
  const autoResumeTriedRef = useRef(false);

  useEffect(() => { tripsRef.current = trips; }, [trips]);
  useEffect(() => { seatMapRef.current = seatMap; }, [seatMap]);

  const activeTripIds = useMemo(
    () => trips.filter((t) => !GPS_LOCKED_STATUSES.includes(t.status)).map((t) => t.id),
    [trips],
  );
  useEffect(() => { activeIdsRef.current = activeTripIds; }, [activeTripIds]);

  const selectedTrip = useMemo(
    () => trips.find((t) => t.id === selectedId) ?? trips[0] ?? null,
    [trips, selectedId],
  );
  const selectedMeta = selectedTrip ? tripMeta[selectedTrip.id] : null;
  const selectedEta  = useMemo(
    () => (selectedTrip ? getEta(selectedTrip, selectedMeta) : null),
    [selectedTrip, selectedMeta],
  );
  const ownTripIds = useMemo(() => new Set(trips.map((t) => t.id)), [trips]);
  const takenOrigins = useMemo(
    () => new Set(trips.map((t) => originName(t).trim().toLowerCase())),
    [trips],
  );

  // ── Persist per-trip ETA bookkeeping ──
  useEffect(() => {
    try { localStorage.setItem(META_KEY, JSON.stringify(tripMeta)); } catch { /* ignore */ }
  }, [tripMeta]);

  const patchMeta = useCallback((id, patch) => {
    setTripMeta((prev) => ({ ...prev, [id]: { dep: null, delay: 0, ...(prev[id] ?? {}), ...patch } }));
  }, []);

  // ── Data loading ──
  const fetchMyTrips = useCallback(async (signal, { silent = false } = {}) => {
    if (!silent) { setLoading(true); setError(''); }
    try {
      const response = await apiClient.get('/trips/my-trips', { signal });
      const list = Array.isArray(response.data) ? response.data : [];
      setTrips((prev) => sortTrips(list.map((t) => mergeTrip(prev.find((p) => p.id === t.id), t))));
      setSelectedId((cur) => (list.some((t) => t.id === cur) ? cur : sortTrips(list)[0]?.id ?? null));
      setTripMeta((prev) => {
        const ids = new Set(list.map((t) => t.id));
        return Object.fromEntries(Object.entries(prev).filter(([id]) => ids.has(id)));
      });
      if (!silent) setSeatMap({});
      return list;
    } catch (err) {
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return null;
      if (!silent) setError('Failed to load your trips. Check your connection and try again.');
      console.error('[DriverDashboard] fetchMyTrips error:', err);
      return null;
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const fetchFleetTrips = useCallback(async (signal) => {
    try {
      const response = await apiClient.get('/trips/live', { signal });
      const list = Array.isArray(response.data) ? response.data : [];
      setFleetTrips(list);
      setFleetLiveData((prev) => {
        const next = { ...prev };
        for (const t of list) {
          const loc = t.liveLocation;
          if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') continue;
          const seen = typeof loc.timestamp === 'number' ? loc.timestamp : Date.now();
          if (!next[t.id] || seen > (next[t.id].lastSeen ?? 0)) {
            next[t.id] = {
              lat: loc.lat, lng: loc.lng,
              speed: typeof loc.speed === 'number' ? loc.speed : null,
              accuracy: typeof loc.accuracy === 'number' ? loc.accuracy : null,
              lastSeen: seen,
            };
          }
        }
        return next;
      });
    } catch (err) {
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
      console.error('[DriverDashboard] fetchFleetTrips error:', err);
    }
  }, []);

  const fetchContactNumbers = useCallback(async (signal) => {
    try {
      const response = await apiClient.get('/drivers/me/contact-numbers', { signal });
      const numbers = Array.isArray(response.data?.contactNumbers) ? response.data.contactNumbers : [];
      setContactNumbers(numbers);
      persistContactNumbersLocally(numbers);
    } catch (err) {
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
      console.warn('[DriverDashboard] fetchContactNumbers failed (using local cache):', err?.message);
    }
  }, []);

  // ── Contact numbers ──
  const saveContactNumbers = useCallback(async (nextNumbers, previous) => {
    setContactsSaving(true);
    setContactsError('');
    try {
      await apiClient.patch('/drivers/me/contact-numbers', { contactNumbers: nextNumbers });
      persistContactNumbersLocally(nextNumbers);
    } catch (err) {
      setContactsError(err?.response?.data?.error ?? 'Failed to save. Try again.');
      setContactNumbers(previous);
      console.error('[DriverDashboard] saveContactNumbers failed:', err);
    } finally {
      setContactsSaving(false);
    }
  }, []);

  const handleAddContact = useCallback(() => {
    const trimmed = newContactNumber.trim();
    if (!trimmed) return;
    if (!PHONE_RE.test(trimmed)) { setContactsError('Enter a valid phone number (7–15 digits).'); return; }
    if (contactNumbers.includes(trimmed)) { setContactsError('That number is already on your list.'); return; }
    if (contactNumbers.length >= MAX_CONTACT_NUMBERS) { setContactsError(`Maximum of ${MAX_CONTACT_NUMBERS} numbers.`); return; }
    const next = [...contactNumbers, trimmed];
    setContactNumbers(next);
    setNewContactNumber('');
    setContactsError('');
    saveContactNumbers(next, contactNumbers);
  }, [newContactNumber, contactNumbers, saveContactNumbers]);

  const handleRemoveContact = useCallback((number) => {
    const next = contactNumbers.filter((n) => n !== number);
    setContactNumbers(next);
    setContactsError('');
    saveContactNumbers(next, contactNumbers);
  }, [contactNumbers, saveContactNumbers]);

  // ── Seats ──
  const persistSeats = useCallback((tripId, seats) => {
    clearTimeout(seatTimersRef.current[tripId]);
    seatTimersRef.current[tripId] = setTimeout(async () => {
      setSeatSaving(true);
      try {
        await apiClient.patch(`/trips/${tripId}/seats`, { availableSeats: seats.available, totalSeats: seats.total });
      } catch (err) {
        console.warn('[DriverDashboard] seat persist failed:', err?.message);
      } finally {
        setSeatSaving(false);
      }
    }, SEAT_PERSIST_DEBOUNCE_MS);
  }, []);

  const changeSeats = (trip, updater) => {
    const next = updater(getSeats(trip, seatMap));
    setSeatMap((prev) => ({ ...prev, [trip.id]: next }));
    persistSeats(trip.id, next);
  };

  // ── Live location: one watch → every active trip ─────────────────────────

  const requestWakeLock = useCallback(async () => {
    try {
      if ('wakeLock' in navigator && !wakeLockRef.current) {
        const lock = await navigator.wakeLock.request('screen');
        wakeLockRef.current = lock;
        lock.addEventListener('release', () => { if (wakeLockRef.current === lock) wakeLockRef.current = null; });
      }
    } catch { /* not supported or denied */ }
  }, []);

  const releaseWakeLock = useCallback(() => {
    try { wakeLockRef.current?.release(); } catch { /* ignore */ }
    wakeLockRef.current = null;
  }, []);

  const flushBuffer = useCallback(async () => {
    if (flushingRef.current || bufferRef.current.length === 0) return;
    const ids = activeIdsRef.current;
    if (ids.length === 0) { bufferRef.current = []; return; }
    flushingRef.current = true;
    const batch = bufferRef.current.splice(0, FLUSH_BATCH);
    try {
      await apiClient.post(LOCATION_ENDPOINT, { tripIds: ids, fixes: batch });
    } catch (err) {
      // Network failure → keep the fixes for the next attempt. Server-side
      // rejections (4xx/5xx) are dropped so a bad batch can't loop forever.
      if (!err?.response) bufferRef.current.unshift(...batch);
    } finally {
      flushingRef.current = false;
    }
  }, []);

  const sendFix = useCallback((fix) => {
    const ids = activeIdsRef.current;
    if (ids.length === 0) return;
    lastSentAtRef.current = Date.now();
    lastSentFixRef.current = fix;
    if (socket.connected && navigator.onLine !== false) {
      for (const tripId of ids) socket.emit('driver_location', { tripId, ...fix });
    } else {
      bufferRef.current.push(fix);
      if (bufferRef.current.length > MAX_BUFFER) {
        bufferRef.current.splice(0, bufferRef.current.length - MAX_BUFFER);
      }
    }
  }, []);

  const stopLocationSharing = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation?.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    clearInterval(heartbeatRef.current);
    heartbeatRef.current = null;
    releaseWakeLock();
    lastFixRef.current = null;
    lastSentFixRef.current = null;
    bufferRef.current = [];
    setSignalWeak(false);
    setGpsState(GPS_STATE.IDLE);
    setLastCoords(null);
  }, [releaseWakeLock]);

  const startLocationSharing = useCallback(() => {
    if (activeIdsRef.current.length === 0) {
      setGpsError('No active trip to share a location for. Start a trip first.');
      setGpsState(GPS_STATE.ERROR);
      return;
    }
    if (!navigator.geolocation) {
      setGpsError('This device does not support GPS.');
      setGpsState(GPS_STATE.ERROR);
      return;
    }
    if (watchIdRef.current !== null) return;

    setGpsError('');
    setSignalWeak(false);
    setGpsState(GPS_STATE.ACQUIRING);
    setMaxSpeedKmh(0);
    lastFixRef.current = null;
    lastSentFixRef.current = null;
    lastSentAtRef.current = 0;
    socket.connect();

    const onPosition = (position) => {
      const { latitude: lat, longitude: lng, speed, accuracy, heading } = position.coords;
      const timestamp = Number.isFinite(position.timestamp) ? position.timestamp : Date.now();
      const prev = lastFixRef.current;

      let resolvedSpeed =
        typeof speed === 'number' && speed >= 0 && speed <= MAX_PLAUSIBLE_SPEED_MPS ? speed : null;

      if (resolvedSpeed === null && prev) {
        const dt = (timestamp - prev.timestamp) / 1000;
        if (dt >= MIN_DT_FOR_FALLBACK_SECONDS) {
          const dist = haversineMeters(prev.lat, prev.lng, lat, lng);
          if (dist >= MIN_DISTANCE_FOR_FALLBACK_M) {
            const derived = dist / dt;
            resolvedSpeed = derived <= MAX_PLAUSIBLE_SPEED_MPS ? derived : null;
          } else {
            resolvedSpeed = 0;
          }
        }
      }

      const fix = {
        lat, lng,
        speed: resolvedSpeed,
        accuracy: typeof accuracy === 'number' ? accuracy : null,
        heading: typeof heading === 'number' && !Number.isNaN(heading) ? heading : null,
        timestamp,
      };
      lastFixRef.current = fix;

      // Throttle: send on an interval, or sooner if the van really moved.
      const sentFix = lastSentFixRef.current;
      const moved = sentFix ? haversineMeters(sentFix.lat, sentFix.lng, lat, lng) : Infinity;
      if (Date.now() - lastSentAtRef.current >= MIN_SEND_INTERVAL_MS || moved >= MIN_SEND_MOVE_M) {
        sendFix(fix);
      }

      setLastCoords({ lat, lng, accuracy: fix.accuracy, speed: resolvedSpeed });
      setGpsState(GPS_STATE.LIVE);
      setGpsError('');
      setSignalWeak(false);

      const kmh = msToKmh(resolvedSpeed);
      if (kmh !== null) setMaxSpeedKmh((p) => Math.max(p, kmh));

      setFleetLiveData((p) => {
        const next = { ...p };
        for (const id of activeIdsRef.current) {
          next[id] = { lat, lng, speed: resolvedSpeed, accuracy: fix.accuracy, lastSeen: Date.now() };
        }
        return next;
      });
    };

    const onGeoError = (err) => {
      console.error('[DriverDashboard] geolocation error:', err);
      if (err?.code === 1) {
        // Permission denied is the only fatal case.
        stopLocationSharing();
        setGpsError(geolocationErrorMessage(err));
        setGpsState(GPS_STATE.ERROR);
        return;
      }
      // Tunnels, canyons, timeouts: keep watching and flag the weak signal.
      setSignalWeak(true);
    };

    watchIdRef.current = navigator.geolocation.watchPosition(onPosition, onGeoError, GPS_OPTIONS);

    // Heartbeat: keeps a stationary van "live", flags weak signal, and
    // flushes fixes buffered while offline.
    heartbeatRef.current = setInterval(() => {
      const last = lastFixRef.current;
      const now = Date.now();
      if (last) {
        const age = now - last.timestamp;
        setSignalWeak(age > WEAK_SIGNAL_MS);
        if (age <= STALE_FIX_MS && now - lastSentAtRef.current >= HEARTBEAT_MS) {
          sendFix({ ...last, speed: age > 10_000 ? 0 : last.speed, timestamp: now });
        }
      }
      if (bufferRef.current.length && navigator.onLine !== false) flushBuffer();
    }, 2500);
  }, [sendFix, flushBuffer, stopLocationSharing]);

  // ── Applying a fresh trip payload (own PATCH response or socket broadcast) ──
  const applyTripUpdate = useCallback((updated) => {
    if (!updated?.id) return;

    if (updated.status === 'COMPLETED' || updated.status === 'CANCELLED') {
      const id = updated.id;
      setTrips((prev) => prev.filter((t) => t.id !== id));
      setSelectedId((cur) => (cur === id ? tripsRef.current.find((t) => t.id !== id)?.id ?? null : cur));
      setFleetTrips((prev) => prev.filter((t) => t.id !== id));
      setFleetLiveData((prev) => { const n = { ...prev }; delete n[id]; return n; });
      setTripMeta((prev) => { const n = { ...prev }; delete n[id]; return n; });
      setSeatMap((prev) => { const n = { ...prev }; delete n[id]; return n; });
      delete lastEtaRef.current[id];
      setStatusError('');
      return;
    }

    const prevTrip = tripsRef.current.find((t) => t.id === updated.id);

    if (prevTrip && updated.direction && prevTrip.direction !== updated.direction) {
      // New leg: reset the ETA clock and send the van out empty.
      patchMeta(updated.id, { dep: null, delay: 0 });
      const cur = seatMapRef.current[updated.id] ?? getSeats(prevTrip, {});
      const reset = { ...cur, available: cur.total };
      setSeatMap((p) => ({ ...p, [updated.id]: reset }));
      persistSeats(updated.id, reset);
    }

    // Dispatcher's exit scan moved the RETURN leg to DEPARTED → start the ETA clock.
    if (prevTrip && prevTrip.status !== 'DEPARTED' && updated.status === 'DEPARTED' && updated.direction === 'RETURN') {
      patchMeta(updated.id, { dep: Date.now(), delay: 0 });
    }

    setTrips((prev) => {
      if (prev.some((t) => t.id === updated.id)) return prev.map((t) => (t.id === updated.id ? mergeTrip(t, updated) : t));
      return sortTrips([...prev, updated]);
    });
  }, [patchMeta, persistSeats]);

  const handleAdvanceStatus = useCallback(async (trip, newStatus) => {
    if (!trip || !newStatus || busyTripId) return;
    setBusyTripId(trip.id);
    setStatusError('');
    try {
      const response = await apiClient.patch(`/trips/${trip.id}/status`, { newStatus });
      const updated = response.data?.trip ?? response.data;

      if (newStatus === 'DEPARTING' || newStatus === 'DEPARTED') {
        patchMeta(trip.id, { dep: Date.now(), delay: 0 });
      }
      if (updated?.id) applyTripUpdate(updated);
      else setTrips((prev) => prev.map((t) => (t.id === trip.id ? { ...t, status: newStatus } : t)));
    } catch (err) {
      console.error('[DriverDashboard] status update error:', err);
      setStatusError(err?.response?.data?.error ?? err?.response?.data?.message ?? 'Could not update trip status. Try again.');
    } finally {
      setBusyTripId(null);
    }
  }, [busyTripId, applyTripUpdate, patchMeta]);

  const handleAddDelay = useCallback((tripId, minutes) => {
    setTripMeta((prev) => {
      const cur = prev[tripId] ?? { dep: null, delay: 0 };
      return { ...prev, [tripId]: { ...cur, delay: (cur.delay ?? 0) + minutes } };
    });
  }, []);

  const handleTripStarted = useCallback((newTrip) => {
    setTrips((prev) => (prev.some((t) => t.id === newTrip.id) ? prev : sortTrips([...prev, newTrip])));
    setSelectedId(newTrip.id);
    setCreating(false);
    setStatusError('');
    setFleetTrips((prev) => (prev.some((t) => t.id === newTrip.id) ? prev : [...prev, newTrip]));
    setPendingAutoStart(newTrip.id);
  }, []);

  const handleLogout = useCallback(async () => {
    stopLocationSharing();
    socket.disconnect();
    try { await apiClient.post('/auth/logout'); } catch (err) { console.warn('[DriverDashboard] logout request failed:', err); }
    try { localStorage.removeItem('token'); localStorage.removeItem('user'); localStorage.removeItem(META_KEY); } catch { /* ignore */ }
    window.location.replace('/login');
  }, [stopLocationSharing]);

  // ── Effects ──

  // Initial load. If location permission was already granted and trips are
  // active (e.g. page refreshed mid-drive), resume sharing automatically.
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      const list = await fetchMyTrips(controller.signal);
      if (!list?.length || autoResumeTriedRef.current) return;
      autoResumeTriedRef.current = true;
      try {
        const perm = await navigator.permissions?.query({ name: 'geolocation' });
        if (perm?.state === 'granted') setPendingAutoStart(list[0].id);
      } catch { /* permissions API unavailable */ }
    })();
    fetchContactNumbers(controller.signal);
    return () => { controller.abort(); stopLocationSharing(); socket.disconnect(); };
  }, [fetchMyTrips, fetchContactNumbers, stopLocationSharing]);

  useEffect(() => {
    const controller = new AbortController();
    fetchFleetTrips(controller.signal);
    const id = setInterval(() => fetchFleetTrips(new AbortController().signal), FLEET_REFETCH_INTERVAL_MS);
    return () => { controller.abort(); clearInterval(id); };
  }, [fetchFleetTrips]);

  // Auto-start sharing once the trip is actually in state.
  useEffect(() => {
    if (!pendingAutoStart) return;
    if (!trips.some((t) => t.id === pendingAutoStart)) return;
    setPendingAutoStart(null);
    if (watchIdRef.current === null) startLocationSharing();
  }, [pendingAutoStart, trips, startLocationSharing]);

  // Nothing left to share for → stop the GPS watch.
  useEffect(() => {
    if (activeTripIds.length === 0 && watchIdRef.current !== null) stopLocationSharing();
  }, [activeTripIds, stopLocationSharing]);

  // Keep the screen awake while sharing, and recover when the tab returns.
  const sharing = gpsState === GPS_STATE.LIVE || gpsState === GPS_STATE.ACQUIRING;
  useEffect(() => {
    if (!sharing) return undefined;
    requestWakeLock();
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      requestWakeLock();
      flushBuffer();
      fetchMyTrips(undefined, { silent: true });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => { document.removeEventListener('visibilitychange', onVisible); releaseWakeLock(); };
  }, [sharing, requestWakeLock, releaseWakeLock, flushBuffer, fetchMyTrips]);

  // Disconnect handling while sharing: reconnect, buffer in the meantime.
  useEffect(() => {
    if (!sharing) return undefined;
    const onDisconnect = (reason) => { if (reason !== 'io client disconnect') socket.connect(); };
    socket.on('disconnect', onDisconnect);
    return () => socket.off('disconnect', onDisconnect);
  }, [sharing]);

  // ETA broadcasts for every trip whose ETA changed.
  useEffect(() => {
    for (const t of trips) {
      const meta = tripMeta[t.id];
      const eta = getEta(t, meta);
      if (!eta) continue;
      const sig = `${eta.getTime()}|${meta?.delay ?? 0}`;
      if (lastEtaRef.current[t.id] === sig) continue;
      lastEtaRef.current[t.id] = sig;
      socket.emit('eta_update', {
        tripId: t.id,
        eta: eta.toISOString(),
        departureTime: getDeparture(t, meta)?.toISOString() ?? null,
        delayMinutes: meta?.delay ?? 0,
      });
    }
  }, [trips, tripMeta]);

  // Socket wiring
  useEffect(() => {
    const emitRegistration = () => {
      socket.emit('subscribe_to_map');
      const uid = userIdRef.current ?? getStoredUserId();
      if (uid) { userIdRef.current = uid; socket.emit('register_driver', { userId: uid }); }
      flushBuffer();
    };
    socket.connect();
    emitRegistration();
    socket.on('connect', emitRegistration);

    const onInitialLocations = (payload = []) => {
      if (!Array.isArray(payload)) return;
      try {
        setFleetLiveData(Object.fromEntries(payload.map(([tid, d]) => [tid, {
          lat: d?.lat, lng: d?.lng,
          speed: typeof d?.speed === 'number' ? d.speed : null,
          accuracy: typeof d?.accuracy === 'number' ? d.accuracy : null,
          lastSeen: d?.timestamp ? new Date(d.timestamp).getTime() : Date.now(),
        }])));
      } catch { /* ignore malformed payloads */ }
    };
    socket.on('initial_locations', onInitialLocations);

    const onVanMoved = (d) => {
      if (!d?.tripId || typeof d.lat !== 'number' || typeof d.lng !== 'number') return;
      setFleetLiveData((prev) => ({
        ...prev,
        [d.tripId]: {
          lat: d.lat, lng: d.lng,
          speed: typeof d.speed === 'number' ? d.speed : null,
          accuracy: typeof d.accuracy === 'number' ? d.accuracy : null,
          lastSeen: Date.now(),
        },
      }));
    };
    socket.on('van_moved', onVanMoved);

    const onTripDispatched = ({ trip: newTrip } = {}) => {
      if (!newTrip?.id) return;
      setFleetTrips((prev) => (prev.some((t) => t.id === newTrip.id) ? prev : [...prev, newTrip]));
      // A trip the dispatcher created for me: pull it in with its QR token.
      if (newTrip.driverId && newTrip.driverId === (userIdRef.current ?? getStoredUserId())) {
        fetchMyTrips(undefined, { silent: true });
      }
    };
    socket.on('trip_dispatched', onTripDispatched);

    const onTripStatusChanged = ({ tripId, trip: updated } = {}) => {
      if (!tripId) return;
      // Fleet map
      setFleetTrips((prev) => {
        if (updated?.status === 'COMPLETED' || updated?.status === 'CANCELLED') return prev.filter((t) => t.id !== tripId);
        if (prev.some((t) => t.id === tripId)) return prev.map((t) => (t.id === tripId ? { ...t, ...updated } : t));
        return updated ? [...prev, updated] : prev;
      });
      if (updated?.status === 'COMPLETED' || updated?.status === 'CANCELLED') {
        setFleetLiveData((prev) => { const n = { ...prev }; delete n[tripId]; return n; });
      }
      // My own trips: dispatcher scans, queue promotion, etc.
      if (updated && tripsRef.current.some((t) => t.id === tripId)) applyTripUpdate(updated);
    };
    socket.on('trip_status_changed', onTripStatusChanged);

    const onStartTracking = ({ tripId } = {}) => { if (tripId) setPendingAutoStart(tripId); };
    socket.on('start_tracking', onStartTracking);

    // Per-trip stop: the "nothing left to share" effect stops the watch once
    // the last active trip is gone, so other running trips keep tracking.
    const onStopTracking = ({ tripId } = {}) => {
      if (tripId) setPendingAutoStart((cur) => (cur === tripId ? null : cur));
    };
    socket.on('stop_tracking', onStopTracking);

    return () => {
      socket.off('connect', emitRegistration);
      socket.off('initial_locations', onInitialLocations);
      socket.off('van_moved', onVanMoved);
      socket.off('trip_dispatched', onTripDispatched);
      socket.off('trip_status_changed', onTripStatusChanged);
      socket.off('start_tracking', onStartTracking);
      socket.off('stop_tracking', onStopTracking);
    };
  }, [applyTripUpdate, fetchMyTrips, flushBuffer]);

  // Clear stale errors when switching trips
  useEffect(() => { setStatusError(''); }, [selectedId]);

  // ── Render ──

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-3 text-slate-500">
          <Spinner className="h-8 w-8 text-teal-700" />
          <p className="text-sm font-medium">Loading your trips…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
        <Card className="w-full max-w-md space-y-4 p-6 text-center">
          <h1 className="text-lg font-semibold text-slate-900">Driver portal</h1>
          <Notice>{error}</Notice>
          <button className={`${BTN.primary} w-full`} onClick={() => fetchMyTrips()}>Try again</button>
        </Card>
      </div>
    );
  }

  const driverName = selectedTrip?.driver?.name ?? trips[0]?.driver?.name ?? getStoredUserName();
  const showStarter = creating || trips.length === 0;

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900 antialiased">
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/85 backdrop-blur">
        <div className="mx-auto flex max-w-lg items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-teal-700 text-white"><Icon name="van" /></span>
            <div className="min-w-0">
              <h1 className="text-base font-semibold leading-tight tracking-tight">Driver portal</h1>
              <p className="truncate text-xs text-slate-500">{driverName ? `Signed in as ${driverName}` : 'Live trip tracking'}</p>
            </div>
          </div>
          <button className={BTN.secondary + ' h-9 px-3'} onClick={handleLogout} aria-label="Log out">
            <Icon name="logout" className="h-4 w-4" /> Log out
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-lg space-y-4 px-4 pb-16 pt-4">
        {activeTripIds.length > 0 && (
          <LiveLocationCard
            gpsState={gpsState}
            gpsError={gpsError}
            lastCoords={lastCoords}
            maxSpeedKmh={maxSpeedKmh}
            signalWeak={signalWeak}
            tripCount={activeTripIds.length}
            onStart={startLocationSharing}
            onStop={stopLocationSharing}
          />
        )}

        {trips.length > 0 && (
          <TripStrip trips={trips} selectedId={selectedTrip?.id} creating={creating}
            onSelect={(id) => { setSelectedId(id); setCreating(false); }}
            onNew={() => setCreating((c) => !c)} />
        )}

        {showStarter ? (
          <TripStarter
            hasTrips={trips.length > 0}
            takenOrigins={takenOrigins}
            onStarted={handleTripStarted}
            onCancel={() => setCreating(false)}
            onRefresh={() => fetchMyTrips(undefined, { silent: true })}
          />
        ) : selectedTrip && (
          <>
            <TripManifest trip={selectedTrip} eta={selectedEta} delayMinutes={selectedMeta?.delay ?? 0} />
            <StatusPanel
              trip={selectedTrip}
              eta={selectedEta}
              delayMinutes={selectedMeta?.delay ?? 0}
              busy={busyTripId === selectedTrip.id}
              error={statusError}
              onAdvance={(next) => handleAdvanceStatus(selectedTrip, next)}
              onAddDelay={(m) => handleAddDelay(selectedTrip.id, m)}
              onRefresh={() => fetchMyTrips(undefined, { silent: true })}
            />
            {!GPS_LOCKED_STATUSES.includes(selectedTrip.status) && (
              <SeatPanel
                seats={getSeats(selectedTrip, seatMap)}
                saving={seatSaving}
                onChange={(fn) => changeSeats(selectedTrip, fn)}
              />
            )}
          </>
        )}

        <FleetMap fleetTrips={fleetTrips} fleetLiveData={fleetLiveData} ownTripIds={ownTripIds} />

        <Card>
          <button onClick={() => setShowContactEditor((s) => !s)} aria-expanded={showContactEditor}
            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-600 rounded-2xl">
            <span className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-100 text-slate-600"><Icon name="phone" className="h-4 w-4" /></span>
              <span>
                <span className="block text-sm font-semibold text-slate-900">Contact numbers</span>
                <span className="block text-xs text-slate-500">{contactNumbers.length} shown to passengers</span>
              </span>
            </span>
            <Icon name="chevron" className={`h-4 w-4 text-slate-400 transition-transform ${showContactEditor ? 'rotate-180' : ''}`} />
          </button>
          {showContactEditor && (
            <ContactPanel
              numbers={contactNumbers}
              newNumber={newContactNumber}
              onNewNumberChange={setNewContactNumber}
              onAdd={handleAddContact}
              onRemove={handleRemoveContact}
              saving={contactsSaving}
              error={contactsError}
            />
          )}
        </Card>
      </main>
    </div>
  );
}
