import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { MapContainer, TileLayer, Marker, ZoomControl } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import apiClient from '../api/axios';
import { socket } from '../api/socket';
import { VIRAC_HUB } from '../components/townCoordinates';

// Same design system as the admin and dispatcher pages: high-contrast elevated
// flat UI, Plus Jakarta Sans, 16px cards, heavy tabular numbers for seats and
// ETAs, and a mobile-first bottom-sheet architecture.
//   Trip tab    : live location, your trips, progress, seats
//   Map tab     : the fleet, every van drawn as a van icon
//   Account tab : contact numbers shown to passengers
//   Sheets      : start a trip, the terminal QR code, report a delay,
//                 seat capacity, add a number, van details
// For notched phones, index.html should use:
//   <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
//
// A trip is a ROUND TRIP made of two legs, tracked by `trip.direction`:
//   OUTBOUND  municipality → terminal:  BOARDING → DEPARTING → DEPARTED
//             No "approaching" step. Once DEPARTED the driver shows a QR code
//             and the dispatcher's scan checks the van into its cooperative's line.
//   RETURN    terminal → municipality:  (QUEUED →) BOARDING → DEPARTING → DEPARTED
//             At DEPARTING the driver shows a QR code again; the dispatcher's
//             exit scan releases the van. The driver taps "Finish trip" at the
//             municipality.
// A driver can run SEVERAL trips at once, one per municipality. Location sharing
// is driver-level: one GPS watch feeds every active trip.

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
// Shared with the admin and dispatcher pages so the theme choice carries across.
const THEME_KEY           = 'terminalink_admin_theme';

const GPS_LOCKED_STATUSES = ['SCHEDULED', 'COMPLETED', 'CANCELLED'];
const ETA_STATUSES        = ['DEPARTING', 'DEPARTED', 'ARRIVING', 'DELAYED'];
const DELAY_STATUSES      = ['DEPARTING', 'DEPARTED', 'ARRIVING', 'DELAYED'];
const MAP_VISIBLE_STATUSES = ['BOARDING', 'QUEUED', 'DEPARTING', 'DEPARTED', 'ARRIVING', 'DELAYED'];
const STATUS_PRIORITY     = ['DEPARTED', 'ARRIVING', 'DEPARTING', 'DELAYED', 'BOARDING', 'QUEUED'];
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
const MOVING_HEADING_KMH   = 4;

const FLEET_REFETCH_INTERVAL_MS    = 30_000;
const FLEET_GPS_STALE_THRESHOLD_MS = 120_000;

const GPS_STATE = { IDLE: 'IDLE', ACQUIRING: 'ACQUIRING', LIVE: 'LIVE', ERROR: 'ERROR' };

const TABS = [
  { id: 'trip',    label: 'Trip',    icon: 'van' },
  { id: 'map',     label: 'Map',     icon: 'map' },
  { id: 'account', label: 'Account', icon: 'user' },
];

const STATUS_META = {
  BOARDING:  { label: 'Boarding',    tone: 'ok',     hex: '#059669' },
  DEPARTING: { label: 'Ready to go', tone: 'warn',   hex: '#d97706' },
  DEPARTED:  { label: 'On the road', tone: 'info',   hex: '#2563eb' },
  ARRIVING:  { label: 'On the road', tone: 'info',   hex: '#2563eb' }, // legacy: shown as on the road
  QUEUED:    { label: 'In queue',    tone: 'violet', hex: '#7c3aed' },
  DELAYED:   { label: 'Delayed',     tone: 'warn',   hex: '#ea580c' },
};
const statusMeta = (s) => STATUS_META[s] ?? STATUS_META.DEPARTED;

// ─── Theme (identical tokens to the admin and dispatcher pages) ───────────────

const THEME_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
.ui-root{
  --bg:#F2F4F7;--surface:#FFFFFF;--surface-2:#F6F8FA;--text:#0B1220;--muted:#475467;--line:#E4E7EC;
  --primary:#00873D;--on-primary:#FFFFFF;--primary-bg:#E3F5EA;
  --ok:#067647;--ok-bg:#E3F5EA;--warn:#B54708;--warn-bg:#FFF1DB;--bad:#B42318;--bad-bg:#FEE9E7;
  --info:#175CD3;--info-bg:#E6EEFD;--violet:#5925DC;--violet-bg:#EEE9FE;--neutral-bg:#EAECF0;
  --bad-solid:#C0182B;--on-bad:#FFFFFF;
  --shadow:0 1px 2px rgba(16,24,40,.06),0 4px 14px rgba(16,24,40,.08);
  --scrim:rgba(11,18,32,.5);
  font-family:'Plus Jakarta Sans',Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  background:var(--bg);color:var(--text);color-scheme:light;
  min-height:100vh;min-height:100dvh;
  -webkit-tap-highlight-color:transparent;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;
}
.ui-root[data-theme="dark"]{
  --bg:#0B0F14;--surface:#151B23;--surface-2:#1B232D;--text:#F4F6F8;--muted:#A9B3C1;--line:#2A3441;
  --primary:#3DD879;--on-primary:#04210F;--primary-bg:#11301E;
  --ok:#5EE09A;--ok-bg:#11301E;--warn:#FDB35C;--warn-bg:#3A2610;--bad:#FF8F85;--bad-bg:#3D1613;
  --info:#8DB8FF;--info-bg:#14264A;--violet:#BDA8FF;--violet-bg:#2A1F55;--neutral-bg:#222B37;
  --bad-solid:#FF6B5E;--on-bad:#2A0805;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 4px 14px rgba(0,0,0,.35);
  --scrim:rgba(0,0,0,.65);color-scheme:dark;
}
.ui-root *:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
.num{font-variant-numeric:tabular-nums;font-weight:800;letter-spacing:-.02em}

.ui-card{background:var(--surface);box-shadow:var(--shadow)}
.ui-soft{background:var(--surface-2)}
.ui-line{border-color:var(--line)}
.ui-divide>*+*{border-top:1px solid var(--line)}
.c-muted{color:var(--muted)}.c-primary{color:var(--primary)}.c-ok{color:var(--ok)}.c-warn{color:var(--warn)}
.c-bad{color:var(--bad)}.c-info{color:var(--info)}.c-violet{color:var(--violet)}
.chip-ok{background:var(--ok-bg);color:var(--ok)}.chip-warn{background:var(--warn-bg);color:var(--warn)}
.chip-bad{background:var(--bad-bg);color:var(--bad)}.chip-info{background:var(--info-bg);color:var(--info)}
.chip-violet{background:var(--violet-bg);color:var(--violet)}.chip-muted{background:var(--neutral-bg);color:var(--muted)}
.chip-primary{background:var(--primary-bg);color:var(--primary)}

