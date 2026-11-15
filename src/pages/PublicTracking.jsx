import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, ZoomControl, Circle, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import apiClient from '../api/axios';
import { socket } from '../api/socket';
import { VIRAC_HUB, getCoordinatesForDestination } from '../components/townCoordinates';

// ─── What commuters see ──────────────────────────────────────────────────────
//
// A trip is a round trip of two legs, tracked by `direction`:
//   OUTBOUND  municipality → terminal
//   RETURN    terminal → municipality (after the dispatcher's check-in scan)
//
// Terminal flow:
//   1. A van reaches the terminal and the dispatcher scans it in. It is now
//      WAITING at the terminal (QUEUED, no queue yet): shown as "Just arrived".
//   2. The dispatcher puts it in a cooperative's queue. It boards right away if
//      that queue's boarding slot is free, otherwise it waits in line (QUEUED
//      with a queue, shown with its position in that queue).
//   3. It leaves the terminal and is on the road to its municipality.
//
// One driver can run several trips at once, so a van can appear in more than one
// row. The map shows one marker per van and lists its trips in the details sheet.
//
// Design system is shared with the dispatcher page (same tokens, Plus Jakarta
// Sans, bottom sheet, bottom navigation). Van colours show which town the van
// is from (Gigmoto blue, Viga red, …) so commuters can spot their van at a glance.

const MAP_CENTER = [13.5820477, 124.2192987];
const REFETCH_INTERVAL_MS    = 30_000;
const GPS_STALE_THRESHOLD_MS = 120_000;
const OSRM_BASE_URL          = 'https://router.project-osrm.org/route/v1/driving';

const HOME_TERMINAL_NAME  = 'Provincial Integrated Transport Terminal and Business Complex';
const HOME_TERMINAL_SHORT = 'Terminal';

// Shared with the admin and dispatcher pages so the theme choice carries across.
const THEME_KEY = 'terminalink_admin_theme';

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

const TABS = [
  { id: 'vans', label: 'Vans', icon: 'list' },
  { id: 'map',  label: 'Map',  icon: 'map' },
];

// ─── Van colour = the town the van is from ───────────────────────────────────

const TOWN_COLORS = {
  gigmoto:    '#2563eb', // blue
  viga:       '#dc2626', // red
  virac:      '#059669', // green
  baras:      '#d97706', // amber
  bato:       '#7c3aed', // violet
  caramoran:  '#0891b2', // cyan
  pandan:     '#db2777', // pink
  panganiban: '#ea580c', // orange
  'san andres': '#65a30d', // lime
  'san miguel': '#0d9488', // teal
  bagamanoc:  '#4f46e5', // indigo
};
const FALLBACK_COLORS = ['#be185d', '#0369a1', '#a16207', '#6d28d9', '#15803d', '#b91c1c'];
const UNKNOWN_TOWN_COLOR = '#475467';

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

const normaliseTown = (name) =>
  String(name ?? '').replace(/\s*terminal$/i, '').trim().toLowerCase();

function townColor(key) {
  if (!key) return UNKNOWN_TOWN_COLOR;
  if (TOWN_COLORS[key]) return TOWN_COLORS[key];
  const match = Object.keys(TOWN_COLORS).find((k) => key.startsWith(k) || k.startsWith(key));
  if (match) return TOWN_COLORS[match];
  return FALLBACK_COLORS[hashString(key) % FALLBACK_COLORS.length];
}

// ─── Status ──────────────────────────────────────────────────────────────────

const STATUS_META = {
  BOARDING:  { label: 'Boarding',    tone: 'ok',     hex: '#059669' },
  DEPARTING: { label: 'Departing',   tone: 'warn',   hex: '#d97706' },
  DEPARTED:  { label: 'On the road', tone: 'info',   hex: '#2563eb' },
  ARRIVING:  { label: 'On the road', tone: 'info',   hex: '#2563eb' },
  QUEUED:    { label: 'In queue',    tone: 'violet', hex: '#7c3aed' },
  DELAYED:   { label: 'Delayed',     tone: 'warn',   hex: '#ea580c' },
};
const PENDING_META = { label: 'Just arrived', tone: 'warn', hex: '#d97706' };
const statusMeta = (s) => STATUS_META[s] ?? STATUS_META.DEPARTED;

// ─── Theme (identical tokens to the dispatcher page) ─────────────────────────

const THEME_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
.ui-root{
  --bg:#F2F4F7;--surface:#FFFFFF;--surface-2:#F6F8FA;--text:#0B1220;--muted:#475467;--line:#E4E7EC;
  --primary:#00873D;--on-primary:#FFFFFF;--primary-bg:#E3F5EA;
  --ok:#067647;--ok-bg:#E3F5EA;--warn:#B54708;--warn-bg:#FFF1DB;--bad:#B42318;--bad-bg:#FEE9E7;
  --info:#175CD3;--info-bg:#E6EEFD;--violet:#5925DC;--violet-bg:#EEE9FE;--neutral-bg:#EAECF0;
  --shadow:0 1px 2px rgba(16,24,40,.06),0 4px 14px rgba(16,24,40,.08);
  --scrim:rgba(11,18,32,.5);
  font-family:'Plus Jakarta Sans',Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  background:var(--bg);color:var(--text);color-scheme:light;
  -webkit-tap-highlight-color:transparent;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;
}
.ui-root[data-theme="dark"]{
  --bg:#0B0F14;--surface:#151B23;--surface-2:#1B232D;--text:#F4F6F8;--muted:#A9B3C1;--line:#2A3441;
  --primary:#3DD879;--on-primary:#04210F;--primary-bg:#11301E;
  --ok:#5EE09A;--ok-bg:#11301E;--warn:#FDB35C;--warn-bg:#3A2610;--bad:#FF8F85;--bad-bg:#3D1613;
  --info:#8DB8FF;--info-bg:#14264A;--violet:#BDA8FF;--violet-bg:#2A1F55;--neutral-bg:#222B37;
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
.b-ghost{background:transparent;color:var(--text)}
@media (hover:hover){
  .b-default:hover:not(:disabled),.b-ghost:hover:not(:disabled){background:var(--surface-2)}
  .b-primary:hover:not(:disabled){filter:brightness(.92)}
  .ui-row:hover{background:var(--surface-2)}
}
.ui-row{transition:background .12s}
.ui-row:active{background:var(--surface-2)}

.town-pill{border:1.5px solid var(--line);background:var(--surface);color:var(--text);transition:background .12s,border-color .12s;touch-action:manipulation}
.town-pill[aria-pressed="true"]{background:var(--text);color:var(--surface);border-color:var(--text)}
.no-scrollbar{scrollbar-width:none;-ms-overflow-style:none}
.no-scrollbar::-webkit-scrollbar{display:none}

.ui-header{background:var(--surface);border-bottom:1px solid var(--line);padding-top:env(safe-area-inset-top)}
.ui-nav{background:var(--surface);border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom);box-shadow:0 -4px 14px rgba(16,24,40,.06)}
.ui-pad{padding-left:max(1rem,env(safe-area-inset-left));padding-right:max(1rem,env(safe-area-inset-right))}
.van-marker{transition:transform 1.2s linear}
.ui-map-overlay{background:var(--surface);box-shadow:var(--shadow)}

