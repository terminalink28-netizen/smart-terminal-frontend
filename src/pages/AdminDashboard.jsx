import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import apiClient from '../api/axios';

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

const THEME_KEY = 'terminalink_admin_theme';

const AUDIT_PAGE_SIZE   = 50;
const AUDIT_EXPORT_MAX  = 5000;
const AUDIT_POLL_MS     = 30_000;
const EMPTY_AUDIT_FILTERS = { search: '', action: '', from: '', to: '' };

const EMAIL_RE     = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN = 4;

// ─── Neumorphic theme ─────────────────────────────────────────────────────────
//
// Every surface shares the page background and is shaped only by a light and a
// dark shadow. Colours come from CSS variables, so the light/dark switch is a
// single data-theme attribute. Text and status colours are chosen for contrast
// first; the soft shadows are decoration, never the only cue.

const THEME_CSS = `
.nm-root{
  --bg:#e2e7ee;--hi:#ffffff;--lo:#b3bfd0;--line:rgba(110,125,150,.28);
  --text:#1b2433;--muted:#4f5b6d;--accent:#0f766e;--on-accent:#ffffff;
  --ok:#047857;--warn:#b45309;--bad:#be123c;--info:#1d4ed8;--violet:#6d28d9;
  --scrim:rgba(27,36,51,.45);
  background:var(--bg);color:var(--text);color-scheme:light;
}
.nm-root[data-theme="dark"]{
  --bg:#20252f;--hi:#2c3441;--lo:#141820;--line:rgba(160,175,200,.16);
  --text:#e8ecf3;--muted:#9ba6b8;--accent:#5eead4;--on-accent:#0b1f1c;
  --ok:#6ee7b7;--warn:#fbbf24;--bad:#fda4af;--info:#93c5fd;--violet:#c4b5fd;
  --scrim:rgba(4,7,11,.68);color-scheme:dark;
}
.nm-root :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.nm-muted{color:var(--muted)}
.nm-line{border-color:var(--line)}
.nm-card{background:var(--bg);box-shadow:9px 9px 18px var(--lo),-9px -9px 18px var(--hi)}
.nm-raised{background:var(--bg);box-shadow:5px 5px 10px var(--lo),-5px -5px 10px var(--hi)}
.nm-inset{background:var(--bg);box-shadow:inset 4px 4px 8px var(--lo),inset -4px -4px 8px var(--hi)}
.nm-chip{background:var(--bg);box-shadow:inset 2px 2px 4px var(--lo),inset -2px -2px 4px var(--hi)}
.nm-btn{background:var(--bg);color:var(--text);box-shadow:5px 5px 10px var(--lo),-5px -5px 10px var(--hi);transition:box-shadow .15s,opacity .15s}
.nm-btn:hover:not(:disabled){box-shadow:3px 3px 6px var(--lo),-3px -3px 6px var(--hi)}
.nm-btn:active:not(:disabled){box-shadow:inset 3px 3px 6px var(--lo),inset -3px -3px 6px var(--hi)}
.nm-btn:disabled{opacity:.5;cursor:not-allowed}
.nm-btn.nm-primary{background:var(--accent);color:var(--on-accent)}
.nm-input{background:var(--bg);color:var(--text);border:1.5px solid transparent;box-shadow:inset 3px 3px 6px var(--lo),inset -3px -3px 6px var(--hi)}
.nm-input::placeholder{color:var(--muted);opacity:.8}
.nm-input:focus{outline:none;border-color:var(--accent)}
.nm-input.nm-invalid{border-color:var(--bad)}
.nm-fill{background:var(--accent)}
.tone-ok{color:var(--ok)}.tone-warn{color:var(--warn)}.tone-bad{color:var(--bad)}
.tone-info{color:var(--info)}.tone-violet{color:var(--violet)}.tone-muted{color:var(--muted)}
.nm-table th{color:var(--muted);font-weight:600;font-size:.75rem}
.nm-table tr+tr td{border-top:1px solid var(--line)}
.nm-table thead tr td,.nm-table thead th{border-bottom:1px solid var(--line)}
`;

// ─── Icons ────────────────────────────────────────────────────────────────────

