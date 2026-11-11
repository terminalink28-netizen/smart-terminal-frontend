import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, ZoomControl, useMap } from 'react-leaflet';
import { useNavigate } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import apiClient from '../api/axios';
import { socket } from '../api/socket';
import QRScannerModal from '../components/QRScannerModal';
import { VIRAC_HUB, getCoordinatesForDestination } from '../components/townCoordinates';

// Same design system as the admin page: high-contrast elevated flat UI,
// Plus Jakarta Sans, 16px cards, heavy tabular numbers for seats and ETAs,
// and a mobile-first bottom-sheet architecture.
//   Phones : bottom navigation (Terminal / Fleet / Map), a floating Scan QR
//            button, and every van's details in a bottom sheet.
//   Desktop: sidebar + map side by side, van details docked at the right.
// For notched phones, index.html should use:
//   <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">

// ─── Constants ────────────────────────────────────────────────────────────────

const MAP_CENTER          = [13.5820477, 124.2192987];
const MAP_ZOOM            = 10;
const SUCCESS_TOAST_TTL   = 4500;
const REFETCH_INTERVAL_MS = 30_000;
const GPS_STALE_MS        = 120_000;
const MOVING_HEADING_KMH  = 4;

const HOME_TERMINAL_NAME  = 'Provincial Integrated Transport Terminal and Business Complex';
const HOME_TERMINAL_SHORT = 'Terminal';

// Shared with the admin page so the theme choice carries across pages.
const THEME_KEY = 'terminalink_admin_theme';

const STATUS_META = {
  BOARDING:  { label: 'Boarding',  tone: 'ok',     hex: '#059669' },
  DEPARTING: { label: 'Departing', tone: 'warn',   hex: '#d97706' },
  DEPARTED:  { label: 'En route',  tone: 'info',   hex: '#2563eb' },
  ARRIVING:  { label: 'En route',  tone: 'info',   hex: '#2563eb' }, // legacy: shown as en route
  QUEUED:    { label: 'In queue',  tone: 'violet', hex: '#7c3aed' },
  DELAYED:   { label: 'Delayed',   tone: 'warn',   hex: '#ea580c' },
};
const statusMeta = (s) => STATUS_META[s] ?? STATUS_META.DEPARTED;
const STATUS_PRIORITY = ['DEPARTED', 'ARRIVING', 'DEPARTING', 'DELAYED', 'BOARDING', 'QUEUED'];

const TABS = [
  { id: 'terminal', label: 'Terminal', icon: 'building' },
  { id: 'fleet',    label: 'Fleet',    icon: 'van' },
  { id: 'map',      label: 'Map',      icon: 'map' },
];

// ─── Theme (identical tokens to the admin page) ───────────────────────────────

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
@media (hover:hover){
  .b-default:hover:not(:disabled),.b-ghost:hover:not(:disabled){background:var(--surface-2)}
  .b-primary:hover:not(:disabled){filter:brightness(.92)}
  .ui-row:hover{background:var(--surface-2)}
}
.ui-row{transition:background .12s}
.ui-row:active{background:var(--surface-2)}

.ui-header{background:var(--surface);border-bottom:1px solid var(--line);padding-top:env(safe-area-inset-top)}
.ui-nav{background:var(--surface);border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom);box-shadow:0 -4px 14px rgba(16,24,40,.06)}
.ui-pad{padding-left:max(1rem,env(safe-area-inset-left));padding-right:max(1rem,env(safe-area-inset-right))}
.ui-toast{background:var(--text);color:var(--surface);box-shadow:var(--shadow)}
.ui-toast-pos{top:calc(env(safe-area-inset-top,0px) + 4.25rem)}
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

// ─── Icons ────────────────────────────────────────────────────────────────────

const VAN_PATH = 'M3 16V7a1 1 0 011-1h9l5 5h2a1 1 0 011 1v4M3 16h2m12 0h-6M7 18a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM17 18a1.5 1.5 0 100-3 1.5 1.5 0 000 3z';