/* Bottom sheet: slides up on phones, centred dialog from 768px, docked panel from 1024px */
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
@media (min-width:1024px){
  .sheet-dock-wrap{background:transparent!important;pointer-events:none;align-items:flex-start!important;justify-content:flex-end!important;padding:1rem!important}
  .sheet-dock-wrap .sheet-panel{pointer-events:auto;max-width:24rem!important;margin-top:4.25rem;max-height:calc(100dvh - 7rem);box-shadow:0 12px 40px rgba(16,24,40,.22)}
}
@media (prefers-reduced-motion:reduce){
  .sheet-scrim,.sheet-panel{animation:none}
  .ui-btn,.van-marker{transition:none}
}
`;

// ─── Icons ───────────────────────────────────────────────────────────────────

const VAN_PATH = 'M3 16V7a1 1 0 011-1h9l5 5h2a1 1 0 011 1v4M3 16h2m12 0h-6M7 18a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM17 18a1.5 1.5 0 100-3 1.5 1.5 0 000 3z';

const ICONS = {
  van:      VAN_PATH,
  building: 'M4 21V5a1 1 0 011-1h8a1 1 0 011 1v16M14 9h5a1 1 0 011 1v11M3 21h18M8 8h2M8 12h2M8 16h2',
  map:      'M9 4l-6 2v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14',
  list:     'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  chevron:  'M9 6l6 6-6 6',
  sun:      'M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4M12 16a4 4 0 100-8 4 4 0 000 8z',
  moon:     'M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z',
  lock:     'M7 11V8a5 5 0 0110 0v3M6 11h12a1 1 0 011 1v7a1 1 0 01-1 1H6a1 1 0 01-1-1v-7a1 1 0 011-1z',
  x:        'M6 6l12 12M18 6L6 18',
  alert:    'M12 9v4M12 17h.01M10.3 4l-8 14a2 2 0 001.7 3h16a2 2 0 001.7-3l-8-14a2 2 0 00-3.4 0z',
  phone:    'M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z',
  locate:   'M12 2v3M12 19v3M2 12h3M19 12h3M12 17a5 5 0 100-10 5 5 0 000 10z',
  signal:   'M5 19v-3M10 19v-7M15 19V9M20 19V5',
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

// ─── Map icons: every marker is a van, coloured by its town ──────────────────

const markerCache = new Map();
function getVanMarkerIcon(color, statusHex, heading, selected) {
  const bucket = typeof heading === 'number' ? (Math.round(heading / 30) * 30) % 360 : null;
  const key = `${color}|${statusHex}|${bucket ?? 'n'}|${selected}`;
  if (markerCache.has(key)) return markerCache.get(key);

  const size = selected ? 44 : 36;
  const glyph = selected ? 24 : 20;
  const pointer = bucket === null ? '' : `
    <div style="position:absolute;inset:-8px;transform:rotate(${bucket}deg)">
      <div style="position:absolute;left:50%;top:-3px;margin-left:-6px;width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:10px solid ${color}"></div>
    </div>`;

  const icon = L.divIcon({
    className: 'van-marker',
    html: `<div style="position:relative;width:${size}px;height:${size}px">${pointer}
      <div style="width:100%;height:100%;border-radius:50%;background:${color};border:3px solid #fff;display:flex;align-items:center;justify-content:center;box-shadow:${selected ? `0 0 0 4px ${color}40,` : ''}0 3px 10px rgba(15,23,42,.4)">
        <svg viewBox="0 0 24 24" width="${glyph}" height="${glyph}" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${VAN_PATH}"/></svg>
      </div>
      <span style="position:absolute;right:-3px;bottom:-3px;width:13px;height:13px;border-radius:50%;background:${statusHex};border:2.5px solid #fff"></span>
    </div>`,
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

/** Seat count priority: live socket value → persisted trip row → van capacity. */
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

const getDirection = (trip) => (trip?.direction === 'RETURN' ? 'RETURN' : 'OUTBOUND');

// The queue a trip belongs to: the dispatcher's choice, else the van's own cooperative.
const queueIdOf   = (trip) => trip?.queueCooperativeId ?? trip?.van?.cooperativeId ?? null;
const queueNameOf = (trip) => trip?.queueCooperative?.name ?? trip?.van?.cooperative?.name ?? null;
// Scanned in at the terminal but not yet put in a cooperative's queue.
const isPendingQueue = (trip) =>
  getDirection(trip) === 'RETURN' && trip?.status === 'QUEUED' && !trip?.queueCooperativeId;

// The town a van is from (route origin). Colours and filters use this.
function townOf(trip) {
  const name = shortPlaceName(trip?.route?.origin);
  const key = normaliseTown(name) || 'unknown';
  return { key, name, color: townColor(key) };
}

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
    if (isPendingQueue(trip)) return 'Arrived at the terminal, waiting to be placed in a queue';
    if (trip.status === 'QUEUED') {
      const q = queueNameOf(trip);
      return q ? `Waiting in the ${q} queue` : 'Waiting in the terminal queue';
    }
    if (trip.status === 'BOARDING') return `Boarding at the terminal for ${o}`;
    if (trip.status === 'DEPARTING') return `Leaving the terminal for ${o}`;
    return `Heading to ${o}`;
  }
  if (trip.status === 'BOARDING')  return `Boarding at ${o}`;
  if (trip.status === 'DEPARTING') return `Leaving ${o} for the terminal`;
  return 'Heading to the terminal';
}

function useIsDesktop() {
  const query = '(min-width: 1024px)';
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (e) => setMatches(e.matches);
    setMatches(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return matches;
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

// ─── Primitives (same as the dispatcher page) ────────────────────────────────

const BTN_BASE = 'ui-btn inline-flex items-center justify-center gap-2 rounded-xl text-sm font-bold';
const BTN_SIZES = { md: 'h-11 px-4 sm:h-10', sm: 'h-10 px-3 text-xs sm:h-9', lg: 'h-12 px-5 text-base', icon: 'h-11 w-11 sm:h-10 sm:w-10' };
const BTN_VARIANTS = { default: 'b-default', primary: 'b-primary', ghost: 'b-ghost' };

function Btn({ variant = 'default', size = 'md', className = '', type = 'button', children, ...rest }) {
  return <button type={type} className={`${BTN_BASE} ${BTN_SIZES[size]} ${BTN_VARIANTS[variant]} ${className}`} {...rest}>{children}</button>;
}

function Card({ className = '', children, ...rest }) {
  return <section className={`ui-card rounded-2xl ${className}`} {...rest}>{children}</section>;
}

function Chip({ tone = 'muted', children }) {
  return <span className={`chip-${tone} inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-bold`}>{children}</span>;
}

function Spinner({ className = 'h-4 w-4' }) {
  return <span className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent ${className}`} role="status" aria-label="Loading" />;
}

