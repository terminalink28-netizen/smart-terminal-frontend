import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import apiClient from '../api/axios';

// High-contrast elevated flat UI (in the spirit of Grab / Google Maps):
//   • Flat white cards lifted by one soft shadow, 16px corners, strong text contrast
//   • Plus Jakarta Sans, with heavy tabular numbers for anything meant to be scanned
//   • Mobile-first bottom-sheet architecture: lists on the page, every detail,
//     form and confirmation in a bottom sheet (centred dialog from 768px up),
//     sections reached from a bottom navigation bar (top tabs from 768px up)
// For notched phones, index.html should use:
//   <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">

// ─── Constants ────────────────────────────────────────────────────────────────

const EMPTY_DATA = {
  stats: { activeTrips: 0, totalTrips: 0, totalVans: 0, totalUsers: 0 },
  staff: [],
  vans: [],
};
const EMPTY_STAFF_FORM = { name: '', email: '', role: '', password: '' };

const VAN_STATUS_META = {
  IDLE:        { label: 'Idle',        tone: 'warn' },
  ON_TRIP:     { label: 'On trip',     tone: 'ok' },
  MAINTENANCE: { label: 'Maintenance', tone: 'bad' },
};
const ROLE_TONE = { ADMIN: 'violet', DISPATCHER: 'info', DRIVER: 'muted' };

const TABS = [
  { id: 'overview',     label: 'Overview',  icon: 'home' },
  { id: 'applications', label: 'Approvals', icon: 'inbox' },
  { id: 'vans',         label: 'Vans',      icon: 'van' },
  { id: 'users',        label: 'Users',     icon: 'users' },
  { id: 'audit',        label: 'Audit',     icon: 'list' },
];

const THEME_KEY = 'terminalink_admin_theme';

const AUDIT_PAGE_SIZE   = 50;
const AUDIT_EXPORT_MAX  = 5000;
const AUDIT_POLL_MS     = 30_000;
const EMPTY_AUDIT_FILTERS = { search: '', action: '', from: '', to: '' };

const EMAIL_RE     = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN = 4;

// ─── Theme ────────────────────────────────────────────────────────────────────
// Every colour pair below is chosen for at least 4.5:1 contrast in its theme.

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
.b-dangersolid{background:var(--bad-solid);color:var(--on-bad)}
.b-ghost{background:transparent;color:var(--text)}
@media (hover:hover){
  .b-default:hover:not(:disabled),.b-ghost:hover:not(:disabled){background:var(--surface-2)}
  .b-primary:hover:not(:disabled),.b-dangersolid:hover:not(:disabled){filter:brightness(.92)}
  .b-danger:hover:not(:disabled){filter:brightness(.96)}
  .ui-row:hover{background:var(--surface-2)}
}

.ui-input{font-size:16px;background:var(--surface);color:var(--text);border:1.5px solid var(--line)}
.ui-input::placeholder{color:var(--muted);opacity:.85}
.ui-input:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-bg)}
.ui-input.invalid{border-color:var(--bad)}
.ui-row{transition:background .12s}
.ui-row:active{background:var(--surface-2)}

.ui-header{background:var(--surface);border-bottom:1px solid var(--line);padding-top:env(safe-area-inset-top)}
.ui-nav{background:var(--surface);border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom);box-shadow:0 -4px 14px rgba(16,24,40,.06)}
.ui-main{padding-left:max(1rem,env(safe-area-inset-left));padding-right:max(1rem,env(safe-area-inset-right))}
.ui-toast{background:var(--text);color:var(--surface);box-shadow:var(--shadow)}
.ui-toast-pos{bottom:calc(env(safe-area-inset-bottom,0px) + 5rem)}

