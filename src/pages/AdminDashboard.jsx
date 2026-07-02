import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import apiClient from '../api/axios';

// ─── Module-level constants ───────────────────────────────────────────────────

const EMPTY_DATA = {
  stats: { activeTrips: 0, totalTrips: 0, totalVans: 0, totalUsers: 0 },
  staff: [],
  fleet: [],
};

const EMPTY_FORM = { name: '', email: '', role: '', driverId: '', password: '' };

// ─── Audit trail config ───────────────────────────────────────────────────────
// The trail accumulates every entry it has ever fetched (persisted to
// localStorage) so admins can scroll back through full history on this page,
// not just "today". A sync runs once on load and again every 24h so the log
// stays current even if the tab is left open for days at a stretch.
const AUDIT_STORAGE_KEY = 'terminalink_admin_audit_history_v1';
const AUDIT_REFRESH_MS  = 24 * 60 * 60 * 1000; // daily background refresh
const AUDIT_MAX_STORED  = 5000;                // hard cap so localStorage can't blow up
const AUDIT_PAGE_SIZE   = 50;                  // "load more" increment in the UI

// Validation rules
const EMAIL_RE     = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DRIVER_ID_RE = /^DRV-\d{3,}$/i;

// Tailwind helper — keeps input JSX clean
const inputCls = (hasError) =>
  `w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2
   focus:ring-blue-400 transition ${
     hasError
       ? 'border-red-400 bg-red-50 focus:ring-red-300'
       : 'border-gray-300 focus:border-blue-400'
   }`;

// ─── AdminDashboard ───────────────────────────────────────────────────────────