function Notice({ tone = 'bad', children, action }) {
  return (
    <div role={tone === 'bad' ? 'alert' : undefined} className={`chip-${tone} flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold`}>
      <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 break-words">{children}</div>
      {action}
    </div>
  );
}

function EmptyState({ icon = 'van', title, children }) {
  return (
    <div className="flex flex-col items-center px-6 py-8 text-center">
      <span className="chip-muted mb-3 flex h-14 w-14 items-center justify-center rounded-full"><Icon name={icon} className="h-6 w-6" /></span>
      <p className="font-bold">{title}</p>
      {children && <p className="c-muted mt-1 max-w-xs text-sm font-medium">{children}</p>}
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

function SectionHeader({ title, count, hint }) {
  return (
    <div className="mb-2 mt-1">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-extrabold tracking-tight">{title}</h2>
        {count !== undefined && <Chip>{count}</Chip>}
      </div>
      {hint && <p className="c-muted text-xs font-medium">{hint}</p>}
    </div>
  );
}

function StatusChip({ status, pending = false }) {
  const m = pending ? PENDING_META : statusMeta(status);
  return <Chip tone={m.tone}>{m.label}</Chip>;
}

// "10/14": bold, tabular, readable at a glance. Turns red when the van is full.
function Seats({ available, total, big = false }) {
  if (available == null || total == null) return null;
  return (
    <span className={`num leading-none ${big ? 'text-4xl' : 'text-lg'} ${available === 0 ? 'c-bad' : ''}`}>
      {available}<span className="c-muted font-bold">/{total}</span>
    </span>
  );
}

function MetricTile({ label, value, tone }) {
  return (
    <div className="ui-card min-w-0 rounded-2xl px-2 py-3 text-center">
      <p className={`num text-2xl leading-none ${tone ? `c-${tone}` : ''}`}>{value}</p>
      <p className="c-muted mt-1.5 truncate text-[11px] font-bold">{label}</p>
    </div>
  );
}

// Small coloured dot + town name, so a van's town is readable without the map.
function TownTag({ town }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: town.color }} />
      <span>{town.name}</span>
    </span>
  );
}

// Round van avatar in the van's town colour (same van glyph as the map marker).
function VanAvatar({ color }) {
  return (
    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white"
      style={{ background: color, boxShadow: '0 0 0 3px var(--surface), 0 0 0 4.5px ' + color + '55' }}>
      <Icon name="van" />
    </span>
  );
}

function DriverContacts({ driver }) {
  const numbers = getDriverContacts(driver);
  if (!numbers.length) return <span className="c-muted">None on file</span>;
  return (
    <span className="flex flex-wrap justify-end gap-1.5">
      {numbers.map((n) => (
        <a key={n} href={`tel:${n.replace(/\s/g, '')}`} onClick={(e) => e.stopPropagation()}
          className="chip-info inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold tabular-nums">
          <Icon name="phone" className="h-3 w-3" /> {n}
        </a>
      ))}
    </span>
  );
}

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

// One line describing the van's live GPS state.
function GpsLine({ gps, data }) {
  if (gps.isLive) {
    const weak = typeof gps.accuracy === 'number' && gps.accuracy > LOW_ACCURACY_THRESHOLD_M;
    return (
      <div className="chip-ok flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs font-bold">
        <span className="flex items-center gap-1.5">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-70" style={{ background: 'var(--ok)' }} />
            <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: 'var(--ok)' }} />
          </span>
          Live · {speedLabel(data?.smoothedSpeed)}
          {weak && <span className="c-warn font-semibold">· weak GPS</span>}
        </span>
        {data?.lastSeen && <span className="font-semibold opacity-80">{relativeTime(data.lastSeen)}</span>}
      </div>
    );
  }
  if (gps.isStale) {
    return (
      <div className="chip-warn flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold">
        <Icon name="signal" className="h-3.5 w-3.5" /> GPS signal lost · last seen {relativeTime(data?.lastSeen)}
      </div>
    );
  }
  if (gps.hasFix && !gps.isTrusted) {
    return (
      <div className="chip-warn flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold">
        <Icon name="signal" className="h-3.5 w-3.5" /> GPS too weak to plot
        {typeof gps.accuracy === 'number' && ` (±${Math.round(gps.accuracy)} m)`}
      </div>
    );
  }
  return (
    <div className="chip-muted flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-bold">
      <Spinner className="h-3 w-3" /> Waiting for the driver's GPS…
    </div>
  );
}

// ─── Bottom sheet (same behaviour as the dispatcher page) ────────────────────