.ui-btn{border:1.5px solid transparent;transition:background .15s,filter .15s,transform .1s;touch-action:manipulation}
.ui-btn:active:not(:disabled){transform:scale(.98)}
.ui-btn:disabled{opacity:.5;cursor:not-allowed}
.b-default{background:var(--surface);color:var(--text);border-color:var(--line)}
.b-primary{background:var(--primary);color:var(--on-primary)}
.b-danger{background:var(--bad-bg);color:var(--bad)}
.b-ghost{background:transparent;color:var(--text)}
.b-select{background:var(--surface);color:var(--text);border-color:var(--line)}
.b-select[aria-selected="true"]{background:var(--primary-bg);border-color:var(--primary)}
@media (hover:hover){
  .b-default:hover:not(:disabled),.b-ghost:hover:not(:disabled){background:var(--surface-2)}
  .b-primary:hover:not(:disabled){filter:brightness(.92)}
  .b-danger:hover:not(:disabled){filter:brightness(.96)}
  .ui-row:hover{background:var(--surface-2)}
}
.ui-row{transition:background .12s}
.ui-row:active{background:var(--surface-2)}

.ui-input{font-size:16px;background:var(--surface);color:var(--text);border:1.5px solid var(--line)}
.ui-input::placeholder{color:var(--muted);opacity:.85}
.ui-input:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-bg)}
.ui-input.invalid{border-color:var(--bad)}

.ui-header{background:var(--surface);border-bottom:1px solid var(--line);padding-top:env(safe-area-inset-top)}
.ui-nav{background:var(--surface);border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom);box-shadow:0 -4px 14px rgba(16,24,40,.06)}
.ui-pad{padding-left:max(1rem,env(safe-area-inset-left));padding-right:max(1rem,env(safe-area-inset-right))}
.van-marker{transition:transform 1.2s linear}
.ui-map-overlay{background:var(--surface);box-shadow:var(--shadow)}

/* Bottom sheet: slides up on phones, centred dialog from 768px */
@keyframes sheet-up{from{transform:translateY(100%)}to{transform:none}}
@keyframes fade-in{from{opacity:0}to{opacity:1}}
@keyframes pop-in{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:none}}
.sheet-scrim{background:var(--scrim);animation:fade-in .18s ease-out}
.sheet-panel{background:var(--surface);box-shadow:0 -10px 40px rgba(16,24,40,.22);max-height:92vh;max-height:92dvh;animation:sheet-up .26s cubic-bezier(.2,.8,.2,1)}
.sheet-handle{touch-action:none;cursor:grab}
.sheet-bar{background:var(--line);filter:brightness(.85)}
.sheet-safe{padding-bottom:calc(.75rem + env(safe-area-inset-bottom))}
@media (min-width:768px){
  .sheet-panel{box-shadow:0 24px 64px rgba(16,24,40,.28);max-height:88vh;max-height:88dvh;animation:pop-in .18s ease-out}
  .sheet-safe{padding-bottom:1rem}
}
@media (prefers-reduced-motion:reduce){
  .sheet-scrim,.sheet-panel{animation:none}
  .ui-btn,.van-marker{transition:none}
}
`;

// ─── Icons ────────────────────────────────────────────────────────────────────

const VAN_PATH = 'M3 16V7a1 1 0 011-1h9l5 5h2a1 1 0 011 1v4M3 16h2m12 0h-6M7 18a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM17 18a1.5 1.5 0 100-3 1.5 1.5 0 000 3z';

const ICONS = {
  van:      VAN_PATH,
  map:      'M9 4l-6 2v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14',
  user:     'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0',
  building: 'M4 21V5a1 1 0 011-1h8a1 1 0 011 1v16M14 9h5a1 1 0 011 1v11M3 21h18M8 8h2M8 12h2M8 16h2',
  pin:      'M12 21c4-4 7-7.2 7-11a7 7 0 10-14 0c0 3.8 3 7 7 11zM12 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z',
  phone:    'M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z',
  plus:     'M12 5v14M5 12h14',
  check:    'M5 13l4 4L19 7',
  clock:    'M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  qr:       'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v6h-4M14 18h2v2h-2z',
  flag:     'M5 21V4M5 4h11l-2 4 2 4H5',
  chevron:  'M9 6l6 6-6 6',
  x:        'M6 6l12 12M18 6L6 18',
  sun:      'M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4M12 16a4 4 0 100-8 4 4 0 000 8z',
  moon:     'M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z',
  logout:   'M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 8l-4 4 4 4M6 12h10',
  signal:   'M5 19v-3M10 19v-7M15 19V9M20 19V5',
  alert:    'M12 9v4M12 17h.01M10.3 4l-8 14a2 2 0 001.7 3h16a2 2 0 001.7-3l-8-14a2 2 0 00-3.4 0z',
  refresh:  'M20 11a8 8 0 00-14.9-3M4 5v4h4M4 13a8 8 0 0014.9 3M20 19v-4h-4',
  trash:    'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3',
  users:    'M16 20v-1a4 4 0 00-4-4H8a4 4 0 00-4 4v1M10 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM20 20v-1a4 4 0 00-3-3.9M16 4.1a3.5 3.5 0 010 6.8',
};

function Icon({ name, className = 'h-5 w-5' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

// ─── Map icons: every marker is a van ─────────────────────────────────────────

const markerCache = new Map();
function getVanMarkerIcon(status, heading, isOwn) {
  const bucket = typeof heading === 'number' ? (Math.round(heading / 30) * 30) % 360 : null;
  const key = `${status}|${bucket ?? 'n'}|${isOwn}`;
  if (markerCache.has(key)) return markerCache.get(key);

  const { hex } = statusMeta(status);
  const size = isOwn ? 44 : 36;
  const glyph = isOwn ? 24 : 20;
  const pointer = bucket === null ? '' : `
    <div style="position:absolute;inset:-8px;transform:rotate(${bucket}deg)">
      <div style="position:absolute;left:50%;top:-3px;margin-left:-6px;width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:10px solid ${hex}"></div>
    </div>`;

  const icon = L.divIcon({
    className: 'van-marker',
    html: `<div style="position:relative;width:${size}px;height:${size}px">${pointer}
      <div style="width:100%;height:100%;border-radius:50%;background:${hex};border:3px solid #fff;display:flex;align-items:center;justify-content:center;box-shadow:${isOwn ? `0 0 0 4px ${hex}40,` : ''}0 3px 10px rgba(15,23,42,.4)">
        <svg viewBox="0 0 24 24" width="${glyph}" height="${glyph}" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${VAN_PATH}"/></svg>
      </div></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
  markerCache.set(key, icon);
  return icon;
}

