import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import apiClient from '../api/axios';

// ─── Module-level constants ───────────────────────────────────────────────────

const EMPTY_DATA = {
  stats: { activeTrips: 0, totalTrips: 0, totalVans: 0, totalUsers: 0 },
  staff: [],
  fleet: [],
};

const EMPTY_STAFF_FORM = { name: '', email: '', role: '', driverId: '', password: '' };
const EMPTY_VAN_FORM   = { plateNumber: '', capacity: '', status: 'IDLE' };

const VAN_STATUSES = ['IDLE', 'DISPATCHED', 'MAINTENANCE', 'OUT_OF_SERVICE'];

// ─── Audit trail config ───────────────────────────────────────────────────────
// The trail accumulates every entry it has ever fetched (persisted to
// localStorage) so admins can scroll back through full history, not just
// "today". A sync runs once on load and again every 24h so the log stays
// current even if the tab is left open for days at a stretch.
const AUDIT_STORAGE_KEY = 'terminalink_admin_audit_history_v1';
const AUDIT_REFRESH_MS  = 24 * 60 * 60 * 1000; // daily background refresh
const AUDIT_MAX_STORED  = 5000;                // hard cap so localStorage can't blow up
const AUDIT_PAGE_SIZE   = 50;                  // "load more" increment in the UI

// Validation rules
const EMAIL_RE     = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DRIVER_ID_RE = /^DRV-\d{3,}$/i;
const PLATE_RE     = /^[A-Z0-9\- ]{4,15}$/i;

// Tailwind helper — keeps input JSX clean
const inputCls = (hasError) =>
  `w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2
   focus:ring-blue-400 transition ${
     hasError
       ? 'border-red-400 bg-red-50 focus:ring-red-300'
       : 'border-gray-300 focus:border-blue-400'
   }`;

