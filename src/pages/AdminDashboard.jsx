import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import apiClient from '../api/axios';

// ─── Module-level constants ───────────────────────────────────────────────────

const EMPTY_DATA = {
  stats: { activeTrips: 0, totalTrips: 0, totalVans: 0, totalUsers: 0 },
  staff: [],
  vans: [],
};

const EMPTY_STAFF_FORM = { name: '', email: '', role: '', password: '' };
const EMPTY_VAN_FORM   = { plateNumber: '', capacity: '', status: 'IDLE' };

const VAN_STATUSES = ['IDLE', 'DISPATCHED', 'MAINTENANCE', 'OUT_OF_SERVICE'];

const AUDIT_STORAGE_KEY = 'terminalink_admin_audit_history_v1';
const AUDIT_REFRESH_MS  = 24 * 60 * 60 * 1000;
const AUDIT_MAX_STORED  = 5000;
const AUDIT_PAGE_SIZE   = 50;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PLATE_RE = /^[A-Z0-9\- ]{4,15}$/i;

const PASSWORD_MIN = 4;

const VAN_STATUS_BAR_COLORS = {
  IDLE: 'bg-yellow-400',
  DISPATCHED: 'bg-green-500',
  MAINTENANCE: 'bg-orange-400',
  OUT_OF_SERVICE: 'bg-red-500',
};
const ROLE_BAR_COLORS = {
  ADMIN: 'bg-purple-500',
  DISPATCHER: 'bg-blue-500',
  DRIVER: 'bg-gray-400',
};
const APPROVAL_BAR_COLORS = {
  APPROVED: 'bg-green-500',
  PENDING: 'bg-amber-400',
  REJECTED: 'bg-red-500',
};

const inputCls = (hasError) =>
  `w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2
   focus:ring-blue-400 transition ${
     hasError
       ? 'border-red-400 bg-red-50 focus:ring-red-300'
       : 'border-gray-300 focus:border-blue-400'
   }`;