const hubIcon = L.divIcon({
  className: '',
  html: `<div style="width:34px;height:34px;border-radius:10px;background:#0B1220;border:3px solid #fff;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 10px rgba(15,23,42,.4)">
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS.building}"/></svg></div>`,
  iconSize: [34, 34],
  iconAnchor: [17, 17],
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

// The dispatcher scans the van's QR at the terminal: when an OUTBOUND van is on
// the road (check-in), and when a RETURN van is ready to leave (exit).
const needsQr = (trip) =>
  Boolean(trip) && ((getDirection(trip) === 'OUTBOUND' && isOnTheRoad(trip)) || (getDirection(trip) === 'RETURN' && trip.status === 'DEPARTING'));

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

// A live fix as the fleet map stores it, from the socket, HTTP, or this phone.
function toLive(raw) {
  if (!raw || typeof raw.lat !== 'number' || typeof raw.lng !== 'number') return null;
  const stamp = typeof raw.timestamp === 'number' ? raw.timestamp : typeof raw.lastSeen === 'number' ? raw.lastSeen : Date.now();
  return {
    lat: raw.lat,
    lng: raw.lng,
    speed: typeof raw.smoothedSpeed === 'number' ? raw.smoothedSpeed : typeof raw.speed === 'number' ? raw.speed : null,
    heading: typeof raw.heading === 'number' ? raw.heading : null,
    accuracy: typeof raw.accuracy === 'number' ? raw.accuracy : null,
    lastSeen: Math.min(stamp, Date.now()),
  };
}

function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === 'light' || saved === 'dark') return saved;
    } catch { /* ignore */ }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  useEffect(() => {
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);
  return [theme, toggle];
}

// ─── Primitives (same as the admin and dispatcher pages) ──────────────────────

const BTN_BASE = 'ui-btn inline-flex items-center justify-center gap-2 rounded-xl text-sm font-bold';
const BTN_SIZES = { md: 'h-11 px-4 sm:h-10', sm: 'h-10 px-3 text-xs sm:h-9', lg: 'h-12 px-5 text-base', icon: 'h-11 w-11 sm:h-10 sm:w-10' };
const BTN_VARIANTS = { default: 'b-default', primary: 'b-primary', danger: 'b-danger', ghost: 'b-ghost' };

function Btn({ variant = 'default', size = 'md', className = '', type = 'button', children, ...rest }) {
  return <button type={type} className={`${BTN_BASE} ${BTN_SIZES[size]} ${BTN_VARIANTS[variant]} ${className}`} {...rest}>{children}</button>;
}

function Card({ className = '', children, ...rest }) {
  return <section className={`ui-card rounded-2xl ${className}`} {...rest}>{children}</section>;
}

function Chip({ tone = 'muted', children }) {
  return <span className={`chip-${tone} inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-bold`}>{children}</span>;
}

function Spinner({ className = 'h-4 w-4' }) {
  return <span className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent ${className}`} role="status" aria-label="Loading" />;
}

function Notice({ tone = 'bad', children }) {
  return (
    <div role={tone === 'bad' ? 'alert' : undefined} className={`chip-${tone} flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold`}>
      <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}

function EmptyState({ icon = 'van', title, children, actions }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <span className="chip-muted mb-3 flex h-14 w-14 items-center justify-center rounded-full"><Icon name={icon} className="h-6 w-6" /></span>
      <p className="text-lg font-extrabold">{title}</p>
      {children && <p className="c-muted mt-1 max-w-xs text-sm font-medium">{children}</p>}
      {actions && <div className="mt-5 flex w-full max-w-xs flex-col gap-2">{actions}</div>}
    </div>
  );
}

function DetailRow({ label, children }) {
  return (
    <div className="ui-line flex items-start justify-between gap-4 border-b py-3 last:border-b-0">
      <dt className="c-muted shrink-0 text-sm font-medium">{label}</dt>
      <dd className="min-w-0 break-words text-right text-sm font-bold">{children}</dd>
    </div>
  );
}

function StatusChip({ status }) {
  const m = statusMeta(status);
  return <Chip tone={m.tone}>{m.label}</Chip>;
}

// ─── Bottom sheet (same behaviour as the admin and dispatcher pages) ──────────

function Sheet({ open, onClose, locked = false, title, subtitle, footer, children }) {
  const [dy, setDy] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startY = useRef(0);

  useEffect(() => { if (open) setDy(0); }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !locked) onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; // no scrolling the page behind the sheet
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open, locked, onClose]);

  if (!open) return null;

  const onPointerDown = (e) => {
    if (locked) return;
    startY.current = e.clientY;
    setDragging(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => { if (dragging) setDy(Math.max(0, e.clientY - startY.current)); };
  const onPointerUp = () => {
    if (!dragging) return;
    setDragging(false);
    if (dy > 110) onClose(); else setDy(0);
  };

  return (
    <div role="dialog" aria-modal="true" aria-label={title}
      className="sheet-scrim fixed inset-0 z-50 flex items-end justify-center md:items-center md:p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !locked) onClose(); }}>
      <div className="sheet-panel flex w-full min-w-0 flex-col rounded-t-2xl md:max-w-md md:rounded-2xl"
        style={{ transform: dy ? `translateY(${dy}px)` : undefined, transition: dragging ? 'none' : 'transform .2s ease-out' }}>
        <div className="sheet-handle flex justify-center py-3 md:hidden" onPointerDown={onPointerDown} onPointerMove={onPointerMove}
          onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          <span className="sheet-bar h-1.5 w-10 rounded-full" />
        </div>
        <div className="flex items-start justify-between gap-3 px-4 pb-3 md:p-5 md:pb-3">
          <div className="min-w-0">
            <h2 className="truncate text-xl font-extrabold tracking-tight">{title}</h2>
            {subtitle && <p className="c-muted text-sm font-medium">{subtitle}</p>}
          </div>
          <Btn variant="ghost" size="icon" onClick={onClose} disabled={locked} aria-label="Close" className="-mr-2 shrink-0"><Icon name="x" /></Btn>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 md:px-5">{children}</div>
        {footer && <div className="ui-line sheet-safe border-t px-4 pt-3 md:px-5">{footer}</div>}
      </div>
    </div>
  );
}

// ─── Sheets ───────────────────────────────────────────────────────────────────

function StartTripSheet({ open, takenOrigins, onStarted, onClose }) {
  const [selected, setSelected]     = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const chosen = MUNICIPALITIES.find((m) => m.name === selected) ?? null;

  useEffect(() => { if (open) { setSelected(null); setSubmitError(''); } }, [open]);

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
      console.error('[StartTripSheet] start trip error:', err);
      setSubmitError(extractErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} locked={submitting} title="Start a trip"
      subtitle={`Where are you departing from? You'll drive to the ${HOME_TERMINAL_SHORT.toLowerCase()} and back.`}
      footer={
        <Btn variant="primary" size="lg" className="w-full" onClick={handleStart} disabled={!chosen || submitting}>
          {submitting ? <><Spinner /> Starting trip…</> : chosen ? `Start trip from ${chosen.name}` : 'Select a municipality'}
        </Btn>
      }>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2" role="listbox" aria-label="Departure municipality">
          {MUNICIPALITIES.map((m) => {
            const taken = takenOrigins.has(m.name.toLowerCase());
            return (
              <button key={m.name} type="button" role="option" aria-selected={selected === m.name} disabled={taken}
                onClick={() => setSelected(m.name)}
                className="ui-btn b-select flex min-h-[64px] flex-col items-start justify-center rounded-xl px-3.5 py-2 text-left">
                <span className="text-base font-extrabold">{m.name}</span>
                <span className="c-muted text-xs font-semibold">{taken ? 'Trip in progress' : <>About <span className="num">{m.minutes}</span> min</>}</span>
              </button>
            );
          })}
        </div>
        {submitError && <Notice>{submitError}</Notice>}
      </div>
    </Sheet>
  );
}