const ICONS = {
  sun:      'M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4M12 16a4 4 0 100-8 4 4 0 000 8z',
  moon:     'M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z',
  refresh:  'M20 11a8 8 0 00-14.9-3M4 5v4h4M4 13a8 8 0 0014.9 3M20 19v-4h-4',
  logout:   'M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 8l-4 4 4 4M6 12h10',
  search:   'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-4.3-4.3',
  x:        'M6 6l12 12M18 6L6 18',
  plus:     'M12 5v14M5 12h14',
  qr:       'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v6h-4M14 18h2v2h-2z',
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

function Icon({ name, className = 'h-4 w-4' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
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

function useAuditTrail(isOpen) {
  const [filters, setFilters]   = useState(EMPTY_AUDIT_FILTERS);
  const [applied, setApplied]   = useState(EMPTY_AUDIT_FILTERS);
  const [logs, setLogs]         = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [total, setTotal]       = useState(0);
  const [actions, setActions]   = useState([]);
  const [loading, setLoading]   = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError]       = useState('');
  const [lastSync, setLastSync] = useState(null);
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
      setLastSync(new Date().toISOString());
    } catch (err) {
      if (isCanceled(err) || handleAuthFailure(err)) return;
      if (mode !== 'head') setError(describeApiError(err, 'Could not load the audit trail.'));
    } finally {
      if (abortRef.current === ctrl) { setLoading(false); setLoadingMore(false); }
    }
  }, [buildParams]);

  // Open the modal, or change a filter → first page.
  useEffect(() => {
    if (!isOpen) return undefined;
    load('replace');
    return () => abortRef.current?.abort();
  }, [isOpen, load]);

  // While open, pick up new entries without losing the pages already loaded.
  useEffect(() => {
    if (!isOpen) return undefined;
    const id = setInterval(() => load('head'), AUDIT_POLL_MS);
    return () => clearInterval(id);
  }, [isOpen, load]);

  const fetchForExport = useCallback(async () => {
    const { data } = await apiClient.get('/admin/audit-logs', { params: buildParams({ limit: AUDIT_EXPORT_MAX }) });
    return Array.isArray(data?.logs) ? data.logs : [];
  }, [buildParams]);

  const setFilter = useCallback((key, value) => setFilters((p) => ({ ...p, [key]: value })), []);
  const clearFilters = useCallback(() => { setFilters(EMPTY_AUDIT_FILTERS); setApplied(EMPTY_AUDIT_FILTERS); }, []);
  const hasFilters = Boolean(filters.search || filters.action || filters.from || filters.to);

  return {
    filters, setFilter, clearFilters, hasFilters,
    logs, total, actions, nextCursor, loading, loadingMore, error, lastSync,
    refresh: () => load('replace'),
    loadMore: () => nextCursor && load('append', nextCursor),
    fetchForExport,
  };
}

// ─── Primitives ───────────────────────────────────────────────────────────────

const BTN_BASE = 'inline-flex items-center justify-center gap-2 rounded-xl text-sm font-semibold';
function Btn({ variant = 'default', size = 'md', className = '', type = 'button', children, ...rest }) {
  const sizing = size === 'sm' ? 'h-8 px-3 text-xs' : size === 'icon' ? 'h-10 w-10' : 'h-10 px-4';
  const tone = variant === 'primary' ? 'nm-primary' : variant === 'danger' ? 'tone-bad' : variant === 'success' ? 'tone-ok' : '';
  return <button type={type} className={`nm-btn ${BTN_BASE} ${sizing} ${tone} ${className}`} {...rest}>{children}</button>;
}

function Card({ className = '', children, ...rest }) {
  return <section className={`nm-card rounded-2xl ${className}`} {...rest}>{children}</section>;
}

function Chip({ tone = 'muted', children }) {
  return (
    <span className={`nm-chip inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold tone-${tone}`}>
      {children}
    </span>
  );
}