// Escapes a single CSV field (wraps in quotes + doubles embedded quotes
// whenever the value contains a comma, quote, or newline).
function toCsvField(value) {
  const str = String(value ?? '');
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

// ─── AdminDashboard ───────────────────────────────────────────────────────────

export default function AdminDashboard() {
  // ── data state ──
  const [data, setData]             = useState(EMPTY_DATA);
  const [loading, setLoading]       = useState(true);
  const [fetchError, setFetchError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  // ── staff mutation state ──
  const [staffModal, setStaffModal] = useState(null); // { mode: 'add'|'edit', user? }
  const [mutationLoading, setMutationLoading] = useState(false);
  const [mutationError, setMutationError]     = useState('');
  const [togglingId, setTogglingId]           = useState(null);

  // ── van mutation state ──
  const [vanModal, setVanModal]         = useState(null); // { mode: 'add'|'edit', van? }
  const [vanMutationLoading, setVanMutationLoading] = useState(false);
  const [vanMutationError, setVanMutationError]     = useState('');

  // ── shared delete-confirmation state (staff OR van) ──
  // { kind: 'user'|'van', id, label, sublabel, role? }
  const [pendingDelete, setPendingDelete] = useState(null);

  // ── toast state ──
  const [toast, setToast] = useState(null); // { type: 'success'|'error', message }
  const toastTimer = useRef(null);

  // ── audit trail state ──
  // auditLogs holds the FULL accumulated history (newest first), not just the
  // latest fetch — every sync merges in new entries on top of what's already
  // there instead of replacing it. The trail lives in its own modal rather
  // than taking up space on the main dashboard.
  const [isAuditOpen, setIsAuditOpen]     = useState(false);
  const [auditLogs, setAuditLogs]         = useState([]);
  const [auditLoading, setAuditLoading]   = useState(true);
  const [auditError, setAuditError]       = useState('');
  const [auditSearch, setAuditSearch]     = useState('');
  const [auditActionFilter, setAuditActionFilter] = useState('');
  const [auditDateFrom, setAuditDateFrom] = useState('');
  const [auditDateTo, setAuditDateTo]     = useState('');
  const [auditVisible, setAuditVisible]   = useState(AUDIT_PAGE_SIZE);
  const [lastAuditSync, setLastAuditSync] = useState(null); // ISO string, shown in the UI
  const lastAuditSyncRef = useRef(null);   // mirrors lastAuditSync for use inside stable callbacks

  const navigate = useNavigate();

  // ── Toast helper ────────────────────────────────────────────────────────────

  const showToast = useCallback((type, message) => {
    clearTimeout(toastTimer.current);
    setToast({ type, message });
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  // Cancel pending toast on unmount
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // ── Data fetching ───────────────────────────────────────────────────────────

  const fetchAdminData = useCallback(
    async (signal) => {
      setLoading(true);
      setFetchError('');
      try {
        const { data: raw } = await apiClient.get('/admin/dashboard', { signal });
        setData({
          stats: { ...EMPTY_DATA.stats, ...(raw?.stats ?? {}) },
          staff: Array.isArray(raw?.staff) ? raw.staff : [],
          fleet: Array.isArray(raw?.fleet) ? raw.fleet : [],
        });
      } catch (err) {
        if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
        if (err?.response?.status === 401 || err?.response?.status === 403) {
          navigate('/login', { replace: true });
          return;
        }
        setFetchError('Failed to load admin data. Please try again.');
      } finally {
        setLoading(false);
      }
    },
    [navigate],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    fetchAdminData(ctrl.signal);
    return () => ctrl.abort();
  }, [fetchAdminData, reloadToken]);

  // ── Audit trail: persistence + incremental sync ─────────────────────────────

  // Save the accumulated history to localStorage so it survives refreshes,
  // tab closes, and multi-day gaps between visits.
  const persistAuditHistory = useCallback((logs, syncTime) => {
    try {
      const trimmed = logs.slice(0, AUDIT_MAX_STORED);
      localStorage.setItem(
        AUDIT_STORAGE_KEY,
        JSON.stringify({ logs: trimmed, lastSync: syncTime }),
      );
    } catch {
      // Storage unavailable or full — history still works for this session,
      // it just won't survive a reload.
    }
  }, []);

  // Fetches only what's new since the last successful sync (via `since`) and
  // merges it into the existing history rather than replacing it, so nothing
  // already loaded is ever lost. `silent` skips the loading spinner for
  // background/automatic refreshes so it doesn't flicker the UI.
  const fetchAuditLogs = useCallback(
    async ({ silent = false } = {}) => {
      if (!silent) setAuditLoading(true);
      setAuditError('');
      try {
        const since = lastAuditSyncRef.current;
        const { data: raw } = await apiClient.get('/admin/audit-logs', {
          params: since ? { since } : undefined,
        });
        const incoming = Array.isArray(raw?.logs) ? raw.logs : Array.isArray(raw) ? raw : [];

        setAuditLogs((prev) => {
          const byId = new Map(prev.map((entry) => [entry.id, entry]));
          incoming.forEach((entry) => {
            if (entry?.id != null) byId.set(entry.id, entry);
          });
          const merged = Array.from(byId.values()).sort(
            (a, b) =>
              new Date(b.timestamp ?? b.createdAt ?? 0) -
              new Date(a.timestamp ?? a.createdAt ?? 0),
          );
          const syncTime = new Date().toISOString();
          lastAuditSyncRef.current = syncTime;
          setLastAuditSync(syncTime);
          persistAuditHistory(merged, syncTime);
          return merged;
        });
      } catch (err) {
        if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
        setAuditError('Could not refresh the audit trail. Showing the last saved history.');
      } finally {
        if (!silent) setAuditLoading(false);
      }
    },
    [persistAuditHistory],
  );

  // On mount: paint whatever history is already cached instantly, then sync
  // with the server (this catches up on everything missed if the admin
  // hasn't opened the dashboard in a day or more). After that, keep syncing
  // once every 24h for as long as the tab stays open.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(AUDIT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.logs)) setAuditLogs(parsed.logs);
        if (parsed?.lastSync) {
          lastAuditSyncRef.current = parsed.lastSync;
          setLastAuditSync(parsed.lastSync);
        }
      }
    } catch {
      // Corrupt or unavailable cache — fall back to a clean server fetch below.
    }

    fetchAuditLogs();
    const id = setInterval(() => fetchAuditLogs({ silent: true }), AUDIT_REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchAuditLogs]);

  const handleClearAuditHistory = useCallback(() => {
    if (!window.confirm('Clear all locally saved audit history on this device? This does not delete anything on the server.')) {
      return;
    }
    try {
      localStorage.removeItem(AUDIT_STORAGE_KEY);
    } catch { /* ignore */ }
    setAuditLogs([]);
    setAuditVisible(AUDIT_PAGE_SIZE);
    lastAuditSyncRef.current = null;
    setLastAuditSync(null);
    fetchAuditLogs();
  }, [fetchAuditLogs]);

  // ── Mutation handlers ───────────────────────────────────────────────────────

  // NOTE: window.location.replace is intentional here — it forces a hard reload
  // on logout, which clears all in-memory state (socket refs, cached responses,
  // etc.). React Router's navigate() would preserve those.
  const handleLogout = useCallback(async () => {
    try {
      await apiClient.post('/auth/logout');
    } finally {
      window.location.replace('/login');
    }
  }, []); // no navigate dep — not used

  // ── Staff modal open/close (clear stale errors on each open) ──

  const openAddStaffModal = useCallback(() => {
    setMutationError('');
    setStaffModal({ mode: 'add' });
  }, []);

  const openEditStaffModal = useCallback((user) => {
    setMutationError('');
    setStaffModal({ mode: 'edit', user });
  }, []);

  const closeStaffModal = useCallback(() => {
    if (mutationLoading) return; // block close while request is in-flight
    setMutationError('');
    setStaffModal(null);
  }, [mutationLoading]);

  // ── Van modal open/close ──

  const openAddVanModal = useCallback(() => {
    setVanMutationError('');
    setVanModal({ mode: 'add' });
  }, []);

  const openEditVanModal = useCallback((van) => {
    setVanMutationError('');
    setVanModal({ mode: 'edit', van });
  }, []);

  const closeVanModal = useCallback(() => {
    if (vanMutationLoading) return;
    setVanMutationError('');
    setVanModal(null);
  }, [vanMutationLoading]);

  // ── Shared delete modal open/close ──

  const openDeleteUserModal = useCallback((user) => {
    setMutationError('');
    setPendingDelete({
      kind: 'user',
      id: user.id,
      label: user.name ?? 'this user',
      sublabel: user.email || user.driverId || '',
      role: user.role,
    });
  }, []);

  const openDeleteVanModal = useCallback((van) => {
    setVanMutationError('');
    setPendingDelete({
      kind: 'van',
      id: van.id,
      label: van.plateNumber ?? 'this van',
      sublabel: `${van.capacity ?? 0} pax · ${van.status ?? 'UNKNOWN'}`,
    });
  }, []);

  const closeDeleteModal = useCallback(() => {
    if (mutationLoading || vanMutationLoading) return;
    setMutationError('');
    setVanMutationError('');
    setPendingDelete(null);
  }, [mutationLoading, vanMutationLoading]);

  // ── Add / edit staff ──

  const handleSubmitStaff = useCallback(
    async (formData) => {
      setMutationLoading(true);
      setMutationError('');
      try {
        if (staffModal?.mode === 'edit') {
          await apiClient.patch(`/admin/users/${staffModal.user.id}`, formData);
          showToast('success', `${formData.name}'s account has been updated.`);
        } else {
          await apiClient.post('/admin/users', formData);
          showToast('success', `${formData.name} has been added as ${formData.role}.`);
        }
        setStaffModal(null);
        setReloadToken((n) => n + 1);
      } catch (err) {
        setMutationError(
          err?.response?.data?.error ??
          err?.response?.data?.message ??
          'Failed to save this account. Please check the details and try again.',
        );
      } finally {
        setMutationLoading(false);
      }
    },
    [staffModal, showToast],
  );

  // ── Add / edit van ──

  const handleSubmitVan = useCallback(
    async (formData) => {
      setVanMutationLoading(true);
      setVanMutationError('');
      try {
        if (vanModal?.mode === 'edit') {
          await apiClient.patch(`/admin/vans/${vanModal.van.id}`, formData);
          showToast('success', `${formData.plateNumber} has been updated.`);
        } else {
          await apiClient.post('/admin/vans', formData);
          showToast('success', `${formData.plateNumber} has been added to the fleet.`);
        }
        setVanModal(null);
        setReloadToken((n) => n + 1);
      } catch (err) {
        setVanMutationError(
          err?.response?.data?.error ??
          err?.response?.data?.message ??
          'Failed to save this van. Please check the details and try again.',
        );
      } finally {
        setVanMutationLoading(false);
      }
    },
    [vanModal, showToast],
  );

  // ── Delete (confirmed) — dispatches to the right endpoint by kind ──

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const isVan = pendingDelete.kind === 'van';
    isVan ? setVanMutationLoading(true) : setMutationLoading(true);
    isVan ? setVanMutationError('') : setMutationError('');
    try {
      await apiClient.delete(
        isVan ? `/admin/vans/${pendingDelete.id}` : `/admin/users/${pendingDelete.id}`,
      );
      showToast(
        'success',
        isVan
          ? `${pendingDelete.label} has been removed from the fleet.`
          : `${pendingDelete.label}'s account has been permanently removed.`,
      );
      setPendingDelete(null);
      setReloadToken((n) => n + 1);
    } catch (err) {
      // Keep modal open and display the server's rejection reason
      const message =
        err?.response?.data?.error ??
        err?.response?.data?.message ??
        `Could not delete ${isVan ? 'this van' : 'this account'}. The server rejected the request.`;
      isVan ? setVanMutationError(message) : setMutationError(message);
    } finally {
      isVan ? setVanMutationLoading(false) : setMutationLoading(false);
    }
  }, [pendingDelete, showToast]);

  // ── Toggle staff active/disabled ──

  const handleToggleActive = useCallback(
    async (user) => {
      if (togglingId !== null) return; // prevent concurrent toggles
      setTogglingId(user.id);
      const next = !user.isActive;
      try {
        await apiClient.patch(`/admin/users/${user.id}`, { isActive: next });
        // Optimistic update — avoid full refetch for a simple boolean flip
        setData((prev) => ({
          ...prev,
          staff: prev.staff.map((u) =>
            u.id === user.id ? { ...u, isActive: next } : u,
          ),
        }));
        showToast(
          'success',
          `${user.name ?? 'User'} has been ${next ? 'activated' : 'deactivated'}.`,
        );
      } catch (err) {
        showToast(
          'error',
          err?.response?.data?.error ??
            `Could not update ${user.name ?? 'this user'}'s status. Please try again.`,
        );
      } finally {
        setTogglingId(null);
      }
    },
    [togglingId, showToast],
  );

  // ── Audit trail: derived/filtered view ──────────────────────────────────────

  const auditActionOptions = useMemo(() => {
    const set = new Set();
    auditLogs.forEach((entry) => { if (entry?.action) set.add(entry.action); });
    return Array.from(set).sort();
  }, [auditLogs]);

  const filteredAuditLogs = useMemo(() => {
    const q = auditSearch.trim().toLowerCase();
    const from = auditDateFrom ? new Date(`${auditDateFrom}T00:00:00`) : null;
    const to   = auditDateTo ? new Date(`${auditDateTo}T23:59:59`) : null;

    return auditLogs.filter((entry) => {
      if (auditActionFilter && entry.action !== auditActionFilter) return false;

      if (from || to) {
        const t = new Date(entry.timestamp ?? entry.createdAt ?? 0);
        if (Number.isNaN(t.getTime())) return false;
        if (from && t < from) return false;
        if (to && t > to) return false;
      }

      if (!q) return true;
      const haystack = [
        entry.actorName, entry.actor, entry.action,
        entry.targetType, entry.target, entry.details, entry.description,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [auditLogs, auditSearch, auditActionFilter, auditDateFrom, auditDateTo]);

  const visibleAuditLogs = filteredAuditLogs.slice(0, auditVisible);

  // Exports every currently-filtered entry (not just the visible slice) as a
  // CSV file downloaded to the admin's device.
  const handleExportAuditCsv = useCallback(() => {
    if (filteredAuditLogs.length === 0) {
      showToast('error', 'There is nothing to export with the current filters.');
      return;
    }
    const header = ['Timestamp', 'Actor', 'Action', 'Target', 'Details'];
    const rows = filteredAuditLogs.map((entry) => [
      formatAuditTimestamp(entry.timestamp ?? entry.createdAt),
      entry.actorName ?? entry.actor ?? 'System',
      entry.action ?? 'UNKNOWN',
      entry.targetType ?? entry.target ?? '',
      entry.details ?? entry.description ?? '',
    ]);
    const csv = [header, ...rows].map((row) => row.map(toCsvField).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `audit-trail-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('success', `Exported ${filteredAuditLogs.length} audit ${filteredAuditLogs.length === 1 ? 'entry' : 'entries'}.`);
  }, [filteredAuditLogs, showToast]);

  const clearAuditFilters = useCallback(() => {
    setAuditSearch('');
    setAuditActionFilter('');
    setAuditDateFrom('');
    setAuditDateTo('');
    setAuditVisible(AUDIT_PAGE_SIZE);
  }, []);

  // ── Render guards ───────────────────────────────────────────────────────────

  if (loading) return <PageState title="Loading Command Center…" />;

  if (fetchError) {
    return (
      <PageState
        title="Dashboard unavailable"
        message={fetchError}
        actionLabel="Retry"
        onAction={() => setReloadToken((n) => n + 1)}
      />
    );
  }

  const anyMutationBusy = mutationLoading || vanMutationLoading;

  // ── Main render ─────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-100 p-4 md:p-6">

      {/* ── Toast notification ── */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl
            shadow-xl font-semibold text-sm flex items-center gap-3 max-w-sm w-full border
            ${toast.type === 'success'
              ? 'bg-green-50 text-green-800 border-green-200'
              : 'bg-red-50 text-red-800 border-red-200'}`}
        >
          <span className="flex-1">
            {toast.type === 'success' ? '✅' : '⚠️'} {toast.message}
          </span>
          <button
            onClick={() => setToast(null)}
            aria-label="Dismiss"
            className="opacity-50 hover:opacity-100 font-bold text-base leading-none"
          >
            ✕
          </button>
        </div>
      )}

      {/* ── Header ── */}
      <div className="max-w-6xl mx-auto bg-white p-5 rounded-xl shadow-sm border mb-6 flex flex-wrap gap-3 justify-between items-center">
        <div>
          <h1 className="text-2xl font-extrabold text-gray-900">Catanduanes Command Center</h1>
          <p className="text-sm text-gray-500">System Administration &amp; Analytics</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setIsAuditOpen(true)}
            title="View the full audit trail"
            className="text-sm font-semibold px-4 py-2 rounded-lg border border-gray-300
              text-gray-700 hover:bg-gray-100 transition flex items-center gap-2"
          >
            🧾 Audit Trail
            <span className="bg-gray-100 text-gray-600 text-xs font-bold px-1.5 py-0.5 rounded">
              {auditLogs.length}
            </span>
          </button>
          <button
            onClick={() => setReloadToken((n) => n + 1)}
            title="Refresh dashboard"
            aria-label="Refresh dashboard"
            className="p-2 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition"
          >
            🔄
          </button>
          <button
            onClick={handleLogout}
            className="bg-red-50 text-red-600 font-bold px-4 py-2 rounded-lg border
              border-red-200 hover:bg-red-100 transition text-sm"
          >
            Secure Logout
          </button>
        </div>
      </div>

      <div className="max-w-6xl mx-auto space-y-6">

        {/* ── KPI Cards ── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard title="Active Trips"       value={data.stats.activeTrips} color="text-green-600" />
          <StatCard title="Total Trips Logged" value={data.stats.totalTrips}  color="text-blue-600" />
          <StatCard title="Total Fleet Size"   value={data.stats.totalVans}   color="text-purple-600" />
          <StatCard title="Total Staff"        value={data.stats.totalUsers}  color="text-orange-600" />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

          {/* ── Fleet Table ── */}
          <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200">
            <div className="flex justify-between items-center mb-4 border-b pb-2">
              <h2 className="text-lg font-bold text-gray-800">Registered Fleet</h2>
              <button
                onClick={openAddVanModal}
                className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold
                  px-3 py-1.5 rounded-lg transition shadow-sm"
              >
                ＋ Add Van
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="p-3">Plate</th>
                    <th className="p-3">Capacity</th>
                    <th className="p-3">Status</th>
                    <th className="p-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.fleet.length === 0 ? (
                    <EmptyTableRow colSpan={4} message="No fleet records found." />
                  ) : (
                    data.fleet.map((van) => (
                      <tr key={van.id} className="border-b hover:bg-gray-50">
                        <td className="p-3 font-bold text-gray-800">{van.plateNumber ?? '—'}</td>
                        <td className="p-3 text-gray-600">{van.capacity ?? 0} pax</td>
                        <td className="p-3">
                          <VanStatusBadge status={van.status} />
                        </td>
                        <td className="p-3">
                          <div className="flex gap-1.5 justify-end">
                            <button
                              onClick={() => openEditVanModal(van)}
                              title="Edit this van"
                              className="text-xs font-semibold px-2 py-1 rounded border
                                border-blue-300 text-blue-700 bg-blue-50 hover:bg-blue-100 transition"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => openDeleteVanModal(van)}
                              title="Remove this van from the fleet"
                              className="text-xs font-semibold px-2 py-1 rounded border
                                border-red-300 text-red-600 bg-red-50 hover:bg-red-100 transition"
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Staff Table ── */}
          <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200">
            <div className="flex justify-between items-center mb-4 border-b pb-2">
              <h2 className="text-lg font-bold text-gray-800">System Users &amp; Drivers</h2>
              <button
                onClick={openAddStaffModal}
                className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold
                  px-3 py-1.5 rounded-lg transition shadow-sm"
              >
                ＋ Add Account
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="p-3">Name</th>
                    <th className="p-3">Role</th>
                    <th className="p-3">Status</th>
                    <th className="p-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.staff.length === 0 ? (
                    <EmptyTableRow colSpan={4} message="No staff accounts found." />
                  ) : (
                    data.staff.map((user) => {
                      const isBusy = togglingId === user.id;
                      const anyToggling = togglingId !== null;
                      return (
                        <tr
                          key={user.id}
                          className={`border-b hover:bg-gray-50 transition-opacity ${isBusy ? 'opacity-50' : ''}`}
                        >
                          <td className="p-3">
                            <div className="font-bold text-gray-800 leading-tight">
                              {user.name ?? 'Unnamed'}
                            </div>
                            <div className="text-xs text-gray-400 mt-0.5">
                              {user.email || user.driverId || '—'}
                            </div>
                          </td>
                          <td className="p-3">
                            <RoleBadge role={user.role} />
                          </td>
                          <td className="p-3">
                            <span className={`px-2 py-0.5 rounded text-xs font-bold ${
                              user.isActive
                                ? 'bg-green-100 text-green-700'
                                : 'bg-gray-100 text-gray-500'
                            }`}>
                              {user.isActive ? 'Active' : 'Disabled'}
                            </span>
                          </td>
                          <td className="p-3">
                            <div className="flex flex-wrap gap-1.5 justify-end">
                              {/* Edit */}
                              <button
                                onClick={() => openEditStaffModal(user)}
                                disabled={isBusy || anyToggling}
                                title="Edit this account"
                                className="text-xs font-semibold px-2 py-1 rounded border
                                  border-blue-300 text-blue-700 bg-blue-50 hover:bg-blue-100
                                  transition disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                Edit
                              </button>

                              {/* Toggle active/disabled */}
                              <button
                                onClick={() => handleToggleActive(user)}
                                disabled={isBusy || anyToggling}
                                title={user.isActive ? 'Disable account' : 'Enable account'}
                                className={`text-xs font-semibold px-2 py-1 rounded border
                                  transition disabled:opacity-40 disabled:cursor-not-allowed
                                  ${user.isActive
                                    ? 'border-yellow-300 text-yellow-700 bg-yellow-50 hover:bg-yellow-100'
                                    : 'border-green-300 text-green-700 bg-green-50 hover:bg-green-100'
                                  }`}
                              >
                                {isBusy ? '…' : user.isActive ? 'Disable' : 'Enable'}
                              </button>

                              {/* Delete — opens confirmation modal */}
                              <button
                                onClick={() => openDeleteUserModal(user)}
                                disabled={isBusy || anyToggling}
                                title="Permanently delete this account"
                                className="text-xs font-semibold px-2 py-1 rounded border
                                  border-red-300 text-red-600 bg-red-50 hover:bg-red-100
                                  transition disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      </div>

      {/* ── Audit Trail Modal ── */}
      <AuditTrailModal
        isOpen={isAuditOpen}
        onClose={() => setIsAuditOpen(false)}
        logs={visibleAuditLogs}
        totalCount={filteredAuditLogs.length}
        fullCount={auditLogs.length}
        loading={auditLoading}
        error={auditError}
        search={auditSearch}
        onSearchChange={(v) => { setAuditSearch(v); setAuditVisible(AUDIT_PAGE_SIZE); }}
        actionFilter={auditActionFilter}
        onActionFilterChange={(v) => { setAuditActionFilter(v); setAuditVisible(AUDIT_PAGE_SIZE); }}
        actionOptions={auditActionOptions}
        dateFrom={auditDateFrom}
        onDateFromChange={(v) => { setAuditDateFrom(v); setAuditVisible(AUDIT_PAGE_SIZE); }}
        dateTo={auditDateTo}
        onDateToChange={(v) => { setAuditDateTo(v); setAuditVisible(AUDIT_PAGE_SIZE); }}
        onClearFilters={clearAuditFilters}
        lastSync={lastAuditSync}
        onRefresh={() => fetchAuditLogs()}
        onLoadMore={() => setAuditVisible((n) => n + AUDIT_PAGE_SIZE)}
        onClearHistory={handleClearAuditHistory}
        onExportCsv={handleExportAuditCsv}
      />

      {/* ── Staff modal (add + edit) ── */}
      <StaffFormModal
        state={staffModal}
        onClose={closeStaffModal}
        onSubmit={handleSubmitStaff}
        isLoading={mutationLoading}
        serverError={mutationError}
        onClearError={() => setMutationError('')}
      />

      {/* ── Van modal (add + edit) ── */}
      <VanFormModal
        state={vanModal}
        onClose={closeVanModal}
        onSubmit={handleSubmitVan}
        isLoading={vanMutationLoading}
        serverError={vanMutationError}
        onClearError={() => setVanMutationError('')}
      />

      {/* ── Shared delete confirmation (staff or van) ── */}
      <ConfirmDeleteModal
        target={pendingDelete}
        onClose={closeDeleteModal}
        onConfirm={handleConfirmDelete}
        isLoading={anyMutationBusy}
        serverError={pendingDelete?.kind === 'van' ? vanMutationError : mutationError}
      />
    </div>
  );
}

// ─── StaffFormModal (handles both Add and Edit) ───────────────────────────────
//
// Security notes:
//  • autoComplete="new-password" prevents browsers injecting saved passwords
//  • autoComplete="off" on driverId prevents wrong autofill
//  • All inputs are controlled — no uncontrolled innerHTML risk
//  • Password length enforced: ≥8 for staff, ≥4 for driver PIN (add mode only —
//    edit mode never touches credentials; use a separate "reset password" flow)
//  • Email validated with regex before submission
//  • Driver ID normalised to uppercase on submit (DRV-001 canonical form)
//  • onClearError called whenever the modal (re)opens so stale errors never
//    bleed across opens

function StaffFormModal({ state, onClose, onSubmit, isLoading, serverError, onClearError }) {
  const isOpen   = state != null;
  const isEdit   = state?.mode === 'edit';
  const original = state?.user ?? null;

  const [form, setForm]     = useState(EMPTY_STAFF_FORM);
  const [errors, setErrors] = useState({});
  const nameRef              = useRef(null);

  // Reset and clear errors each time the modal opens; pre-fill from the
  // target user when editing.
  useEffect(() => {
    if (isOpen) {
      setForm(
        isEdit && original
          ? {
              name: original.name ?? '',
              email: original.email ?? '',
              role: original.role ?? '',
              driverId: original.driverId ?? '',
              password: '',
            }
          : EMPTY_STAFF_FORM,
      );
      setErrors({});
      onClearError();
      const id = setTimeout(() => nameRef.current?.focus(), 60);
      return () => clearTimeout(id);
    }
  }, [isOpen, isEdit, original, onClearError]);

  // Escape key support
  useEffect(() => {
    if (!isOpen) return;
    const fn = (e) => { if (e.key === 'Escape' && !isLoading) onClose(); };
    document.addEventListener('keydown', fn);
    return () => document.removeEventListener('keydown', fn);
  }, [isOpen, isLoading, onClose]);

  const change = (e) => {
    const { name, value } = e.target;
    setForm((p) => ({ ...p, [name]: value }));
    setErrors((p) => ({ ...p, [name]: '' }));
    if (serverError) onClearError();
  };

  const validate = () => {
    const e   = {};
    const nm  = form.name.trim();
    const em  = form.email.trim();
    const did = form.driverId.trim();

    if (!nm)               e.name     = 'Full name is required.';
    else if (nm.length > 100) e.name  = 'Name must be 100 characters or fewer.';

    if (!form.role)        e.role     = 'Role is required.';

    if (form.role && form.role !== 'DRIVER') {
      if (!em)             e.email    = 'Email address is required.';
      else if (!EMAIL_RE.test(em)) e.email = 'Enter a valid email address.';
    }

    if (form.role === 'DRIVER') {
      if (!did)            e.driverId = 'Driver ID is required.';
      else if (!DRIVER_ID_RE.test(did)) e.driverId = 'Must follow the format DRV-001.';
    }

    // Credentials are only collected (and required) when creating a new account.
    if (!isEdit) {
      const minLen = form.role === 'DRIVER' ? 4 : 8;
      if (!form.password)
        e.password = 'This field is required.';
      else if (form.password.length < minLen)
        e.password = `${form.role === 'DRIVER' ? 'PIN' : 'Password'} must be at least ${minLen} characters.`;
    }

    return e;
  };

  const submit = () => {
    const e = validate();
    if (Object.keys(e).length > 0) { setErrors(e); return; }

    // Build a clean payload — never send fields that don't apply to the role,
    // and never send credentials from the edit form.
    onSubmit({
      name: form.name.trim(),
      role: form.role,
      ...(!isEdit && { password: form.password }),
      ...(form.role !== 'DRIVER' && { email: form.email.trim() }),
      ...(form.role === 'DRIVER' && { driverId: form.driverId.trim().toUpperCase() }),
    });
  };

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="staff-modal-title"
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !isLoading) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">

        {/* Header */}
        <div className="flex justify-between items-center p-5 border-b">
          <h2 id="staff-modal-title" className="text-lg font-bold text-gray-900">
            {isEdit ? 'Edit Account' : 'Create New Account'}
          </h2>
          <button
            onClick={onClose}
            disabled={isLoading}
            aria-label="Close modal"
            className="text-gray-400 hover:text-gray-600 disabled:opacity-40 text-xl leading-none"
          >
            ✕
          </button>
        </div>

        {/* Server error banner */}
        {serverError && (
          <div className="mx-5 mt-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
            ⚠️ {serverError}
          </div>
        )}

        {/* Form body */}
        <div className="p-5 space-y-4">
          <Field label="Full Name" required error={errors.name}>
            <input
              ref={nameRef}
              name="name" type="text" value={form.name} onChange={change}
              placeholder="e.g. Juan dela Cruz"
              autoComplete="name" maxLength={100}
              className={inputCls(errors.name)}
            />
          </Field>

          <Field label="Role" required error={errors.role}>
            <select
              name="role" value={form.role} onChange={change}
              disabled={isEdit} // role changes can cascade credential requirements; keep simple
              className={`${inputCls(errors.role)} bg-white disabled:opacity-60 disabled:cursor-not-allowed`}
            >
              <option value="">— Select a role —</option>
              <option value="ADMIN">Admin</option>
              <option value="DISPATCHER">Dispatcher</option>
              <option value="DRIVER">Driver</option>
            </select>
            {isEdit && (
              <p className="text-xs text-gray-400 mt-1">
                Role can't be changed here. Delete and re-create the account to change roles.
              </p>
            )}
          </Field>

          {/* Email — only for Admin / Dispatcher */}
          {form.role && form.role !== 'DRIVER' && (
            <Field label="Email Address" required error={errors.email}>
              <input
                name="email" type="email" value={form.email} onChange={change}
                placeholder="staff@terminal.gov.ph"
                autoComplete="email"
                className={inputCls(errors.email)}
              />
            </Field>
          )}

          {/* Driver ID — only for Driver role */}
          {form.role === 'DRIVER' && (
            <Field
              label="Driver ID" required error={errors.driverId}
              hint="Format: DRV-001, DRV-012, etc."
            >
              <input
                name="driverId" type="text" value={form.driverId} onChange={change}
                placeholder="DRV-001"
                autoComplete="off" maxLength={20}
                className={`${inputCls(errors.driverId)} uppercase`}
              />
            </Field>
          )}

          {/* Password / PIN — add mode only */}
          {!isEdit && form.role && (
            <Field
              label={form.role === 'DRIVER' ? 'PIN' : 'Password'}
              required
              error={errors.password}
              hint={form.role === 'DRIVER' ? 'Min. 4 characters.' : 'Min. 8 characters.'}
            >
              <input
                name="password" type="password" value={form.password} onChange={change}
                placeholder={form.role === 'DRIVER' ? 'Min. 4 characters' : 'Min. 8 characters'}
                autoComplete="new-password"
                className={inputCls(errors.password)}
              />
            </Field>
          )}

          {isEdit && (
            <p className="text-xs text-gray-400">
              To reset this user's password or PIN, use the dedicated reset flow — it isn't changed here.
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-5 border-t bg-gray-50 rounded-b-2xl">
          <button
            onClick={onClose} disabled={isLoading}
            className="flex-1 py-2 border border-gray-300 rounded-lg text-sm font-semibold
              text-gray-700 hover:bg-gray-100 transition disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={submit} disabled={isLoading}
            className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg
              text-sm font-bold transition disabled:opacity-70 disabled:cursor-not-allowed"
          >
            {isLoading ? (isEdit ? 'Saving…' : 'Creating…') : (isEdit ? 'Save Changes' : 'Create Account')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── VanFormModal (handles both Add and Edit) ─────────────────────────────────

function VanFormModal({ state, onClose, onSubmit, isLoading, serverError, onClearError }) {
  const isOpen   = state != null;
  const isEdit   = state?.mode === 'edit';
  const original = state?.van ?? null;

  const [form, setForm]     = useState(EMPTY_VAN_FORM);
  const [errors, setErrors] = useState({});
  const plateRef             = useRef(null);

  useEffect(() => {
    if (isOpen) {
      setForm(
        isEdit && original
          ? {
              plateNumber: original.plateNumber ?? '',
              capacity: String(original.capacity ?? ''),
              status: original.status ?? 'IDLE',
            }
          : EMPTY_VAN_FORM,
      );
      setErrors({});
      onClearError();
      const id = setTimeout(() => plateRef.current?.focus(), 60);
      return () => clearTimeout(id);
    }
  }, [isOpen, isEdit, original, onClearError]);

  useEffect(() => {
    if (!isOpen) return;
    const fn = (e) => { if (e.key === 'Escape' && !isLoading) onClose(); };
    document.addEventListener('keydown', fn);
    return () => document.removeEventListener('keydown', fn);
  }, [isOpen, isLoading, onClose]);

  const change = (e) => {
    const { name, value } = e.target;
    setForm((p) => ({ ...p, [name]: value }));
    setErrors((p) => ({ ...p, [name]: '' }));
    if (serverError) onClearError();
  };

  const validate = () => {
    const e   = {};
    const plt = form.plateNumber.trim();
    const cap = Number(form.capacity);

    if (!plt)                  e.plateNumber = 'Plate number is required.';
    else if (!PLATE_RE.test(plt)) e.plateNumber = 'Use letters, numbers, spaces, or dashes only (4–15 chars).';

    if (!form.capacity)        e.capacity = 'Capacity is required.';
    else if (!Number.isInteger(cap) || cap < 1 || cap > 30)
      e.capacity = 'Enter a whole number between 1 and 30.';

    if (!form.status)          e.status = 'Status is required.';

    return e;
  };

  const submit = () => {
    const e = validate();
    if (Object.keys(e).length > 0) { setErrors(e); return; }

    onSubmit({
      plateNumber: form.plateNumber.trim().toUpperCase(),
      capacity: Number(form.capacity),
      status: form.status,
    });
  };

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="van-modal-title"
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !isLoading) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm">

        {/* Header */}
        <div className="flex justify-between items-center p-5 border-b">
          <h2 id="van-modal-title" className="text-lg font-bold text-gray-900">
            {isEdit ? 'Edit Van' : 'Add Van to Fleet'}
          </h2>
          <button
            onClick={onClose}
            disabled={isLoading}
            aria-label="Close modal"
            className="text-gray-400 hover:text-gray-600 disabled:opacity-40 text-xl leading-none"
          >
            ✕
          </button>
        </div>

        {serverError && (
          <div className="mx-5 mt-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
            ⚠️ {serverError}
          </div>
        )}

        {/* Form body */}
        <div className="p-5 space-y-4">
          <Field label="Plate Number" required error={errors.plateNumber}>
            <input
              ref={plateRef}
              name="plateNumber" type="text" value={form.plateNumber} onChange={change}
              placeholder="e.g. ABC-1234"
              autoComplete="off" maxLength={15}
              className={`${inputCls(errors.plateNumber)} uppercase`}
            />
          </Field>

          <Field label="Capacity" required error={errors.capacity} hint="Passenger seats, 1–30.">
            <input
              name="capacity" type="number" min={1} max={30} value={form.capacity} onChange={change}
              placeholder="e.g. 12"
              className={inputCls(errors.capacity)}
            />
          </Field>

          <Field label="Status" required error={errors.status}>
            <select
              name="status" value={form.status} onChange={change}
              className={`${inputCls(errors.status)} bg-white`}
            >
              {VAN_STATUSES.map((s) => (
                <option key={s} value={s}>{s.replace('_', ' ')}</option>
              ))}
            </select>
          </Field>
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-5 border-t bg-gray-50 rounded-b-2xl">
          <button
            onClick={onClose} disabled={isLoading}
            className="flex-1 py-2 border border-gray-300 rounded-lg text-sm font-semibold
              text-gray-700 hover:bg-gray-100 transition disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={submit} disabled={isLoading}
            className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg
              text-sm font-bold transition disabled:opacity-70 disabled:cursor-not-allowed"
          >
            {isLoading ? (isEdit ? 'Saving…' : 'Adding…') : (isEdit ? 'Save Changes' : 'Add Van')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── ConfirmDeleteModal (shared by staff + fleet) ─────────────────────────────
//
// Security notes:
//  • Modal stays open on server error so the admin sees the rejection reason
//    (e.g. "cannot delete last admin", "van has active trips")
//  • Shown a stronger warning when the target is a user with the ADMIN role
//  • Close is blocked while the request is in-flight to prevent double-submit
//  • All displayed values flow through JSX — no innerHTML

function ConfirmDeleteModal({ target, onClose, onConfirm, isLoading, serverError }) {
  const isAdminRole = target?.kind === 'user' && target?.role === 'ADMIN';
  const isVan       = target?.kind === 'van';

  useEffect(() => {
    if (!target) return;
    const fn = (e) => { if (e.key === 'Escape' && !isLoading) onClose(); };
    document.addEventListener('keydown', fn);
    return () => document.removeEventListener('keydown', fn);
  }, [target, isLoading, onClose]);

  if (!target) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-modal-title"
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !isLoading) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm">
        <div className="p-6 space-y-4 text-center">
          <div className="text-4xl" aria-hidden="true">⚠️</div>
          <h2 id="delete-modal-title" className="text-lg font-black text-gray-900">
            {isVan ? 'Remove Van?' : 'Delete Account?'}
          </h2>
          <p className="text-sm text-gray-500">
            You are about to {isVan ? 'permanently remove' : 'permanently delete'}:
          </p>

          {/* Target card */}
          <div className="inline-block py-2 px-5 bg-gray-50 border border-gray-200 rounded-xl text-left">
            <p className="font-bold text-gray-900">{target.label}</p>
            <div className="mt-1">
              {isVan ? (
                <span className="text-xs text-gray-500">{target.sublabel}</span>
              ) : (
                <RoleBadge role={target.role} />
              )}
            </div>
          </div>

          {/* Extra warning for Admin accounts */}
          {isAdminRole && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 text-left">
              <strong>Admin account detected.</strong> Ensure at least one other admin
              remains in the system before proceeding.
            </div>
          )}

          {/* General permanent-action warning */}
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 text-left">
            This action is <strong>permanent and cannot be undone.</strong>{' '}
            {isVan
              ? 'This van will no longer be assignable to trips.'
              : 'All data associated with this account will be removed.'}
          </div>

          {/* Server error (keeps modal open on failure) */}
          {serverError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 text-left">
              ⚠️ {serverError}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-5 border-t bg-gray-50 rounded-b-2xl">
          <button
            onClick={onClose} disabled={isLoading}
            className="flex-1 py-2 border border-gray-300 rounded-lg text-sm font-semibold
              text-gray-700 hover:bg-gray-100 transition disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm} disabled={isLoading}
            className="flex-1 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg
              text-sm font-black transition disabled:opacity-70 disabled:cursor-not-allowed"
          >
            {isLoading ? 'Deleting…' : `🗑 Yes, ${isVan ? 'Remove' : 'Delete'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function RoleBadge({ role }) {
  const styles = {
    ADMIN:      'bg-purple-100 text-purple-800',
    DISPATCHER: 'bg-blue-100 text-blue-800',
    DRIVER:     'bg-gray-100 text-gray-700',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-bold ${styles[role] ?? 'bg-gray-100 text-gray-500'}`}>
      {role ?? 'UNKNOWN'}
    </span>
  );
}

function VanStatusBadge({ status }) {
  const styles = {
    IDLE:            'bg-yellow-100 text-yellow-800',
    DISPATCHED:      'bg-green-100 text-green-800',
    MAINTENANCE:     'bg-orange-100 text-orange-800',
    OUT_OF_SERVICE:  'bg-red-100 text-red-800',
  };
  return (
    <span className={`px-2 py-1 rounded text-xs font-bold ${styles[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {(status ?? 'UNKNOWN').replace('_', ' ')}
    </span>
  );
}

function StatCard({ title, value, color }) {
  return (
    <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 flex flex-col items-center justify-center">
      <div className="text-sm text-gray-500 font-semibold mb-1 text-center">{title}</div>
      <div className={`text-3xl font-black ${color}`}>{value ?? 0}</div>
    </div>
  );
}

function EmptyTableRow({ colSpan, message }) {
  return (
    <tr>
      <td colSpan={colSpan} className="p-4 text-center text-sm text-gray-400 italic">
        {message}
      </td>
    </tr>
  );
}

// ─── AuditTrailModal ──────────────────────────────────────────────────────────
//
// Notes:
//  • `logs` is already the sliced/filtered/paginated view — this component is
//    purely presentational and does no fetching or storage of its own.
//  • The parent keeps the FULL history in state (backed by localStorage), so
//    this modal is really just windowing into however much of it the admin
//    has chosen to reveal via search/filters + "Load more".
//  • Background sync happens automatically once a day; "Refresh Now" lets an
//    admin force an out-of-band check without waiting for the interval.
//  • Lives in its own modal (rather than inline on the dashboard) so the main
//    page stays focused on live operational data.

function AuditTrailModal({
  isOpen, onClose,
  logs, totalCount, fullCount, loading, error,
  search, onSearchChange,
  actionFilter, onActionFilterChange, actionOptions,
  dateFrom, onDateFromChange, dateTo, onDateToChange, onClearFilters,
  lastSync, onRefresh, onLoadMore, onClearHistory, onExportCsv,
}) {
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    if (!isOpen) return;
    const fn = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', fn);
    return () => document.removeEventListener('keydown', fn);
  }, [isOpen, onClose]);

  useEffect(() => { if (!isOpen) setExpandedId(null); }, [isOpen]);

  if (!isOpen) return null;

  const hasFilters = Boolean(search || actionFilter || dateFrom || dateTo);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="audit-modal-title"
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex flex-wrap justify-between items-center gap-3 p-5 border-b">
          <div>
            <h2 id="audit-modal-title" className="text-lg font-bold text-gray-900">Audit Trail</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              {fullCount} {fullCount === 1 ? 'entry' : 'entries'} saved on this device
              {lastSync && <> · Last synced {formatAuditTimestamp(lastSync)}</>}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close audit trail"
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
          >
            ✕
          </button>
        </div>

        {/* Filter bar */}
        <div className="p-5 border-b space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search actor, action, target…"
              className="px-3 py-1.5 border border-gray-300 rounded-lg text-xs flex-1 min-w-[10rem]
                focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
            />
            <select
              value={actionFilter}
              onChange={(e) => onActionFilterChange(e.target.value)}
              className="px-3 py-1.5 border border-gray-300 rounded-lg text-xs bg-white
                focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
            >
              <option value="">All actions</option>
              {actionOptions.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => onDateFromChange(e.target.value)}
              title="From date"
              className="px-3 py-1.5 border border-gray-300 rounded-lg text-xs
                focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
            />
            <span className="text-xs text-gray-400">to</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => onDateToChange(e.target.value)}
              title="To date"
              className="px-3 py-1.5 border border-gray-300 rounded-lg text-xs
                focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
            />
            {hasFilters && (
              <button
                onClick={onClearFilters}
                className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-300
                  text-gray-500 hover:bg-gray-100 transition"
              >
                Clear filters
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={onRefresh}
              disabled={loading}
              title="Check for new audit entries now"
              className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-300
                text-gray-700 hover:bg-gray-100 transition disabled:opacity-50"
            >
              {loading ? 'Syncing…' : '🔄 Refresh Now'}
            </button>
            <button
              onClick={onExportCsv}
              title="Export the currently filtered entries as CSV"
              className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-300
                text-gray-700 hover:bg-gray-100 transition"
            >
              ⬇️ Export CSV
            </button>
            <button
              onClick={onClearHistory}
              title="Clear locally saved history on this device"
              className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-red-200
                text-red-600 hover:bg-red-50 transition ml-auto"
            >
              Clear local history
            </button>
          </div>

          {error && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
              ⚠️ {error}
            </div>
          )}
        </div>

        {/* Table */}
        <div className="overflow-y-auto flex-1">
          <table className="w-full text-sm text-left">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide sticky top-0">
              <tr>
                <th className="p-3">Timestamp</th>
                <th className="p-3">Actor</th>
                <th className="p-3">Action</th>
                <th className="p-3">Target</th>
                <th className="p-3">Details</th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 ? (
                <EmptyTableRow
                  colSpan={5}
                  message={loading ? 'Loading audit history…' : 'No audit entries match these filters.'}
                />
              ) : (
                logs.map((entry) => {
                  const isExpanded = expandedId === entry.id;
                  const hasMeta = entry.metadata && typeof entry.metadata === 'object';
                  return (
                    <>
                      <tr
                        key={entry.id}
                        onClick={() => hasMeta && setExpandedId(isExpanded ? null : entry.id)}
                        className={`border-b hover:bg-gray-50 align-top ${hasMeta ? 'cursor-pointer' : ''}`}
                      >
                        <td className="p-3 whitespace-nowrap text-gray-500 text-xs">
                          {formatAuditTimestamp(entry.timestamp ?? entry.createdAt)}
                        </td>
                        <td className="p-3 font-semibold text-gray-800">
                          {entry.actorName ?? entry.actor ?? 'System'}
                        </td>
                        <td className="p-3">
                          <AuditActionBadge action={entry.action} />
                        </td>
                        <td className="p-3 text-gray-600">
                          {entry.targetType ?? entry.target ?? '—'}
                        </td>
                        <td className="p-3 text-gray-500 text-xs max-w-xs">
                          {entry.details ?? entry.description ?? '—'}
                          {hasMeta && (
                            <span className="ml-1 text-blue-500">{isExpanded ? '▲' : '▼'}</span>
                          )}
                        </td>
                      </tr>
                      {isExpanded && hasMeta && (
                        <tr key={`${entry.id}-meta`} className="bg-gray-50 border-b">
                          <td colSpan={5} className="p-3">
                            <pre className="text-xs text-gray-600 whitespace-pre-wrap break-all bg-white
                              border border-gray-200 rounded-lg p-3">
                              {JSON.stringify(entry.metadata, null, 2)}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        {totalCount > logs.length && (
          <div className="p-4 border-t text-center">
            <button
              onClick={onLoadMore}
              className="text-xs font-semibold px-4 py-2 rounded-lg border border-gray-300
                text-gray-700 hover:bg-gray-100 transition"
            >
              Load more ({totalCount - logs.length} remaining)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function AuditActionBadge({ action }) {
  const key = (action ?? '').toUpperCase();
  const styles = {
    CREATE: 'bg-green-100 text-green-800',
    UPDATE: 'bg-blue-100 text-blue-800',
    DELETE: 'bg-red-100 text-red-800',
    LOGIN:  'bg-purple-100 text-purple-800',
    LOGOUT: 'bg-gray-100 text-gray-600',
  };
  const matched = Object.keys(styles).find((k) => key.includes(k));
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-bold ${matched ? styles[matched] : 'bg-gray-100 text-gray-600'}`}>
      {action ?? 'UNKNOWN'}
    </span>
  );
}

// Renders a stable, locale-aware date/time. Falls back gracefully if the
// timestamp is missing or malformed rather than throwing.
function formatAuditTimestamp(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function PageState({ title, message, actionLabel, onAction }) {
  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-white rounded-xl shadow-sm border p-6 text-center">
        <h1 className="text-xl font-black text-gray-800">{title}</h1>
        {message && (
          <p className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
            {message}
          </p>
        )}
        {actionLabel && onAction && (
          <button
            onClick={onAction}
            className="mt-4 w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-lg transition"
          >
            {actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Form helpers ─────────────────────────────────────────────────────────────

function Field({ label, required, error, hint, children }) {
  return (
    <div>
      <label className="block text-sm font-semibold text-gray-700 mb-1">
        {label}
        {required && <span className="text-red-500 ml-0.5" aria-hidden="true">*</span>}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
      {error && <p role="alert" className="text-xs text-red-500 mt-1">{error}</p>}
    </div>
  );
}