function QrSheet({ trip, onClose, onRefresh }) {
  const van = trip?.van;
  const isExit = trip ? getDirection(trip) === 'RETURN' : false;
  return (
    <Sheet open={Boolean(trip)} onClose={onClose}
      title={isExit ? 'Leaving the terminal' : 'Arriving at the terminal'}
      subtitle={isExit ? `Show this to the dispatcher. Once scanned, your trip to ${trip ? legDestination(trip) : ''} starts.` : "Show this to the dispatcher. Scanning checks you into your cooperative's line."}
      footer={trip && <Btn size="lg" className="w-full" onClick={onRefresh}><Icon name="refresh" /> Already scanned? Refresh</Btn>}>
      {trip && (
        <div className="space-y-4 text-center">
          {van?.qrToken ? (
            <>
              <div className="mx-auto inline-block max-w-full rounded-2xl p-4" style={{ background: '#FFFFFF', boxShadow: 'inset 0 0 0 1.5px #E4E7EC' }}>
                <QRCodeSVG value={van.qrToken} size={232} bgColor="#FFFFFF" fgColor="#0B1220" style={{ maxWidth: '100%', height: 'auto' }} />
              </div>
              <p className="num text-3xl">{van.plateNumber}</p>
              {!isExit && <p className="c-muted text-sm font-medium">If the boarding slot is free you start boarding right away. Otherwise you join the queue.</p>}
            </>
          ) : (
            <Notice tone="warn">QR code unavailable. Tap Refresh, or ask the dispatcher to {isExit ? 'release' : 'check in'} your van manually.</Notice>
          )}
        </div>
      )}
    </Sheet>
  );
}

function DelaySheet({ open, currentDelay, onAdd, onReset, onClose }) {
  return (
    <Sheet open={open} onClose={onClose} title="Report a delay" subtitle="Passengers and the dispatcher see the new arrival time."
      footer={currentDelay > 0 ? <Btn size="lg" className="w-full" onClick={onReset}>Clear delay ({currentDelay} min)</Btn> : null}>
      <div className="space-y-3">
        {currentDelay > 0 && <Notice tone="warn"><span className="num">{currentDelay}</span> min of delay already added.</Notice>}
        <div className="grid grid-cols-2 gap-3">
          {DELAY_OPTIONS.map((m) => (
            <Btn key={m} size="lg" onClick={() => onAdd(m)} aria-label={`Add ${m} minute delay`}>
              +<span className="num">{m}</span> min
            </Btn>
          ))}
        </div>
      </div>
    </Sheet>
  );
}

function CapacitySheet({ open, seats, onChange, onClose }) {
  const roundBtn = 'ui-btn b-default flex h-14 w-14 items-center justify-center rounded-full text-3xl font-extrabold';
  return (
    <Sheet open={open} onClose={onClose} title="Seat capacity" subtitle="How many passengers this van can carry on this trip."
      footer={<Btn variant="primary" size="lg" className="w-full" onClick={onClose}>Done</Btn>}>
      <div className="flex items-center justify-center gap-8 py-6">
        <button type="button" className={roundBtn} aria-label="Decrease total capacity"
          onClick={() => onChange((s) => { const t = Math.max(1, s.total - 1); return { total: t, available: Math.min(s.available, t) }; })}>−</button>
        <p className="num w-20 text-center text-6xl">{seats.total}</p>
        <button type="button" className={roundBtn} aria-label="Increase total capacity"
          onClick={() => onChange((s) => ({ ...s, total: Math.min(100, s.total + 1) }))}>+</button>
      </div>
    </Sheet>
  );
}

function AddNumberSheet({ open, value, onChange, onSubmit, error, saving, onClose }) {
  const inputRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const fine = window.matchMedia?.('(pointer: fine)').matches; // skip auto-focus on touch screens
    const id = setTimeout(() => { if (fine) inputRef.current?.focus(); }, 80);
    return () => clearTimeout(id);
  }, [open]);
  const canAdd = value.trim().length > 0 && PHONE_RE.test(value.trim());
  return (
    <Sheet open={open} onClose={onClose} locked={saving} title="Add a number" subtitle="Passengers see this on the public tracking page."
      footer={<Btn variant="primary" size="lg" className="w-full" onClick={onSubmit} disabled={!canAdd || saving}>{saving ? <><Spinner /> Saving…</> : 'Add number'}</Btn>}>
      <div className="space-y-3">
        <input ref={inputRef} type="tel" inputMode="tel" placeholder="09XXXXXXXXX" value={value} maxLength={15}
          onChange={(e) => onChange(e.target.value)} aria-label="New contact number" onKeyDown={(e) => { if (e.key === 'Enter' && canAdd) onSubmit(); }}
          className={`ui-input h-12 w-full rounded-xl px-3.5 font-bold tabular-nums ${error ? 'invalid' : ''}`} />
        {error && <Notice>{error}</Notice>}
      </div>
    </Sheet>
  );
}

function VanInfoSheet({ trip, live, onClose }) {
  const { available, total } = trip ? { available: trip.availableSeats ?? trip.van?.capacity ?? null, total: trip.totalSeats ?? trip.van?.capacity ?? null } : {};
  const kmh = msToKmh(live?.speed);
  return (
    <Sheet open={Boolean(trip)} onClose={onClose} title={trip?.van?.plateNumber ?? ''} subtitle={trip?.driver?.name ?? 'Driver'}>
      {trip && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <StatusChip status={trip.status} />
            <Chip tone={getDirection(trip) === 'RETURN' ? 'violet' : 'info'}>{getDirection(trip) === 'RETURN' ? 'Return leg' : 'Outbound'}</Chip>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="ui-soft rounded-2xl p-4">
              <p className="num text-4xl leading-none">{available ?? '—'}<span className="c-muted font-bold">/{total ?? '—'}</span></p>
              <p className="c-muted mt-1 text-sm font-semibold">seats free</p>
            </div>
            <div className="ui-soft rounded-2xl p-4">
              <p className="num text-4xl leading-none">{kmh == null ? '—' : kmh > 1 ? kmh : 0}</p>
              <p className="c-muted mt-1 text-sm font-semibold">km/h</p>
            </div>
          </div>
          <dl>
            <DetailRow label="Route">{legOrigin(trip)} → {legDestination(trip)}</DetailRow>
            <DetailRow label="Cooperative">{trip.van?.cooperative?.name ?? 'Unassigned'}</DetailRow>
          </dl>
        </div>
      )}
    </Sheet>
  );
}