function Sheet({ open, onClose, title, subtitle, footer, dock = false, children }) {
  const [dy, setDy] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startY = useRef(0);

  useEffect(() => { if (open) setDy(0); }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const onPointerDown = (e) => {
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
    <div role="dialog" aria-modal={!dock} aria-label={title}
      className={`sheet-scrim fixed inset-0 z-50 flex items-end justify-center md:items-center md:p-4 ${dock ? 'sheet-dock-wrap' : ''}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet-panel flex w-full min-w-0 flex-col rounded-t-2xl md:max-w-md md:rounded-2xl"
        style={{ transform: dy ? `translateY(${dy}px)` : undefined, transition: dragging ? 'none' : 'transform .2s ease-out' }}>
        <div className="sheet-handle flex justify-center py-3 md:hidden" onPointerDown={onPointerDown} onPointerMove={onPointerMove}
          onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          <span className="sheet-bar h-1.5 w-10 rounded-full" />
        </div>
        <div className="flex items-start justify-between gap-3 px-4 pb-3 md:p-5 md:pb-3">
          <div className="min-w-0">
            <h2 className="truncate text-xl font-extrabold tracking-tight">{title}</h2>
            {subtitle && <div className="c-muted truncate text-sm font-medium">{subtitle}</div>}
          </div>
          <Btn variant="ghost" size="icon" onClick={onClose} aria-label="Close" className="-mr-2 shrink-0"><Icon name="x" /></Btn>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 md:px-5">{children}</div>
        {footer && <div className="ui-line sheet-safe border-t px-4 pt-3 md:px-5">{footer}</div>}
      </div>
    </div>
  );
}

// ─── List rows ───────────────────────────────────────────────────────────────

function VanRow({ trip, onOpen, trailing, footer, subtitle }) {
  const town = townOf(trip);
  return (
    <li>
      <button type="button" onClick={() => onOpen(trip.id)} aria-label={`Open ${trip.van?.plateNumber ?? 'van'}`}
        className="ui-row flex min-h-[68px] w-full items-center gap-3 px-4 py-3 text-left">
        <VanAvatar color={town.color} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-bold">{trip.van?.plateNumber ?? 'Unknown plate'}</span>
          <span className="c-muted block truncate text-sm font-medium">
            <TownTag town={town} />
            {queueNameOf(trip) && getDirection(trip) === 'RETURN' ? ` · ${queueNameOf(trip)}` : ''}
          </span>
          <span className="c-muted block truncate text-xs font-medium">{subtitle ?? tripDirectionText(trip)}</span>
        </span>
        {trailing}
        <Icon name="chevron" className="c-muted h-4 w-4 shrink-0" />
      </button>
      {footer && <div className="px-4 pb-3">{footer}</div>}
    </li>
  );
}

// ─── Map helpers ─────────────────────────────────────────────────────────────
// On phones the map is hidden while the list tab is active. Leaflet measures its
// container on mount, so it must re-measure when the tab is revealed.

function MapInvalidator({ active }) {
  const map = useMap();
  useEffect(() => {
    if (!active) return undefined;
    const t = setTimeout(() => map.invalidateSize(), 60);
    return () => clearTimeout(t);
  }, [active, map]);
  return null;
}

function MapBoundsFitter({ positions, active }) {
  const map = useMap();
  const fittedRef = useRef(false);
  useEffect(() => {
    if (!active || fittedRef.current || !positions.length) return undefined;
    const t = setTimeout(() => {
      try {
        map.invalidateSize();
        map.fitBounds(L.latLngBounds([VIRAC_HUB, ...positions]), { padding: [50, 50], maxZoom: 13 });
        fittedRef.current = true;
      } catch { /* ignore malformed coords */ }
    }, 100);
    return () => clearTimeout(t);
  }, [map, positions, active]);
  return null;
}

// On selection: pan to the van, then fit its road route once it has loaded.
function SelectionFocus({ tripId, position, routeCoords, active }) {
  const map = useMap();
  const stateRef = useRef({ tripId: null, fitted: false });
  useEffect(() => {
    if (!tripId) { stateRef.current = { tripId: null, fitted: false }; return undefined; }
    if (!active) return undefined;
    const t = setTimeout(() => {
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
    }, 120);
    return () => clearTimeout(t);
  }, [map, tripId, position, routeCoords, active]);
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

// ─── Navigation ──────────────────────────────────────────────────────────────

function BottomNav({ tab, onChange, counts }) {
  return (
    <nav className="ui-nav fixed inset-x-0 bottom-0 z-40 lg:hidden" aria-label="Public views">
      <ul className="mx-auto grid max-w-lg grid-cols-2">
        {TABS.map((t) => {
          const on = tab === t.id;
          const count = counts[t.id];
          return (
            <li key={t.id}>
              <button type="button" onClick={() => onChange(t.id)} aria-current={on ? 'page' : undefined}
                className={`relative flex min-h-[58px] w-full flex-col items-center justify-center gap-0.5 text-[11px] font-bold ${on ? 'c-primary' : 'c-muted'}`}>
                {on && <span className="absolute top-0 h-[3px] w-10 rounded-b-full" style={{ background: 'var(--primary)' }} />}
                <span className="relative">
                  <Icon name={t.icon} className="h-6 w-6" />
                  {count > 0 && (
                    <span className="num absolute -right-3 -top-1.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px]"
                      style={{ background: on ? 'var(--primary)' : 'var(--muted)', color: on ? 'var(--on-primary)' : 'var(--surface)' }}>{count}</span>
                  )}
                </span>
                {t.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function PublicTracking() {
  const navigate = useNavigate();
  const [theme, toggleTheme] = useTheme();
  const isDesktop = useIsDesktop();

  const [activeTrips, setActiveTrips]     = useState([]);
  const [liveData, setLiveData]           = useState({});
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState('');
  const [reloadToken, setReloadToken]     = useState(0);
  const [socketStatus, setSocketStatus]   = useState('connecting');
  const [, setTick]                       = useState(0);
  const [liveEtas, setLiveEtas]           = useState({});
  const [selectedRoute, setSelectedRoute] = useState(EMPTY_ROUTE);

  const [activeTab, setActiveTab]           = useState('vans');
  const [townFilter, setTownFilter]         = useState(null);
  const [sheetTripId, setSheetTripId]       = useState(null);
  const [selectedTripId, setSelectedTripId] = useState(null);

  const selectedTripIdRef = useRef(selectedTripId);
  const activeTripsRef    = useRef(activeTrips);
  const routeStartRef     = useRef({ tripId: null, direction: null, start: null });
  const routeAbortRef     = useRef(null);
  const mapRef            = useRef(null);
  useEffect(() => { selectedTripIdRef.current = selectedTripId; }, [selectedTripId]);
  useEffect(() => { activeTripsRef.current = activeTrips; }, [activeTrips]);

  const mapVisible = activeTab === 'map' || isDesktop;

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
      setSheetTripId((cur) => (cur === tripId ? null : cur));
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

  // ── Town filter ──
  const townChips = useMemo(() => {
    const map = new Map();
    for (const trip of activeTrips) {
      const t = townOf(trip);
      if (!map.has(t.key)) map.set(t.key, { ...t, count: 0 });
      map.get(t.key).count += 1;
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [activeTrips]);

  // If the filtered town has no vans any more, fall back to showing everything.
  const effectiveFilter = townFilter && townChips.some((t) => t.key === townFilter) ? townFilter : null;

  const visibleTrips = useMemo(
    () => (effectiveFilter ? activeTrips.filter((t) => townOf(t).key === effectiveFilter) : activeTrips),
    [activeTrips, effectiveFilter],
  );

  // ── Derived lists ──
  const boardingTrips = useMemo(() => visibleTrips.filter((t) => BOARDING_STATUSES.includes(t.status)), [visibleTrips]);
  const drivingTrips  = useMemo(() => visibleTrips.filter((t) => DRIVING_STATUSES.includes(t.status)), [visibleTrips]);
  const mapTrips      = useMemo(() => visibleTrips.filter((t) => MAP_VISIBLE_STATUSES.includes(t.status)), [visibleTrips]);

  const queuedTrips = useMemo(
    () => visibleTrips
      .filter((t) => QUEUED_STATUSES.includes(t.status))
      .sort((a, b) => new Date(a.actualArrival ?? a.scheduledTime ?? 0) - new Date(b.actualArrival ?? b.scheduledTime ?? 0)),
    [visibleTrips],
  );

  // Vans scanned in but not yet put in a queue, and the per-cooperative queues.
  const pendingTrips = useMemo(() => queuedTrips.filter(isPendingQueue), [queuedTrips]);

  const queueLanes = useMemo(() => {
    const lanes = new Map();
    for (const trip of queuedTrips) {
      if (isPendingQueue(trip)) continue;
      const key = queueIdOf(trip) ?? 'unassigned';
      if (!lanes.has(key)) lanes.set(key, { key, name: queueNameOf(trip) ?? 'Terminal queue', trips: [], boardingNow: [] });
      lanes.get(key).trips.push(trip);
    }
    // Who is boarding right now at each queue's terminal slot.
    for (const trip of boardingTrips) {
      if (getDirection(trip) !== 'RETURN') continue;
      const lane = lanes.get(queueIdOf(trip) ?? 'unassigned');
      if (lane) lane.boardingNow.push(trip);
    }
    return Array.from(lanes.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [queuedTrips, boardingTrips]);

  // tripId → { position, size } within its own queue.
  const queuePositions = useMemo(() => {
    const m = new Map();
    for (const lane of queueLanes) lane.trips.forEach((t, i) => m.set(t.id, { position: i + 1, size: lane.trips.length }));
    return m;
  }, [queueLanes]);

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
  // Vans waiting at the same known spot (e.g. the terminal) are fanned out so none hide another.
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

    const list = Array.from(groups.values()).map((g) => {
      const primary =
        g.trips.find((t) => t.id === selectedTripId) ??
        [...g.trips].sort((a, b) => STATUS_PRIORITY.indexOf(a.status) - STATUS_PRIORITY.indexOf(b.status))[0];
      return { ...g, primary };
    });

    const stacks = new Map();
    for (const g of list) {
      if (g.isLive) continue;
      const k = g.position.join(',');
      if (!stacks.has(k)) stacks.set(k, []);
      stacks.get(k).push(g);
    }
    for (const stack of stacks.values()) {
      if (stack.length < 2) continue;
      stack.sort((a, b) => String(a.primary.id).localeCompare(String(b.primary.id)));
      stack.forEach((g, i) => {
        const angle = (i / stack.length) * 2 * Math.PI;
        const radius = 0.0007 * (1 + Math.floor(i / 8));
        g.position = [g.position[0] + radius * Math.sin(angle), g.position[1] + radius * Math.cos(angle)];
      });
    }
    return list;
  }, [mapTrips, resolveTripPosition, selectedTripId]);

  const activeVanPositions = useMemo(() => markerGroups.map((g) => g.position), [markerGroups]);
  const liveCount = useMemo(
    () => activeTrips.filter((t) => resolveTripPosition(t).isLive).length,
    [activeTrips, resolveTripPosition],
  );

  const sheetTrip        = useMemo(() => activeTrips.find((t) => t.id === sheetTripId) ?? null, [activeTrips, sheetTripId]);
  const selectedTrip     = useMemo(() => activeTrips.find((t) => t.id === selectedTripId) ?? null, [activeTrips, selectedTripId]);
  const selectedLive     = selectedTripId ? liveData[selectedTripId] : null;
  const selectedGps      = useMemo(() => (selectedTrip ? resolveTripPosition(selectedTrip) : null), [selectedTrip, resolveTripPosition]);
  const selectedPosition = selectedGps?.position ?? null;
  const selectedTown     = selectedTrip ? townOf(selectedTrip) : null;

  const siblings = sheetTrip
    ? activeTrips.filter((t) => t.id !== sheetTrip.id && (t.van?.id ?? t.vanId) === (sheetTrip.van?.id ?? sheetTrip.vanId))
    : [];

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

  // ── Callbacks ──
  const openTrip   = useCallback((tripId) => { setSheetTripId(tripId); setSelectedTripId(tripId); }, []);
  const closeSheet = useCallback(() => { setSheetTripId(null); setSelectedTripId(null); }, []);

  // "Show on map": on phones this switches to the Map tab and keeps the van highlighted with its route.
  const focusOnMap = useCallback((trip) => {
    const { position } = resolveTripPosition(trip);
    setSelectedTripId(trip.id);
    if (!isDesktop) { setSheetTripId(null); setActiveTab('map'); }
    if (position) setTimeout(() => mapRef.current?.setView(position, 14, { animate: true }), isDesktop ? 0 : 200);
  }, [resolveTripPosition, isDesktop]);

  // ── Render states ──
  const shell = (children) => (
    <div className="ui-root" data-theme={theme} style={{ height: '100dvh' }}>
      <style>{THEME_CSS}</style>
      {children}
    </div>
  );

  if (loading) {
    return shell(
      <div className="flex h-full items-center justify-center p-6">
        <Card className="flex items-center gap-3 px-5 py-4"><Spinner className="c-primary h-5 w-5" /><span className="font-bold">Loading live vans…</span></Card>
      </div>,
    );
  }

  if (error && activeTrips.length === 0) {
    return shell(
      <div className="flex h-full items-center justify-center p-6">
        <Card className="w-full max-w-md space-y-4 p-6 text-center">
          <h1 className="text-xl font-extrabold">Can't reach live tracking</h1>
          <Notice>{error}</Notice>
          <Btn variant="primary" size="lg" className="w-full" onClick={() => setReloadToken((n) => n + 1)}>Try again</Btn>
        </Card>
      </div>,
    );
  }

  const socketChip =
    socketStatus === 'connected'
      ? { text: 'Live', tone: 'ok', ping: true }
      : socketStatus === 'disconnected'
      ? { text: 'Offline', tone: 'bad', ping: false }
      : { text: 'Connecting', tone: 'warn', ping: false };

  // ── Sheet: selected van details ──
  const sheetPending  = Boolean(sheetTrip) && isPendingQueue(sheetTrip);
  const sheetTown     = sheetTrip ? townOf(sheetTrip) : null;
  const sheetLive     = sheetTrip ? liveData[sheetTrip.id] : null;
  const sheetGps      = sheetTrip ? resolveTripPosition(sheetTrip) : null;
  const sheetSeats    = sheetTrip ? resolveSeatInfo(sheetTrip, sheetLive) : null;
  const sheetEta      = sheetTrip && ETA_STATUSES.includes(sheetTrip.status) ? liveEtas[sheetTrip.id] ?? null : null;
  const sheetQueuePos = sheetTrip ? queuePositions.get(sheetTrip.id) : null;
  const sheetRoute    = sheetTrip && selectedRoute.tripId === sheetTrip.id ? selectedRoute : null;
  const sheetRouteCoords = sheetRoute?.coords ?? [];

  const vansSection = (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-2">
        <MetricTile label="Boarding" value={boardingTrips.length} tone="ok" />
        <MetricTile label="In queue" value={queuedTrips.length} tone="violet" />
        <MetricTile label="On the road" value={drivingTrips.length} tone="info" />
      </div>

      {/* Boarding */}
      <section>
        <SectionHeader title="Boarding now" count={boardingTrips.length} hint="Vans you can ride right now. The number is how many seats are free." />
        <Card className="overflow-hidden">
          {boardingTrips.length === 0 ? (
            <EmptyState icon="van" title="No vans boarding">When a van opens for passengers it shows up here with its free seats.</EmptyState>
          ) : (
            <ul className="ui-divide">
              {boardingTrips.map((trip) => {
                const data = liveData[trip.id];
                const seat = resolveSeatInfo(trip, data);
                const full = seat.available === 0;
                return (
                  <VanRow key={trip.id} trip={trip} onOpen={openTrip}
                    trailing={
                      <span className="flex flex-col items-end gap-1.5">
                        <Seats available={seat.available} total={seat.total} big />
                        <Chip tone={full ? 'bad' : 'ok'}>{full ? 'Full' : 'seats free'}</Chip>
                      </span>
                    } />
                );
              })}
            </ul>
          )}
        </Card>
      </section>

      {/* Queue */}
      <section>
        <SectionHeader title="Terminal queue" count={queuedTrips.length}
          hint="Each cooperative has its own line. Vans board one at a time in the order shown." />
        {queuedTrips.length === 0 ? (
          <Card><EmptyState icon="building" title="No vans waiting">Nobody is queued at the terminal right now.</EmptyState></Card>
        ) : (
          <div className="space-y-3">
            {pendingTrips.length > 0 && (
              <Card className="overflow-hidden">
                <div className="ui-line flex items-center justify-between gap-2 border-b px-4 py-3">
                  <span className="flex min-w-0 items-center gap-2 font-extrabold">
                    <Icon name="building" className="c-muted h-4 w-4 shrink-0" />
                    <span className="truncate">Just arrived</span>
                  </span>
                  <span className="c-muted shrink-0 text-xs font-bold">being placed in a queue</span>
                </div>
                <ul className="ui-divide">
                  {pendingTrips.map((trip) => {
                    const seat = resolveSeatInfo(trip, liveData[trip.id]);
                    return (
                      <VanRow key={trip.id} trip={trip} onOpen={openTrip}
                        trailing={
                          <span className="flex flex-col items-end gap-1.5">
                            <Seats available={seat.available} total={seat.total} />
                            <Chip tone="warn">At terminal</Chip>
                          </span>
                        } />
                    );
                  })}
                </ul>
              </Card>
            )}

            {queueLanes.map((lane) => (
              <Card key={lane.key} className="overflow-hidden">
                <div className="ui-line border-b px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2 font-extrabold">
                      <Icon name="building" className="c-muted h-4 w-4 shrink-0" />
                      <span className="truncate">{lane.name}</span>
                    </span>
                    <span className="c-muted shrink-0 text-xs font-bold">
                      <span className="num text-sm" style={{ color: 'var(--text)' }}>{lane.trips.length}</span> waiting
                    </span>
                  </div>
                  {lane.boardingNow.length > 0 && (
                    <p className="c-ok mt-1 truncate text-xs font-bold">
                      Boarding now: {lane.boardingNow.map((t) => `${t.van?.plateNumber ?? 'van'} → ${legDestination(t)}`).join(', ')}
                    </p>
                  )}
                </div>
                <ul className="ui-divide">
                  {lane.trips.map((trip, index) => (
                    <VanRow key={trip.id} trip={trip} onOpen={openTrip}
                      subtitle={index === 0 ? 'Next to board' : `${index} ${index === 1 ? 'van' : 'vans'} ahead`}
                      trailing={
                        <span className="chip-violet flex shrink-0 flex-col items-center rounded-xl px-3 py-1.5">
                          <span className="num text-xl leading-none">#{index + 1}</span>
                          <span className="mt-0.5 text-[11px] font-bold">in line</span>
                        </span>
                      } />
                  ))}
                </ul>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* On the road */}
      <section>
        <SectionHeader title="On the road" count={drivingTrips.length} hint="Vans that have left. Tap one to see where it is and when it arrives." />
        <Card className="overflow-hidden">
          {drivingTrips.length === 0 ? (
            <EmptyState icon="van" title="No vans in transit">Vans on the move will appear here.</EmptyState>
          ) : (
            <ul className="ui-divide">
              {drivingTrips.map((trip) => {
                const data = liveData[trip.id];
                const seat = resolveSeatInfo(trip, data);
                const gps = resolveTripPosition(trip);
                const eta = liveEtas[trip.id];
                return (
                  <VanRow key={trip.id} trip={trip} onOpen={openTrip}
                    subtitle={`${tripRouteLabel(trip)}${eta ? ` · arrives ${formatTime(eta.eta)}` : ''}`}
                    trailing={
                      <span className="flex flex-col items-end gap-1.5">
                        <Seats available={seat.available} total={seat.total} />
                        <Chip tone={statusMeta(trip.status).tone}>{gps.isLive ? speedLabel(data?.smoothedSpeed) : statusMeta(trip.status).label}</Chip>
                      </span>
                    } />
                );
              })}
            </ul>
          )}
        </Card>
      </section>

      <p className="c-muted px-1 pb-2 text-center text-xs font-medium">
        Van colour shows the town it is from. Locations come live from each driver's phone.
      </p>
    </div>
  );

  return shell(
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <header className="ui-header z-30 shrink-0">
        <div className="ui-pad flex h-14 items-center gap-3 lg:h-16">
          <span className="b-primary flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"><Icon name="van" /></span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-extrabold leading-tight tracking-tight">Terminalink</p>
            <p className="c-muted truncate text-xs font-semibold leading-tight">Live van tracking</p>
          </div>
          <span className={`chip-${socketChip.tone} inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold`}>
            <span className="relative flex h-2 w-2">
              {socketChip.ping && <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-70" style={{ background: 'currentColor' }} />}
              <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: 'currentColor' }} />
            </span>
            {socketChip.text}
          </span>
          <Btn variant="ghost" size="icon" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
          </Btn>
          <Btn onClick={() => navigate('/login')} aria-label="Staff access">
            <Icon name="lock" className="h-[18px] w-[18px]" /> <span className="hidden sm:inline">Staff</span>
          </Btn>
        </div>

        {/* Town filter: pick where the van is from */}
        {townChips.length > 1 && (
          <div className="ui-pad no-scrollbar flex gap-2 overflow-x-auto pb-3" role="group" aria-label="Filter vans by town">
            <button type="button" className="town-pill inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-bold"
              aria-pressed={effectiveFilter === null} onClick={() => setTownFilter(null)}>
              All towns <span className="num text-xs opacity-70">{activeTrips.length}</span>
            </button>
            {townChips.map((t) => (
              <button key={t.key} type="button" className="town-pill inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-bold"
                aria-pressed={effectiveFilter === t.key} onClick={() => setTownFilter(effectiveFilter === t.key ? null : t.key)}>
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: t.color }} />
                {t.name} <span className="num text-xs opacity-70">{t.count}</span>
              </button>
            ))}
          </div>
        )}
      </header>

      {socketStatus === 'disconnected' && (
        <div className="chip-warn z-10 shrink-0 px-4 py-2 text-center text-sm font-bold">
          Live updates paused. Reconnecting…{' '}
          <button onClick={() => setReloadToken((n) => n + 1)} className="ml-1 font-extrabold underline underline-offset-2">Reload</button>
        </div>
      )}
      {error && activeTrips.length > 0 && (
        <div className="chip-bad z-10 shrink-0 px-4 py-2 text-center text-sm font-bold">{error}</div>
      )}

      {/* Body */}
      <div className="relative z-0 flex min-h-0 flex-1 overflow-hidden">
        {/* Van lists (phones: the "Vans" tab; desktop: always beside the map) */}
        <aside className={`${activeTab === 'map' ? 'hidden lg:flex' : 'flex'} ui-line min-w-0 flex-1 flex-col overflow-hidden lg:w-[26rem] lg:flex-none lg:border-r xl:w-[28rem]`}>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-28 lg:pb-6">
            <div className="ui-pad pt-4 lg:pr-4">{vansSection}</div>
          </div>
        </aside>

        {/* Map (phones: its own tab) */}
        <main className={`${activeTab === 'map' ? 'block' : 'hidden'} relative z-0 flex-1 lg:block`} style={{ background: 'var(--surface-2)' }}>
          <MapContainer center={MAP_CENTER} zoom={11} className="h-full w-full" ref={mapRef} zoomControl={false}>
            <MapInvalidator active={mapVisible} />
            <ZoomControl position="topright" />
            <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <MapBoundsFitter positions={mapFocusPositions} active={mapVisible} />
            <SelectionFocus tripId={selectedTripId} position={selectedPosition} routeCoords={routeCoords} active={mapVisible} />

            <Marker position={VIRAC_HUB} icon={hubIcon} />

            {selectedTrip && selectedGps?.isLive && typeof selectedGps.accuracy === 'number' && selectedGps.accuracy > 0 && (
              <Circle center={selectedPosition} radius={selectedGps.accuracy}
                pathOptions={{ color: accuracyRing(selectedGps.accuracy), fillColor: accuracyRing(selectedGps.accuracy), fillOpacity: 0.08, weight: 1 }} />
            )}

            {routeCoords.length > 1 && (
              <Polyline positions={routeCoords}
                pathOptions={{ color: selectedTown?.color ?? '#0f766e', weight: 5, opacity: 0.85, lineCap: 'round', lineJoin: 'round' }} />
            )}

            {markerGroups.map((group) => {
              const trip = group.primary;
              const data = liveData[trip.id];
              const moving = (msToKmh(data?.smoothedSpeed) ?? 0) >= MOVING_HEADING_KMH;
              const heading = group.isLive && moving && typeof data?.heading === 'number' ? data.heading : null;
              const isSelected = group.trips.some((t) => t.id === selectedTripId);
              const town = townOf(trip);
              const statusHex = (isPendingQueue(trip) ? PENDING_META : statusMeta(trip.status)).hex;

              return (
                <Marker key={group.key} position={group.position} icon={getVanMarkerIcon(town.color, statusHex, heading, isSelected)}
                  zIndexOffset={isSelected ? 1000 : 0} eventHandlers={{ click: () => openTrip(trip.id) }} />
              );
            })}
          </MapContainer>

          {/* Live count + current selection */}
          <div className="pointer-events-none absolute left-3 top-3 z-[1000] flex max-w-[calc(100%-5rem)] flex-col items-start gap-2">
            <span className="ui-map-overlay inline-flex items-center gap-2 rounded-full px-3 py-2 text-xs font-bold">
              <span className="relative flex h-2 w-2">
                {liveCount > 0 && <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-70" style={{ background: 'var(--primary)' }} />}
                <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: liveCount > 0 ? 'var(--primary)' : 'var(--muted)' }} />
              </span>
              <span className="num">{liveCount}</span> {liveCount === 1 ? 'van' : 'vans'} live
            </span>

            {selectedTrip && !sheetTripId && (
              <span className="ui-map-overlay pointer-events-auto inline-flex max-w-full items-center gap-2 rounded-full py-1.5 pl-3 pr-1.5 text-xs font-bold">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: selectedTown?.color }} />
                <span className="min-w-0 truncate">{selectedTrip.van?.plateNumber ?? 'Van'} · {tripRouteLabel(selectedTrip)}</span>
                <button type="button" onClick={() => setSheetTripId(selectedTrip.id)}
                  className="b-primary ui-btn h-7 shrink-0 rounded-full px-3 text-xs font-bold">Details</button>
                <button type="button" onClick={closeSheet} aria-label="Stop following"
                  className="chip-muted flex h-7 w-7 shrink-0 items-center justify-center rounded-full"><Icon name="x" className="h-3.5 w-3.5" /></button>
              </span>
            )}
          </div>

          {/* Legend: which colour is which town */}
          {townChips.length > 0 && (
            <div className="ui-map-overlay pointer-events-none absolute left-3 z-[1000] max-w-[calc(100%-1.5rem)] rounded-2xl px-3 py-2 lg:bottom-4"
              style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 4.5rem)' }}>
              <p className="c-muted mb-1 text-[10px] font-extrabold uppercase tracking-wider">Vans from</p>
              <ul className="flex flex-wrap gap-x-3 gap-y-1">
                {townChips.map((t) => (
                  <li key={t.key} className="flex items-center gap-1.5 text-xs font-bold">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: t.color }} />{t.name}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {activeTrips.length > 0 && liveCount === 0 && (
            <div className="ui-map-overlay pointer-events-none absolute left-1/2 top-16 z-[1000] flex w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 items-center justify-center gap-2 rounded-2xl px-4 py-3 text-center text-xs font-bold">
              <Spinner className="h-4 w-4" /> Waiting for drivers to share their GPS…
            </div>
          )}
        </main>
      </div>

      <BottomNav tab={activeTab} onChange={setActiveTab} counts={{ vans: visibleTrips.length, map: 0 }} />

      {/* Van details */}
      <Sheet open={Boolean(sheetTrip)} onClose={closeSheet} dock
        title={sheetTrip?.van?.plateNumber ?? ''}
        subtitle={sheetTrip ? (
          <span className="inline-flex items-center gap-2">
            <TownTag town={sheetTown} />
            <span>·</span>
            <span className="truncate">{sheetTrip.driver?.name ?? 'No driver assigned'}</span>
          </span>
        ) : ''}
        footer={sheetTrip && (
          <Btn variant="primary" size="lg" className="w-full" onClick={() => focusOnMap(sheetTrip)} disabled={!sheetGps?.position}>
            <Icon name="locate" /> Show on map
          </Btn>
        )}>
        {sheetTrip && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip status={sheetTrip.status} pending={sheetPending} />
              <Chip tone={getDirection(sheetTrip) === 'RETURN' ? 'violet' : 'info'}>
                {getDirection(sheetTrip) === 'RETURN' ? 'Leaving the terminal' : 'Coming to the terminal'}
              </Chip>
              {queueNameOf(sheetTrip) && getDirection(sheetTrip) === 'RETURN' && !sheetPending && <Chip>{queueNameOf(sheetTrip)}</Chip>}
            </div>

            <p className="c-muted text-sm font-semibold">{tripDirectionText(sheetTrip)}</p>

            {sheetPending && <Notice tone="warn">A dispatcher will place this van in a queue shortly. Check back for its position in line.</Notice>}

            <div className="grid grid-cols-2 gap-3">
              <div className="ui-soft rounded-2xl p-4">
                <Seats available={sheetSeats.available} total={sheetSeats.total} big />
                <p className="c-muted mt-1 flex items-center gap-1.5 text-sm font-semibold">
                  <Icon name="users" className="h-3.5 w-3.5" /> seats free
                </p>
              </div>
              {sheetQueuePos ? (
                <div className="ui-soft rounded-2xl p-4">
                  <p className="num c-violet text-4xl leading-none">#{sheetQueuePos.position}</p>
                  <p className="c-muted mt-1 text-sm font-semibold">of {sheetQueuePos.size} in line</p>
                </div>
              ) : (
                <div className="ui-soft rounded-2xl p-4">
                  <p className="num text-3xl leading-none">{sheetGps?.isLive ? speedLabel(sheetLive?.smoothedSpeed) : '—'}</p>
                  <p className="c-muted mt-1 text-sm font-semibold">speed</p>
                </div>
              )}
            </div>

            {sheetEta && (
              <div className="chip-primary flex items-end justify-between rounded-2xl px-4 py-3">
                <div>
                  <p className="text-xs font-bold">Estimated arrival at {legDestination(sheetTrip)}</p>
                  <p className="num mt-0.5 text-3xl leading-none">{formatTime(sheetEta.eta)}</p>
                </div>
                <div className="text-right text-xs font-bold">
                  <EtaCountdown etaIso={sheetEta.eta} />
                  {sheetEta.delayMinutes > 0 && <p className="mt-1"><Chip tone="warn">+{sheetEta.delayMinutes} min delay</Chip></p>}
                </div>
              </div>
            )}

            <GpsLine gps={sheetGps} data={sheetLive} />

            <dl>
              <DetailRow label="Route">{tripRouteLabel(sheetTrip)}</DetailRow>
              <DetailRow label="Heading to">{legDestination(sheetTrip)}</DetailRow>
              {formatTime(sheetTrip.scheduledTime) && <DetailRow label="Trip started">{formatTime(sheetTrip.scheduledTime)}</DetailRow>}
              {sheetGps?.isLive && typeof sheetLive?.accuracy === 'number' && (
                <DetailRow label="GPS accuracy">
                  <span className="num">±{Math.round(sheetLive.accuracy)} m</span>
                  {sheetLive.accuracy > LOW_ACCURACY_THRESHOLD_M && <span className="c-warn ml-1 text-xs">weak</span>}
                </DetailRow>
              )}
              <DetailRow label="Call the driver"><DriverContacts driver={sheetTrip.driver} /></DetailRow>
            </dl>

            {sheetRoute?.loading && (
              <p className="c-muted flex items-center gap-2 text-xs font-semibold"><Spinner className="h-3 w-3" /> Building road route…</p>
            )}
            {sheetRoute?.error && !sheetRoute.loading && <Notice tone="warn">{sheetRoute.error}</Notice>}
            {sheetRouteCoords.length > 1 && sheetRoute?.distanceMeters != null && sheetRoute?.durationSeconds != null && (
              <p className="c-muted text-xs font-semibold">
                Road route: {Math.round(sheetRoute.distanceMeters / 1000)} km, about {formatDuration(sheetRoute.durationSeconds)}
              </p>
            )}

            {siblings.length > 0 && (
              <div>
                <p className="c-muted mb-2 text-sm font-semibold">Other trips on this van</p>
                <ul className="ui-soft ui-divide overflow-hidden rounded-2xl">
                  {siblings.map((s) => (
                    <li key={s.id}>
                      <button type="button" onClick={() => openTrip(s.id)} className="ui-row flex min-h-[52px] w-full items-center justify-between gap-3 px-4 py-2 text-left">
                        <span className="truncate text-sm font-bold">{tripRouteLabel(s)}</span>
                        <StatusChip status={s.status} pending={isPendingQueue(s)} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Sheet>
    </div>,
  );
}