/* Bottom sheet: slides up on phones, centred dialog from 768px */
@keyframes sheet-up{from{transform:translateY(100%)}to{transform:none}}
@keyframes fade-in{from{opacity:0}to{opacity:1}}
@keyframes pop-in{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:none}}
.sheet-scrim{animation:fade-in .18s ease-out}
.sheet-panel{background:var(--surface);box-shadow:0 -10px 40px rgba(16,24,40,.22);max-height:92vh;max-height:92dvh;animation:sheet-up .26s cubic-bezier(.2,.8,.2,1)}
.sheet-handle{touch-action:none;cursor:grab}
.sheet-bar{background:var(--line);filter:brightness(.85)}
.sheet-safe{padding-bottom:calc(.75rem + env(safe-area-inset-bottom))}
@media (min-width:768px){
  .sheet-panel{box-shadow:0 24px 64px rgba(16,24,40,.28);max-height:88vh;max-height:88dvh;animation:pop-in .18s ease-out}
  .sheet-safe{padding-bottom:1rem}
  .ui-toast-pos{bottom:1.5rem}
}
@media (prefers-reduced-motion:reduce){
  .sheet-scrim,.sheet-panel{animation:none}
  .ui-btn{transition:none}
}
`;

// ─── Icons ────────────────────────────────────────────────────────────────────

const ICONS = {
  home:     'M3 11l9-8 9 8M5 10v10a1 1 0 001 1h4v-6h4v6h4a1 1 0 001-1V10',
  inbox:    'M3 13l3-8h12l3 8M3 13v6a1 1 0 001 1h16a1 1 0 001-1v-6M3 13h5l1 3h6l1-3h5',
  list:     'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  filter:   'M4 6h16M7 12h10M10 18h4',
  chevron:  'M9 6l6 6-6 6',
  sun:      'M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4M12 16a4 4 0 100-8 4 4 0 000 8z',
  moon:     'M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z',
  refresh:  'M20 11a8 8 0 00-14.9-3M4 5v4h4M4 13a8 8 0 0014.9 3M20 19v-4h-4',
  logout:   'M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 8l-4 4 4 4M6 12h10',
  search:   'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-4.3-4.3',
  x:        'M6 6l12 12M18 6L6 18',
  plus:     'M12 5v14M5 12h14',
  trash:    'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3',
  check:    'M5 13l4 4L19 7',
  doc:      'M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1zM14 3v5h5M9 13h6M9 17h6',
  users:    'M16 20v-1a4 4 0 00-4-4H8a4 4 0 00-4 4v1M10 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM20 20v-1a4 4 0 00-3-3.9M16 4.1a3.5 3.5 0 010 6.8',
  van:      'M3 16V7a1 1 0 011-1h9l5 5h2a1 1 0 011 1v4M3 16h2m12 0h-6M7 18a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM17 18a1.5 1.5 0 100-3 1.5 1.5 0 000 3z',
  clock:    'M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  copy:     'M9 9h10a1 1 0 011 1v10a1 1 0 01-1 1H9a1 1 0 01-1-1V10a1 1 0 011-1zM5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1',
  download: 'M12 4v11M8 11l4 4 4-4M5 20h14',
  dice:     'M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2zM8 8h.01M16 8h.01M8 16h.01M16 16h.01M12 12h.01',
  eye:      'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
  eyeOff:   'M3 3l18 18M10.6 5.1A9.6 9.6 0 0112 5c6 0 10 7 10 7a17 17 0 01-3.2 4M6.5 6.6A16.6 16.6 0 002 12s4 7 10 7c1.8 0 3.4-.5 4.8-1.2M9.9 9.9a3 3 0 004.2 4.2',
  alert:    'M12 9v4M12 17h.01M10.3 4l-8 14a2 2 0 001.7 3h16a2 2 0 001.7-3l-8-14a2 2 0 00-3.4 0z',
};

function Icon({ name, className = 'h-5 w-5' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toCsvField(value) {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function describeApiError(err, fallback) {
  if (err?.code === 'ECONNABORTED') return 'The request timed out. Check your connection and try again.';
  if (err?.response) {
    if (Array.isArray(err.response.data?.errors)) return err.response.data.errors.map((e) => e.msg || e.message).join(', ');
    return err.response.data?.error ?? err.response.data?.message ?? fallback;
  }
  if (err?.request) return 'Network error. Could not reach the server.';
  return err?.message ?? fallback;
}

const isCanceled = (err) => err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED';

function handleAuthFailure(err) {
  if (err?.response?.status === 401 || err?.response?.status === 403) {
    localStorage.removeItem('user');
    window.location.replace('/login');
    return true;
  }
  return false;
}

function formatTimestamp(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const auditTarget = (e) => [e.targetType, e.target].filter(Boolean).join(': ') || '—';
const initials = (name) => (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';

// A PIN is weak when it is one repeated digit, a straight run, or a repeated block (1212, 123123).
function isWeakPassword(pw) {
  if (!pw) return true;
  if (/^(\d+)\1+$/.test(pw)) return true;
  if (/^\d+$/.test(pw)) {
    const d = pw.split('').map(Number);
    const asc = d.every((n, i) => i === 0 || n === d[i - 1] + 1);
    const desc = d.every((n, i) => i === 0 || n === d[i - 1] - 1);
    if (asc || desc) return true;
  }
  return false;
}

function generateRandomPassword(minLen = 4, maxLen = 8) {
  const len = Math.floor(Math.random() * (maxLen - minLen + 1)) + minLen;
  let pw = '';
  let attempts = 0;
  do {
    pw = Array.from({ length: len }, () => Math.floor(Math.random() * 10)).join('');
    attempts += 1;
  } while (isWeakPassword(pw) && attempts < 200);
  return pw;
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

// ─── Audit trail data (server-driven: filters, paging and export all run on the API) ───

function mergeAuditRows(existing, incoming) {
  const byId = new Map(existing.map((e) => [e.id, e]));
  incoming.forEach((e) => byId.set(e.id, e));
  return Array.from(byId.values()).sort(
    (a, b) => new Date(b.timestamp) - new Date(a.timestamp) || (a.id < b.id ? 1 : -1),
  );
}

function useAuditTrail(isActive) {
  const [filters, setFilters]   = useState(EMPTY_AUDIT_FILTERS);
  const [applied, setApplied]   = useState(EMPTY_AUDIT_FILTERS);
  const [logs, setLogs]         = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [total, setTotal]       = useState(0);
  const [actions, setActions]   = useState([]);
  const [loading, setLoading]   = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError]       = useState('');
  const abortRef = useRef(null);

  // Typing in the search box shouldn't fire a request per keystroke.
  useEffect(() => {
    const id = setTimeout(() => setApplied(filters), 300);
    return () => clearTimeout(id);
  }, [filters]);

  const buildParams = useCallback((extra = {}) => {
    const params = { limit: AUDIT_PAGE_SIZE, ...extra };
    if (applied.search.trim()) params.search = applied.search.trim();
    if (applied.action) params.action = applied.action;
    if (applied.from) params.from = new Date(`${applied.from}T00:00:00`).toISOString();
    if (applied.to) params.to = new Date(`${applied.to}T23:59:59.999`).toISOString();
    return params;
  }, [applied]);

  // mode: 'replace' (first page), 'append' (load more), 'head' (background refresh that keeps loaded pages)
  const load = useCallback(async (mode = 'replace', cursor = null) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    if (mode === 'append') setLoadingMore(true);
    if (mode === 'replace') { setLoading(true); setLoadingMore(false); }
    if (mode !== 'head') setError('');

    try {
      const { data } = await apiClient.get('/admin/audit-logs', {
        params: buildParams(cursor ? { cursor } : {}),
        signal: ctrl.signal,
      });
      const incoming = Array.isArray(data?.logs) ? data.logs : [];

      if (mode === 'replace') { setLogs(incoming); setNextCursor(data?.nextCursor ?? null); }
      else if (mode === 'append') { setLogs((prev) => mergeAuditRows(prev, incoming)); setNextCursor(data?.nextCursor ?? null); }
      else setLogs((prev) => mergeAuditRows(prev, incoming));

      if (typeof data?.total === 'number') setTotal(data.total);
      if (Array.isArray(data?.actions)) setActions(data.actions);
    } catch (err) {
      if (isCanceled(err) || handleAuthFailure(err)) return;
      if (mode !== 'head') setError(describeApiError(err, 'Could not load the audit trail.'));
    } finally {
      if (abortRef.current === ctrl) { setLoading(false); setLoadingMore(false); }
    }
  }, [buildParams]);

  // Switching to the tab, or changing a filter → first page.
  useEffect(() => {
    if (!isActive) return undefined;
    load('replace');
    return () => abortRef.current?.abort();
  }, [isActive, load]);

  // While the tab is open, pick up new entries without losing loaded pages.
  useEffect(() => {
    if (!isActive) return undefined;
    const id = setInterval(() => load('head'), AUDIT_POLL_MS);
    return () => clearInterval(id);
  }, [isActive, load]);

  const fetchForExport = useCallback(async () => {
    const { data } = await apiClient.get('/admin/audit-logs', { params: buildParams({ limit: AUDIT_EXPORT_MAX }) });
    return Array.isArray(data?.logs) ? data.logs : [];
  }, [buildParams]);

  const setFilter = useCallback((key, value) => setFilters((p) => ({ ...p, [key]: value })), []);
  const clearFilters = useCallback(() => { setFilters(EMPTY_AUDIT_FILTERS); setApplied(EMPTY_AUDIT_FILTERS); }, []);
  const activeFilterCount = [filters.action, filters.from, filters.to].filter(Boolean).length;
  const hasFilters = activeFilterCount > 0 || Boolean(filters.search);

  return {
    filters, setFilter, clearFilters, hasFilters, activeFilterCount,
    logs, total, actions, nextCursor, loading, loadingMore, error,
    refresh: () => load('replace'),
    loadMore: () => nextCursor && load('append', nextCursor),
    fetchForExport,
  };
}

// ─── Primitives ───────────────────────────────────────────────────────────────
// Touch targets are 44–48px on phones and tighten from 640px up.

const BTN_BASE = 'ui-btn inline-flex items-center justify-center gap-2 rounded-xl text-sm font-bold';
const BTN_SIZES = {
  md:   'h-11 px-4 sm:h-10',
  sm:   'h-10 px-3 text-xs sm:h-9',
  lg:   'h-12 px-5 text-base',
  icon: 'h-11 w-11 sm:h-10 sm:w-10',
};
const BTN_VARIANTS = {
  default: 'b-default', primary: 'b-primary', danger: 'b-danger', dangerSolid: 'b-dangersolid', ghost: 'b-ghost',
};

function Btn({ variant = 'default', size = 'md', className = '', type = 'button', children, ...rest }) {
  return <button type={type} className={`${BTN_BASE} ${BTN_SIZES[size]} ${BTN_VARIANTS[variant]} ${className}`} {...rest}>{children}</button>;
}

function Card({ className = '', children, ...rest }) {
  return <section className={`ui-card rounded-2xl ${className}`} {...rest}>{children}</section>;
}

function Chip({ tone = 'muted', children }) {
  return (
    <span className={`chip-${tone} inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-bold`}>
      {children}
    </span>
  );
}

function Spinner({ className = 'h-4 w-4' }) {
  return <span className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent ${className}`} role="status" aria-label="Loading" />;
}