// ─── Trip tab pieces ──────────────────────────────────────────────────────────

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
              <span className={`num flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm ${done ? 'b-primary' : current ? 'chip-primary' : 'chip-muted'}`}
                style={current ? { boxShadow: 'inset 0 0 0 2px var(--primary)' } : undefined}>
                {done ? <Icon name="check" className="h-4 w-4" /> : i + 1}
              </span>
              {i < steps.length - 1 && <span className="mx-1 h-1 flex-1 rounded-full" style={{ background: done ? 'var(--primary)' : 'var(--line)' }} />}
            </div>
            <span className={`mt-1.5 self-start text-[11px] font-bold ${current ? '' : 'c-muted'}`}>{step.label}</span>
          </li>
        );
      })}
    </ol>
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

function TripStrip({ trips, selectedId, onSelect, onNew }) {
  return (
    <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" role="tablist" aria-label="Your active trips">
      {trips.map((t) => {
        const active = t.id === selectedId;
        return (
          <button key={t.id} type="button" role="tab" aria-selected={active} onClick={() => onSelect(t.id)}
            className={`ui-btn ${active ? 'b-primary' : 'b-default'} min-w-[11rem] shrink-0 rounded-xl px-3.5 py-2.5 text-left`}>
            <span className="flex items-center gap-2 text-sm font-extrabold">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: active ? 'var(--on-primary)' : statusMeta(t.status).hex }} />
              <span className="truncate">{legOrigin(t)} → {legDestination(t)}</span>
            </span>
            <span className={`mt-0.5 block text-xs font-semibold ${active ? '' : 'c-muted'}`} style={active ? { opacity: 0.85 } : undefined}>{statusMeta(t.status).label}</span>
          </button>
        );
      })}
      <button type="button" onClick={onNew} aria-label="Start another trip"
        className="ui-btn b-default flex min-w-[7.5rem] shrink-0 items-center justify-center gap-1.5 rounded-xl border-dashed px-3 py-2.5 text-sm font-bold">
        <Icon name="plus" className="h-4 w-4" /> New trip
      </button>
    </div>
  );
}

function LiveLocationCard({ gpsState, gpsError, lastCoords, maxSpeedKmh, signalWeak, tripCount, onStart, onStop }) {
  if (gpsState === GPS_STATE.ACQUIRING) {
    return (
      <Card className="flex items-center gap-3 p-4">
        <Spinner className="c-primary h-6 w-6" />
        <div>
          <p className="font-extrabold">Finding your GPS signal…</p>
          <p className="c-muted text-sm font-medium">Can take a few seconds outdoors, longer indoors.</p>
        </div>
      </Card>
    );
  }

  if (gpsState === GPS_STATE.LIVE) {
    const kmh = msToKmh(lastCoords?.speed);
    return (
      <Card className="overflow-hidden" aria-label="Live location sharing">
        <div className="flex items-center justify-between px-4 pt-4">
          <span className="flex items-center gap-2 text-sm font-bold">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-70" style={{ background: 'var(--primary)' }} />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full" style={{ background: 'var(--primary)' }} />
            </span>
            Sharing live location
          </span>
          <span className="c-muted text-xs font-bold"><span className="num">{tripCount}</span> active trip{tripCount === 1 ? '' : 's'}</span>
        </div>
        <div className="flex items-end justify-between px-4 pb-4 pt-3">
          <div>
            <span className="num text-5xl leading-none">{kmh === null ? '—' : kmh}</span>
            <span className="c-muted ml-1.5 text-sm font-bold">km/h</span>
          </div>
          <div className="c-muted text-right text-xs font-semibold">
            <p>Peak <span className="num">{maxSpeedKmh}</span> km/h</p>
            <p className="mt-0.5">{lastCoords?.accuracy != null ? <>±<span className="num">{Math.round(lastCoords.accuracy)}</span> m accuracy</> : 'Accuracy unknown'}</p>
          </div>
        </div>
        {signalWeak && <div className="px-4 pb-3"><Notice tone="warn">Weak GPS signal. Your last known position stays visible.</Notice></div>}
        <button type="button" onClick={onStop} className="ui-row ui-line w-full border-t py-3.5 text-sm font-bold">Stop sharing</button>
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <span className="chip-primary flex h-11 w-11 shrink-0 items-center justify-center rounded-full"><Icon name="pin" /></span>
        <div className="min-w-0 flex-1">
          <p className="font-extrabold">Share your live location</p>
          <p className="c-muted text-sm font-medium">
            Starts automatically when a trip begins boarding. One signal covers all <span className="num">{tripCount}</span> of your active trip{tripCount === 1 ? '' : 's'}.
          </p>
        </div>
      </div>
      {gpsError && <div className="mt-3"><Notice>{gpsError}</Notice></div>}
      <Btn variant="primary" size="lg" className="mt-3 w-full" onClick={onStart}>Share location now</Btn>
    </Card>
  );
}

function TripSummaryCard({ trip, eta, delayMinutes }) {
  const direction = getDirection(trip);
  const coop = trip.van?.cooperative?.name;
  const showEta = ETA_STATUSES.includes(trip.status);
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="c-muted text-xs font-bold">{direction === 'RETURN' ? 'Return leg' : 'Outbound leg'}</p>
          <h2 className="mt-0.5 text-2xl font-extrabold leading-tight tracking-tight">{legOrigin(trip)} → {legDestination(trip)}</h2>
        </div>
        <StatusChip status={trip.status} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="ui-soft rounded-2xl p-4">
          {(() => {
            const total = trip.totalSeats ?? trip.van?.capacity;
            const available = trip.availableSeats ?? total;
            return (
              <>
                <p className={`num text-4xl leading-none ${available === 0 ? 'c-bad' : ''}`}>{available ?? '—'}<span className="c-muted font-bold">/{total ?? '—'}</span></p>
                <p className="c-muted mt-1 text-sm font-semibold">seats free</p>
              </>
            );
          })()}
        </div>
        <div className="ui-soft rounded-2xl p-4">
          <p className="num text-4xl leading-none">{showEta && eta ? fmtTime(eta) : '—'}</p>
          <p className="c-muted mt-1 text-sm font-semibold">
            {showEta && eta ? <>arrive {legDestination(trip)} · <span className="c-primary font-bold"><EtaCountdown eta={eta} /></span></> : 'ETA after you depart'}
          </p>
          {delayMinutes > 0 && <div className="mt-2"><Chip tone="warn">+{delayMinutes} min delay</Chip></div>}
        </div>
      </div>

      <dl className="mt-2">
        <DetailRow label="Van plate"><span className="num">{trip.van?.plateNumber ?? 'Unknown'}</span></DetailRow>
        {coop && <DetailRow label="Cooperative">{coop}</DetailRow>}
        <DetailRow label="Trip started">{trip.scheduledTime ? fmtTime(new Date(trip.scheduledTime)) : '—'}</DetailRow>
      </dl>
    </Card>
  );
}