function Spinner({ className = 'h-4 w-4' }) {
  return <span className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent ${className}`} role="status" />;
}

function SearchInput({ value, onChange, placeholder, ariaLabel }) {
  return (
    <div className="relative">
      <span className="nm-muted pointer-events-none absolute inset-y-0 left-3 flex items-center"><Icon name="search" /></span>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={ariaLabel}
        className="nm-input h-10 w-full rounded-xl pl-9 pr-9 text-sm" />
      {value && (
        <button type="button" onClick={() => onChange('')} aria-label="Clear search"
          className="nm-muted absolute inset-y-0 right-2 flex items-center rounded-lg px-1.5"><Icon name="x" className="h-3.5 w-3.5" /></button>
      )}
    </div>
  );
}

function Field({ label, required, error, hint, action, children }) {
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-2">
        <label className="text-sm font-semibold">{label}{required && <span className="tone-bad ml-0.5" aria-hidden="true">*</span>}</label>
        {action}
      </div>
      {children}
      {hint && !error && <p className="nm-muted mt-1.5 text-xs">{hint}</p>}
      {error && <p role="alert" className="tone-bad mt-1.5 text-xs font-medium">{error}</p>}
    </div>
  );
}

function Notice({ tone = 'bad', children }) {
  return (
    <div role={tone === 'bad' ? 'alert' : undefined} className="nm-inset flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm">
      <span className={`tone-${tone} mt-0.5`}><Icon name="alert" /></span>
      <div className="min-w-0 flex-1 font-medium">{children}</div>
    </div>
  );
}

function EmptyRow({ colSpan, children }) {
  return <tr><td colSpan={colSpan} className="nm-muted px-3 py-8 text-center text-sm">{children}</td></tr>;
}

function Modal({ open, onClose, locked = false, size = 'max-w-md', labelledBy, children }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !locked) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, locked, onClose]);

  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-labelledby={labelledBy}
      className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4" style={{ background: 'var(--scrim)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget && !locked) onClose(); }}>
      <div className={`nm-card flex max-h-[95vh] w-full ${size} flex-col rounded-t-2xl sm:max-h-[90vh] sm:rounded-2xl`}>{children}</div>
    </div>
  );
}

function ModalHeader({ id, title, subtitle, onClose, disabled }) {
  return (
    <div className="nm-line flex items-start justify-between gap-3 border-b p-4 sm:p-5">
      <div className="min-w-0">
        <h2 id={id} className="text-base font-bold tracking-tight sm:text-lg">{title}</h2>
        {subtitle && <p className="nm-muted mt-0.5 text-xs">{subtitle}</p>}
      </div>
      <Btn size="icon" onClick={onClose} disabled={disabled} aria-label="Close" className="!h-8 !w-8 shrink-0"><Icon name="x" /></Btn>
    </div>
  );
}

function ThemeToggle({ theme, onToggle }) {
  const dark = theme === 'dark';
  return (
    <Btn size="icon" onClick={onToggle} aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} title={dark ? 'Light mode' : 'Dark mode'}>
      <Icon name={dark ? 'sun' : 'moon'} className="h-[18px] w-[18px]" />
    </Btn>
  );
}

function RoleBadge({ role }) {
  return <Chip tone={ROLE_TONE[role] ?? 'muted'}>{role ?? 'UNKNOWN'}</Chip>;
}

function VanStatusBadge({ status }) {
  const meta = VAN_STATUS_META[status];
  return <Chip tone={meta?.tone ?? 'muted'}>{meta?.label ?? status ?? 'Unknown'}</Chip>;
}

function StatCard({ icon, label, value, tone }) {
  return (
    <Card className="flex items-center gap-4 p-4 sm:p-5">
      <span className={`nm-inset flex h-11 w-11 shrink-0 items-center justify-center rounded-xl tone-${tone}`}><Icon name={icon} className="h-5 w-5" /></span>
      <div className="min-w-0">
        <p className="nm-muted truncate text-xs font-medium">{label}</p>
        <p className="text-2xl font-bold tabular-nums tracking-tight">{value ?? 0}</p>
      </div>
    </Card>
  );
}

function SectionHeader({ title, count, children }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-base font-bold tracking-tight">
        {title}
        {count !== undefined && <Chip>{count}</Chip>}
      </h2>
      {children}
    </div>
  );
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
  return (
    <Btn size="sm" onClick={copy}>
      <Icon name={copied ? 'check' : 'copy'} className="h-3.5 w-3.5" /> {copied ? 'Copied' : 'Copy code'}
    </Btn>
  );
}

function AuditActionBadge({ action }) {
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

// ─── Modals ───────────────────────────────────────────────────────────────────

function StaffFormModal({ isOpen, onClose, onSubmit, isLoading, serverError, onClearError }) {
  const [form, setForm]     = useState(EMPTY_STAFF_FORM);
  const [errors, setErrors] = useState({});
  const [showPin, setShowPin] = useState(false);
  const nameRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    setForm(EMPTY_STAFF_FORM);
    setErrors({});
    setShowPin(false);
    onClearError();
    const id = setTimeout(() => nameRef.current?.focus(), 60);
    return () => clearTimeout(id);
  }, [isOpen, onClearError]);

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
    <Modal open={isOpen} onClose={onClose} locked={isLoading} labelledBy="staff-modal-title">
      <ModalHeader id="staff-modal-title" title="Add staff account" subtitle="Admins and dispatchers. Drivers sign up on their own." onClose={onClose} disabled={isLoading} />
      <div className="space-y-4 overflow-y-auto p-4 sm:p-5">
        {serverError && <Notice>{serverError}</Notice>}
        <Field label="Full name" required error={errors.name}>
          <input ref={nameRef} name="name" value={form.name} onChange={change} placeholder="e.g. Juan dela Cruz" autoComplete="name" maxLength={100}
            className={`nm-input h-11 w-full rounded-xl px-3 text-sm ${errors.name ? 'nm-invalid' : ''}`} />
        </Field>
        <Field label="Role" required error={errors.role}>
          <select name="role" value={form.role} onChange={change} className={`nm-input h-11 w-full rounded-xl px-3 text-sm ${errors.role ? 'nm-invalid' : ''}`}>
            <option value="">Select a role</option>
            <option value="ADMIN">Admin</option>
            <option value="DISPATCHER">Dispatcher</option>
          </select>
        </Field>
        <Field label="Email address" required error={errors.email}>
          <input name="email" type="email" value={form.email} onChange={change} placeholder="staff@terminal.gov.ph" autoComplete="email"
            className={`nm-input h-11 w-full rounded-xl px-3 text-sm ${errors.email ? 'nm-invalid' : ''}`} />
        </Field>
        <Field label="PIN" required error={errors.password} hint={`At least ${PASSWORD_MIN} characters. The generator avoids obvious patterns.`}
          action={<button type="button" onClick={generate} className="tone-info inline-flex items-center gap-1 text-xs font-semibold underline-offset-2 hover:underline"><Icon name="dice" className="h-3.5 w-3.5" /> Generate</button>}>
          <div className="relative">
            <input name="password" type={showPin ? 'text' : 'password'} value={form.password} onChange={change} placeholder="Enter a PIN" autoComplete="new-password" maxLength={128}
              className={`nm-input h-11 w-full rounded-xl pl-3 pr-11 text-sm ${errors.password ? 'nm-invalid' : ''}`} />
            <button type="button" onClick={() => setShowPin((v) => !v)} aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
              className="nm-muted absolute inset-y-0 right-0 flex items-center px-3"><Icon name={showPin ? 'eyeOff' : 'eye'} /></button>
          </div>
        </Field>
      </div>
      <div className="nm-line flex flex-col-reverse gap-3 border-t p-4 sm:flex-row sm:p-5">
        <Btn onClick={onClose} disabled={isLoading} className="flex-1">Cancel</Btn>
        <Btn variant="primary" onClick={submit} disabled={isLoading} className="flex-1">
          {isLoading ? <><Spinner /> Creating…</> : 'Create account'}
        </Btn>
      </div>
    </Modal>
  );
}

function VanQrModal({ van, onClose }) {
  return (
    <Modal open={Boolean(van)} onClose={onClose} size="max-w-sm" labelledBy="qr-title">
      {van && (
        <>
          <ModalHeader id="qr-title" title={van.plateNumber} subtitle="Terminal scan code" onClose={onClose} />
          <div className="space-y-4 overflow-y-auto p-5 text-center">
            {van.qrToken ? (
              <>
                <div className="mx-auto inline-block rounded-2xl p-4" style={{ background: '#ffffff' }}>
                  <QRCodeSVG value={van.qrToken} size={196} bgColor="#ffffff" fgColor="#0f172a" />
                </div>
                <p className="nm-muted text-xs">The same code every time. Reprint it if the sticker is lost or damaged.</p>
                <CopyButton text={van.qrToken} />
              </>
            ) : (
              <Notice tone="warn">The server did not return a QR token for this van.</Notice>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

function LicensePhotoModal({ driver, onClose }) {
  return (
    <Modal open={Boolean(driver)} onClose={onClose} size="max-w-lg" labelledBy="license-title">
      {driver && (
        <>
          <ModalHeader id="license-title" title={driver.name} subtitle="Driver's license" onClose={onClose} />
          <div className="overflow-auto p-4">
            <img src={driver.licensePhotoUrl} alt="Driver's license" className="h-auto w-full rounded-xl" />
          </div>
        </>
      )}
    </Modal>
  );
}

function RejectDriverModal({ target, reason, onReasonChange, onClose, onConfirm, isLoading, serverError }) {
  return (
    <Modal open={Boolean(target)} onClose={onClose} locked={isLoading} size="max-w-sm" labelledBy="reject-title">
      {target && (
        <>
          <ModalHeader id="reject-title" title="Reject application?" onClose={onClose} disabled={isLoading} />
          <div className="space-y-4 p-5">
            <p className="nm-muted text-sm">
              <strong style={{ color: 'var(--text)' }}>{target.name}</strong>'s application will be rejected and the van they registered will be removed. A reason is optional.
            </p>
            <textarea value={reason} onChange={(e) => onReasonChange(e.target.value)} placeholder="Reason (optional)" rows={3} maxLength={300}
              className="nm-input w-full rounded-xl px-3 py-2 text-sm" />
            {serverError && <Notice>{serverError}</Notice>}
          </div>
          <div className="nm-line flex flex-col-reverse gap-3 border-t p-4 sm:flex-row sm:p-5">
            <Btn onClick={onClose} disabled={isLoading} className="flex-1">Cancel</Btn>
            <Btn variant="danger" onClick={onConfirm} disabled={isLoading} className="flex-1">
              {isLoading ? <><Spinner /> Rejecting…</> : 'Reject application'}
            </Btn>
          </div>
        </>
      )}
    </Modal>
  );
}

function ConfirmDeleteModal({ target, onClose, onConfirm, isLoading, serverError }) {
  const isVan = target?.kind === 'van';
  return (
    <Modal open={Boolean(target)} onClose={onClose} locked={isLoading} size="max-w-sm" labelledBy="delete-title">
      {target && (
        <>
          <ModalHeader id="delete-title" title={isVan ? 'Remove van?' : 'Delete account?'} onClose={onClose} disabled={isLoading} />
          <div className="space-y-4 overflow-y-auto p-5">
            <div className="nm-inset rounded-xl px-4 py-3">
              <p className="break-all font-bold">{target.label}</p>
              <div className="mt-1.5">{isVan ? <span className="nm-muted text-xs">{target.sublabel}</span> : <RoleBadge role={target.role} />}</div>
            </div>
            {target.role === 'ADMIN' && <Notice tone="warn">This is an admin account. At least one other admin must remain.</Notice>}
            <p className="nm-muted text-sm">
              This is permanent. {isVan ? 'The van can no longer be assigned to trips.' : "The account's data is removed. If the person has trips on record, disable the account instead."}
            </p>
            {serverError && <Notice>{serverError}</Notice>}
          </div>
          <div className="nm-line flex flex-col-reverse gap-3 border-t p-4 sm:flex-row sm:p-5">
            <Btn onClick={onClose} disabled={isLoading} className="flex-1">Cancel</Btn>
            <Btn variant="danger" onClick={onConfirm} disabled={isLoading} className="flex-1">
              {isLoading ? <><Spinner /> Deleting…</> : isVan ? 'Remove van' : 'Delete account'}
            </Btn>
          </div>
        </>
      )}
    </Modal>
  );
}

function AuditTrailModal({ isOpen, onClose, trail, onExport, exporting }) {
  const { filters, setFilter, clearFilters, hasFilters, logs, total, actions, nextCursor, loading, loadingMore, error, lastSync } = trail;

  return (
    <Modal open={isOpen} onClose={onClose} size="max-w-5xl" labelledBy="audit-title">
      <ModalHeader id="audit-title" title="Audit trail"
        subtitle={`${total} ${total === 1 ? 'entry' : 'entries'}${hasFilters ? ' match your filters' : ''}${lastSync ? ` · updated ${formatTimestamp(lastSync)}` : ''}`}
        onClose={onClose} />

      <div className="nm-line space-y-3 border-b p-4 sm:p-5">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_12rem_auto]">
          <SearchInput value={filters.search} onChange={(v) => setFilter('search', v)} placeholder="Search actor, action, target, details…" ariaLabel="Search audit trail" />
          <select value={filters.action} onChange={(e) => setFilter('action', e.target.value)} aria-label="Filter by action" className="nm-input h-10 rounded-xl px-3 text-sm">
            <option value="">All actions</option>
            {actions.map((a) => <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>)}
          </select>
          <div className="flex items-center gap-2">
            <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilter('from', e.target.value)} aria-label="From date" className="nm-input h-10 min-w-0 flex-1 rounded-xl px-2 text-sm" />
            <span className="nm-muted text-xs">to</span>
            <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilter('to', e.target.value)} aria-label="To date" className="nm-input h-10 min-w-0 flex-1 rounded-xl px-2 text-sm" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Btn size="sm" onClick={trail.refresh} disabled={loading}>{loading ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="refresh" className="h-3.5 w-3.5" />} Refresh</Btn>
          <Btn size="sm" onClick={onExport} disabled={exporting || total === 0}>{exporting ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="download" className="h-3.5 w-3.5" />} Export CSV</Btn>
          {hasFilters && <Btn size="sm" onClick={clearFilters}>Clear filters</Btn>}
        </div>
        {error && <Notice tone="warn">{error}</Notice>}
      </div>

      <div className="flex-1 overflow-auto">
        <table className="nm-table w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr>
              <th className="sticky top-0 px-4 py-3" style={{ background: 'var(--bg)' }}>Time</th>
              <th className="sticky top-0 px-4 py-3" style={{ background: 'var(--bg)' }}>Actor</th>
              <th className="sticky top-0 px-4 py-3" style={{ background: 'var(--bg)' }}>Action</th>
              <th className="sticky top-0 px-4 py-3" style={{ background: 'var(--bg)' }}>Target</th>
              <th className="sticky top-0 px-4 py-3" style={{ background: 'var(--bg)' }}>Details</th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 ? (
              <EmptyRow colSpan={5}>{loading ? 'Loading audit trail…' : hasFilters ? 'No entries match these filters.' : 'Nothing has been recorded yet. Admin actions appear here as they happen.'}</EmptyRow>
            ) : logs.map((entry) => (
              <tr key={entry.id} className="align-top">
                <td className="nm-muted whitespace-nowrap px-4 py-3 text-xs">{formatTimestamp(entry.timestamp)}</td>
                <td className="px-4 py-3 font-semibold">{entry.actorName ?? 'System'}</td>
                <td className="px-4 py-3"><AuditActionBadge action={entry.action} /></td>
                <td className="px-4 py-3">{auditTarget(entry)}</td>
                <td className="nm-muted max-w-xs px-4 py-3 text-xs">{entry.details ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {nextCursor && (
          <div className="p-4 text-center">
            <Btn size="sm" onClick={trail.loadMore} disabled={loadingMore}>
              {loadingMore ? <><Spinner className="h-3.5 w-3.5" /> Loading…</> : `Load more (${Math.max(total - logs.length, 0)} remaining)`}
            </Btn>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminDashboard() {
  const [theme, toggleTheme] = useTheme();

  const [data, setData]               = useState(EMPTY_DATA);
  const [loading, setLoading]         = useState(true);
  const [fetchError, setFetchError]   = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [loggingOut, setLoggingOut]   = useState(false);

  const [isStaffModalOpen, setIsStaffModalOpen] = useState(false);
  const [staffSaving, setStaffSaving] = useState(false);
  const [staffError, setStaffError]   = useState('');
  const [togglingId, setTogglingId]   = useState(null);

  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting]           = useState(false);
  const [deleteError, setDeleteError]     = useState('');

  const [viewingQrVan, setViewingQrVan] = useState(null);
  const [vanSearch, setVanSearch]       = useState('');
  const [staffSearch, setStaffSearch]   = useState('');

  const [pendingDrivers, setPendingDrivers] = useState([]);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [pendingError, setPendingError]     = useState('');
  const [driverActionId, setDriverActionId] = useState(null);
  const [licensePhotoView, setLicensePhotoView] = useState(null);
  const [rejectTarget, setRejectTarget]     = useState(null);
  const [rejectReason, setRejectReason]     = useState('');
  const [rejectSubmitting, setRejectSubmitting] = useState(false);
  const [rejectError, setRejectError]       = useState('');

  const [isAuditOpen, setIsAuditOpen] = useState(false);
  const [exporting, setExporting]     = useState(false);
  const trail = useAuditTrail(isAuditOpen);

  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const showToast = useCallback((type, message) => {
    clearTimeout(toastTimer.current);
    setToast({ type, message });
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

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
  const closeStaffModal = useCallback(() => { if (!staffSaving) { setStaffError(''); setIsStaffModalOpen(false); } }, [staffSaving]);

  const handleSubmitStaff = useCallback(async (form) => {
    setStaffSaving(true);
    setStaffError('');
    try {
      await apiClient.post('/admin/users', form);
      showToast('success', `${form.name} was added as ${form.role.toLowerCase()}.`);
      setIsStaffModalOpen(false);
      reload();
    } catch (err) {
      if (handleAuthFailure(err)) return;
      setStaffError(describeApiError(err, 'Failed to save this account. Check the details and try again.'));
    } finally {
      setStaffSaving(false);
    }
  }, [showToast, reload]);

  const openDeleteUser = useCallback((u) => {
    setDeleteError('');
    setPendingDelete({ kind: 'user', id: u.id, label: u.name ?? 'this user', role: u.role });
  }, []);
  const openDeleteVan = useCallback((v) => {
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

  const handleApproveDriver = useCallback(async (driver) => {
    if (driverActionId !== null) return;
    setDriverActionId(driver.id);
    try {
      await apiClient.patch(`/admin/drivers/${driver.id}/approve`);
      setPendingDrivers((prev) => prev.filter((d) => d.id !== driver.id));
      showToast('success', `${driver.name} was approved and can now log in.`);
      reload();
    } catch (err) {
      if (handleAuthFailure(err)) return;
      showToast('error', describeApiError(err, `Could not approve ${driver.name}.`));
    } finally {
      setDriverActionId(null);
    }
  }, [driverActionId, showToast, reload]);

  const openReject = useCallback((driver) => { setRejectError(''); setRejectReason(''); setRejectTarget(driver); }, []);
  const closeReject = useCallback(() => { if (!rejectSubmitting) { setRejectTarget(null); setRejectReason(''); setRejectError(''); } }, [rejectSubmitting]);

  const handleConfirmReject = useCallback(async () => {
    if (!rejectTarget) return;
    setRejectSubmitting(true);
    setRejectError('');
    try {
      await apiClient.patch(`/admin/drivers/${rejectTarget.id}/reject`, { reason: rejectReason.trim() || undefined });
      setPendingDrivers((prev) => prev.filter((d) => d.id !== rejectTarget.id));
      showToast('success', `${rejectTarget.name}'s application was rejected.`);
      setRejectTarget(null);
      setRejectReason('');
      reload();
    } catch (err) {
      if (handleAuthFailure(err)) return;
      setRejectError(describeApiError(err, 'Could not reject this application.'));
    } finally {
      setRejectSubmitting(false);
    }
  }, [rejectTarget, rejectReason, showToast, reload]);

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
  // Pending drivers have their own list above, so they're left out of the staff table.
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

  // ── Render ──
  const shell = (children) => (
    <div className="nm-root min-h-screen" data-theme={theme}>
      <style>{THEME_CSS}</style>
      {children}
    </div>
  );

  if (loading) {
    return shell(
      <div className="flex min-h-screen items-center justify-center p-6">
        <Card className="flex items-center gap-3 px-6 py-5"><Spinner className="tone-info h-5 w-5" /><span className="font-semibold">Loading command center…</span></Card>
      </div>,
    );
  }

  if (fetchError) {
    return shell(
      <div className="flex min-h-screen items-center justify-center p-6">
        <Card className="w-full max-w-md space-y-4 p-6 text-center">
          <h1 className="text-lg font-bold">Dashboard unavailable</h1>
          <Notice>{fetchError}</Notice>
          <Btn variant="primary" className="w-full" onClick={reload}>Retry</Btn>
        </Card>
      </div>,
    );
  }

  return shell(
    <div className="p-3 sm:p-5 lg:p-8">
      {toast && (
        <div role="status" aria-live="polite" className="fixed left-1/2 top-4 z-[60] w-full max-w-sm -translate-x-1/2 px-3">
          <div className="nm-card flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-semibold">
            <span className={toast.type === 'success' ? 'tone-ok' : 'tone-bad'}><Icon name={toast.type === 'success' ? 'check' : 'alert'} className="h-5 w-5" /></span>
            <span className="flex-1">{toast.message}</span>
            <button onClick={() => setToast(null)} aria-label="Dismiss" className="nm-muted rounded-lg p-1"><Icon name="x" /></button>
          </div>
        </div>
      )}

      <div className="mx-auto max-w-6xl space-y-6">
        <Card className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Command center</h1>
            <p className="nm-muted text-sm">Catanduanes terminal administration</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Btn onClick={() => setIsAuditOpen(true)}><Icon name="doc" /> Audit trail</Btn>
            <Btn size="icon" onClick={reload} aria-label="Refresh dashboard" title="Refresh"><Icon name="refresh" className="h-[18px] w-[18px]" /></Btn>
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
            <Btn onClick={handleLogout} disabled={loggingOut}><Icon name="logout" /> {loggingOut ? 'Logging out…' : 'Log out'}</Btn>
          </div>
        </Card>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard icon="van" label="Active trips" value={data.stats.activeTrips} tone="ok" />
          <StatCard icon="van" label="Registered vans" value={data.stats.totalVans} tone="info" />
          <StatCard icon="users" label="System users" value={data.stats.totalUsers} tone="violet" />
          <StatCard icon="clock" label="Pending approvals" value={pendingDrivers.length} tone="warn" />
        </div>

        <Card className="p-4 sm:p-5">
          <SectionHeader title="Driver applications" count={pendingDrivers.length} />
          {pendingLoading ? (
            <p className="nm-muted flex items-center justify-center gap-2 py-8 text-sm"><Spinner /> Loading applications…</p>
          ) : pendingError ? (
            <Notice>{pendingError}</Notice>
          ) : pendingDrivers.length === 0 ? (
            <p className="nm-muted py-8 text-center text-sm">No applications waiting for review.</p>
          ) : (
            <ul className="space-y-3">
              {pendingDrivers.map((driver) => {
                const busy = driverActionId === driver.id;
                return (
                  <li key={driver.id} className={`nm-inset flex flex-col gap-3 rounded-2xl p-3 sm:flex-row sm:items-center ${busy ? 'opacity-60' : ''}`}>
                    <button type="button" onClick={() => driver.licensePhotoUrl && setLicensePhotoView(driver)} disabled={!driver.licensePhotoUrl}
                      aria-label={`View ${driver.name}'s license photo`} title="View license photo"
                      className="nm-raised nm-muted flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl">
                      {driver.licensePhotoUrl ? <img src={driver.licensePhotoUrl} alt="" className="h-full w-full object-cover" /> : <Icon name="doc" className="h-6 w-6" />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className="font-bold">{driver.name}</p>
                      <p className="nm-muted mt-0.5 flex flex-wrap gap-x-3 text-xs">
                        <span>ID {driver.driverId ?? '—'}</span>
                        <span>Van {driver.assignedVan?.plateNumber ?? '—'}</span>
                        <span>{driver.contactNumber || 'No contact number'}</span>
                        <span>Applied {formatTimestamp(driver.createdAt)}</span>
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Btn variant="success" size="sm" onClick={() => handleApproveDriver(driver)} disabled={busy}>
                        {busy ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="check" className="h-3.5 w-3.5" />} Approve
                      </Btn>
                      <Btn variant="danger" size="sm" onClick={() => openReject(driver)} disabled={busy}><Icon name="x" className="h-3.5 w-3.5" /> Reject</Btn>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card className="p-4 sm:p-5">
            <SectionHeader title="Registered vans" count={data.vans.length} />
            <p className="nm-muted mb-4 text-xs">Drivers register their own van when they sign up, so this list is view-only.</p>
            {data.vans.length > 0 && <div className="mb-4"><SearchInput value={vanSearch} onChange={setVanSearch} placeholder="Search vans" ariaLabel="Search vans" /></div>}
            <div className="overflow-x-auto">
              <table className="nm-table w-full min-w-[420px] text-left text-sm">
                <thead><tr><th className="px-3 py-2">Van</th><th className="px-3 py-2">Seats</th><th className="px-3 py-2">Status</th><th className="px-3 py-2 text-right">Actions</th></tr></thead>
                <tbody>
                  {filteredVans.length === 0 ? (
                    <EmptyRow colSpan={4}>{data.vans.length === 0 ? 'No vans registered yet.' : 'No vans match your search.'}</EmptyRow>
                  ) : filteredVans.map((van) => {
                    const driverName = van.driver?.name ?? van.driverName;
                    return (
                      <tr key={van.id}>
                        <td className="px-3 py-3">
                          <p className="font-bold">{van.plateNumber ?? '—'}</p>
                          {driverName && <p className="nm-muted text-xs">{driverName}</p>}
                        </td>
                        <td className="px-3 py-3 tabular-nums">{van.capacity ?? 0}</td>
                        <td className="px-3 py-3"><VanStatusBadge status={van.status} /></td>
                        <td className="px-3 py-3">
                          <div className="flex justify-end gap-2">
                            <Btn size="sm" onClick={() => setViewingQrVan(van)} aria-label={`Show QR for ${van.plateNumber}`}><Icon name="qr" className="h-3.5 w-3.5" /> QR</Btn>
                            <Btn size="sm" variant="danger" onClick={() => openDeleteVan(van)} aria-label={`Delete ${van.plateNumber}`}><Icon name="trash" className="h-3.5 w-3.5" /></Btn>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="p-4 sm:p-5">
            <SectionHeader title="Users & drivers" count={staffRows.length}>
              <Btn variant="primary" size="sm" onClick={() => { setStaffError(''); setIsStaffModalOpen(true); }}><Icon name="plus" className="h-3.5 w-3.5" /> Add staff</Btn>
            </SectionHeader>
            {staffRows.length > 0 && <div className="mb-4"><SearchInput value={staffSearch} onChange={setStaffSearch} placeholder="Search users" ariaLabel="Search users" /></div>}
            <div className="overflow-x-auto">
              <table className="nm-table w-full min-w-[480px] text-left text-sm">
                <thead><tr><th className="px-3 py-2">Name</th><th className="px-3 py-2">Role</th><th className="px-3 py-2">Status</th><th className="px-3 py-2 text-right">Actions</th></tr></thead>
                <tbody>
                  {filteredStaff.length === 0 ? (
                    <EmptyRow colSpan={4}>{staffRows.length === 0 ? 'No accounts yet. Use Add staff to create one.' : 'No users match your search.'}</EmptyRow>
                  ) : filteredStaff.map((user) => {
                    const busy = togglingId === user.id;
                    const rejected = user.role === 'DRIVER' && user.approvalStatus === 'REJECTED';
                    return (
                      <tr key={user.id} className={busy ? 'opacity-60' : ''}>
                        <td className="px-3 py-3">
                          <p className="font-bold leading-tight">{user.name ?? 'Unnamed'}</p>
                          <p className="nm-muted break-all text-xs">{user.email || user.driverId || '—'}{user.contactNumber ? ` · ${user.contactNumber}` : ''}</p>
                        </td>
                        <td className="px-3 py-3"><RoleBadge role={user.role} /></td>
                        <td className="px-3 py-3">
                          {rejected ? <Chip tone="bad">Rejected</Chip> : <Chip tone={user.isActive ? 'ok' : 'muted'}>{user.isActive ? 'Active' : 'Disabled'}</Chip>}
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex justify-end gap-2">
                            {!rejected && (
                              <Btn size="sm" onClick={() => handleToggleActive(user)} disabled={togglingId !== null}>
                                {busy ? <Spinner className="h-3.5 w-3.5" /> : user.isActive ? 'Disable' : 'Enable'}
                              </Btn>
                            )}
                            <Btn size="sm" variant="danger" onClick={() => openDeleteUser(user)} disabled={togglingId !== null} aria-label={`Delete ${user.name}`}><Icon name="trash" className="h-3.5 w-3.5" /></Btn>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </div>

      <AuditTrailModal isOpen={isAuditOpen} onClose={() => setIsAuditOpen(false)} trail={trail} onExport={handleExportAudit} exporting={exporting} />
      <StaffFormModal isOpen={isStaffModalOpen} onClose={closeStaffModal} onSubmit={handleSubmitStaff} isLoading={staffSaving} serverError={staffError} onClearError={clearStaffError} />
      <VanQrModal van={viewingQrVan} onClose={() => setViewingQrVan(null)} />
      <ConfirmDeleteModal target={pendingDelete} onClose={closeDelete} onConfirm={handleConfirmDelete} isLoading={deleting} serverError={deleteError} />
      <LicensePhotoModal driver={licensePhotoView} onClose={() => setLicensePhotoView(null)} />
      <RejectDriverModal target={rejectTarget} reason={rejectReason} onReasonChange={setRejectReason} onClose={closeReject} onConfirm={handleConfirmReject} isLoading={rejectSubmitting} serverError={rejectError} />
    </div>,
  );
}