function Avatar({ children, tone = 'primary' }) {
  return <span className={`chip-${tone} flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm font-extrabold`}>{children}</span>;
}

function SearchBox({ value, onChange, placeholder, ariaLabel }) {
  return (
    <div className="relative min-w-0 flex-1">
      <span className="c-muted pointer-events-none absolute inset-y-0 left-3.5 flex items-center"><Icon name="search" /></span>
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={ariaLabel}
        className="ui-input h-12 w-full rounded-xl pl-11 pr-11 font-medium md:h-11" />
      {value && (
        <button type="button" onClick={() => onChange('')} aria-label="Clear search"
          className="c-muted absolute inset-y-0 right-0 flex w-11 items-center justify-center"><Icon name="x" className="h-4 w-4" /></button>
      )}
    </div>
  );
}

function Field({ label, required, error, hint, action, children }) {
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <label className="text-sm font-bold">{label}{required && <span className="c-bad ml-0.5" aria-hidden="true">*</span>}</label>
        {action}
      </div>
      {children}
      {hint && !error && <p className="c-muted mt-1.5 text-xs font-medium">{hint}</p>}
      {error && <p role="alert" className="c-bad mt-1.5 text-xs font-semibold">{error}</p>}
    </div>
  );
}

function Notice({ tone = 'bad', children }) {
  return (
    <div role={tone === 'bad' ? 'alert' : undefined} className={`chip-${tone} flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold`}>
      <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}

function EmptyState({ icon = 'inbox', title, children }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <span className="chip-muted mb-3 flex h-14 w-14 items-center justify-center rounded-full"><Icon name={icon} className="h-6 w-6" /></span>
      <p className="font-bold">{title}</p>
      {children && <p className="c-muted mt-1 max-w-xs text-sm">{children}</p>}
    </div>
  );
}

function PageTitle({ title, subtitle, children }) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-extrabold tracking-tight">{title}</h1>
        {subtitle && <p className="c-muted text-sm font-medium">{subtitle}</p>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
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

function RoleChip({ role }) {
  return <Chip tone={ROLE_TONE[role] ?? 'muted'}>{role ?? 'UNKNOWN'}</Chip>;
}

function VanStatusChip({ status }) {
  const meta = VAN_STATUS_META[status];
  return <Chip tone={meta?.tone ?? 'muted'}>{meta?.label ?? status ?? 'Unknown'}</Chip>;
}

function AuditActionChip({ action }) {
  const key = (action ?? '').toUpperCase();
  const tone =
    /DELETE|REJECT/.test(key) ? 'bad'
    : /DISABLE/.test(key) ? 'warn'
    : /CREATE|APPROVE|ENABLE/.test(key) ? 'ok'
    : /UPDATE/.test(key) ? 'info'
    : /LOGIN|LOGOUT/.test(key) ? 'violet'
    : 'muted';
  return <Chip tone={tone}>{(action ?? 'UNKNOWN').replace(/_/g, ' ')}</Chip>;
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };
  return <Btn size="sm" onClick={copy}><Icon name={copied ? 'check' : 'copy'} className="h-4 w-4" /> {copied ? 'Copied' : 'Copy code'}</Btn>;
}

// ─── Bottom sheet ─────────────────────────────────────────────────────────────
// Phones: slides up from the bottom, drag the handle down to dismiss.
// 768px and up: a centred dialog. `footer` stays pinned above the home bar.