const ICONS = {
  van:      VAN_PATH,
  building: 'M4 21V5a1 1 0 011-1h8a1 1 0 011 1v16M14 9h5a1 1 0 011 1v11M3 21h18M8 8h2M8 12h2M8 16h2',
  map:      'M9 4l-6 2v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14',
  scan:     'M4 8V6a2 2 0 012-2h2M16 4h2a2 2 0 012 2v2M20 16v2a2 2 0 01-2 2h-2M8 20H6a2 2 0 01-2-2v-2M4 12h16',
  chevron:  'M9 6l6 6-6 6',
  sun:      'M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4M12 16a4 4 0 100-8 4 4 0 000 8z',
  moon:     'M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z',
  logout:   'M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 8l-4 4 4 4M6 12h10',
  x:        'M6 6l12 12M18 6L6 18',
  check:    'M5 13l4 4L19 7',
  alert:    'M12 9v4M12 17h.01M10.3 4l-8 14a2 2 0 001.7 3h16a2 2 0 001.7-3l-8-14a2 2 0 00-3.4 0z',
  phone:    'M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z',
  locate:   'M12 2v3M12 19v3M2 12h3M19 12h3M12 17a5 5 0 100-10 5 5 0 000 10z',
  signal:   'M5 19v-3M10 19v-7M15 19V9M20 19V5',
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
function getVanMarkerIcon(status, heading, selected) {
  const bucket = typeof heading === 'number' ? (Math.round(heading / 30) * 30) % 360 : null;
  const key = `${status}|${bucket ?? 'n'}|${selected}`;
  if (markerCache.has(key)) return markerCache.get(key);

  const { hex } = statusMeta(status);
  const size = selected ? 44 : 36;
  const glyph = selected ? 24 : 20;
  const pointer = bucket === null ? '' : `
    <div style="position:absolute;inset:-8px;transform:rotate(${bucket}deg)">
      <div style="position:absolute;left:50%;top:-3px;margin-left:-6px;width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:10px solid ${hex}"></div>
    </div>`;

  const icon = L.divIcon({
    className: 'van-marker',
    html: `<div style="position:relative;width:${size}px;height:${size}px">${pointer}
      <div style="width:100%;height:100%;border-radius:50%;background:${hex};border:3px solid #fff;display:flex;align-items:center;justify-content:center;box-shadow:${selected ? `0 0 0 4px ${hex}40,` : ''}0 3px 10px rgba(15,23,42,.4)">
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

const isHomeTerminal = (name) =>
  typeof name === 'string' && name.trim().toLowerCase() === HOME_TERMINAL_NAME.toLowerCase();
const shortPlace = (name) =>
  (isHomeTerminal(name) ? HOME_TERMINAL_SHORT : (name ?? 'Unknown').replace(/\s*Terminal$/i, ''));
const isDesktopViewport = () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches;
const getDirection = (trip) => (trip?.direction === 'RETURN' ? 'RETURN' : 'OUTBOUND');

const mpsToKph = (mps) => Math.round((mps ?? 0) * 3.6);
function formatSpeed(mps) {
  if (typeof mps !== 'number') return '—';
  const kph = mpsToKph(mps);
  return kph > 1 ? `${kph} km/h` : 'Stopped';
}
const fmtTime = (iso) => {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return '—'; }
};
function relativeTime(ts) {
  if (!ts) return null;
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ago` : 'over an hour ago';
}

const originPlace = (trip) => trip.route?.origin ?? trip.route?.name?.split('→')[0]?.trim() ?? 'origin';
const cooperativeName = (trip) => trip.van?.cooperative?.name ?? 'Unassigned';
const legDestination = (trip) => (getDirection(trip) === 'RETURN' ? shortPlace(originPlace(trip)) : HOME_TERMINAL_SHORT);
const tripRouteLabel = (trip) => {
  const o = shortPlace(originPlace(trip));
  return getDirection(trip) === 'RETURN' ? `${HOME_TERMINAL_SHORT} → ${o}` : `${o} → ${HOME_TERMINAL_SHORT}`;
};

// An outbound van that has left its municipality is on its way in: it needs the
// terminal check-in scan. (ARRIVING is legacy and treated the same way.)
const isIncoming = (trip) =>
  getDirection(trip) === 'OUTBOUND' && (trip.status === 'DEPARTED' || trip.status === 'ARRIVING');
// A return-leg van that tapped "Ready to depart" needs the exit scan.
const isReadyToExit = (trip) => getDirection(trip) === 'RETURN' && trip.status === 'DEPARTING';
const isAwaitingScan = (trip) => isIncoming(trip) || isReadyToExit(trip);

function seatsOf(trip) {
  const total = trip.seatInfo?.totalSeats ?? trip.totalSeats ?? trip.van?.capacity ?? null;
  const available = trip.seatInfo?.availableSeats ?? trip.availableSeats ?? total;
  return { available, total };
}

function getContacts(driver) {
  if (!driver) return [];
  if (Array.isArray(driver.contactNumbers) && driver.contactNumbers.length) return driver.contactNumbers.filter(Boolean);
  return typeof driver.contactNumber === 'string' && driver.contactNumber ? [driver.contactNumber] : [];
}

// Normalises a fix from the socket (`van_moved`, `initial_locations`) or HTTP (`liveLocation`).
function normaliseFix(raw) {
  if (!raw || typeof raw.lat !== 'number' || typeof raw.lng !== 'number') return null;
  const stamp = typeof raw.timestamp === 'number' ? raw.timestamp : typeof raw.lastSeen === 'number' ? raw.lastSeen : Date.now();
  return {
    lat: raw.lat,
    lng: raw.lng,
    speed: typeof raw.smoothedSpeed === 'number' ? raw.smoothedSpeed : typeof raw.speed === 'number' ? raw.speed : null,
    heading: typeof raw.heading === 'number' ? raw.heading : null,
    accuracy: typeof raw.accuracy === 'number' ? raw.accuracy : null,
    positionTrusted: raw.positionTrusted !== false,
    lastSeen: Math.min(stamp, Date.now()),
  };
}

// Where a van sits with no usable live fix: at its origin municipality while
// boarding outbound, or at the terminal for the return leg.
function fallbackPositionForTrip(trip) {
  if (getDirection(trip) === 'RETURN') return VIRAC_HUB;
  const name = originPlace(trip);
  return getCoordinatesForDestination(name) ?? (isHomeTerminal(name) ? VIRAC_HUB : null);
}

function resolvePosition(trip, fix) {
  const live = Boolean(fix) && Date.now() - fix.lastSeen <= GPS_STALE_MS && fix.positionTrusted;
  if (live) return { position: [fix.lat, fix.lng], isLive: true };
  if (trip.status === 'BOARDING' || trip.status === 'QUEUED' || isReadyToExit(trip)) {
    const fb = fallbackPositionForTrip(trip);
    if (fb) return { position: fb, isLive: false };
  }
  return { position: null, isLive: false };
}

function locationHint(trip, pos, fix) {
  if (pos.isLive) return formatSpeed(fix?.speed);
  if (trip.status === 'BOARDING') return getDirection(trip) === 'RETURN' ? 'Boarding at the terminal' : `Boarding at ${shortPlace(originPlace(trip))}`;
  if (trip.status === 'QUEUED') return 'Waiting in line at the terminal';
  if (isReadyToExit(trip)) return 'At the terminal, waiting for exit scan';
  return 'Waiting for GPS…';
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

// ─── Primitives (same as the admin page) ──────────────────────────────────────

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

function Avatar({ children, tone = 'primary' }) {
  return <span className={`chip-${tone} flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm font-extrabold`}>{children}</span>;
}

function Notice({ tone = 'bad', children }) {
  return (
    <div role={tone === 'bad' ? 'alert' : undefined} className={`chip-${tone} flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold`}>
      <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}

function EmptyState({ icon = 'van', title, children }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
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

function ListRow({ leading, title, subtitle, trailing, onClick, ariaLabel }) {
  return (
    <li>
      <button type="button" onClick={onClick} aria-label={ariaLabel}
        className="ui-row flex min-h-[68px] w-full items-center gap-3 px-4 py-3 text-left">
        {leading}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-bold">{title}</span>
          {subtitle && <span className="c-muted block truncate text-sm font-medium">{subtitle}</span>}
        </span>
        {trailing}
        <Icon name="chevron" className="c-muted h-4 w-4 shrink-0" />
      </button>
    </li>
  );
}

function StatusChip({ status }) {
  const m = statusMeta(status);
  return <Chip tone={m.tone}>{m.label}</Chip>;
}

// "10/14": bold, tabular, readable in a glance. Turns red when the van is full.
function Seats({ trip, big = false }) {
  const { available, total } = seatsOf(trip);
  if (available == null || total == null) return null;
  return (
    <span className={`num leading-none ${big ? 'text-4xl' : 'text-lg'} ${available === 0 ? 'c-bad' : ''}`}>
      {available}<span className="c-muted font-bold">/{total}</span>
    </span>
  );
}

function ContactLinks({ driver }) {
  const numbers = getContacts(driver);
  if (!numbers.length) return <span className="c-muted">None on file</span>;
  return (
    <span className="flex flex-wrap justify-end gap-1.5">
      {numbers.map((n) => (
        <a key={n} href={`tel:${n.replace(/\s/g, '')}`} className="chip-info inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold tabular-nums">
          <Icon name="phone" className="h-3 w-3" /> {n}
        </a>
      ))}
    </span>
  );
}

// ─── Bottom sheet (same behaviour as the admin page; `dock` pins it to the right on desktop) ───

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
            {subtitle && <p className="c-muted truncate text-sm font-medium">{subtitle}</p>}
          </div>
          <Btn variant="ghost" size="icon" onClick={onClose} aria-label="Close" className="-mr-2 shrink-0"><Icon name="x" /></Btn>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 md:px-5">{children}</div>
        {footer && <div className="ui-line sheet-safe border-t px-4 pt-3 md:px-5">{footer}</div>}
      </div>
    </div>
  );
}

// ─── Trip sheet ───────────────────────────────────────────────────────────────

function TripSheet({ trip, fix, eta, siblings, onClose, onShowOnMap, onOpenOther }) {
  const pos = trip ? resolvePosition(trip, fix) : { position: null, isLive: false };

  return (
    <Sheet open={Boolean(trip)} onClose={onClose} dock
      title={trip?.van?.plateNumber ?? ''} subtitle={trip ? (trip.driver?.name ?? 'No driver assigned') : ''}
      footer={trip && (
        <Btn variant="primary" size="lg" className="w-full" onClick={() => onShowOnMap(trip)} disabled={!pos.position}>
          <Icon name="locate" /> Show on map
        </Btn>
      )}>
      {trip && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip status={trip.status} />
            <Chip tone={getDirection(trip) === 'RETURN' ? 'violet' : 'info'}>{getDirection(trip) === 'RETURN' ? 'Return leg' : 'Outbound'}</Chip>
            <Chip>{cooperativeName(trip)}</Chip>
          </div>

          {isIncoming(trip) && <Notice tone="info">On its way to the terminal. Scan its QR code when it arrives to check it in.</Notice>}
          {isReadyToExit(trip) && <Notice tone="warn">Ready to leave the terminal. Scan its QR code to release it.</Notice>}

          <div className="grid grid-cols-2 gap-3">
            <div className="ui-soft rounded-2xl p-4">
              <Seats trip={trip} big />
              <p className="c-muted mt-1 text-sm font-semibold">seats free</p>
            </div>
            <div className="ui-soft rounded-2xl p-4">
              <p className="num text-3xl leading-none">{pos.isLive ? formatSpeed(fix?.speed) : '—'}</p>
              <p className="c-muted mt-1 text-sm font-semibold">speed</p>
            </div>
          </div>

          {eta && ['DEPARTING', 'DEPARTED', 'ARRIVING', 'DELAYED'].includes(trip.status) && (
            <div className="chip-primary flex items-end justify-between rounded-2xl px-4 py-3">
              <div>
                <p className="text-xs font-bold">Estimated arrival at {legDestination(trip)}</p>
                <p className="num mt-0.5 text-3xl leading-none">{fmtTime(eta.eta)}</p>
              </div>
              {eta.delayMinutes > 0 && <Chip tone="warn">+{eta.delayMinutes} min</Chip>}
            </div>
          )}

          <dl>
            <DetailRow label="Route">{tripRouteLabel(trip)}</DetailRow>
            <DetailRow label="Heading to">{legDestination(trip)}</DetailRow>
            <DetailRow label="GPS">
              {pos.isLive
                ? <span className="c-ok">Live · {relativeTime(fix?.lastSeen)}</span>
                : <span className="c-muted">{locationHint(trip, pos, fix)}</span>}
            </DetailRow>
            {pos.isLive && fix?.accuracy != null && <DetailRow label="Accuracy"><span className="num">±{Math.round(fix.accuracy)} m</span></DetailRow>}
            <DetailRow label="Driver contact"><ContactLinks driver={trip.driver} /></DetailRow>
          </dl>

          {siblings.length > 0 && (
            <div>
              <p className="c-muted mb-2 text-sm font-semibold">Other trips on this van</p>
              <ul className="ui-soft ui-divide overflow-hidden rounded-2xl">
                {siblings.map((s) => (
                  <li key={s.id}>
                    <button type="button" onClick={() => onOpenOther(s.id)} className="ui-row flex min-h-[52px] w-full items-center justify-between gap-3 px-4 py-2 text-left">
                      <span className="truncate text-sm font-bold">{tripRouteLabel(s)}</span>
                      <StatusChip status={s.status} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}

// ─── Map helper ───────────────────────────────────────────────────────────────
// On phones the map is hidden while another tab is active. Leaflet measures its
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

// ─── Lists ────────────────────────────────────────────────────────────────────

function MetricTile({ label, value, tone }) {
  return (
    <div className="ui-card min-w-0 rounded-2xl px-2 py-3 text-center">
      <p className={`num text-2xl leading-none ${tone ? `c-${tone}` : ''}`}>{value}</p>
      <p className="c-muted mt-1.5 truncate text-[11px] font-bold">{label}</p>
    </div>
  );
}

const ordinal = (n) => `${n}${n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;

function LaneEntry({ entry, kind, onOpen }) {
  const t = entry.trip ?? {};
  const seatsTrip = { availableSeats: t.availableSeats, totalSeats: t.totalSeats, van: { capacity: entry.capacity } };
  const heading = kind === 'DEPARTING' ? 'Scan to release' : kind === 'BOARDING' ? 'Now boarding'
    : entry.queuePosition === 1 ? 'Next in line' : `${ordinal(entry.queuePosition)} in line`;
  const tone = kind === 'DEPARTING' ? 'warn' : kind === 'BOARDING' ? 'ok' : 'violet';

  return (
    <ListRow onClick={() => t.id && onOpen(t.id)} ariaLabel={`Open ${entry.plateNumber}`}
      leading={
        <Avatar tone={tone}>
          {kind === 'DEPARTING' ? <Icon name="scan" /> : kind === 'BOARDING' ? <Icon name="van" /> : <span className="num text-base">#{entry.queuePosition}</span>}
        </Avatar>
      }
      title={entry.plateNumber}
      subtitle={`${entry.driver?.name ?? 'No driver on file'}${t.origin ? ` · to ${shortPlace(t.origin)}` : ''}`}
      trailing={
        <span className="flex flex-col items-end gap-1.5">
          {kind !== 'QUEUED' && <Seats trip={seatsTrip} />}
          <Chip tone={tone}>{heading}</Chip>
        </span>
      } />
  );
}

function CooperativeLane({ group, onOpen }) {
  const total = group.departing.length + group.boarding.length + group.queued.length;
  return (
    <Card className="overflow-hidden">
      <div className="ui-line flex items-center justify-between gap-2 border-b px-4 py-3">
        <span className="flex min-w-0 items-center gap-2 font-extrabold">
          <Icon name="building" className="c-muted h-4 w-4 shrink-0" />
          <span className="truncate">{group.cooperativeName}</span>
        </span>
        <span className="c-muted shrink-0 text-xs font-bold"><span className="num text-sm" style={{ color: 'var(--text)' }}>{total}</span> in line</span>
      </div>
      <ul className="ui-divide">
        {group.departing.map((e) => <LaneEntry key={e.vanId} entry={e} kind="DEPARTING" onOpen={onOpen} />)}
        {group.boarding.map((e) => <LaneEntry key={e.vanId} entry={e} kind="BOARDING" onOpen={onOpen} />)}
        {group.queued.map((e) => <LaneEntry key={e.vanId} entry={e} kind="QUEUED" onOpen={onOpen} />)}
      </ul>
    </Card>
  );
}

function TripRow({ trip, fix, eta, onOpen }) {
  const pos = resolvePosition(trip, fix);
  const awaiting = isAwaitingScan(trip);
  return (
    <ListRow onClick={() => onOpen(trip.id)} ariaLabel={`Open ${trip.van?.plateNumber ?? 'van'}`}
      leading={<Avatar tone={statusMeta(trip.status).tone}><Icon name="van" /></Avatar>}
      title={trip.van?.plateNumber ?? 'Unknown plate'}
      subtitle={`${trip.driver?.name ?? 'No driver'} · ${tripRouteLabel(trip)}`}
      trailing={
        <span className="flex flex-col items-end gap-1.5">
          <span className="flex items-baseline gap-2">
            {eta && isIncoming(trip) && <span className="num text-sm">{fmtTime(eta.eta)}</span>}
            <Seats trip={trip} />
          </span>
          {awaiting ? <Chip tone="primary">Needs scan</Chip> : <Chip tone={statusMeta(trip.status).tone}>{pos.isLive ? formatSpeed(fix?.speed) : statusMeta(trip.status).label}</Chip>}
        </span>
      } />
  );
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function BottomNav({ tab, onChange, counts }) {
  return (
    <nav className="ui-nav fixed inset-x-0 bottom-0 z-40 lg:hidden" aria-label="Dispatcher views">
      <ul className="mx-auto grid max-w-lg grid-cols-3">
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DispatcherDashboard() {
  const [theme, toggleTheme] = useTheme();
  const navigate = useNavigate();

  const [activeTrips, setActiveTrips]     = useState([]);
  const [liveLocations, setLiveLocations] = useState({});
  const [liveEtas, setLiveEtas]           = useState({});
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState('');
  const [reloadToken, setReloadToken]     = useState(0);
  const [, setTick]                       = useState(0);

  const [terminalGroups, setTerminalGroups]   = useState([]);
  const [terminalLoading, setTerminalLoading] = useState(true);
  const [terminalError, setTerminalError]     = useState('');

  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');

  // Phones: which full-screen view is showing. From 1024px everything is visible at once.
  const [activeTab, setActiveTab] = useState('terminal');
  const [sheetTripId, setSheetTripId]       = useState(null);
  const [selectedTripId, setSelectedTripId] = useState(null);

  const successTimerRef  = useRef(null);
  const terminalTimerRef = useRef(null);
  const mapRef           = useRef(null);
  const activeTripsRef   = useRef([]);
  useEffect(() => { activeTripsRef.current = activeTrips; }, [activeTrips]);

  // ── API fetching ──
  const mergeFixes = useCallback((pairs) => {
    setLiveLocations((prev) => {
      const next = { ...prev };
      for (const [tripId, raw] of pairs) {
        const fix = normaliseFix(raw);
        if (fix && (!next[tripId] || fix.lastSeen >= next[tripId].lastSeen)) next[tripId] = fix;
      }
      return next;
    });
  }, []);

  const fetchActiveTrips = useCallback(async (signal) => {
    try {
      const response = await apiClient.get('/trips/live', { signal });
      const trips = Array.isArray(response.data) ? response.data : [];
      setActiveTrips(trips);
      mergeFixes(trips.filter((t) => t.liveLocation).map((t) => [t.id, t.liveLocation]));
      setError('');
    } catch (err) {
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
      setError('Failed to load live dispatcher data. Check your connection.');
      console.error('[DispatcherDashboard] fetchActiveTrips error:', err);
    } finally {
      setLoading(false);
    }
  }, [mergeFixes]);

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

  // Seat taps and status changes can arrive in bursts, so refresh the line-up once they settle.
  const scheduleTerminalRefresh = useCallback(() => {
    clearTimeout(terminalTimerRef.current);
    terminalTimerRef.current = setTimeout(() => fetchTerminalVans(), 500);
  }, [fetchTerminalVans]);

  // Safety-net poll in case a socket event is missed.
  useEffect(() => {
    const id = setInterval(() => {
      const ctrl = new AbortController();
      fetchActiveTrips(ctrl.signal);
      fetchTerminalVans(ctrl.signal);
    }, REFETCH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchActiveTrips, fetchTerminalVans]);

  // Keeps "updated 12s ago" labels fresh.
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  // ── WebSockets ──
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setTerminalLoading(true);
    fetchActiveTrips(controller.signal);
    fetchTerminalVans(controller.signal);

    const handleInitialLocations = (pairs = []) => { if (Array.isArray(pairs)) mergeFixes(pairs); };

    const handleVanMoved = (data) => { if (data?.tripId) mergeFixes([[data.tripId, data]]); };

    const handleSeatUpdate = (data) => {
      if (!data?.tripId || typeof data.availableSeats !== 'number') return;
      setActiveTrips((prev) => prev.map((t) => (t.id === data.tripId
        ? { ...t, seatInfo: { availableSeats: data.availableSeats, totalSeats: data.totalSeats } } : t)));
      scheduleTerminalRefresh(); // boarding vans in the line-up show seats too
    };

    const dropTripState = (tripId) => {
      setLiveLocations((prev) => { if (!(tripId in prev)) return prev; const n = { ...prev }; delete n[tripId]; return n; });
      setLiveEtas((prev) => { if (!(tripId in prev)) return prev; const n = { ...prev }; delete n[tripId]; return n; });
    };

    const handleTripStatusChanged = ({ tripId, status, trip }) => {
      if (!tripId) return;
      const finished = status === 'COMPLETED' || status === 'CANCELLED';

      // A new leg starts with a fresh ETA.
      const before = activeTripsRef.current.find((t) => t.id === tripId);
      if (before && trip?.direction && before.direction !== trip.direction) {
        setLiveEtas((prev) => { const n = { ...prev }; delete n[tripId]; return n; });
      }

      setActiveTrips((prev) => {
        if (finished) return prev.filter((t) => t.id !== tripId);
        if (prev.some((t) => t.id === tripId)) return prev.map((t) => (t.id === tripId ? { ...t, status, ...(trip || {}) } : t));
        return trip ? [trip, ...prev] : prev;
      });
      if (finished) {
        dropTripState(tripId);
        setSheetTripId((cur) => (cur === tripId ? null : cur));
      }
      // Check-in scans, exit scans, departures from the boarding slot and queue promotions all change the line-up.
      scheduleTerminalRefresh();
    };

    const handleTripDispatched = ({ trip }) => {
      if (!trip?.id) return;
      setActiveTrips((prev) => (prev.some((t) => t.id === trip.id) ? prev : [trip, ...prev]));
    };

    const handleEtaUpdate = ({ tripId, eta, delayMinutes } = {}) => {
      if (!tripId || !eta) return;
      setLiveEtas((prev) => ({ ...prev, [tripId]: { eta, delayMinutes: delayMinutes ?? 0 } }));
    };

    socket.connect();
    socket.emit('subscribe_to_map');
    socket.on('initial_locations',     handleInitialLocations);
    socket.on('van_moved',             handleVanMoved);
    socket.on('seat_update_broadcast', handleSeatUpdate);
    socket.on('trip_status_changed',   handleTripStatusChanged);
    socket.on('trip_dispatched',       handleTripDispatched);
    socket.on('eta_update',            handleEtaUpdate);

    return () => {
      controller.abort();
      socket.off('initial_locations',     handleInitialLocations);
      socket.off('van_moved',             handleVanMoved);
      socket.off('seat_update_broadcast', handleSeatUpdate);
      socket.off('trip_status_changed',   handleTripStatusChanged);
      socket.off('trip_dispatched',       handleTripDispatched);
      socket.off('eta_update',            handleEtaUpdate);
      socket.disconnect();
      clearTimeout(successTimerRef.current);
      clearTimeout(terminalTimerRef.current);
    };
  }, [fetchActiveTrips, fetchTerminalVans, mergeFixes, scheduleTerminalRefresh, reloadToken]);

  // ── Callbacks ──
  const showSuccess = useCallback((message) => {
    setSuccessMessage(message);
    clearTimeout(successTimerRef.current);
    successTimerRef.current = setTimeout(() => setSuccessMessage(''), SUCCESS_TOAST_TTL);
  }, []);

  // After a scan the line-up has changed, so on a phone jump to the Terminal tab to show the result.
  const handleScanSuccess = useCallback((result) => {
    showSuccess(typeof result === 'string' ? result : 'QR scan successful.');
    fetchActiveTrips();
    fetchTerminalVans();
    if (!isDesktopViewport()) setActiveTab('terminal');
  }, [fetchActiveTrips, fetchTerminalVans, showSuccess]);

  const openTrip = useCallback((tripId) => { setSheetTripId(tripId); setSelectedTripId(tripId); }, []);
  const closeSheet = useCallback(() => { setSheetTripId(null); setSelectedTripId(null); }, []);

  // "Show on map": on phones this switches to the Map tab and keeps the van highlighted.
  const focusOnMap = useCallback((trip) => {
    const { position } = resolvePosition(trip, liveLocations[trip.id]);
    const phone = !isDesktopViewport();
    if (phone) { setSheetTripId(null); setSelectedTripId(trip.id); setActiveTab('map'); }
    if (position) setTimeout(() => mapRef.current?.setView(position, 14, { animate: true }), phone ? 160 : 0);
  }, [liveLocations]);

  const handleLogout = useCallback(async () => {
    try { await apiClient.post('/auth/logout'); } catch (err) { console.error('[DispatcherDashboard] Logout error:', err); }
    finally {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      navigate('/login', { replace: true });
    }
  }, [navigate]);

  // ── Derived data ──
  // Only cooperatives that actually have a scanned van in line (including vans waiting for their exit scan).
  const lanes = useMemo(() => terminalGroups
    .map((g) => ({
      ...g,
      departing: Array.isArray(g.departing) ? g.departing : [],
      boarding: Array.isArray(g.boarding) ? g.boarding : [],
      queued: Array.isArray(g.queued) ? g.queued : [],
    }))
    .filter((g) => g.departing.length + g.boarding.length + g.queued.length > 0), [terminalGroups]);

  const boardingCount = lanes.reduce((n, g) => n + g.boarding.length, 0);
  const queuedCount   = lanes.reduce((n, g) => n + g.queued.length, 0);
  const lineUpCount   = lanes.reduce((n, g) => n + g.departing.length + g.boarding.length + g.queued.length, 0);

  const incomingTrips = useMemo(() => activeTrips.filter(isIncoming).sort((a, b) => {
    const ea = liveEtas[a.id]?.eta ? new Date(liveEtas[a.id].eta).getTime() : Infinity;
    const eb = liveEtas[b.id]?.eta ? new Date(liveEtas[b.id].eta).getTime() : Infinity;
    return ea - eb || new Date(a.scheduledTime ?? 0) - new Date(b.scheduledTime ?? 0);
  }), [activeTrips, liveEtas]);

  const awaitingScanCount = activeTrips.filter(isAwaitingScan).length;
  const liveCount = activeTrips.filter((t) => resolvePosition(t, liveLocations[t.id]).isLive).length;

  // One marker per van that has a live fix (a driver's simultaneous trips share it).
  const markerGroups = useMemo(() => {
    const groups = new Map();
    for (const trip of activeTrips) {
      const r = resolvePosition(trip, liveLocations[trip.id]);
      if (!r.position) continue;
      const vanKey = trip.van?.id ?? trip.vanId ?? trip.id;
      const key = r.isLive ? `van:${vanKey}` : `trip:${trip.id}`;
      if (!groups.has(key)) groups.set(key, { key, position: r.position, isLive: r.isLive, trips: [] });
      groups.get(key).trips.push(trip);
    }
    return Array.from(groups.values()).map((g) => ({
      ...g,
      primary: g.trips.find((t) => t.id === selectedTripId)
        ?? [...g.trips].sort((a, b) => STATUS_PRIORITY.indexOf(a.status) - STATUS_PRIORITY.indexOf(b.status))[0],
    }));
  }, [activeTrips, liveLocations, selectedTripId]);

  const sheetTrip = activeTrips.find((t) => t.id === sheetTripId) ?? null;
  const siblings = sheetTrip
    ? activeTrips.filter((t) => t.id !== sheetTrip.id && (t.van?.id ?? t.vanId) === (sheetTrip.van?.id ?? sheetTrip.vanId))
    : [];

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
        <Card className="flex items-center gap-3 px-5 py-4"><Spinner className="c-primary h-5 w-5" /><span className="font-bold">Connecting to terminal…</span></Card>
      </div>,
    );
  }

  if (error) {
    return shell(
      <div className="flex h-full items-center justify-center p-6">
        <Card className="w-full max-w-md space-y-4 p-6 text-center">
          <h1 className="text-xl font-extrabold">Dispatcher dashboard</h1>
          <Notice>{error}</Notice>
          <Btn variant="primary" size="lg" className="w-full" onClick={() => setReloadToken((n) => n + 1)}>Retry</Btn>
        </Card>
      </div>,
    );
  }

  const terminalSection = (
    <div className="space-y-4">
      {terminalError && <Notice>{terminalError}</Notice>}

      <div>
        <SectionHeader title="Heading to the terminal" count={incomingTrips.length} hint="Scan each van's QR when it arrives." />
        <Card className="overflow-hidden">
          {incomingTrips.length === 0 ? (
            <EmptyState icon="van" title="No vans on the way">Vans appear here once they leave their municipality.</EmptyState>
          ) : (
            <ul className="ui-divide">
              {incomingTrips.map((t) => <TripRow key={t.id} trip={t} fix={liveLocations[t.id]} eta={liveEtas[t.id]} onOpen={openTrip} />)}
            </ul>
          )}
        </Card>
      </div>

      <div>
        <SectionHeader title="Terminal line-up" count={lineUpCount} hint="One lane per cooperative, in scan order." />
        {terminalLoading ? (
          <Card><p className="c-muted flex items-center justify-center gap-2 py-10 text-sm font-semibold"><Spinner /> Loading line-up…</p></Card>
        ) : lanes.length === 0 ? (
          <Card><EmptyState icon="scan" title="No scanned vans yet">A van joins its cooperative's line when you scan its QR at the terminal, and leaves it when you scan it again.</EmptyState></Card>
        ) : (
          <div className="space-y-3">
            {lanes.map((g) => <CooperativeLane key={g.cooperativeId ?? 'unassigned'} group={g} onOpen={openTrip} />)}
          </div>
        )}
      </div>
    </div>
  );

  const fleetSection = (
    <div>
      <SectionHeader title="Live fleet" count={activeTrips.length} />
      <Card className="overflow-hidden">
        {activeTrips.length === 0 ? (
          <EmptyState icon="van" title="No active trips">Trips appear here when drivers start them.</EmptyState>
        ) : (
          <ul className="ui-divide">
            {activeTrips.map((t) => <TripRow key={t.id} trip={t} fix={liveLocations[t.id]} eta={liveEtas[t.id]} onOpen={openTrip} />)}
          </ul>
        )}
      </Card>
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
            <p className="c-muted text-xs font-semibold leading-tight">Dispatcher</p>
          </div>
          
          <Btn variant="ghost" size="icon" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
          </Btn>
          <Btn onClick={handleLogout}><Icon name="logout" className="h-[18px] w-[18px]" /> Logout</Btn>
        </div>
      </header>

      {successMessage && (
        <div role="status" aria-live="polite" className="ui-toast-pos pointer-events-none fixed inset-x-0 z-[60] flex justify-center px-4">
          <div className="ui-toast pointer-events-auto flex max-w-md items-center gap-3 rounded-2xl px-4 py-3 text-sm font-bold">
            <Icon name="check" className="h-5 w-5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{successMessage}</span>
            <button onClick={() => setSuccessMessage('')} aria-label="Dismiss" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg opacity-80"><Icon name="x" className="h-4 w-4" /></button>
          </div>
        </div>
      )}

      {/* Body */}
      <div className="relative z-0 flex min-h-0 flex-1 overflow-hidden">
        {/* Sidebar (phones: full-screen Terminal / Fleet tabs; desktop: both, stacked) */}
        <aside className={`${activeTab === 'map' ? 'hidden' : 'flex'} ui-line min-w-0 flex-1 flex-col overflow-hidden lg:w-[26rem] lg:flex-none lg:border-r xl:w-[28rem]`}>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-44 lg:pb-6">
            <div className="ui-pad space-y-4 pt-4 lg:pr-4">
              <div className="grid grid-cols-4 gap-2">
                <MetricTile label="Active" value={activeTrips.length} />
                <MetricTile label="Incoming" value={incomingTrips.length} tone="info" />
                <MetricTile label="Boarding" value={boardingCount} tone="ok" />
                <MetricTile label="In line" value={queuedCount} tone="violet" />
              </div>
              <div className={activeTab === 'terminal' ? 'block' : 'hidden lg:block'}>{terminalSection}</div>
              <div className={activeTab === 'fleet' ? 'block' : 'hidden lg:block'}>{fleetSection}</div>
            </div>
          </div>
        </aside>

        {/* Map (phones: its own tab) */}
        <main className={`${activeTab === 'map' ? 'block' : 'hidden'} relative z-0 flex-1 lg:block`} style={{ background: 'var(--surface-2)' }}>
          <MapContainer center={MAP_CENTER} zoom={MAP_ZOOM} className="h-full w-full" ref={mapRef} zoomControl={false}>
            <MapInvalidator active={activeTab === 'map'} />
            <ZoomControl position="topright" />
            <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

            <Marker position={VIRAC_HUB} icon={hubIcon} />

            {markerGroups.map((group) => {
              const trip = group.primary;
              const fix = liveLocations[trip.id];
              const moving = (mpsToKph(fix?.speed)) >= MOVING_HEADING_KMH;
              const heading = group.isLive && moving ? fix?.heading : null;
              const selected = group.trips.some((t) => t.id === selectedTripId);
              return (
                <Marker key={group.key} position={group.position} icon={getVanMarkerIcon(trip.status, heading, selected)}
                  zIndexOffset={selected ? 1000 : 0} eventHandlers={{ click: () => openTrip(trip.id) }} />
              );
            })}
          </MapContainer>

          <div className="pointer-events-none absolute left-3 top-3 z-[1000] flex items-center gap-2">
            <span className="ui-map-overlay inline-flex items-center gap-2 rounded-full px-3 py-2 text-xs font-bold">
              <span className="relative flex h-2 w-2">
                {liveCount > 0 && <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-70" style={{ background: 'var(--primary)' }} />}
                <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: liveCount > 0 ? 'var(--primary)' : 'var(--muted)' }} />
              </span>
              <span className="num">{liveCount}</span> {liveCount === 1 ? 'van' : 'vans'} live
            </span>
          </div>

          {activeTrips.length > 0 && liveCount === 0 && (
            <div className="ui-map-overlay pointer-events-none absolute bottom-24 left-1/2 z-[1000] flex w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 items-center justify-center gap-2 rounded-2xl px-4 py-3 text-center text-xs font-bold lg:bottom-6">
              <Spinner className="h-4 w-4" /> Waiting for drivers to start sharing GPS…
            </div>
          )}
        </main>
      </div>

      {/* Floating scan button (phones) */}
      <button type="button" onClick={() => setIsScannerOpen(true)}
        className="ui-btn b-primary fixed right-4 z-40 inline-flex h-14 items-center gap-2 rounded-2xl px-5 text-base font-extrabold lg:hidden"
        style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 4.75rem)', boxShadow: '0 8px 24px rgba(0,135,61,.35)' }}>
        <Icon name="scan" className="h-6 w-6" /> Scan QR
        {awaitingScanCount > 0 && <span className="num rounded-full px-2 text-sm" style={{ background: 'var(--on-primary)', color: 'var(--primary)' }}>{awaitingScanCount}</span>}
      </button>

      <BottomNav tab={activeTab} onChange={setActiveTab} counts={{ terminal: lineUpCount, fleet: activeTrips.length, map: 0 }} />

      <TripSheet trip={sheetTrip} fix={sheetTrip ? liveLocations[sheetTrip.id] : null} eta={sheetTrip ? liveEtas[sheetTrip.id] : null}
        siblings={siblings} onClose={closeSheet} onShowOnMap={focusOnMap} onOpenOther={openTrip} />

      <QRScannerModal isOpen={isScannerOpen} onClose={() => setIsScannerOpen(false)} onSuccess={handleScanSuccess} />
    </div>,
  );
}