function ProgressCard({ trip, delayMinutes, busy, error, onAdvance, onShowQr, onOpenDelay }) {
  const direction = getDirection(trip);
  const step = getAdvanceStep(trip);
  const qr = needsQr(trip);
  const canFinish = direction === 'RETURN' && isOnTheRoad(trip);
  const isQueued = trip.status === 'QUEUED';

  return (
    <Card className="space-y-4 p-4" aria-label="Trip progress">
      <h2 className="text-lg font-extrabold tracking-tight">Trip progress</h2>

      {!isQueued && <Stepper trip={trip} />}

      {isQueued && (
        <div className="chip-violet rounded-2xl p-4 text-center">
          <p className="font-extrabold">You're checked in and in the queue</p>
          <p className="mt-1 text-sm font-medium">Another van from your cooperative is boarding. You'll start boarding automatically when it leaves.</p>
        </div>
      )}

      {trip.status === 'DELAYED' && <Notice tone="warn">Trip marked as delayed. Contact your dispatcher to resume.</Notice>}

      {step && (
        <div>
          <Btn variant="primary" size="lg" className="w-full" disabled={busy} onClick={() => onAdvance(step.next)}>
            {busy ? <><Spinner /> Updating…</> : step.label}
          </Btn>
          <p className="c-muted mt-2 text-center text-sm font-medium">{step.hint}</p>
        </div>
      )}

      {qr && (
        <div className="space-y-2">
          <Notice tone={direction === 'RETURN' ? 'warn' : 'info'}>
            {direction === 'RETURN'
              ? 'Ready to leave. Show your QR code to the dispatcher to be released.'
              : 'On the way. Show your QR code to the dispatcher when you reach the terminal.'}
          </Notice>
          <Btn variant="primary" size="lg" className="w-full" onClick={onShowQr}>
            <Icon name="qr" /> {direction === 'RETURN' ? 'Show exit QR code' : 'Show check-in QR code'}
          </Btn>
        </div>
      )}

      {canFinish && (
        <div className="chip-ok rounded-2xl p-4 text-center">
          <p className="font-extrabold">Heading to {legDestination(trip)}</p>
          <p className="mt-1 text-sm font-medium">No scan needed. Finish the trip once passengers are off.</p>
          <Btn variant="primary" size="lg" className="mt-3 w-full" disabled={busy} onClick={() => onAdvance('COMPLETED')}>
            {busy ? <><Spinner /> Finishing…</> : <><Icon name="flag" /> Finish trip</>}
          </Btn>
        </div>
      )}

      {error && <Notice>{error}</Notice>}

      {DELAY_STATUSES.includes(trip.status) && (
        <Btn className="w-full" onClick={onOpenDelay}>
          <Icon name="clock" /> Report a delay{delayMinutes > 0 && <span className="chip-warn num rounded-full px-2 py-0.5 text-xs">+{delayMinutes} min</span>}
        </Btn>
      )}
    </Card>
  );
}

function SeatCard({ seats, saving, onChange, onEditCapacity }) {
  const pct = seats.total === 0 ? 0 : Math.round((seats.available / seats.total) * 100);
  const bar = pct > 50 ? 'var(--ok)' : pct > 25 ? 'var(--warn)' : 'var(--bad)';
  const roundBtn = 'ui-btn flex h-16 w-16 items-center justify-center rounded-full text-4xl font-extrabold';
  return (
    <Card className="p-4" aria-label="Seat availability">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-extrabold tracking-tight">Seats</h2>
        {saving ? <span className="c-muted flex items-center gap-1.5 text-xs font-bold"><Spinner className="h-3 w-3" /> Saving</span> : <span className="c-muted text-xs font-semibold">Saved automatically</span>}
      </div>
      <div className="flex items-center justify-center gap-5 py-5">
        <button type="button" className={`${roundBtn} b-default`} aria-label="Mark one seat taken"
          onClick={() => onChange((s) => ({ ...s, available: Math.max(0, s.available - 1) }))}>−</button>
        <div className="w-32 text-center" aria-live="polite" aria-atomic="true">
          <p className={`num text-6xl leading-none ${seats.available === 0 ? 'c-bad' : ''}`}>{seats.available}</p>
          <p className="c-muted mt-1.5 text-sm font-bold">of <span className="num">{seats.total}</span> free</p>
        </div>
        <button type="button" className={`${roundBtn} b-primary`} aria-label="Free up one seat"
          onClick={() => onChange((s) => ({ ...s, available: Math.min(s.total, s.available + 1) }))}>+</button>
      </div>
      <div className="h-2 overflow-hidden rounded-full" style={{ background: 'var(--neutral-bg)' }}>
        <div className="h-full rounded-full transition-all duration-300" style={{ width: `${pct}%`, background: bar }} />
      </div>
      {seats.available === 0 && <p className="c-bad mt-2 text-center text-sm font-bold">Van is full</p>}
      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="c-muted text-xs font-medium">Resets to full when the return trip begins.</p>
        <Btn size="sm" onClick={onEditCapacity}><Icon name="users" className="h-4 w-4" /> Capacity</Btn>
      </div>
    </Card>
  );
}

// ─── Map tab ──────────────────────────────────────────────────────────────────