function toCsvField(value) {
  const str = String(value ?? '');
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function describeApiError(err, fallback) {
  if (err?.code === 'ECONNABORTED') {
    return 'The request timed out. Please check your connection and try again.';
  }
  if (err?.response) {
    if (Array.isArray(err.response.data?.errors)) {
      return err.response.data.errors.map(e => e.msg || e.message).join(', ');
    }
    return err.response.data?.error ?? err.response.data?.message ?? fallback;
  }
  if (err?.request) {
    return 'Network error — could not reach the server. Please check your connection and try again.';
  }
  return err?.message ?? fallback;
}

const handleAuthFailure = (err) => {
  if (err?.response?.status === 401 || err?.response?.status === 403) {
    localStorage.removeItem('user');
    window.location.replace('/login');
    return true;
  }
  return false;
};

// ─── Random PIN Generator ─────────────────────────────────────────────────────

const WEAK_PASSWORD_PATTERNS = new Set([
  '0000','1111','2222','3333','4444','5555','6666','7777','8888','9999',
  '00000','11111','22222','33333','44444','55555','66666','77777','88888','99999',
  '000000','111111','222222','333333','444444','555555','666666','777777','888888','999999',
  '0000000','1111111','2222222','3333333','4444444','5555555','6666666','7777777','8888888','9999999',
  '00000000','11111111','22222222','33333333','44444444','55555555','66666666','77777777','88888888','99999999',
  '0123','1234','2345','3456','4567','5678','6789',
  '3210','4321','5432','6543','7654','8765','9876',
  '01234','12345','23456','34567','45678','56789',
  '43210','54321','65432','76543','87654','98765',
  '012345','123456','234567','345678','456789',
  '543210','654321','765432','876543','987654',
  '0123456','1234567','2345678','3456789',
  '6543210','7654321','8765432','9876543',
  '01234567','12345678','23456789',
  '76543210','87654321','98765432',
  '1212','2121','1122','2211','1010','0101',
  '123123','112233','121212','696969','101010',
  '12341234','12121212','11112222',
]);

function isWeakPassword(pw) {
  if (!pw) return true;
  if (/^(.)\1+$/.test(pw)) return true;
  if (WEAK_PASSWORD_PATTERNS.has(pw)) return true;
  if (/^\d+$/.test(pw)) {
    const digits = pw.split('').map(Number);
    let asc = true, desc = true;
    for (let i = 1; i < digits.length; i++) {
      if (digits[i] !== digits[i - 1] + 1) asc = false;
      if (digits[i] !== digits[i - 1] - 1) desc = false;
    }
    if (asc || desc) return true;
  }
  return false;
}

function generateRandomPassword(minLen = 4, maxLen = 8) {
  const len = Math.floor(Math.random() * (maxLen - minLen + 1)) + minLen;
  let pw = '';
  let attempts = 0;
  do {
    pw = '';
    for (let i = 0; i < len; i++) pw += Math.floor(Math.random() * 10);
    attempts++;
  } while (isWeakPassword(pw) && attempts < 200);
  return pw;
}

// ─── AdminDashboard ───────────────────────────────────────────────────────────

export default function AdminDashboard() {
  const [data, setData]             = useState(EMPTY_DATA);
  const [loading, setLoading]       = useState(true);
  const [fetchError, setFetchError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);

  const [isStaffModalOpen, setIsStaffModalOpen] = useState(false);
  const [mutationLoading, setMutationLoading] = useState(false);
  const [mutationError, setMutationError]     = useState('');
  const [togglingId, setTogglingId]           = useState(null);

  const [isVanModalOpen, setIsVanModalOpen] = useState(false);
  const [vanMutationLoading, setVanMutationLoading] = useState(false);
  const [vanMutationError, setVanMutationError]     = useState('');

  const [viewingQrVan, setViewingQrVan] = useState(null);

  const [pendingDelete, setPendingDelete] = useState(null);

  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const [vanSearch, setVanSearch]     = useState('');
  const [staffSearch, setStaffSearch] = useState('');

  const [isAuditOpen, setIsAuditOpen]     = useState(false);
  const [auditLogs, setAuditLogs]         = useState([]);
  const [auditLoading, setAuditLoading]   = useState(true);
  const [auditError, setAuditError]       = useState('');
  const [auditSearch, setAuditSearch]     = useState('');
  const [auditActionFilter, setAuditActionFilter] = useState('');
  const [auditDateFrom, setAuditDateFrom] = useState('');
  const [auditDateTo, setAuditDateTo]     = useState('');
  const [auditVisible, setAuditVisible]   = useState(AUDIT_PAGE_SIZE);
  const [lastAuditSync, setLastAuditSync] = useState(null);
  const lastAuditSyncRef = useRef(null);

  // ── Pending driver applications ──────────────────────────────────────────
  const [pendingDrivers, setPendingDrivers] = useState([]);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [pendingError, setPendingError]     = useState('');
  const [driverActionId, setDriverActionId] = useState(null);
  const [licensePhotoView, setLicensePhotoView] = useState(null);
  const [rejectTarget, setRejectTarget]     = useState(null);
  const [rejectReason, setRejectReason]     = useState('');
  const [rejectSubmitting, setRejectSubmitting] = useState(false);
  const [rejectError, setRejectError]       = useState('');

  const showToast = useCallback((type, message) => {
    clearTimeout(toastTimer.current);
    setToast({ type, message });
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const fetchAdminData = useCallback(async (signal) => {
    setLoading(true);
    setFetchError('');
    try {
      const { data: raw } = await apiClient.get('/admin/dashboard', { signal });
      setData({
        stats: { ...EMPTY_DATA.stats, ...(raw?.stats ?? {}) },
        staff: Array.isArray(raw?.staff) ? raw.staff : Array.isArray(raw?.users) ? raw.users : [],
        vans: Array.isArray(raw?.vans) ? raw.vans : Array.isArray(raw?.fleet) ? raw.fleet : [],
      });
    } catch (err) {
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
      if (handleAuthFailure(err)) return;
      console.error('Failed to load admin dashboard data:', err);
      setFetchError(describeApiError(err, 'Failed to load admin data. Please try again.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchAdminData(ctrl.signal);
    return () => ctrl.abort();
  }, [fetchAdminData, reloadToken]);

  const fetchPendingDrivers = useCallback(async (signal) => {
    setPendingLoading(true);
    setPendingError('');
    try {
      const { data: raw } = await apiClient.get('/admin/drivers/pending', { signal });
      setPendingDrivers(Array.isArray(raw) ? raw : []);
    } catch (err) {
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
      if (handleAuthFailure(err)) return;
      console.error('Failed to load pending drivers:', err);
      setPendingError(describeApiError(err, 'Failed to load pending driver applications.'));
    } finally {
      setPendingLoading(false);
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchPendingDrivers(ctrl.signal);
    return () => ctrl.abort();
  }, [fetchPendingDrivers, reloadToken]);

  const persistAuditHistory = useCallback((logs, syncTime) => {
    try {
      const trimmed = logs.slice(0, AUDIT_MAX_STORED);
      localStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify({ logs: trimmed, lastSync: syncTime }));
    } catch { /* ignore */ }
  }, []);

  const fetchAuditLogs = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setAuditLoading(true);
    setAuditError('');
    try {
      const since = lastAuditSyncRef.current;
      const { data: raw } = await apiClient.get('/admin/audit-logs', { params: since ? { since } : undefined });
      const incoming = Array.isArray(raw?.logs) ? raw.logs : Array.isArray(raw) ? raw : [];

      setAuditLogs((prev) => {
        const byId = new Map(prev.map((entry) => [entry.id, entry]));
        incoming.forEach((entry) => { if (entry?.id != null) byId.set(entry.id, entry); });
        const merged = Array.from(byId.values()).sort((a, b) => new Date(b.timestamp ?? b.createdAt ?? 0) - new Date(a.timestamp ?? a.createdAt ?? 0));
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
  }, [persistAuditHistory]);

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
    } catch { /* ignore */ }

    fetchAuditLogs();
    const id = setInterval(() => fetchAuditLogs({ silent: true }), AUDIT_REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchAuditLogs]);

  const handleClearAuditHistory = useCallback(() => {
    if (!window.confirm('Clear all locally saved audit history on this device? This does not delete anything on the server.')) return;
    try { localStorage.removeItem(AUDIT_STORAGE_KEY); } catch { /* ignore */ }
    setAuditLogs([]);
    setAuditVisible(AUDIT_PAGE_SIZE);
    lastAuditSyncRef.current = null;
    setLastAuditSync(null);
    fetchAuditLogs();
  }, [fetchAuditLogs]);

  const handleLogout = useCallback(async () => {
    setLoggingOut(true);
    try {
      await apiClient.post('/auth/logout');
    } catch (err) {
      console.error('Logout request failed, logging out locally anyway:', err);
    } finally {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      try { localStorage.removeItem(AUDIT_STORAGE_KEY); } catch (err) { console.error(err); }
      window.location.replace('/login');
    }
  }, []);

  const openAddStaffModal = useCallback(() => { setMutationError(''); setIsStaffModalOpen(true); }, []);
  const closeStaffModal = useCallback(() => { if (mutationLoading) return; setMutationError(''); setIsStaffModalOpen(false); }, [mutationLoading]);

  const openAddVanModal = useCallback(() => { setVanMutationError(''); setIsVanModalOpen(true); }, []);
  const closeVanModal = useCallback(() => { if (vanMutationLoading) return; setVanMutationError(''); setIsVanModalOpen(false); }, [vanMutationLoading]);

  const openDeleteUserModal = useCallback((user) => {
    setMutationError('');
    setPendingDelete({ kind: 'user', id: user.id, label: user.name ?? 'this user', sublabel: user.email || user.driverId || '', role: user.role });
  }, []);

  const openDeleteVanModal = useCallback((van) => {
    setVanMutationError('');
    setPendingDelete({ kind: 'van', id: van.id, label: van.plateNumber ?? 'this van', sublabel: `${van.capacity ?? 0} pax · ${van.status ?? 'UNKNOWN'}` });
  }, []);

  const closeDeleteModal = useCallback(() => {
    if (mutationLoading || vanMutationLoading) return;
    setMutationError(''); setVanMutationError(''); setPendingDelete(null);
  }, [mutationLoading, vanMutationLoading]);

  const handleSubmitStaff = useCallback(async (formData) => {
    setMutationLoading(true);
    setMutationError('');
    try {
      await apiClient.post('/admin/users', formData);
      showToast('success', `${formData.name} has been added as ${formData.role}.`);
      setIsStaffModalOpen(false);
      setReloadToken((n) => n + 1);
    } catch (err) {
      if (handleAuthFailure(err)) return;
      console.error('Failed to save staff account:', err);
      setMutationError(describeApiError(err, 'Failed to save this account. Please check the details and try again.'));
    } finally {
      setMutationLoading(false);
    }
  }, [showToast]);

  const handleSubmitVan = useCallback(async (formData) => {
    setVanMutationLoading(true);
    setVanMutationError('');
    try {
      const { data: res } = await apiClient.post('/admin/vans', formData);
      showToast('success', `${formData.plateNumber} has been registered.`);
      setIsVanModalOpen(false);
      // Show the new van's QR right away so the admin can print the sticker.
      setViewingQrVan(res);
      setReloadToken((n) => n + 1);
    } catch (err) {
      if (handleAuthFailure(err)) return;
      console.error('Failed to save van:', err);
      setVanMutationError(describeApiError(err, 'Failed to save this van. Please check the details and try again.'));
    } finally {
      setVanMutationLoading(false);
    }
  }, [showToast]);

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const isVan = pendingDelete.kind === 'van';
    isVan ? setVanMutationLoading(true) : setMutationLoading(true);
    isVan ? setVanMutationError('') : setMutationError('');
    try {
      await apiClient.delete(isVan ? `/admin/vans/${pendingDelete.id}` : `/admin/users/${pendingDelete.id}`);
      setData((prev) => isVan ? { ...prev, vans: prev.vans.filter((v) => v.id !== pendingDelete.id) } : { ...prev, staff: prev.staff.filter((u) => u.id !== pendingDelete.id) });
      showToast('success', isVan ? `${pendingDelete.label} has been removed from the vans list.` : `${pendingDelete.label}'s account has been permanently removed.`);
      setPendingDelete(null);
      setReloadToken((n) => n + 1);
    } catch (err) {
      if (handleAuthFailure(err)) return;
      console.error(`Failed to delete ${isVan ? 'van' : 'user'}:`, err);
      const message = describeApiError(err, `Could not delete ${isVan ? 'this van' : 'this account'}. The server rejected the request.`);
      isVan ? setVanMutationError(message) : setMutationError(message);
    } finally {
      isVan ? setVanMutationLoading(false) : setMutationLoading(false);
    }
  }, [pendingDelete, showToast]);

  const handleToggleActive = useCallback(async (user) => {
    if (togglingId !== null) return;
    setTogglingId(user.id);
    const next = !user.isActive;
    try {
      await apiClient.patch(`/admin/users/${user.id}`, { isActive: next });
      setData((prev) => ({ ...prev, staff: prev.staff.map((u) => u.id === user.id ? { ...u, isActive: next } : u) }));
      showToast('success', `${user.name ?? 'User'} has been ${next ? 'activated' : 'deactivated'}.`);
    } catch (err) {
      if (handleAuthFailure(err)) return;
      console.error('Failed to toggle user active status:', err);
      showToast('error', describeApiError(err, `Could not update ${user.name ?? 'this user'}'s status. Please try again.`));
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
      showToast('success', `${driver.name} has been approved and can now log in.`);
      setReloadToken((n) => n + 1);
    } catch (err) {
      if (handleAuthFailure(err)) return;
      console.error('Failed to approve driver:', err);
      showToast('error', describeApiError(err, `Could not approve ${driver.name}. Please try again.`));
    } finally {
      setDriverActionId(null);
    }
  }, [driverActionId, showToast]);

  const openRejectModal = useCallback((driver) => {
    setRejectError('');
    setRejectReason('');
    setRejectTarget(driver);
  }, []);

  const closeRejectModal = useCallback(() => {
    if (rejectSubmitting) return;
    setRejectTarget(null);
    setRejectReason('');
    setRejectError('');
  }, [rejectSubmitting]);

  const handleConfirmReject = useCallback(async () => {
    if (!rejectTarget) return;
    setRejectSubmitting(true);
    setRejectError('');
    try {
      await apiClient.patch(`/admin/drivers/${rejectTarget.id}/reject`, {
        reason: rejectReason.trim() || undefined,
      });
      setPendingDrivers((prev) => prev.filter((d) => d.id !== rejectTarget.id));
      showToast('success', `${rejectTarget.name}'s application has been rejected.`);
      setRejectTarget(null);
      setRejectReason('');
      setReloadToken((n) => n + 1);
    } catch (err) {
      if (handleAuthFailure(err)) return;
      console.error('Failed to reject driver:', err);
      setRejectError(describeApiError(err, 'Could not reject this application. Please try again.'));
    } finally {
      setRejectSubmitting(false);
    }
  }, [rejectTarget, rejectReason, showToast]);

  // Pending drivers already have their own section above — keep them out of
  // the main staff table so nobody appears twice.
  const staffTableData = useMemo(
    () => data.staff.filter((u) => !(u.role === 'DRIVER' && u.approvalStatus === 'PENDING')),
    [data.staff],
  );

  const filteredVans = useMemo(() => {
    const q = vanSearch.trim().toLowerCase();
    if (!q) return data.vans;
    return data.vans.filter((van) => {
      const driverName = van.driverName ?? van.driver?.name ?? '';
      return (
        String(van.plateNumber ?? '').toLowerCase().includes(q) ||
        String(van.status ?? '').toLowerCase().includes(q) ||
        String(van.capacity ?? '').toLowerCase().includes(q) ||
        String(driverName).toLowerCase().includes(q)
      );
    });
  }, [data.vans, vanSearch]);

  const filteredStaff = useMemo(() => {
    const q = staffSearch.trim().toLowerCase();
    if (!q) return staffTableData;
    return staffTableData.filter((user) => (
      String(user.name ?? '').toLowerCase().includes(q) ||
      String(user.email ?? '').toLowerCase().includes(q) ||
      String(user.driverId ?? '').toLowerCase().includes(q) ||
      String(user.contactNumber ?? '').toLowerCase().includes(q) ||
      String(user.role ?? '').toLowerCase().includes(q)
    ));
  }, [staffTableData, staffSearch]);

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
      const haystack = [entry.actorName, entry.actor, entry.action, entry.targetType, entry.target, entry.details, entry.description].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [auditLogs, auditSearch, auditActionFilter, auditDateFrom, auditDateTo]);

  const visibleAuditLogs = filteredAuditLogs.slice(0, auditVisible);

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
    setAuditSearch(''); setAuditActionFilter(''); setAuditDateFrom(''); setAuditDateTo(''); setAuditVisible(AUDIT_PAGE_SIZE);
  }, []);

  // ── Analytics ──────────────────────────────────────────────────────────
  const roleBreakdown = useMemo(() => {
    const counts = { ADMIN: 0, DISPATCHER: 0, DRIVER: 0 };
    data.staff.forEach((u) => { if (counts[u.role] !== undefined) counts[u.role] += 1; });
    return counts;
  }, [data.staff]);

  const vanStatusBreakdown = useMemo(() => {
    const counts = {};
    VAN_STATUSES.forEach((s) => { counts[s] = 0; });
    data.vans.forEach((v) => { if (counts[v.status] !== undefined) counts[v.status] += 1; });
    return counts;
  }, [data.vans]);

  // `data.staff` already includes every driver (pending/approved/rejected),
  // so this reads straight off it — no separate addition needed.
  const driverApprovalBreakdown = useMemo(() => {
    const counts = { APPROVED: 0, PENDING: 0, REJECTED: 0 };
    data.staff.forEach((u) => {
      if (u.role !== 'DRIVER') return;
      const status = u.approvalStatus ?? 'APPROVED';
      if (counts[status] !== undefined) counts[status] += 1;
    });
    return counts;
  }, [data.staff]);

  if (loading) return <PageState loading title="Loading Command Center…" />;

  if (fetchError) {
    return <PageState title="Dashboard unavailable" message={fetchError} actionLabel="Retry" onAction={() => setReloadToken((n) => n + 1)} />;
  }

  const anyMutationBusy = mutationLoading || vanMutationLoading;

  return (
    <div className="min-h-screen bg-gray-100 p-3 sm:p-4 md:p-6">
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed top-3 left-1/2 -translate-x-1/2 z-50 px-4 py-3 rounded-xl shadow-xl font-semibold text-sm flex items-center gap-3 max-w-[calc(100%-1.5rem)] sm:max-w-sm w-full border ${
            toast.type === 'success' ? 'bg-green-50 text-green-800 border-green-200' : 'bg-red-50 text-red-800 border-red-200'
          }`}
        >
          <span className="flex-1">{toast.type === 'success' ? '✅' : '⚠️'} {toast.message}</span>
          <button onClick={() => setToast(null)} aria-label="Dismiss" className="opacity-50 hover:opacity-100 font-bold text-base leading-none">✕</button>
        </div>
      )}

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="max-w-6xl mx-auto bg-white p-4 sm:p-5 rounded-xl shadow-sm border mb-4 sm:mb-6 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-extrabold text-gray-900 leading-tight">Catanduanes Command Center</h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-0.5">System Administration &amp; Analytics</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setIsAuditOpen(true)}
            title="View the full audit trail"
            className="text-xs sm:text-sm font-semibold px-3 sm:px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100 transition flex items-center gap-2 flex-1 sm:flex-initial justify-center"
          >
            🧾 <span className="hidden xs:inline sm:inline">Audit Trail</span>
            <span className="bg-gray-100 text-gray-600 text-xs font-bold px-1.5 py-0.5 rounded">{auditLogs.length}</span>
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
            disabled={loggingOut}
            className="bg-red-50 text-red-600 font-bold px-3 sm:px-4 py-2 rounded-lg border border-red-200 hover:bg-red-100 transition text-xs sm:text-sm disabled:opacity-50 disabled:cursor-not-allowed flex-1 sm:flex-initial"
          >
            {loggingOut ? 'Logging out…' : 'Log out'}
          </button>
        </div>
      </div>

      <div className="max-w-6xl mx-auto space-y-4 sm:space-y-6">
        {/* ── Stat cards ───────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
          <StatCard title="Active Trips" value={data.stats.activeTrips} color="text-green-600" icon="🚐" />
          <StatCard title="Total Trips" value={data.stats.totalTrips} color="text-blue-600" icon="📊" />
          <StatCard title="Total Vans" value={data.stats.totalVans} color="text-purple-600" icon="🚌" />
          <StatCard title="Total Staff" value={data.stats.totalUsers} color="text-orange-600" icon="👥" />
        </div>

        {/* ── Analytics ────────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
          <BreakdownCard
            title="Staff by Role"
            entries={[
              { label: 'Admin', count: roleBreakdown.ADMIN, colorClass: ROLE_BAR_COLORS.ADMIN },
              { label: 'Dispatcher', count: roleBreakdown.DISPATCHER, colorClass: ROLE_BAR_COLORS.DISPATCHER },
              { label: 'Driver', count: roleBreakdown.DRIVER, colorClass: ROLE_BAR_COLORS.DRIVER },
            ]}
          />
          <BreakdownCard
            title="Fleet Status"
            entries={VAN_STATUSES.map((s) => ({
              label: s.replace('_', ' '),
              count: vanStatusBreakdown[s],
              colorClass: VAN_STATUS_BAR_COLORS[s],
            }))}
          />
          <BreakdownCard
            title="Driver Approvals"
            entries={[
              { label: 'Approved', count: driverApprovalBreakdown.APPROVED, colorClass: APPROVAL_BAR_COLORS.APPROVED },
              { label: 'Pending', count: driverApprovalBreakdown.PENDING, colorClass: APPROVAL_BAR_COLORS.PENDING },
              { label: 'Rejected', count: driverApprovalBreakdown.REJECTED, colorClass: APPROVAL_BAR_COLORS.REJECTED },
            ]}
          />
        </div>

        {/* ── Pending driver applications ─────────────────────────────── */}
        <div className="bg-white p-3 sm:p-4 rounded-xl shadow-sm border border-gray-200">
          <div className="flex justify-between items-center mb-3 border-b pb-3">
            <h2 className="text-base sm:text-lg font-bold text-gray-800 flex items-center gap-2">
              Pending Driver Applications
              <span className="text-xs font-bold bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">{pendingDrivers.length}</span>
            </h2>
          </div>

          {pendingLoading ? (
            <p className="text-sm text-gray-400 text-center py-6">Loading applications…</p>
          ) : pendingError ? (
            <p className="text-sm text-red-600 text-center py-6">{pendingError}</p>
          ) : pendingDrivers.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-6 italic">No pending applications right now.</p>
          ) : (
            <div className="space-y-3">
              {pendingDrivers.map((driver) => {
                const isBusy = driverActionId === driver.id;
                return (
                  <div
                    key={driver.id}
                    className={`flex flex-col sm:flex-row sm:items-center gap-3 border border-gray-200 rounded-lg p-3 transition-opacity ${isBusy ? 'opacity-50' : ''}`}
                  >
                    <button
                      type="button"
                      onClick={() => driver.licensePhotoUrl && setLicensePhotoView(driver)}
                      disabled={!driver.licensePhotoUrl}
                      className="shrink-0 w-16 h-16 rounded-lg border border-gray-200 overflow-hidden bg-gray-50 disabled:cursor-default"
                      title="View license photo"
                    >
                      {driver.licensePhotoUrl ? (
                        <img src={driver.licensePhotoUrl} alt="License" className="w-full h-full object-cover" />
                      ) : (
                        <span className="flex items-center justify-center h-full text-xl">📄</span>
                      )}
                    </button>

                    <div className="flex-1 min-w-0">
                      <div className="font-bold text-gray-800">{driver.name}</div>
                      <div className="text-xs text-gray-400 mt-0.5 flex flex-wrap gap-x-3">
                        <span>ID: {driver.driverId}</span>
                        <span>📞 {driver.contactNumber || '—'}</span>
                        <span>Applied {formatAuditTimestamp(driver.createdAt)}</span>
                      </div>
                    </div>

                    <div className="flex gap-2 shrink-0">
                      <button
                        onClick={() => handleApproveDriver(driver)}
                        disabled={isBusy}
                        className="text-xs font-bold px-3 py-1.5 rounded-lg border border-green-300 text-green-700 bg-green-50 hover:bg-green-100 transition disabled:opacity-40"
                      >
                        {isBusy ? '…' : '✓ Approve'}
                      </button>
                      <button
                        onClick={() => openRejectModal(driver)}
                        disabled={isBusy}
                        className="text-xs font-bold px-3 py-1.5 rounded-lg border border-red-300 text-red-600 bg-red-50 hover:bg-red-100 transition disabled:opacity-40"
                      >
                        ✕ Reject
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
          {/* ── Vans card ─────────────────────────────────────────────── */}
          <div className="bg-white p-3 sm:p-4 rounded-xl shadow-sm border border-gray-200">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 sm:gap-3 mb-3 border-b pb-3">
              <h2 className="text-base sm:text-lg font-bold text-gray-800 flex items-center gap-2">
                Registered Vans
                <span className="text-xs font-bold bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{data.vans.length}</span>
              </h2>
              <button
                onClick={openAddVanModal}
                className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold px-3 py-1.5 rounded-lg transition shadow-sm whitespace-nowrap self-stretch sm:self-auto"
              >
                ＋ Add Van
              </button>
            </div>

            {data.vans.length > 0 && (
              <div className="mb-3">
                <SearchInput
                  value={vanSearch}
                  onChange={setVanSearch}
                  placeholder="Search vans…"
                  ariaLabel="Search vans"
                />
              </div>
            )}

            <div className="overflow-x-auto -mx-3 sm:mx-0">
              <table className="w-full text-sm text-left min-w-[420px]">
                <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="p-3">Plate</th>
                    <th className="p-3">Capacity</th>
                    <th className="p-3">Status</th>
                    <th className="p-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredVans.length === 0 ? (
                    <EmptyTableRow
                      colSpan={4}
                      message={
                        data.vans.length === 0
                          ? 'No vans yet. Tap "Add Van" to register the first one.'
                          : 'No vans match your search.'
                      }
                    />
                  ) : filteredVans.map((van) => {
                    const driverName = van.driverName ?? van.driver?.name ?? null;
                    return (
                      <tr key={van.id} className="border-b hover:bg-gray-50">
                        <td className="p-3">
                          <div className="font-bold text-gray-800">{van.plateNumber ?? '—'}</div>
                          {driverName && <div className="text-xs text-gray-400 mt-0.5">Driver: {driverName}</div>}
                        </td>
                        <td className="p-3 text-gray-600">{van.capacity ?? 0} pax</td>
                        <td className="p-3"><VanStatusBadge status={van.status} /></td>
                        <td className="p-3">
                          <div className="flex gap-1.5 justify-end">
                            <button onClick={() => setViewingQrVan(van)} title="View this van's scan QR" className="text-xs font-semibold px-2 py-1 rounded border border-purple-300 text-purple-700 bg-purple-50 hover:bg-purple-100 transition">QR</button>
                            <button onClick={() => openDeleteVanModal(van)} className="text-xs font-semibold px-2 py-1 rounded border border-red-300 text-red-600 bg-red-50 hover:bg-red-100 transition">Delete</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Staff card ────────────────────────────────────────────── */}
          <div className="bg-white p-3 sm:p-4 rounded-xl shadow-sm border border-gray-200">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 sm:gap-3 mb-3 border-b pb-3">
              <h2 className="text-base sm:text-lg font-bold text-gray-800 flex items-center gap-2">
                System Users &amp; Drivers
                <span className="text-xs font-bold bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{staffTableData.length}</span>
              </h2>
              <button
                onClick={openAddStaffModal}
                className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold px-3 py-1.5 rounded-lg transition shadow-sm whitespace-nowrap self-stretch sm:self-auto"
              >
                ＋ Add Staff Account
              </button>
            </div>

            {staffTableData.length > 0 && (
              <div className="mb-3">
                <SearchInput
                  value={staffSearch}
                  onChange={setStaffSearch}
                  placeholder="Search staff…"
                  ariaLabel="Search staff"
                />
              </div>
            )}

            <div className="overflow-x-auto -mx-3 sm:mx-0">
              <table className="w-full text-sm text-left min-w-[560px]">
                <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="p-3">Name</th>
                    <th className="p-3">Contact</th>
                    <th className="p-3">Role</th>
                    <th className="p-3">Status</th>
                    <th className="p-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredStaff.length === 0 ? (
                    <EmptyTableRow
                      colSpan={5}
                      message={
                        staffTableData.length === 0
                          ? 'No staff accounts yet. Tap "Add Staff Account" to create one.'
                          : 'No staff match your search.'
                      }
                    />
                  ) : filteredStaff.map((user) => {
                    const isBusy = togglingId === user.id;
                    const anyToggling = togglingId !== null;
                    const isRejectedDriver = user.role === 'DRIVER' && user.approvalStatus === 'REJECTED';
                    return (
                      <tr key={user.id} className={`border-b hover:bg-gray-50 transition-opacity ${isBusy ? 'opacity-50' : ''}`}>
                        <td className="p-3">
                          <div className="font-bold text-gray-800 leading-tight">{user.name ?? 'Unnamed'}</div>
                          <div className="text-xs text-gray-400 mt-0.5 break-all">{user.email || user.driverId || '—'}</div>
                        </td>
                        <td className="p-3 text-gray-600 whitespace-nowrap">{user.contactNumber || '—'}</td>
                        <td className="p-3"><RoleBadge role={user.role} /></td>
                        <td className="p-3">
                          {isRejectedDriver ? (
                            <span className="px-2 py-0.5 rounded text-xs font-bold bg-red-100 text-red-700">Rejected</span>
                          ) : (
                            <span className={`px-2 py-0.5 rounded text-xs font-bold ${user.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                              {user.isActive ? 'Active' : 'Disabled'}
                            </span>
                          )}
                        </td>
                        <td className="p-3">
                          <div className="flex flex-wrap gap-1.5 justify-end">
                            {!isRejectedDriver && (
                              <button onClick={() => handleToggleActive(user)} disabled={isBusy || anyToggling} className={`text-xs font-semibold px-2 py-1 rounded border transition disabled:opacity-40 disabled:cursor-not-allowed ${user.isActive ? 'border-yellow-300 text-yellow-700 bg-yellow-50 hover:bg-yellow-100' : 'border-green-300 text-green-700 bg-green-50 hover:bg-green-100'}`}>
                                {isBusy ? '…' : user.isActive ? 'Disable' : 'Enable'}
                              </button>
                            )}
                            <button onClick={() => openDeleteUserModal(user)} disabled={isBusy || anyToggling} className="text-xs font-semibold px-2 py-1 rounded border border-red-300 text-red-600 bg-red-50 hover:bg-red-100 transition disabled:opacity-40 disabled:cursor-not-allowed">Delete</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <AuditTrailModal
        isOpen={isAuditOpen} onClose={() => setIsAuditOpen(false)} logs={visibleAuditLogs} totalCount={filteredAuditLogs.length} fullCount={auditLogs.length}
        loading={auditLoading} error={auditError} search={auditSearch} onSearchChange={(v) => { setAuditSearch(v); setAuditVisible(AUDIT_PAGE_SIZE); }}
        actionFilter={auditActionFilter} onActionFilterChange={(v) => { setAuditActionFilter(v); setAuditVisible(AUDIT_PAGE_SIZE); }} actionOptions={auditActionOptions}
        dateFrom={auditDateFrom} onDateFromChange={(v) => { setAuditDateFrom(v); setAuditVisible(AUDIT_PAGE_SIZE); }} dateTo={auditDateTo} onDateToChange={(v) => { setAuditDateTo(v); setAuditVisible(AUDIT_PAGE_SIZE); }}
        onClearFilters={clearAuditFilters} lastSync={lastAuditSync} onRefresh={() => fetchAuditLogs()} onLoadMore={() => setAuditVisible((n) => n + AUDIT_PAGE_SIZE)}
        onClearHistory={handleClearAuditHistory} onExportCsv={handleExportAuditCsv}
      />
      <StaffFormModal isOpen={isStaffModalOpen} onClose={closeStaffModal} onSubmit={handleSubmitStaff} isLoading={mutationLoading} serverError={mutationError} onClearError={() => setMutationError('')} />
      <VanFormModal isOpen={isVanModalOpen} onClose={closeVanModal} onSubmit={handleSubmitVan} isLoading={vanMutationLoading} serverError={vanMutationError} onClearError={() => setVanMutationError('')} />
      <QrOnlyModal van={viewingQrVan} onClose={() => setViewingQrVan(null)} />
      <ConfirmDeleteModal target={pendingDelete} onClose={closeDeleteModal} onConfirm={handleConfirmDelete} isLoading={anyMutationBusy} serverError={pendingDelete?.kind === 'van' ? vanMutationError : mutationError} />
      <LicensePhotoModal driver={licensePhotoView} onClose={() => setLicensePhotoView(null)} />
      <RejectDriverModal
        target={rejectTarget}
        reason={rejectReason}
        onReasonChange={setRejectReason}
        onClose={closeRejectModal}
        onConfirm={handleConfirmReject}
        isLoading={rejectSubmitting}
        serverError={rejectError}
      />
    </div>
  );
}