function Sheet({ open, onClose, locked = false, title, subtitle, footer, wide = false, children }) {
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
      style={{ background: 'var(--scrim)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget && !locked) onClose(); }}>
      <div className={`sheet-panel flex w-full min-w-0 flex-col rounded-t-2xl md:rounded-2xl ${wide ? 'md:max-w-2xl' : 'md:max-w-md'}`}
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

function StaffSheet({ open, onClose, onSubmit, isLoading, serverError, onClearError }) {
  const [form, setForm]     = useState(EMPTY_STAFF_FORM);
  const [errors, setErrors] = useState({});
  const [showPin, setShowPin] = useState(false);
  const nameRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    setForm(EMPTY_STAFF_FORM);
    setErrors({});
    setShowPin(false);
    onClearError();
    // Skip auto-focus on touch screens so the keyboard doesn't cover the sheet.
    const fine = window.matchMedia?.('(pointer: fine)').matches;
    const id = setTimeout(() => { if (fine) nameRef.current?.focus(); }, 80);
    return () => clearTimeout(id);
  }, [open, onClearError]);

  const change = (e) => {
    const { name, value } = e.target;
    setForm((p) => ({ ...p, [name]: value }));
    setErrors((p) => ({ ...p, [name]: '' }));
    if (serverError) onClearError();
  };

  const generate = () => {
    setForm((p) => ({ ...p, password: generateRandomPassword() }));
    setErrors((p) => ({ ...p, password: '' }));
    setShowPin(true);
    if (serverError) onClearError();
  };

  const submit = () => {
    const e = {};
    const name = form.name.trim();
    const email = form.email.trim();
    if (!name) e.name = 'Full name is required.';
    else if (name.length > 100) e.name = 'Name must be 100 characters or fewer.';
    if (!form.role) e.role = 'Role is required.';
    if (!email) e.email = 'Email address is required.';
    else if (!EMAIL_RE.test(email)) e.email = 'Enter a valid email address.';
    if (!form.password) e.password = 'A PIN is required.';
    else if (form.password.length < PASSWORD_MIN) e.password = `PIN must be at least ${PASSWORD_MIN} characters.`;
    if (Object.keys(e).length) { setErrors(e); return; }
    onSubmit({ name, role: form.role, email, password: form.password });
  };

  return (
    <Sheet open={open} onClose={onClose} locked={isLoading} title="Add staff" subtitle="Admins and dispatchers. Drivers sign up on their own."
      footer={<Btn variant="primary" size="lg" className="w-full" onClick={submit} disabled={isLoading}>{isLoading ? <><Spinner /> Creating…</> : 'Create account'}</Btn>}>
      <div className="space-y-4 pt-1">
        {serverError && <Notice>{serverError}</Notice>}
        <Field label="Full name" required error={errors.name}>
          <input ref={nameRef} name="name" value={form.name} onChange={change} placeholder="e.g. Juan dela Cruz" autoComplete="name" maxLength={100}
            className={`ui-input h-12 w-full rounded-xl px-3.5 font-medium ${errors.name ? 'invalid' : ''}`} />
        </Field>
        <Field label="Role" required error={errors.role}>
          <select name="role" value={form.role} onChange={change} className={`ui-input h-12 w-full rounded-xl px-3.5 font-medium ${errors.role ? 'invalid' : ''}`}>
            <option value="">Select a role</option>
            <option value="ADMIN">Admin</option>
            <option value="DISPATCHER">Dispatcher</option>
          </select>
        </Field>
        <Field label="Email address" required error={errors.email}>
          <input name="email" type="email" inputMode="email" value={form.email} onChange={change} placeholder="staff@terminal.gov.ph" autoComplete="email" autoCapitalize="none"
            className={`ui-input h-12 w-full rounded-xl px-3.5 font-medium ${errors.email ? 'invalid' : ''}`} />
        </Field>
        <Field label="PIN" required error={errors.password} hint={`At least ${PASSWORD_MIN} characters. The generator avoids obvious patterns.`}
          action={<button type="button" onClick={generate} className="c-info inline-flex h-8 items-center gap-1 text-xs font-bold"><Icon name="dice" className="h-4 w-4" /> Generate</button>}>
          <div className="relative">
            <input name="password" type={showPin ? 'text' : 'password'} value={form.password} onChange={change} placeholder="Enter a PIN" autoComplete="new-password" maxLength={128}
              className={`ui-input h-12 w-full rounded-xl pl-3.5 pr-12 font-medium ${errors.password ? 'invalid' : ''}`} />
            <button type="button" onClick={() => setShowPin((v) => !v)} aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
              className="c-muted absolute inset-y-0 right-0 flex w-12 items-center justify-center"><Icon name={showPin ? 'eyeOff' : 'eye'} /></button>
          </div>
        </Field>
      </div>
    </Sheet>
  );
}

function ApplicationSheet({ app, onClose, onApprove, onReject, approving, rejecting, error }) {
  const [step, setStep] = useState('review');
  const [reason, setReason] = useState('');
  useEffect(() => { setStep('review'); setReason(''); }, [app?.id]);

  const footer = !app ? null : step === 'review' ? (
    <div className="grid grid-cols-2 gap-3">
      <Btn variant="danger" size="lg" onClick={() => setStep('reject')} disabled={approving}>Reject</Btn>
      <Btn variant="primary" size="lg" onClick={() => onApprove(app)} disabled={approving}>{approving ? <Spinner /> : <Icon name="check" />} Approve</Btn>
    </div>
  ) : (
    <div className="grid grid-cols-2 gap-3">
      <Btn size="lg" onClick={() => setStep('review')} disabled={rejecting}>Back</Btn>
      <Btn variant="dangerSolid" size="lg" onClick={() => onReject(app, reason)} disabled={rejecting}>{rejecting ? <Spinner /> : null} Confirm reject</Btn>
    </div>
  );

  return (
    <Sheet open={Boolean(app)} onClose={onClose} locked={approving || rejecting} title={app?.name ?? ''} subtitle="Driver application" footer={footer}>
      {app && (
        <div className="space-y-4">
          {error && <Notice>{error}</Notice>}
          {step === 'review' ? (
            <>
              {app.licensePhotoUrl ? (
                <img src={app.licensePhotoUrl} alt={`${app.name}'s driver's license`} className="ui-soft max-h-72 w-full rounded-2xl object-contain" />
              ) : (
                <div className="ui-soft c-muted flex h-32 items-center justify-center rounded-2xl text-sm font-semibold">No license photo uploaded</div>
              )}
              <dl>
                <DetailRow label="Driver ID">{app.driverId ?? '—'}</DetailRow>
                <DetailRow label="Van plate"><span className="num">{app.assignedVan?.plateNumber ?? '—'}</span></DetailRow>
                <DetailRow label="Contact">{app.contactNumber || '—'}</DetailRow>
                <DetailRow label="Applied">{formatTimestamp(app.createdAt)}</DetailRow>
              </dl>
            </>
          ) : (
            <>
              <p className="c-muted text-sm font-medium">
                <strong style={{ color: 'var(--text)' }}>{app.name}</strong>'s application will be rejected and the van they registered will be removed. A reason is optional.
              </p>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" rows={4} maxLength={300}
                className="ui-input w-full rounded-xl px-3.5 py-3 font-medium" />
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}

function VanSheet({ van, onClose, onDelete }) {
  const driverName = van?.driver?.name ?? van?.driverName;
  return (
    <Sheet open={Boolean(van)} onClose={onClose} title={van?.plateNumber ?? ''} subtitle="Registered van"
      footer={van && <Btn variant="danger" size="lg" className="w-full" onClick={() => onDelete(van)}><Icon name="trash" /> Remove van</Btn>}>
      {van && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="ui-soft rounded-2xl p-4">
              <p className="num text-4xl">{van.capacity ?? 0}</p>
              <p className="c-muted text-sm font-semibold">seats</p>
            </div>
            <div className="ui-soft flex flex-col justify-between rounded-2xl p-4">
              <p className="c-muted text-sm font-semibold">Status</p>
              <div><VanStatusChip status={van.status} /></div>
            </div>
          </div>
          <dl><DetailRow label="Driver">{driverName ?? 'Unassigned'}</DetailRow></dl>
          <div className="space-y-3 text-center">
            {van.qrToken ? (
              <>
                <div className="mx-auto inline-block max-w-full rounded-2xl p-4" style={{ background: '#FFFFFF', boxShadow: 'inset 0 0 0 1.5px #E4E7EC' }}>
                  <QRCodeSVG value={van.qrToken} size={184} bgColor="#FFFFFF" fgColor="#0B1220" style={{ maxWidth: '100%', height: 'auto' }} />
                </div>
                <p className="c-muted text-xs font-medium">Terminal scan code. It never changes, so reprint it if the sticker is lost.</p>
                <CopyButton text={van.qrToken} />
              </>
            ) : (
              <Notice tone="warn">The server did not return a QR token for this van.</Notice>
            )}
          </div>
        </div>
      )}
    </Sheet>
  );
}

function UserSheet({ user, onClose, onToggle, onDelete, toggling }) {
  const rejected = user?.role === 'DRIVER' && user?.approvalStatus === 'REJECTED';
  return (
    <Sheet open={Boolean(user)} onClose={onClose} locked={toggling} title={user?.name ?? ''} subtitle="Account"
      footer={user && (
        <div className={`grid gap-3 ${rejected ? 'grid-cols-1' : 'grid-cols-2'}`}>
          {!rejected && (
            <Btn size="lg" onClick={() => onToggle(user)} disabled={toggling}>
              {toggling ? <Spinner /> : null} {user.isActive ? 'Disable' : 'Enable'}
            </Btn>
          )}
          <Btn variant="danger" size="lg" onClick={() => onDelete(user)} disabled={toggling}><Icon name="trash" /> Delete</Btn>
        </div>
      )}>
      {user && (
        <dl>
          <DetailRow label="Role"><RoleChip role={user.role} /></DetailRow>
          <DetailRow label="Status">{rejected ? <Chip tone="bad">Rejected</Chip> : <Chip tone={user.isActive ? 'ok' : 'muted'}>{user.isActive ? 'Active' : 'Disabled'}</Chip>}</DetailRow>
          {user.email && <DetailRow label="Email">{user.email}</DetailRow>}
          {user.driverId && <DetailRow label="Driver ID">{user.driverId}</DetailRow>}
          {user.assignedVan?.plateNumber && <DetailRow label="Van"><span className="num">{user.assignedVan.plateNumber}</span></DetailRow>}
          <DetailRow label="Contact">{user.contactNumber || '—'}</DetailRow>
        </dl>
      )}
    </Sheet>
  );
}

function ConfirmDeleteSheet({ target, onClose, onConfirm, isLoading, serverError }) {
  const isVan = target?.kind === 'van';
  return (
    <Sheet open={Boolean(target)} onClose={onClose} locked={isLoading} title={isVan ? 'Remove this van?' : 'Delete this account?'}
      footer={target && (
        <div className="grid grid-cols-2 gap-3">
          <Btn size="lg" onClick={onClose} disabled={isLoading}>Cancel</Btn>
          <Btn variant="dangerSolid" size="lg" onClick={onConfirm} disabled={isLoading}>{isLoading ? <Spinner /> : <Icon name="trash" />} {isVan ? 'Remove' : 'Delete'}</Btn>
        </div>
      )}>
      {target && (
        <div className="space-y-4">
          <div className="ui-soft flex items-center justify-between gap-3 rounded-2xl p-4">
            <div className="min-w-0">
              <p className="break-all text-lg font-extrabold">{target.label}</p>
              {isVan && <p className="c-muted text-sm font-medium">{target.sublabel}</p>}
            </div>
            {!isVan && <RoleChip role={target.role} />}
          </div>
          {target.role === 'ADMIN' && <Notice tone="warn">This is an admin account. At least one other admin must remain.</Notice>}
          <p className="c-muted text-sm font-medium">
            This is permanent. {isVan ? 'The van can no longer be assigned to trips.' : "The account's data is removed. If the person has trips on record, disable the account instead."}
          </p>
          {serverError && <Notice>{serverError}</Notice>}
        </div>
      )}
    </Sheet>
  );
}

function AuditEntrySheet({ entry, onClose }) {
  return (
    <Sheet open={Boolean(entry)} onClose={onClose} title="Audit entry" subtitle={entry ? formatTimestamp(entry.timestamp) : ''}>
      {entry && (
        <dl>
          <DetailRow label="Action"><AuditActionChip action={entry.action} /></DetailRow>
          <DetailRow label="Actor">{entry.actorName ?? 'System'}</DetailRow>
          <DetailRow label="Target">{auditTarget(entry)}</DetailRow>
          <DetailRow label="Details">{entry.details ?? '—'}</DetailRow>
        </dl>
      )}
    </Sheet>
  );
}

function AuditFiltersSheet({ open, onClose, trail }) {
  const { filters, setFilter, actions, activeFilterCount } = trail;
  return (
    <Sheet open={open} onClose={onClose} title="Filters" subtitle="Narrow the audit trail"
      footer={
        <div className="grid grid-cols-2 gap-3">
          <Btn size="lg" onClick={trail.clearFilters} disabled={!trail.hasFilters}>Clear all</Btn>
          <Btn variant="primary" size="lg" onClick={onClose}>Show results{activeFilterCount ? ` (${trail.total})` : ''}</Btn>
        </div>
      }>
      <div className="space-y-4 pt-1">
        <Field label="Action">
          <select value={filters.action} onChange={(e) => setFilter('action', e.target.value)} className="ui-input h-12 w-full rounded-xl px-3.5 font-medium">
            <option value="">All actions</option>
            {actions.map((a) => <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From">
            <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilter('from', e.target.value)} className="ui-input h-12 w-full min-w-0 rounded-xl px-3 font-medium" />
          </Field>
          <Field label="To">
            <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilter('to', e.target.value)} className="ui-input h-12 w-full min-w-0 rounded-xl px-3 font-medium" />
          </Field>
        </div>
      </div>
    </Sheet>
  );
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function BottomNav({ tab, onChange, pendingCount }) {
  return (
    <nav className="ui-nav fixed inset-x-0 bottom-0 z-40 md:hidden" aria-label="Sections">
      <ul className="mx-auto grid max-w-lg grid-cols-5">
        {TABS.map((t) => {
          const on = tab === t.id;
          return (
            <li key={t.id}>
              <button type="button" onClick={() => onChange(t.id)} aria-current={on ? 'page' : undefined}
                className={`relative flex min-h-[58px] w-full flex-col items-center justify-center gap-0.5 text-[11px] font-bold ${on ? 'c-primary' : 'c-muted'}`}>
                {on && <span className="absolute top-0 h-[3px] w-8 rounded-b-full" style={{ background: 'var(--primary)' }} />}
                <span className="relative">
                  <Icon name={t.icon} className="h-6 w-6" />
                  {t.id === 'applications' && pendingCount > 0 && (
                    <span className="absolute -right-2.5 -top-1.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-extrabold"
                      style={{ background: 'var(--bad-solid)', color: 'var(--on-bad)' }}>{pendingCount}</span>
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

function TopTabs({ tab, onChange, pendingCount }) {
  return (
    <nav className="ui-line hidden border-t md:block" aria-label="Sections">
      <ul className="mx-auto flex max-w-5xl gap-1 px-4 py-2">
        {TABS.map((t) => {
          const on = tab === t.id;
          return (
            <li key={t.id}>
              <button type="button" onClick={() => onChange(t.id)} aria-current={on ? 'page' : undefined}
                className={`inline-flex h-10 items-center gap-2 rounded-xl px-4 text-sm font-bold ${on ? 'chip-primary' : 'c-muted ui-row'}`}>
                <Icon name={t.icon} className="h-[18px] w-[18px]" /> {t.label}
                {t.id === 'applications' && pendingCount > 0 && (
                  <span className="rounded-full px-1.5 text-[11px] font-extrabold" style={{ background: 'var(--bad-solid)', color: 'var(--on-bad)' }}>{pendingCount}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ─── Tab views ────────────────────────────────────────────────────────────────

function StatTile({ icon, label, value, tone }) {
  return (
    <Card className="p-4">
      <span className={`chip-${tone} flex h-10 w-10 items-center justify-center rounded-xl`}><Icon name={icon} /></span>
      <p className="num mt-3 text-4xl leading-none">{value ?? 0}</p>
      <p className="c-muted mt-1.5 text-sm font-semibold">{label}</p>
    </Card>
  );
}

function OverviewTab({ data, pendingCount, fleetCounts, onGo, onAddStaff }) {
  return (
    <div className="space-y-4">
      <PageTitle title="Overview" subtitle="Catanduanes terminal at a glance" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile icon="van" label="Active trips" value={data.stats.activeTrips} tone="ok" />
        <StatTile icon="van" label="Registered vans" value={data.stats.totalVans} tone="info" />
        <StatTile icon="users" label="System users" value={data.stats.totalUsers} tone="violet" />
        <StatTile icon="clock" label="Pending approvals" value={pendingCount} tone="warn" />
      </div>

      {pendingCount > 0 && (
        <Card className="flex items-center gap-3 p-4">
          <span className="chip-warn flex h-11 w-11 shrink-0 items-center justify-center rounded-full"><Icon name="inbox" /></span>
          <div className="min-w-0 flex-1">
            <p className="font-extrabold"><span className="num">{pendingCount}</span> driver {pendingCount === 1 ? 'application' : 'applications'} waiting</p>
            <p className="c-muted text-sm font-medium">Approve to let them log in.</p>
          </div>
          <Btn variant="primary" size="sm" onClick={() => onGo('applications')}>Review</Btn>
        </Card>
      )}

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-bold">Fleet right now</h2>
        <div className="grid grid-cols-3 gap-3">
          {Object.entries(VAN_STATUS_META).map(([key, meta]) => (
            <div key={key} className="ui-soft rounded-xl p-3 text-center">
              <p className={`num text-3xl c-${meta.tone}`}>{fleetCounts[key] ?? 0}</p>
              <p className="c-muted mt-0.5 text-xs font-bold">{meta.label}</p>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        <Btn variant="primary" size="lg" onClick={onAddStaff}><Icon name="plus" /> Add staff</Btn>
        <Btn size="lg" onClick={() => onGo('audit')}><Icon name="list" /> View audit trail</Btn>
      </div>
    </div>
  );
}

function ApplicationsTab({ drivers, loading, error, onOpen }) {
  return (
    <div className="space-y-4">
      <PageTitle title="Driver approvals" subtitle={`${drivers.length} waiting for review`} />
      <Card className="overflow-hidden">
        {loading ? (
          <p className="c-muted flex items-center justify-center gap-2 py-12 text-sm font-semibold"><Spinner /> Loading applications…</p>
        ) : error ? (
          <div className="p-4"><Notice>{error}</Notice></div>
        ) : drivers.length === 0 ? (
          <EmptyState icon="check" title="All caught up">No applications are waiting for review.</EmptyState>
        ) : (
          <ul className="ui-divide">
            {drivers.map((d) => (
              <ListRow key={d.id} onClick={() => onOpen(d.id)} ariaLabel={`Review ${d.name}'s application`}
                leading={d.licensePhotoUrl
                  ? <img src={d.licensePhotoUrl} alt="" className="h-11 w-11 shrink-0 rounded-xl object-cover" />
                  : <Avatar tone="warn">{initials(d.name)}</Avatar>}
                title={d.name}
                subtitle={`Van ${d.assignedVan?.plateNumber ?? '—'} · ${formatTimestamp(d.createdAt)}`}
                trailing={<Chip tone="warn">Pending</Chip>} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function VansTab({ vans, search, onSearch, totalCount, onOpen }) {
  return (
    <div className="space-y-4">
      <PageTitle title="Vans" subtitle={`${totalCount} registered. Drivers add their own van when they sign up.`} />
      {totalCount > 0 && <div className="flex"><SearchBox value={search} onChange={onSearch} placeholder="Search plate, driver, status" ariaLabel="Search vans" /></div>}
      <Card className="overflow-hidden">
        {vans.length === 0 ? (
          <EmptyState icon="van" title={totalCount === 0 ? 'No vans yet' : 'No matches'}>
            {totalCount === 0 ? 'Vans appear here once drivers register.' : 'Try a different search.'}
          </EmptyState>
        ) : (
          <ul className="ui-divide">
            {vans.map((v) => {
              const driverName = v.driver?.name ?? v.driverName;
              return (
                <ListRow key={v.id} onClick={() => onOpen(v.id)} ariaLabel={`Open ${v.plateNumber}`}
                  leading={<Avatar tone="info"><Icon name="van" /></Avatar>}
                  title={v.plateNumber ?? '—'}
                  subtitle={driverName ?? 'No driver'}
                  trailing={
                    <span className="flex flex-col items-end gap-1">
                      <span className="num text-lg leading-none">{v.capacity ?? 0}<span className="c-muted ml-0.5 text-xs font-bold">seats</span></span>
                      <VanStatusChip status={v.status} />
                    </span>
                  } />
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

function UsersTab({ users, search, onSearch, totalCount, onOpen, onAdd }) {
  return (
    <div className="space-y-4">
      <PageTitle title="Users & drivers" subtitle={`${totalCount} accounts`}>
        <Btn variant="primary" size="sm" onClick={onAdd}><Icon name="plus" className="h-4 w-4" /> Add staff</Btn>
      </PageTitle>
      {totalCount > 0 && <div className="flex"><SearchBox value={search} onChange={onSearch} placeholder="Search name, email, role" ariaLabel="Search users" /></div>}
      <Card className="overflow-hidden">
        {users.length === 0 ? (
          <EmptyState icon="users" title={totalCount === 0 ? 'No accounts yet' : 'No matches'}>
            {totalCount === 0 ? 'Use Add staff to create an admin or dispatcher.' : 'Try a different search.'}
          </EmptyState>
        ) : (
          <ul className="ui-divide">
            {users.map((u) => {
              const rejected = u.role === 'DRIVER' && u.approvalStatus === 'REJECTED';
              return (
                <ListRow key={u.id} onClick={() => onOpen(u.id)} ariaLabel={`Open ${u.name}`}
                  leading={<Avatar tone={ROLE_TONE[u.role] ?? 'muted'}>{initials(u.name)}</Avatar>}
                  title={u.name ?? 'Unnamed'}
                  subtitle={u.email || u.driverId || '—'}
                  trailing={
                    <span className="flex flex-col items-end gap-1">
                      <RoleChip role={u.role} />
                      {rejected ? <Chip tone="bad">Rejected</Chip> : <Chip tone={u.isActive ? 'ok' : 'muted'}>{u.isActive ? 'Active' : 'Disabled'}</Chip>}
                    </span>
                  } />
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

function AuditTab({ trail, onOpenEntry, onOpenFilters, onExport, exporting }) {
  const { logs, total, loading, loadingMore, error, nextCursor, filters, setFilter, hasFilters, activeFilterCount } = trail;
  const emptyTitle = loading ? 'Loading…' : hasFilters ? 'No entries match' : 'Nothing recorded yet';
  const emptyText = loading ? '' : hasFilters ? 'Try different filters.' : 'Admin actions appear here as they happen.';

  return (
    <div className="space-y-4">
      <PageTitle title="Audit trail" subtitle={`${total} ${total === 1 ? 'entry' : 'entries'}${hasFilters ? ' match' : ''}`}>
        <Btn size="icon" onClick={trail.refresh} disabled={loading} aria-label="Refresh audit trail">{loading ? <Spinner /> : <Icon name="refresh" />}</Btn>
        <Btn size="icon" onClick={onExport} disabled={exporting || total === 0} aria-label="Export CSV">{exporting ? <Spinner /> : <Icon name="download" />}</Btn>
      </PageTitle>

      <div className="flex gap-2">
        <SearchBox value={filters.search} onChange={(v) => setFilter('search', v)} placeholder="Search actor, action, target" ariaLabel="Search audit trail" />
        <Btn onClick={onOpenFilters} className="relative h-12 shrink-0 md:h-11" aria-label="Open filters">
          <Icon name="filter" /> <span className="hidden sm:inline">Filters</span>
          {activeFilterCount > 0 && (
            <span className="num absolute -right-1.5 -top-1.5 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1 text-[11px]"
              style={{ background: 'var(--primary)', color: 'var(--on-primary)' }}>{activeFilterCount}</span>
          )}
        </Btn>
      </div>

      {error && <Notice tone="warn">{error}</Notice>}

      <Card className="overflow-hidden">
        {logs.length === 0 ? (
          loading ? <p className="c-muted flex items-center justify-center gap-2 py-12 text-sm font-semibold"><Spinner /> Loading audit trail…</p>
                  : <EmptyState icon="list" title={emptyTitle}>{emptyText}</EmptyState>
        ) : (
          <ul className="ui-divide">
            {logs.map((e) => (
              <li key={e.id}>
                <button type="button" onClick={() => onOpenEntry(e)}
                  className="ui-row block w-full px-4 py-3 text-left md:grid md:grid-cols-[9.5rem_9rem_11rem_minmax(0,1fr)] md:items-center md:gap-4">
                  <div className="flex items-start justify-between gap-2 md:contents">
                    <span className="md:order-3"><AuditActionChip action={e.action} /></span>
                    <span className="c-muted text-xs font-semibold md:order-1">{formatTimestamp(e.timestamp)}</span>
                  </div>
                  <p className="mt-1.5 font-bold md:order-2 md:mt-0">{e.actorName ?? 'System'}</p>
                  <div className="min-w-0 md:order-4">
                    <p className="truncate text-sm font-semibold">{auditTarget(e)}</p>
                    {e.details && <p className="c-muted truncate text-xs font-medium">{e.details}</p>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {nextCursor && (
        <Btn className="w-full" onClick={trail.loadMore} disabled={loadingMore}>
          {loadingMore ? <><Spinner /> Loading…</> : <>Load more <span className="num">({Math.max(total - logs.length, 0)})</span></>}
        </Btn>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminDashboard() {
  const [theme, toggleTheme] = useTheme();
  const [tab, setTab] = useState('overview');

  const [data, setData]               = useState(EMPTY_DATA);
  const [loading, setLoading]         = useState(true);
  const [fetchError, setFetchError]   = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [loggingOut, setLoggingOut]   = useState(false);

  const [staffOpen, setStaffOpen]     = useState(false);
  const [staffSaving, setStaffSaving] = useState(false);
  const [staffError, setStaffError]   = useState('');
  const [togglingId, setTogglingId]   = useState(null);

  const [vanId, setVanId]   = useState(null);
  const [userId, setUserId] = useState(null);
  const [appId, setAppId]   = useState(null);
  const [vanSearch, setVanSearch]     = useState('');
  const [staffSearch, setStaffSearch] = useState('');

  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting]           = useState(false);
  const [deleteError, setDeleteError]     = useState('');

  const [pendingDrivers, setPendingDrivers] = useState([]);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [pendingError, setPendingError]     = useState('');
  const [approving, setApproving]           = useState(false);
  const [rejecting, setRejecting]           = useState(false);
  const [appError, setAppError]             = useState('');

  const [auditEntry, setAuditEntry]     = useState(null);
  const [filtersOpen, setFiltersOpen]   = useState(false);
  const [exporting, setExporting]       = useState(false);
  const trail = useAuditTrail(tab === 'audit');

  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const showToast = useCallback((type, message) => {
    clearTimeout(toastTimer.current);
    setToast({ type, message });
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);
  useEffect(() => { window.scrollTo({ top: 0 }); }, [tab]);

  // ── Data ──
  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      setLoading(true);
      setFetchError('');
      try {
        const { data: raw } = await apiClient.get('/admin/dashboard', { signal: ctrl.signal });
        setData({
          stats: { ...EMPTY_DATA.stats, ...(raw?.stats ?? {}) },
          staff: Array.isArray(raw?.staff) ? raw.staff : Array.isArray(raw?.users) ? raw.users : [],
          vans: Array.isArray(raw?.vans) ? raw.vans : Array.isArray(raw?.fleet) ? raw.fleet : [],
        });
      } catch (err) {
        if (isCanceled(err) || handleAuthFailure(err)) return;
        setFetchError(describeApiError(err, 'Failed to load admin data. Please try again.'));
      } finally {
        setLoading(false);
      }
    })();
    return () => ctrl.abort();
  }, [reloadToken]);

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      setPendingLoading(true);
      setPendingError('');
      try {
        const { data: raw } = await apiClient.get('/admin/drivers/pending', { signal: ctrl.signal });
        setPendingDrivers(Array.isArray(raw) ? raw : []);
      } catch (err) {
        if (isCanceled(err) || handleAuthFailure(err)) return;
        setPendingError(describeApiError(err, 'Failed to load pending driver applications.'));
      } finally {
        setPendingLoading(false);
      }
    })();
    return () => ctrl.abort();
  }, [reloadToken]);

  // ── Actions ──
  const handleLogout = useCallback(async () => {
    setLoggingOut(true);
    try { await apiClient.post('/auth/logout'); } catch (err) { console.error('Logout request failed, logging out locally anyway:', err); }
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.replace('/login');
  }, []);

  const clearStaffError = useCallback(() => setStaffError(''), []);
  const openStaff = useCallback(() => { setStaffError(''); setStaffOpen(true); }, []);
  const closeStaff = useCallback(() => { if (!staffSaving) { setStaffError(''); setStaffOpen(false); } }, [staffSaving]);

  const handleSubmitStaff = useCallback(async (form) => {
    setStaffSaving(true);
    setStaffError('');
    try {
      await apiClient.post('/admin/users', form);
      showToast('success', `${form.name} was added as ${form.role.toLowerCase()}.`);
      setStaffOpen(false);
      reload();
    } catch (err) {
      if (handleAuthFailure(err)) return;
      setStaffError(describeApiError(err, 'Failed to save this account. Check the details and try again.'));
    } finally {
      setStaffSaving(false);
    }
  }, [showToast, reload]);

  const askDeleteUser = useCallback((u) => {
    setUserId(null);
    setDeleteError('');
    setPendingDelete({ kind: 'user', id: u.id, label: u.name ?? 'this user', role: u.role });
  }, []);
  const askDeleteVan = useCallback((v) => {
    setVanId(null);
    setDeleteError('');
    setPendingDelete({ kind: 'van', id: v.id, label: v.plateNumber ?? 'this van', sublabel: `${v.capacity ?? 0} seats · ${VAN_STATUS_META[v.status]?.label ?? v.status ?? 'Unknown'}` });
  }, []);
  const closeDelete = useCallback(() => { if (!deleting) { setDeleteError(''); setPendingDelete(null); } }, [deleting]);

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const isVan = pendingDelete.kind === 'van';
    setDeleting(true);
    setDeleteError('');
    try {
      await apiClient.delete(isVan ? `/admin/vans/${pendingDelete.id}` : `/admin/users/${pendingDelete.id}`);
      showToast('success', isVan ? `${pendingDelete.label} was removed.` : `${pendingDelete.label}'s account was deleted.`);
      setPendingDelete(null);
      reload();
    } catch (err) {
      if (handleAuthFailure(err)) return;
      setDeleteError(describeApiError(err, `Could not delete ${isVan ? 'this van' : 'this account'}.`));
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, showToast, reload]);

  const handleToggleActive = useCallback(async (user) => {
    if (togglingId !== null) return;
    setTogglingId(user.id);
    const next = !user.isActive;
    try {
      await apiClient.patch(`/admin/users/${user.id}`, { isActive: next });
      setData((prev) => ({ ...prev, staff: prev.staff.map((u) => (u.id === user.id ? { ...u, isActive: next } : u)) }));
      showToast('success', `${user.name ?? 'User'} was ${next ? 'enabled' : 'disabled'}.`);
    } catch (err) {
      if (handleAuthFailure(err)) return;
      showToast('error', describeApiError(err, `Could not update ${user.name ?? 'this user'}.`));
    } finally {
      setTogglingId(null);
    }
  }, [togglingId, showToast]);

  const closeApp = useCallback(() => { if (!approving && !rejecting) { setAppId(null); setAppError(''); } }, [approving, rejecting]);

  const handleApproveDriver = useCallback(async (driver) => {
    setApproving(true);
    setAppError('');
    try {
      await apiClient.patch(`/admin/drivers/${driver.id}/approve`);
      setPendingDrivers((prev) => prev.filter((d) => d.id !== driver.id));
      setAppId(null);
      showToast('success', `${driver.name} was approved and can now log in.`);
      reload();
    } catch (err) {
      if (handleAuthFailure(err)) return;
      setAppError(describeApiError(err, `Could not approve ${driver.name}.`));
    } finally {
      setApproving(false);
    }
  }, [showToast, reload]);

  const handleRejectDriver = useCallback(async (driver, reason) => {
    setRejecting(true);
    setAppError('');
    try {
      await apiClient.patch(`/admin/drivers/${driver.id}/reject`, { reason: reason?.trim() || undefined });
      setPendingDrivers((prev) => prev.filter((d) => d.id !== driver.id));
      setAppId(null);
      showToast('success', `${driver.name}'s application was rejected.`);
      reload();
    } catch (err) {
      if (handleAuthFailure(err)) return;
      setAppError(describeApiError(err, 'Could not reject this application.'));
    } finally {
      setRejecting(false);
    }
  }, [showToast, reload]);

  const handleExportAudit = useCallback(async () => {
    setExporting(true);
    try {
      const rows = await trail.fetchForExport();
      if (rows.length === 0) { showToast('error', 'There is nothing to export with the current filters.'); return; }
      const header = ['Time', 'Actor', 'Action', 'Target', 'Details'];
      const body = rows.map((e) => [formatTimestamp(e.timestamp), e.actorName ?? 'System', e.action ?? '', auditTarget(e) === '—' ? '' : auditTarget(e), e.details ?? '']);
      const csv = [header, ...body].map((r) => r.map(toCsvField).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit-trail-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast('success', `Exported ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}.`);
    } catch (err) {
      if (handleAuthFailure(err)) return;
      showToast('error', describeApiError(err, 'Could not export the audit trail.'));
    } finally {
      setExporting(false);
    }
  }, [trail, showToast]);

  // ── Derived ──
  // Pending drivers have their own tab, so they're left out of the users list.
  const staffRows = useMemo(() => data.staff.filter((u) => !(u.role === 'DRIVER' && u.approvalStatus === 'PENDING')), [data.staff]);

  const filteredVans = useMemo(() => {
    const q = vanSearch.trim().toLowerCase();
    if (!q) return data.vans;
    return data.vans.filter((v) => [v.plateNumber, v.status, v.capacity, v.driver?.name ?? v.driverName]
      .some((f) => String(f ?? '').toLowerCase().includes(q)));
  }, [data.vans, vanSearch]);

  const filteredStaff = useMemo(() => {
    const q = staffSearch.trim().toLowerCase();
    if (!q) return staffRows;
    return staffRows.filter((u) => [u.name, u.email, u.driverId, u.contactNumber, u.role]
      .some((f) => String(f ?? '').toLowerCase().includes(q)));
  }, [staffRows, staffSearch]);

  const fleetCounts = useMemo(() => {
    const counts = {};
    data.vans.forEach((v) => { counts[v.status] = (counts[v.status] ?? 0) + 1; });
    return counts;
  }, [data.vans]);

  // Sheets read the live record by id, so they always show the latest data.
  const selectedVan  = data.vans.find((v) => v.id === vanId) ?? null;
  const selectedUser = data.staff.find((u) => u.id === userId) ?? null;
  const selectedApp  = pendingDrivers.find((d) => d.id === appId) ?? null;

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
        <Card className="flex items-center gap-3 px-5 py-4"><Spinner className="c-primary h-5 w-5" /><span className="font-bold">Loading command center…</span></Card>
      </div>,
    );
  }

  if (fetchError) {
    return shell(
      <div className="flex min-h-screen items-center justify-center p-6">
        <Card className="w-full max-w-md space-y-4 p-6 text-center">
          <h1 className="text-xl font-extrabold">Dashboard unavailable</h1>
          <Notice>{fetchError}</Notice>
          <Btn variant="primary" size="lg" className="w-full" onClick={reload}>Retry</Btn>
        </Card>
      </div>,
    );
  }

  return shell(
    <>
      <header className="ui-header sticky top-0 z-30">
        <div className="ui-main mx-auto flex h-14 max-w-5xl items-center gap-3 md:h-16">
          <span className="b-primary flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"><Icon name="van" /></span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-extrabold leading-tight tracking-tight">Terminalink</p>
            <p className="c-muted text-xs font-semibold leading-tight">Command center</p>
          </div>
          <Btn variant="ghost" size="icon" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
          </Btn>
          <Btn onClick={handleLogout} disabled={loggingOut}>
            {loggingOut ? <Spinner /> : <Icon name="logout" className="h-[18px] w-[18px]" />} Logout
          </Btn>
        </div>
        <TopTabs tab={tab} onChange={setTab} pendingCount={pendingDrivers.length} />
      </header>

      <main className="ui-main mx-auto max-w-5xl pb-28 pt-5 md:pb-10">
        {tab === 'overview' && (
          <OverviewTab data={data} pendingCount={pendingDrivers.length} fleetCounts={fleetCounts} onGo={setTab} onAddStaff={openStaff} />
        )}
        {tab === 'applications' && (
          <ApplicationsTab drivers={pendingDrivers} loading={pendingLoading} error={pendingError}
            onOpen={(id) => { setAppError(''); setAppId(id); }} />
        )}
        {tab === 'vans' && (
          <VansTab vans={filteredVans} totalCount={data.vans.length} search={vanSearch} onSearch={setVanSearch} onOpen={setVanId} />
        )}
        {tab === 'users' && (
          <UsersTab users={filteredStaff} totalCount={staffRows.length} search={staffSearch} onSearch={setStaffSearch} onOpen={setUserId} onAdd={openStaff} />
        )}
        {tab === 'audit' && (
          <AuditTab trail={trail} onOpenEntry={setAuditEntry} onOpenFilters={() => setFiltersOpen(true)} onExport={handleExportAudit} exporting={exporting} />
        )}
      </main>

      <BottomNav tab={tab} onChange={setTab} pendingCount={pendingDrivers.length} />

      {toast && (
        <div role="status" aria-live="polite" className="ui-toast-pos pointer-events-none fixed inset-x-0 z-[60] flex justify-center px-4">
          <div className="ui-toast pointer-events-auto flex max-w-md items-center gap-3 rounded-2xl px-4 py-3 text-sm font-bold">
            <Icon name={toast.type === 'success' ? 'check' : 'alert'} className="h-5 w-5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{toast.message}</span>
            <button onClick={() => setToast(null)} aria-label="Dismiss" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg opacity-80"><Icon name="x" className="h-4 w-4" /></button>
          </div>
        </div>
      )}

      <StaffSheet open={staffOpen} onClose={closeStaff} onSubmit={handleSubmitStaff} isLoading={staffSaving} serverError={staffError} onClearError={clearStaffError} />
      <ApplicationSheet app={selectedApp} onClose={closeApp} onApprove={handleApproveDriver} onReject={handleRejectDriver} approving={approving} rejecting={rejecting} error={appError} />
      <VanSheet van={selectedVan} onClose={() => setVanId(null)} onDelete={askDeleteVan} />
      <UserSheet user={selectedUser} onClose={() => setUserId(null)} onToggle={handleToggleActive} onDelete={askDeleteUser} toggling={togglingId === selectedUser?.id} />
      <ConfirmDeleteSheet target={pendingDelete} onClose={closeDelete} onConfirm={handleConfirmDelete} isLoading={deleting} serverError={deleteError} />
      <AuditEntrySheet entry={auditEntry} onClose={() => setAuditEntry(null)} />
      <AuditFiltersSheet open={filtersOpen} onClose={() => setFiltersOpen(false)} trail={trail} />
    </>,
  );
}