function FleetMapTab({ markerGroups, liveCount, onOpen }) {
  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Fleet map</h1>
          <p className="c-muted text-sm font-medium"><span className="num">{liveCount}</span> {liveCount === 1 ? 'van is' : 'vans are'} sharing live location</p>
        </div>
      </div>
      <Card className="relative overflow-hidden" style={{ height: 'calc(100dvh - 16rem)', minHeight: 320 }}>
        <MapContainer center={VIRAC_HUB} zoom={11} style={{ height: '100%', width: '100%' }} scrollWheelZoom={false} zoomControl={false}>
          <ZoomControl position="topright" />
          <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          <Marker position={VIRAC_HUB} icon={hubIcon} />
          {markerGroups.map((g) => {
            const kmh = msToKmh(g.live?.speed) ?? 0;
            const heading = kmh >= MOVING_HEADING_KMH ? g.live?.heading : null;
            return (
              <Marker key={g.key} position={g.position} icon={getVanMarkerIcon(g.primary.status, heading, g.isOwn)}
                zIndexOffset={g.isOwn ? 1000 : 0} eventHandlers={{ click: () => onOpen(g.primary.id) }} />
            );
          })}
        </MapContainer>
        {markerGroups.length === 0 && (
          <div className="ui-map-overlay pointer-events-none absolute bottom-4 left-1/2 z-[1000] flex w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 items-center justify-center rounded-2xl px-4 py-3 text-center text-xs font-bold">
            No vans are sharing live location yet.
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function BottomNav({ tab, onChange }) {
  return (
    <nav className="ui-nav fixed inset-x-0 bottom-0 z-40" aria-label="Driver views">
      <ul className="mx-auto grid max-w-lg grid-cols-3">
        {TABS.map((t) => {
          const on = tab === t.id;
          return (
            <li key={t.id}>
              <button type="button" onClick={() => onChange(t.id)} aria-current={on ? 'page' : undefined}
                className={`relative flex min-h-[58px] w-full flex-col items-center justify-center gap-0.5 text-[11px] font-bold ${on ? 'c-primary' : 'c-muted'}`}>
                {on && <span className="absolute top-0 h-[3px] w-10 rounded-b-full" style={{ background: 'var(--primary)' }} />}
                <Icon name={t.icon} className="h-6 w-6" />
                {t.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DriverDashboard() {
  const [theme, toggleTheme] = useTheme();
  const [tab, setTab] = useState('trip');

  const [trips, setTrips]               = useState([]);
  const [selectedId, setSelectedId]     = useState(null);
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

  const [contactNumbers, setContactNumbers]     = useState(getStoredContactNumbers);
  const [newContactNumber, setNewContactNumber] = useState('');
  const [contactsSaving, setContactsSaving]     = useState(false);
  const [contactsError, setContactsError]       = useState('');

  // Sheets
  const [startOpen, setStartOpen]       = useState(false);
  const [qrOpen, setQrOpen]             = useState(false);
  const [delayOpen, setDelayOpen]       = useState(false);
  const [capacityOpen, setCapacityOpen] = useState(false);
  const [addNumberOpen, setAddNumberOpen] = useState(false);
  const [vanInfoId, setVanInfoId]       = useState(null);

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

  useEffect(() => { window.scrollTo({ top: 0 }); }, [tab]);

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
          const live = toLive(t.liveLocation);
          if (live && (!next[t.id] || live.lastSeen > (next[t.id].lastSeen ?? 0))) next[t.id] = live;
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

  // Returns true when the number was accepted, so the sheet can close.
  const handleAddContact = useCallback(() => {
    const trimmed = newContactNumber.trim();
    if (!trimmed) return false;
    if (!PHONE_RE.test(trimmed)) { setContactsError('Enter a valid phone number (7–15 digits).'); return false; }
    if (contactNumbers.includes(trimmed)) { setContactsError('That number is already on your list.'); return false; }
    if (contactNumbers.length >= MAX_CONTACT_NUMBERS) { setContactsError(`Maximum of ${MAX_CONTACT_NUMBERS} numbers.`); return false; }
    const next = [...contactNumbers, trimmed];
    setContactNumbers(next);
    setNewContactNumber('');
    setContactsError('');
    saveContactNumbers(next, contactNumbers);
    return true;
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
          next[id] = { lat, lng, speed: resolvedSpeed, heading: fix.heading, accuracy: fix.accuracy, lastSeen: Date.now() };
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

    // A trip that arrived by socket carries no QR token, so pull the full record.
    if (!prevTrip) fetchMyTrips(undefined, { silent: true });
  }, [patchMeta, persistSeats, fetchMyTrips]);

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

      // Ready to leave the terminal: the dispatcher's exit scan is next, so show the QR straight away.
      if (newStatus === 'DEPARTING' && getDirection(updated?.id ? updated : trip) === 'RETURN') setQrOpen(true);
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
    setDelayOpen(false);
  }, []);

  const handleResetDelay = useCallback((tripId) => {
    patchMeta(tripId, { delay: 0 });
    setDelayOpen(false);
  }, [patchMeta]);

  const handleTripStarted = useCallback((newTrip) => {
    setTrips((prev) => (prev.some((t) => t.id === newTrip.id) ? prev : sortTrips([...prev, newTrip])));
    setSelectedId(newTrip.id);
    setStartOpen(false);
    setTab('trip');
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
        const entries = payload.map(([tid, d]) => [tid, toLive(d)]).filter(([, live]) => live);
        setFleetLiveData(Object.fromEntries(entries));
      } catch { /* ignore malformed payloads */ }
    };
    socket.on('initial_locations', onInitialLocations);

    const onVanMoved = (d) => {
      const live = d?.tripId ? toLive(d) : null;
      if (!live) return;
      setFleetLiveData((prev) => ({ ...prev, [d.tripId]: live }));
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

  // Clear stale errors and per-trip sheets when switching trips
  useEffect(() => { setStatusError(''); setQrOpen(false); setDelayOpen(false); setCapacityOpen(false); }, [selectedId]);

  // ── Derived for the map ──
  // One marker per van that has a live fix (a driver's simultaneous trips share it).
  const markerGroups = useMemo(() => {
    const now = Date.now();
    const groups = new Map();
    for (const trip of fleetTrips) {
      if (!MAP_VISIBLE_STATUSES.includes(trip.status)) continue;
      const live = fleetLiveData[trip.id];
      if (!live || now - (live.lastSeen ?? 0) > FLEET_GPS_STALE_THRESHOLD_MS) continue;
      const vanKey = trip.van?.id ?? trip.vanId ?? trip.id;
      if (!groups.has(vanKey)) groups.set(vanKey, { key: vanKey, position: [live.lat, live.lng], live, trips: [] });
      groups.get(vanKey).trips.push(trip);
    }
    return Array.from(groups.values()).map((g) => ({
      ...g,
      isOwn: g.trips.some((t) => ownTripIds.has(t.id)),
      primary: [...g.trips].sort((a, b) => STATUS_PRIORITY.indexOf(a.status) - STATUS_PRIORITY.indexOf(b.status))[0],
    }));
  }, [fleetTrips, fleetLiveData, ownTripIds]);

  const vanInfoTrip = fleetTrips.find((t) => t.id === vanInfoId) ?? null;

  // ── Render ──
  const shell = (children) => (
    <div className="ui-root" data-theme={theme}>
      <style>{THEME_CSS}</style>
      {children}
    </div>
  );

  if (loading) {
    return shell(
      <div className="flex min-h-screen items-center justify-center p-6">
        <Card className="flex items-center gap-3 px-5 py-4"><Spinner className="c-primary h-5 w-5" /><span className="font-bold">Loading your trips…</span></Card>
      </div>,
    );
  }

  if (error) {
    return shell(
      <div className="flex min-h-screen items-center justify-center p-6">
        <Card className="w-full max-w-md space-y-4 p-6 text-center">
          <h1 className="text-xl font-extrabold">Driver portal</h1>
          <Notice>{error}</Notice>
          <Btn variant="primary" size="lg" className="w-full" onClick={() => fetchMyTrips()}>Try again</Btn>
        </Card>
      </div>,
    );
  }

  const driverName = selectedTrip?.driver?.name ?? trips[0]?.driver?.name ?? getStoredUserName();
  const qrSheetTrip = qrOpen && selectedTrip && needsQr(selectedTrip) ? selectedTrip : null; // closes itself once the dispatcher scans
  const selectedSeats = selectedTrip ? getSeats(selectedTrip, seatMap) : null;
  // The summary card shows the seat count the driver is editing, not the last server value.
  const summaryTrip = selectedTrip && selectedSeats
    ? { ...selectedTrip, availableSeats: selectedSeats.available, totalSeats: selectedSeats.total }
    : selectedTrip;

  return shell(
    <>
      <header className="ui-header sticky top-0 z-30">
        <div className="ui-pad mx-auto flex h-14 max-w-lg items-center gap-3">
          <span className="b-primary flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"><Icon name="van" /></span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-extrabold leading-tight tracking-tight">Terminalink</p>
            <p className="c-muted truncate text-xs font-semibold leading-tight">{driverName ? `Driver · ${driverName}` : 'Driver'}</p>
          </div>
          <Btn variant="ghost" size="icon" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
          </Btn>
          <Btn onClick={handleLogout}><Icon name="logout" className="h-[18px] w-[18px]" /> Logout</Btn>
        </div>
      </header>

      <main className="ui-pad mx-auto max-w-lg space-y-4 pb-28 pt-4">
        {tab === 'trip' && (
          <>
            {activeTripIds.length > 0 && (
              <LiveLocationCard gpsState={gpsState} gpsError={gpsError} lastCoords={lastCoords} maxSpeedKmh={maxSpeedKmh}
                signalWeak={signalWeak} tripCount={activeTripIds.length} onStart={startLocationSharing} onStop={stopLocationSharing} />
            )}

            {trips.length > 0 && (
              <TripStrip trips={trips} selectedId={selectedTrip?.id} onSelect={setSelectedId} onNew={() => setStartOpen(true)} />
            )}

            {!selectedTrip ? (
              <Card>
                <EmptyState icon="van" title="Ready to roll?" actions={
                  <>
                    <Btn variant="primary" size="lg" onClick={() => setStartOpen(true)}><Icon name="plus" /> Start a trip</Btn>
                    <Btn variant="ghost" onClick={() => fetchMyTrips(undefined, { silent: true })}><Icon name="refresh" className="h-4 w-4" /> Check for an assigned trip</Btn>
                  </>
                }>
                  Pick your municipality and we'll open a trip to the {HOME_TERMINAL_SHORT.toLowerCase()} and bring you back.
                </EmptyState>
              </Card>
            ) : (
              <>
                <TripSummaryCard trip={summaryTrip} eta={selectedEta} delayMinutes={selectedMeta?.delay ?? 0} />
                <ProgressCard
                  trip={selectedTrip}
                  delayMinutes={selectedMeta?.delay ?? 0}
                  busy={busyTripId === selectedTrip.id}
                  error={statusError}
                  onAdvance={(next) => handleAdvanceStatus(selectedTrip, next)}
                  onShowQr={() => setQrOpen(true)}
                  onOpenDelay={() => setDelayOpen(true)}
                />
                {!GPS_LOCKED_STATUSES.includes(selectedTrip.status) && (
                  <SeatCard seats={selectedSeats} saving={seatSaving} onChange={(fn) => changeSeats(selectedTrip, fn)} onEditCapacity={() => setCapacityOpen(true)} />
                )}
              </>
            )}
          </>
        )}

        {tab === 'map' && <FleetMapTab markerGroups={markerGroups} liveCount={markerGroups.length} onOpen={setVanInfoId} />}

        {tab === 'account' && (
          <div className="space-y-4">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h1 className="text-2xl font-extrabold tracking-tight">Contact numbers</h1>
                <p className="c-muted text-sm font-medium"><span className="num">{contactNumbers.length}</span> of {MAX_CONTACT_NUMBERS} shown to passengers</p>
              </div>
              <Btn variant="primary" size="sm" disabled={contactNumbers.length >= MAX_CONTACT_NUMBERS}
                onClick={() => { setContactsError(''); setNewContactNumber(''); setAddNumberOpen(true); }}>
                <Icon name="plus" className="h-4 w-4" /> Add number
              </Btn>
            </div>
            {contactsError && !addNumberOpen && <Notice>{contactsError}</Notice>}
            <Card className="overflow-hidden">
              {contactNumbers.length === 0 ? (
                <EmptyState icon="phone" title="No numbers yet">Passengers see these on the public tracking page so they can call you.</EmptyState>
              ) : (
                <ul className="ui-divide">
                  {contactNumbers.map((n) => (
                    <li key={n} className="flex min-h-[68px] items-center gap-3 px-4 py-3">
                      <span className="chip-primary flex h-11 w-11 shrink-0 items-center justify-center rounded-full"><Icon name="phone" /></span>
                      <span className="num min-w-0 flex-1 truncate text-lg">{n}</span>
                      <Btn variant="danger" size="sm" onClick={() => handleRemoveContact(n)} disabled={contactsSaving} aria-label={`Remove ${n}`}><Icon name="trash" className="h-4 w-4" /></Btn>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )}
      </main>

      <BottomNav tab={tab} onChange={setTab} />

      <StartTripSheet open={startOpen} takenOrigins={takenOrigins} onStarted={handleTripStarted} onClose={() => setStartOpen(false)} />
      <QrSheet trip={qrSheetTrip} onClose={() => setQrOpen(false)} onRefresh={() => fetchMyTrips(undefined, { silent: true })} />
      <DelaySheet open={delayOpen && Boolean(selectedTrip)} currentDelay={selectedMeta?.delay ?? 0}
        onAdd={(m) => handleAddDelay(selectedTrip.id, m)} onReset={() => handleResetDelay(selectedTrip.id)} onClose={() => setDelayOpen(false)} />
      <CapacitySheet open={capacityOpen && Boolean(selectedTrip)} seats={selectedSeats ?? { total: 0, available: 0 }}
        onChange={(fn) => changeSeats(selectedTrip, fn)} onClose={() => setCapacityOpen(false)} />
      <AddNumberSheet open={addNumberOpen} value={newContactNumber} onChange={(v) => { setNewContactNumber(v); setContactsError(''); }}
        onSubmit={() => { if (handleAddContact()) setAddNumberOpen(false); }} error={contactsError} saving={contactsSaving} onClose={() => setAddNumberOpen(false)} />
      <VanInfoSheet trip={vanInfoTrip} live={vanInfoTrip ? fleetLiveData[vanInfoTrip.id] : null} onClose={() => setVanInfoId(null)} />
    </>,
  );
}