// ─── StaffFormModal (Add only — Admin & Dispatcher accounts) ─────────────────

function StaffFormModal({ isOpen, onClose, onSubmit, isLoading, serverError, onClearError }) {
  const [form, setForm]     = useState(EMPTY_STAFF_FORM);
  const [errors, setErrors] = useState({});
  const [passwordVisible, setPasswordVisible] = useState(false);
  const nameRef              = useRef(null);

  useEffect(() => {
    if (isOpen) {
      setForm(EMPTY_STAFF_FORM);
      setErrors({});
      setPasswordVisible(false);
      onClearError();
      const id = setTimeout(() => nameRef.current?.focus(), 60);
      return () => clearTimeout(id);
    }
  }, [isOpen, onClearError]);

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

  const handleGeneratePassword = () => {
    const pw = generateRandomPassword();
    setForm((p) => ({ ...p, password: pw }));
    setErrors((p) => ({ ...p, password: '' }));
    setPasswordVisible(true);
    if (serverError) onClearError();
  };

  const validate = () => {
    const e   = {};
    const nm  = form.name.trim();
    const em  = form.email.trim();

    if (!nm) e.name = 'Full name is required.';
    else if (nm.length > 100) e.name = 'Name must be 100 characters or fewer.';

    if (!form.role) e.role = 'Role is required.';

    if (!em) e.email = 'Email address is required.';
    else if (!EMAIL_RE.test(em)) e.email = 'Enter a valid email address.';

    if (!form.password) e.password = 'A PIN is required.';
    else if (form.password.length < PASSWORD_MIN) e.password = `PIN must be at least ${PASSWORD_MIN} characters.`;

    return e;
  };

  const submit = () => {
    const e = validate();
    if (Object.keys(e).length > 0) { setErrors(e); return; }

    onSubmit({
      name: form.name.trim(),
      role: form.role,
      email: form.email.trim(),
      password: form.password,
    });
  };

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="staff-modal-title"
      className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !isLoading) onClose(); }}
    >
      <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full max-w-md max-h-[95vh] sm:max-h-[90vh] flex flex-col">
        <div className="flex justify-between items-center p-4 sm:p-5 border-b">
          <h2 id="staff-modal-title" className="text-base sm:text-lg font-bold text-gray-900">Add Staff Account</h2>
          <button onClick={onClose} disabled={isLoading} aria-label="Close" className="text-gray-400 hover:text-gray-600 disabled:opacity-40 text-xl leading-none p-1">✕</button>
        </div>
        {serverError && <div className="mx-4 sm:mx-5 mt-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">⚠️ {serverError}</div>}
        <div className="p-4 sm:p-5 space-y-4 overflow-y-auto">
          <Field label="Full Name" required error={errors.name}>
            <input ref={nameRef} name="name" type="text" value={form.name} onChange={change} placeholder="e.g. Juan dela Cruz" autoComplete="name" maxLength={100} className={inputCls(errors.name)} />
          </Field>

          <Field label="Role" required error={errors.role}>
            <select name="role" value={form.role} onChange={change} className={`${inputCls(errors.role)} bg-white`}>
              <option value="">— Select a role —</option>
              <option value="ADMIN">Admin</option>
              <option value="DISPATCHER">Dispatcher</option>
            </select>
            <p className="text-xs text-blue-600 mt-1.5 font-medium">Drivers register themselves and are approved from the Pending Driver Applications list above — they aren't created here.</p>
          </Field>

          <Field label="Email Address" required error={errors.email}>
            <input name="email" type="email" value={form.email} onChange={change} placeholder="staff@terminal.gov.ph" autoComplete="email" className={inputCls(errors.email)} />
          </Field>

          <Field
            label="PIN"
            required
            error={errors.password}
            hint={`At least ${PASSWORD_MIN} characters. Use the generator for a quick, non-obvious PIN.`}
            action={<GeneratePasswordButton onGenerate={handleGeneratePassword} />}
          >
            <PasswordInput
              name="password"
              value={form.password}
              onChange={change}
              placeholder="Enter a PIN"
              autoComplete="new-password"
              hasError={errors.password}
              maxLength={128}
              visible={passwordVisible}
              onToggleVisible={() => setPasswordVisible((v) => !v)}
            />
          </Field>
        </div>
        <div className="flex flex-col-reverse sm:flex-row gap-2 sm:gap-3 p-4 sm:p-5 border-t bg-gray-50 rounded-b-2xl">
          <button onClick={onClose} disabled={isLoading} className="flex-1 py-2.5 sm:py-2 border border-gray-300 rounded-lg text-sm font-semibold text-gray-700 hover:bg-gray-100 transition disabled:opacity-40">Cancel</button>
          <button onClick={submit} disabled={isLoading} className="flex-1 py-2.5 sm:py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-bold transition disabled:opacity-70 disabled:cursor-not-allowed">
            {isLoading ? 'Creating…' : 'Create Account'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── VanFormModal (Add only) ───────────────────────────────────────────────

function VanFormModal({ isOpen, onClose, onSubmit, isLoading, serverError, onClearError }) {
  const [form, setForm]     = useState(EMPTY_VAN_FORM);
  const [errors, setErrors] = useState({});
  const plateRef             = useRef(null);

  useEffect(() => {
    if (isOpen) {
      setForm(EMPTY_VAN_FORM);
      setErrors({});
      onClearError();
      const id = setTimeout(() => plateRef.current?.focus(), 60);
      return () => clearTimeout(id);
    }
  }, [isOpen, onClearError]);

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

    if (!plt) e.plateNumber = 'Plate number is required.';
    else if (!PLATE_RE.test(plt)) e.plateNumber = 'Use letters, numbers, spaces, or dashes only (4–15 chars).';

    if (!form.capacity) e.capacity = 'Capacity is required.';
    else if (!Number.isInteger(cap) || cap < 1 || cap > 30) e.capacity = 'Enter a whole number between 1 and 30.';

    if (!form.status) e.status = 'Status is required.';

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
      className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !isLoading) onClose(); }}
    >
      <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full max-w-md max-h-[95vh] sm:max-h-[90vh] flex flex-col">
        <div className="flex justify-between items-center p-4 sm:p-5 border-b bg-slate-50">
          <h2 id="van-modal-title" className="text-base sm:text-lg font-black text-gray-900">Add Van</h2>
          <button onClick={onClose} disabled={isLoading} aria-label="Close" className="text-gray-400 hover:text-gray-600 disabled:opacity-40 text-xl leading-none p-1">✕</button>
        </div>

        {serverError && <div className="mx-4 sm:mx-5 mt-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm font-medium">⚠️ {serverError}</div>}

        <div className="p-4 sm:p-5 overflow-y-auto space-y-4">
          <Field label="Plate Number" required error={errors.plateNumber}>
            <input ref={plateRef} name="plateNumber" type="text" value={form.plateNumber} onChange={change} placeholder="e.g. ABC-1234" autoComplete="off" maxLength={15} className={`${inputCls(errors.plateNumber)} uppercase`} />
          </Field>

          <div className="grid grid-cols-2 gap-3 sm:gap-4">
            <Field label="Capacity" required error={errors.capacity} hint="Seats (1-30).">
              <input name="capacity" type="number" min={1} max={30} value={form.capacity} onChange={change} placeholder="e.g. 14" className={inputCls(errors.capacity)} />
            </Field>
            <Field label="Status" required error={errors.status}>
              <select name="status" value={form.status} onChange={change} className={`${inputCls(errors.status)} bg-white`}>
                {VAN_STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
              </select>
            </Field>
          </div>

          <p className="text-xs text-blue-600 font-medium">
            Once registered, you'll see the van's scannable QR code right away. Driver assignment happens automatically as drivers are approved and start trips.
          </p>
        </div>

        <div className="flex flex-col-reverse sm:flex-row gap-2 sm:gap-3 p-4 sm:p-5 border-t bg-gray-50 rounded-b-2xl">
          <button onClick={onClose} disabled={isLoading} className="flex-1 py-2.5 sm:py-2 border border-gray-300 rounded-lg text-sm font-semibold text-gray-700 hover:bg-gray-100 transition disabled:opacity-40">Cancel</button>
          <button onClick={submit} disabled={isLoading} className="flex-[2] py-2.5 sm:py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-bold transition disabled:opacity-70 disabled:cursor-not-allowed">
            {isLoading ? 'Creating…' : 'Add Van'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── QrOnlyModal ────────────────────────────────────────────────────────────

function QrOnlyModal({ van, onClose }) {
  useEffect(() => {
    if (!van) return;
    const fn = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', fn);
    return () => document.removeEventListener('keydown', fn);
  }, [van, onClose]);

  if (!van) return null;

  const qrToken = van.qrToken;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="qr-only-title"
      className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
    >
      <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full max-w-sm max-h-[95vh] sm:max-h-[90vh] flex flex-col">
        <div className="p-5 sm:p-6 space-y-4 text-center overflow-y-auto">
          <div className="text-4xl" aria-hidden="true">📱</div>
          <h2 id="qr-only-title" className="text-base sm:text-lg font-black text-gray-900">{van.plateNumber} — Scan QR</h2>

          {!qrToken ? (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
              No QR token was returned for this van by the server.
            </div>
          ) : (
            <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 sm:p-4 text-left space-y-3">
              <div className="flex items-center gap-2">
                <code className="flex-1 text-[11px] bg-white border border-gray-200 rounded px-2 py-1.5 break-all font-mono">
                  {qrToken}
                </code>
                <CopyButton text={qrToken} label="Copy" />
              </div>
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(qrToken)}`}
                alt="Van QR preview"
                className="mx-auto rounded-lg border border-gray-200 max-w-full"
              />
              <p className="text-xs text-gray-400">
                Reprint this if the sticker is lost or damaged — it's the same code every time.
              </p>
            </div>
          )}
        </div>
        <div className="p-4 sm:p-5 border-t bg-gray-50 rounded-b-2xl">
          <button onClick={onClose} className="w-full py-2.5 sm:py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-bold transition">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── LicensePhotoModal ──────────────────────────────────────────────────────

function LicensePhotoModal({ driver, onClose }) {
  useEffect(() => {
    if (!driver) return;
    const fn = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', fn);
    return () => document.removeEventListener('keydown', fn);
  }, [driver, onClose]);

  if (!driver) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="license-photo-title"
      className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] flex flex-col overflow-hidden">
        <div className="flex justify-between items-center p-4 border-b">
          <h2 id="license-photo-title" className="text-sm font-bold text-gray-900">{driver.name} — Driver's License</h2>
          <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-600 text-xl leading-none p-1">✕</button>
        </div>
        <div className="p-4 overflow-auto bg-gray-50">
          <img src={driver.licensePhotoUrl} alt="Driver's license" className="w-full h-auto rounded-lg border" />
        </div>
      </div>
    </div>
  );
}

// ─── RejectDriverModal ──────────────────────────────────────────────────────

function RejectDriverModal({ target, reason, onReasonChange, onClose, onConfirm, isLoading, serverError }) {
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
      aria-labelledby="reject-modal-title"
      className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !isLoading) onClose(); }}
    >
      <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full max-w-sm max-h-[95vh] sm:max-h-[90vh] flex flex-col">
        <div className="p-5 sm:p-6 space-y-4">
          <h2 id="reject-modal-title" className="text-base sm:text-lg font-black text-gray-900 text-center">Reject Application?</h2>
          <p className="text-sm text-gray-500 text-center">
            Rejecting <strong>{target.name}</strong>'s application. You can optionally add a reason.
          </p>
          <textarea
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            placeholder="Reason (optional)"
            rows={3}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-300 focus:border-red-300"
          />
          {serverError && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">⚠️ {serverError}</div>}
        </div>
        <div className="flex flex-col-reverse sm:flex-row gap-2 sm:gap-3 p-4 sm:p-5 border-t bg-gray-50 rounded-b-2xl">
          <button onClick={onClose} disabled={isLoading} className="flex-1 py-2.5 sm:py-2 border border-gray-300 rounded-lg text-sm font-semibold text-gray-700 hover:bg-gray-100 transition disabled:opacity-40">Cancel</button>
          <button onClick={onConfirm} disabled={isLoading} className="flex-1 py-2.5 sm:py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-black transition disabled:opacity-70 disabled:cursor-not-allowed">
            {isLoading ? 'Rejecting…' : 'Confirm Reject'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── ConfirmDeleteModal ───────────────────────────────────────────────────────

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
      className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !isLoading) onClose(); }}
    >
      <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full max-w-sm max-h-[95vh] sm:max-h-[90vh] flex flex-col">
        <div className="p-5 sm:p-6 space-y-4 text-center overflow-y-auto">
          <div className="text-4xl" aria-hidden="true">⚠️</div>
          <h2 id="delete-modal-title" className="text-base sm:text-lg font-black text-gray-900">{isVan ? 'Remove Van?' : 'Delete Account?'}</h2>
          <p className="text-sm text-gray-500">You are about to {isVan ? 'permanently remove' : 'permanently delete'}:</p>
          <div className="inline-block py-2 px-4 sm:px-5 bg-gray-50 border border-gray-200 rounded-xl text-left">
            <p className="font-bold text-gray-900 break-all">{target.label}</p>
            <div className="mt-1">{isVan ? <span className="text-xs text-gray-500">{target.sublabel}</span> : <RoleBadge role={target.role} />}</div>
          </div>
          {isAdminRole && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 text-left"><strong>Admin account detected.</strong> Ensure at least one other admin remains in the system before proceeding.</div>}
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 text-left">This action is <strong>permanent and cannot be undone.</strong> {isVan ? 'This van will no longer be assignable to trips.' : 'All data associated with this account will be removed.'}</div>
          {serverError && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 text-left">⚠️ {serverError}</div>}
        </div>
        <div className="flex flex-col-reverse sm:flex-row gap-2 sm:gap-3 p-4 sm:p-5 border-t bg-gray-50 rounded-b-2xl">
          <button onClick={onClose} disabled={isLoading} className="flex-1 py-2.5 sm:py-2 border border-gray-300 rounded-lg text-sm font-semibold text-gray-700 hover:bg-gray-100 transition disabled:opacity-40">Cancel</button>
          <button onClick={onConfirm} disabled={isLoading} className="flex-1 py-2.5 sm:py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-black transition disabled:opacity-70 disabled:cursor-not-allowed">
            {isLoading ? 'Deleting…' : `🗑 Yes, ${isVan ? 'Remove' : 'Delete'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function RoleBadge({ role }) {
  const styles = { ADMIN: 'bg-purple-100 text-purple-800', DISPATCHER: 'bg-blue-100 text-blue-800', DRIVER: 'bg-gray-100 text-gray-700' };
  return <span className={`px-2 py-0.5 rounded text-xs font-bold ${styles[role] ?? 'bg-gray-100 text-gray-500'}`}>{role ?? 'UNKNOWN'}</span>;
}

function VanStatusBadge({ status }) {
  const styles = { IDLE: 'bg-yellow-100 text-yellow-800', DISPATCHED: 'bg-green-100 text-green-800', MAINTENANCE: 'bg-orange-100 text-orange-800', OUT_OF_SERVICE: 'bg-red-100 text-red-800' };
  return <span className={`px-2 py-1 rounded text-xs font-bold whitespace-nowrap ${styles[status] ?? 'bg-gray-100 text-gray-600'}`}>{(status ?? 'UNKNOWN').replace('_', ' ')}</span>;
}

function StatCard({ title, value, color, icon }) {
  return (
    <div className="bg-white p-3 sm:p-5 rounded-xl shadow-sm border border-gray-200 flex items-center gap-3 sm:gap-4">
      {icon && (
        <div className={`text-xl sm:text-2xl w-9 h-9 sm:w-11 sm:h-11 shrink-0 rounded-full bg-gray-50 flex items-center justify-center ${color}`} aria-hidden="true">
          {icon}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[10px] sm:text-xs text-gray-500 font-semibold uppercase tracking-wide truncate">{title}</div>
        <div className={`text-lg sm:text-2xl font-black ${color}`}>{value ?? 0}</div>
      </div>
    </div>
  );
}

function BreakdownCard({ title, entries }) {
  const total = entries.reduce((sum, e) => sum + (e.count || 0), 0);
  return (
    <div className="bg-white p-3 sm:p-4 rounded-xl shadow-sm border border-gray-200">
      <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">{title}</h3>
      <div className="space-y-2.5">
        {entries.map((e) => {
          const pct = total === 0 ? 0 : Math.round((e.count / total) * 100);
          return (
            <div key={e.label}>
              <div className="flex justify-between text-xs mb-1">
                <span className="font-semibold text-gray-600 capitalize">{e.label}</span>
                <span className="text-gray-400">{e.count}</span>
              </div>
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${e.colorClass}`} style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EmptyTableRow({ colSpan, message }) {
  return <tr><td colSpan={colSpan} className="p-6 text-center text-sm text-gray-400 italic">{message}</td></tr>;
}

function PasswordInput({ name, value, onChange, placeholder, autoComplete, hasError, maxLength, inputRef, visible, onToggleVisible }) {
  return (
    <div className="relative">
      <input
        ref={inputRef}
        name={name}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete={autoComplete}
        maxLength={maxLength}
        className={`${inputCls(hasError)} pr-11`}
      />
      <button
        type="button"
        onClick={onToggleVisible}
        aria-label={visible ? 'Hide PIN' : 'Show PIN'}
        title={visible ? 'Hide PIN' : 'Show PIN'}
        className="absolute inset-y-0 right-0 px-3 flex items-center text-gray-400 hover:text-gray-700 transition"
      >
        {visible ? '🙈' : '👁'}
      </button>
    </div>
  );
}

function GeneratePasswordButton({ onGenerate }) {
  return (
    <button
      type="button"
      onClick={onGenerate}
      title="Generate a random 4–8 digit PIN that isn't an obvious pattern"
      className="text-xs font-semibold text-blue-600 hover:text-blue-800 hover:underline transition inline-flex items-center gap-1 whitespace-nowrap"
    >
      🎲 Generate Random PIN
    </button>
  );
}

function CopyButton({ text, label = 'Copy', disabled }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (disabled) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard not available — fail silently */ }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      disabled={disabled}
      title={copied ? 'Copied!' : label}
      className={`shrink-0 text-xs font-bold px-2 py-1.5 rounded border transition ${
        copied
          ? 'border-green-300 text-green-700 bg-green-50'
          : 'border-blue-300 text-blue-700 bg-blue-50 hover:bg-blue-100'
      } disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      {copied ? '✓ Copied' : label}
    </button>
  );
}

function SearchInput({ value, onChange, placeholder, ariaLabel }) {
  return (
    <div className="relative">
      <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-gray-400 pointer-events-none" aria-hidden="true">🔍</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="w-full pl-9 pr-9 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-700 text-xs"
        >
          ✕
        </button>
      )}
    </div>
  );
}

// ─── AuditTrailModal ──────────────────────────────────────────────────────────

function AuditTrailModal({
  isOpen, onClose, logs, totalCount, fullCount, loading, error, search, onSearchChange,
  actionFilter, onActionFilterChange, actionOptions, dateFrom, onDateFromChange, dateTo, onDateToChange,
  onClearFilters, lastSync, onRefresh, onLoadMore, onClearHistory, onExportCsv,
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
      className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full max-w-4xl max-h-[95vh] sm:max-h-[90vh] flex flex-col">
        <div className="flex flex-wrap justify-between items-center gap-3 p-4 sm:p-5 border-b">
          <div className="min-w-0">
            <h2 id="audit-modal-title" className="text-base sm:text-lg font-bold text-gray-900">Audit Trail</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              {fullCount} {fullCount === 1 ? 'entry' : 'entries'} saved on this device
              {lastSync && <> · Synced {formatAuditTimestamp(lastSync)}</>}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close audit trail" className="text-gray-400 hover:text-gray-600 text-xl leading-none p-1">✕</button>
        </div>

        <div className="p-3 sm:p-5 border-b space-y-3">
          <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2">
            <input
              type="text"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search actor, action, target…"
              aria-label="Search audit trail"
              className="px-3 py-2 sm:py-1.5 border border-gray-300 rounded-lg text-sm sm:text-xs flex-1 min-w-0 sm:min-w-[10rem] focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
            />
            <select
              value={actionFilter}
              onChange={(e) => onActionFilterChange(e.target.value)}
              aria-label="Filter by action"
              className="px-3 py-2 sm:py-1.5 border border-gray-300 rounded-lg text-sm sm:text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
            >
              <option value="">All actions</option>
              {actionOptions.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => onDateFromChange(e.target.value)}
                title="From date"
                aria-label="From date"
                className="flex-1 px-3 py-2 sm:py-1.5 border border-gray-300 rounded-lg text-sm sm:text-xs focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
              />
              <span className="text-xs text-gray-400">to</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => onDateToChange(e.target.value)}
                title="To date"
                aria-label="To date"
                className="flex-1 px-3 py-2 sm:py-1.5 border border-gray-300 rounded-lg text-sm sm:text-xs focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
              />
            </div>
            {hasFilters && (
              <button onClick={onClearFilters} className="text-xs font-semibold px-3 py-2 sm:py-1.5 rounded-lg border border-gray-300 text-gray-500 hover:bg-gray-100 transition">Clear filters</button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={onRefresh} disabled={loading} title="Check for new audit entries now" className="text-xs font-semibold px-3 py-2 sm:py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100 transition disabled:opacity-50 flex-1 sm:flex-initial">
              {loading ? 'Syncing…' : '🔄 Refresh'}
            </button>
            <button onClick={onExportCsv} title="Export filtered entries as CSV" className="text-xs font-semibold px-3 py-2 sm:py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100 transition flex-1 sm:flex-initial">⬇️ Export CSV</button>
            <button onClick={onClearHistory} title="Clear locally saved history on this device" className="text-xs font-semibold px-3 py-2 sm:py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition w-full sm:w-auto sm:ml-auto">Clear local history</button>
          </div>
          {error && <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">⚠️ {error}</div>}
        </div>

        <div className="overflow-y-auto flex-1">
          <table className="w-full text-sm text-left min-w-[560px]">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide sticky top-0 z-10">
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
                <EmptyTableRow colSpan={5} message={loading ? 'Loading audit history…' : 'No audit entries match these filters.'} />
              ) : logs.map((entry) => {
                const isExpanded = expandedId === entry.id;
                const hasMeta = entry.metadata && typeof entry.metadata === 'object';
                return (
                  <tr
                    key={entry.id}
                    onClick={() => hasMeta && setExpandedId(isExpanded ? null : entry.id)}
                    className={`border-b hover:bg-gray-50 align-top ${hasMeta ? 'cursor-pointer' : ''}`}
                  >
                    <td className="p-3 whitespace-nowrap text-gray-500 text-xs">{formatAuditTimestamp(entry.timestamp ?? entry.createdAt)}</td>
                    <td className="p-3 font-semibold text-gray-800">{entry.actorName ?? entry.actor ?? 'System'}</td>
                    <td className="p-3"><AuditActionBadge action={entry.action} /></td>
                    <td className="p-3 text-gray-600">{entry.targetType ?? entry.target ?? '—'}</td>
                    <td className="p-3 text-gray-500 text-xs max-w-xs">{entry.details ?? entry.description ?? '—'} {hasMeta && <span className="ml-1 text-blue-500">{isExpanded ? '▲' : '▼'}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {totalCount > logs.length && (
          <div className="p-4 border-t text-center">
            <button onClick={onLoadMore} className="text-xs font-semibold px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100 transition">Load more ({totalCount - logs.length} remaining)</button>
          </div>
        )}
      </div>
    </div>
  );
}

function AuditActionBadge({ action }) {
  const key = (action ?? '').toUpperCase();
  const styles = { CREATE: 'bg-green-100 text-green-800', UPDATE: 'bg-blue-100 text-blue-800', DELETE: 'bg-red-100 text-red-800', APPROVE: 'bg-green-100 text-green-800', REJECT: 'bg-red-100 text-red-800', DISABLE: 'bg-orange-100 text-orange-800', ENABLE: 'bg-green-100 text-green-800', LOGIN: 'bg-purple-100 text-purple-800', LOGOUT: 'bg-gray-100 text-gray-600' };
  const matched = Object.keys(styles).find((k) => key.includes(k));
  return <span className={`px-2 py-0.5 rounded text-xs font-bold whitespace-nowrap ${matched ? styles[matched] : 'bg-gray-100 text-gray-600'}`}>{action ?? 'UNKNOWN'}</span>;
}

function formatAuditTimestamp(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function PageState({ title, message, actionLabel, onAction, loading }) {
  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4 sm:p-6">
      <div className="max-w-md w-full bg-white rounded-xl shadow-sm border p-6 text-center">
        {loading && (
          <div className="mx-auto mb-4 h-10 w-10 rounded-full border-4 border-blue-100 border-t-blue-600 animate-spin" aria-hidden="true" />
        )}
        <h1 className="text-lg sm:text-xl font-black text-gray-800">{title}</h1>
        {message && <p className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{message}</p>}
        {actionLabel && onAction && <button onClick={onAction} className="mt-4 w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-lg transition">{actionLabel}</button>}
      </div>
    </div>
  );
}

function Field({ label, required, error, hint, action, children }) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 mb-1">
        <label className="block text-sm font-semibold text-gray-700">
          {label} {required && <span className="text-red-500 ml-0.5" aria-hidden="true">*</span>}
        </label>
        {action}
      </div>
      {children}
      {hint && !error && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
      {error && <p role="alert" className="text-xs text-red-500 mt-1">{error}</p>}
    </div>
  );
}