export default function AdminDashboard() {
  // ── data state ──
  const [data, setData]           = useState(EMPTY_DATA);
  const [loading, setLoading]     = useState(true);
  const [fetchError, setFetchError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  // ── mutation state ──
  const [isAddOpen, setIsAddOpen]       = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null); // { id, name, role }
  const [mutationLoading, setMutationLoading] = useState(false);
  const [mutationError, setMutationError]     = useState('');
  const [togglingId, setTogglingId]           = useState(null);

  // ── toast state ──
  const [toast, setToast] = useState(null); // { type: 'success'|'error', message }
  const toastTimer = useRef(null);

  // ── audit trail state ──
  // auditLogs holds the FULL accumulated history (newest first), not just the
  // latest fetch — every sync merges in new entries on top of what's already
  // there instead of replacing it.
  const [auditLogs, setAuditLogs]         = useState([]);
  const [auditLoading, setAuditLoading]   = useState(true);
  const [auditError, setAuditError]       = useState('');
  const [auditSearch, setAuditSearch]     = useState('');
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
  // already on the page is ever lost. `silent` skips the loading spinner for
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

  // ── Modal open/close helpers (clear stale errors on each open) ──

  const openAddModal = useCallback(() => {
    setMutationError('');
    setIsAddOpen(true);
  }, []);

  const closeAddModal = useCallback(() => {
    if (mutationLoading) return; // block close while request is in-flight
    setMutationError('');
    setIsAddOpen(false);
  }, [mutationLoading]);

  const openDeleteModal = useCallback((user) => {
    setMutationError('');
    setPendingDelete({
      id: user.id,
      name: user.name ?? 'this user',
      role: user.role,
    });
  }, []);

  const closeDeleteModal = useCallback(() => {
    if (mutationLoading) return;
    setMutationError('');
    setPendingDelete(null);
  }, [mutationLoading]);

  // ── Add staff ──

  const handleAddStaff = useCallback(
    async (formData) => {
      setMutationLoading(true);
      setMutationError('');
      try {
        await apiClient.post('/admin/users', formData);
        setIsAddOpen(false);
        setReloadToken((n) => n + 1);
        showToast('success', `${formData.name} has been added as ${formData.role}.`);
      } catch (err) {
        setMutationError(
          err?.response?.data?.error ??
          err?.response?.data?.message ??
          'Failed to create account. Please check the details and try again.',
        );
      } finally {
        setMutationLoading(false);
      }
    },
    [showToast],
  );

  // ── Delete staff (confirmed) ──

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setMutationLoading(true);
    setMutationError('');
    try {
      await apiClient.delete(`/admin/users/${pendingDelete.id}`);
      showToast('success', `${pendingDelete.name}'s account has been permanently removed.`);
      setPendingDelete(null);
      setReloadToken((n) => n + 1);
    } catch (err) {
      // Keep modal open and display the server's rejection reason
      setMutationError(
        err?.response?.data?.error ??
        err?.response?.data?.message ??
        'Could not delete this account. The server rejected the request.',
      );
    } finally {
      setMutationLoading(false);
    }
  }, [pendingDelete, showToast]);

  // ── Toggle active/disabled ──

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

  const filteredAuditLogs = useMemo(() => {
    const q = auditSearch.trim().toLowerCase();
    if (!q) return auditLogs;
    return auditLogs.filter((entry) => {
      const haystack = [
        entry.actorName, entry.actor, entry.action,
        entry.targetType, entry.target, entry.details, entry.description,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [auditLogs, auditSearch]);

  const visibleAuditLogs = filteredAuditLogs.slice(0, auditVisible);

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
      <div className="max-w-6xl mx-auto bg-white p-5 rounded-xl shadow-sm border mb-6 flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-extrabold text-gray-900">Catanduanes Command Center</h1>
          <p className="text-sm text-gray-500">System Administration &amp; Analytics</p>
        </div>
        <div className="flex items-center gap-3">
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
            <h2 className="text-lg font-bold text-gray-800 mb-4 border-b pb-2">Registered Fleet</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="p-3">Plate</th>
                    <th className="p-3">Capacity</th>
                    <th className="p-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.fleet.length === 0 ? (
                    <EmptyTableRow colSpan={3} message="No fleet records found." />
                  ) : (
                    data.fleet.map((van) => (
                      <tr key={van.id} className="border-b hover:bg-gray-50">
                        <td className="p-3 font-bold text-gray-800">{van.plateNumber ?? '—'}</td>
                        <td className="p-3 text-gray-600">{van.capacity ?? 0} pax</td>
                        <td className="p-3">
                          <span className={`px-2 py-1 rounded text-xs font-bold ${
                            van.status === 'IDLE'
                              ? 'bg-yellow-100 text-yellow-800'
                              : 'bg-green-100 text-green-800'
                          }`}>
                            {van.status ?? 'UNKNOWN'}
                          </span>
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
                onClick={openAddModal}
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
                            <div className="flex gap-1.5 justify-end">
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
                                onClick={() => openDeleteModal(user)}
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

        {/* ── Audit Trail ── */}
        <AuditTrailPanel
          logs={visibleAuditLogs}
          totalCount={filteredAuditLogs.length}
          fullCount={auditLogs.length}
          loading={auditLoading}
          error={auditError}
          search={auditSearch}
          onSearchChange={(v) => { setAuditSearch(v); setAuditVisible(AUDIT_PAGE_SIZE); }}
          lastSync={lastAuditSync}
          onRefresh={() => fetchAuditLogs()}
          onLoadMore={() => setAuditVisible((n) => n + AUDIT_PAGE_SIZE)}
          onClearHistory={handleClearAuditHistory}
        />
      </div>

      {/* ── Modals ── */}
      <AddStaffModal
        isOpen={isAddOpen}
        onClose={closeAddModal}
        onSubmit={handleAddStaff}
        isLoading={mutationLoading}
        serverError={mutationError}
        onClearError={() => setMutationError('')}
      />

      <ConfirmDeleteModal
        user={pendingDelete}
        onClose={closeDeleteModal}
        onConfirm={handleConfirmDelete}
        isLoading={mutationLoading}
        serverError={mutationError}
      />
    </div>
  );
}

// ─── AddStaffModal ────────────────────────────────────────────────────────────
//
// Security notes:
//  • autoComplete="new-password" prevents browsers injecting saved passwords
//  • autoComplete="off" on driverId prevents wrong autofill
//  • All inputs are controlled — no uncontrolled innerHTML risk
//  • Password length enforced: ≥8 for staff, ≥4 for driver PIN
//  • Email validated with regex before submission
//  • Driver ID normalised to uppercase on submit (DRV-001 canonical form)
//  • onClearError called on isOpen change so stale errors never bleed across opens

function AddStaffModal({ isOpen, onClose, onSubmit, isLoading, serverError, onClearError }) {
  const [form, setForm]     = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const nameRef             = useRef(null);

  // Reset and clear errors each time the modal opens
  useEffect(() => {
    if (isOpen) {
      setForm(EMPTY_FORM);
      setErrors({});
      onClearError();
      // Focus the first field after the transition
      const id = setTimeout(() => nameRef.current?.focus(), 60);
      return () => clearTimeout(id);
    }
  }, [isOpen, onClearError]);

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
    // Clear the field-level error on change
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

    const minLen = form.role === 'DRIVER' ? 4 : 8;
    if (!form.password)
      e.password = 'This field is required.';
    else if (form.password.length < minLen)
      e.password = `${form.role === 'DRIVER' ? 'PIN' : 'Password'} must be at least ${minLen} characters.`;

    return e;
  };

  const submit = () => {
    const e = validate();
    if (Object.keys(e).length > 0) { setErrors(e); return; }

    // Build a clean payload — never send fields that don't apply to the role
    onSubmit({
      name:     form.name.trim(),
      role:     form.role,
      password: form.password,
      ...(form.role !== 'DRIVER' && { email: form.email.trim() }),
      ...(form.role === 'DRIVER' && { driverId: form.driverId.trim().toUpperCase() }),
    });
  };

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-modal-title"
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
      // Backdrop click closes (but not while loading)
      onClick={(e) => { if (e.target === e.currentTarget && !isLoading) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">

        {/* Header */}
        <div className="flex justify-between items-center p-5 border-b">
          <h2 id="add-modal-title" className="text-lg font-bold text-gray-900">
            Create New Account
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
              className={`${inputCls(errors.role)} bg-white`}
            >
              <option value="">— Select a role —</option>
              <option value="ADMIN">Admin</option>
              <option value="DISPATCHER">Dispatcher</option>
              <option value="DRIVER">Driver</option>
            </select>
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

          {/* Password / PIN — shown once a role is selected */}
          {form.role && (
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
            {isLoading ? 'Creating…' : 'Create Account'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── ConfirmDeleteModal ───────────────────────────────────────────────────────
//
// Security notes:
//  • Modal stays open on server error so the admin sees the rejection reason
//    (e.g. "cannot delete last admin", "user has active trips")
//  • Shown a stronger warning when the target is an ADMIN role
//  • Close is blocked while the request is in-flight to prevent double-submit
//  • All displayed values (user.name, user.role) flow through JSX — no innerHTML

function ConfirmDeleteModal({ user, onClose, onConfirm, isLoading, serverError }) {
  const isAdminRole = user?.role === 'ADMIN';

  useEffect(() => {
    if (!user) return;
    const fn = (e) => { if (e.key === 'Escape' && !isLoading) onClose(); };
    document.addEventListener('keydown', fn);
    return () => document.removeEventListener('keydown', fn);
  }, [user, isLoading, onClose]);

  if (!user) return null;

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
            Delete Account?
          </h2>
          <p className="text-sm text-gray-500">You are about to permanently delete:</p>

          {/* Target user card */}
          <div className="inline-block py-2 px-5 bg-gray-50 border border-gray-200 rounded-xl text-left">
            <p className="font-bold text-gray-900">{user.name}</p>
            <div className="mt-1">
              <RoleBadge role={user.role} />
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
            This action is <strong>permanent and cannot be undone.</strong> All data
            associated with this account will be removed.
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
            {isLoading ? 'Deleting…' : '🗑 Yes, Delete'}
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

// ─── AuditTrailPanel ──────────────────────────────────────────────────────────
//
// Notes:
//  • `logs` is already the sliced/filtered/paginated view — this component is
//    purely presentational and does no fetching or storage of its own.
//  • The parent keeps the FULL history in state (backed by localStorage), so
//    this panel is really just windowing into however much of it the admin
//    has chosen to reveal via search + "Load more".
//  • Background sync happens automatically once a day; "Refresh Now" lets an
//    admin force an out-of-band check without waiting for the interval.

function AuditTrailPanel({
  logs, totalCount, fullCount, loading, error,
  search, onSearchChange, lastSync, onRefresh, onLoadMore, onClearHistory,
}) {
  return (
    <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200">
      <div className="flex flex-wrap justify-between items-center gap-3 mb-4 border-b pb-3">
        <div>
          <h2 className="text-lg font-bold text-gray-800">Audit Trail</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            {fullCount} {fullCount === 1 ? 'entry' : 'entries'} saved on this page
            {lastSync && <> · Last synced {formatAuditTimestamp(lastSync)}</>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search actor, action, target…"
            className="px-3 py-1.5 border border-gray-300 rounded-lg text-xs w-52
              focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
          />
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
            onClick={onClearHistory}
            title="Clear locally saved history on this device"
            className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-red-200
              text-red-600 hover:bg-red-50 transition"
          >
            Clear history
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
          ⚠️ {error}
        </div>
      )}

      <div className="overflow-x-auto max-h-[28rem] overflow-y-auto">
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
                message={loading ? 'Loading audit history…' : 'No audit entries found.'}
              />
            ) : (
              logs.map((entry) => (
                <tr key={entry.id} className="border-b hover:bg-gray-50 align-top">
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
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalCount > logs.length && (
        <div className="mt-3 text-center">
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
