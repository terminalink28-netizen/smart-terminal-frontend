import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import apiClient from '../api/axios';

const DRIVER_ID_RE = /^DRV-\d{3,}$/i;
const PHONE_RE = /^(\+?63|0)9\d{9}$/;
const PIN_MIN = 4;
const MAX_FILE_MB = 5;

function extractErrorMessage(err) {
  const serverMsg = err?.response?.data?.error ?? err?.response?.data?.message;
  if (serverMsg) return serverMsg;
  if (err?.code === 'ECONNABORTED') return 'The request timed out. Please try again.';
  if (err?.request) return 'Network error — could not reach the server.';
  return err?.message ?? 'Something went wrong. Please try again.';
}

export default function DriverRegister() {
  const navigate = useNavigate();
  const fileInputRef = useRef(null);

  const [form, setForm] = useState({
    name: '', driverId: '', contactNumber: '', pin: '', confirmPin: '', vanId: '',
  });
  const [licenseFile, setLicenseFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [assignedPlate, setAssignedPlate] = useState('');

  const [availableVans, setAvailableVans] = useState([]);
  const [vansLoading, setVansLoading] = useState(true);
  const [vansError, setVansError] = useState('');

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      setVansLoading(true);
      setVansError('');
      try {
        const { data } = await apiClient.get('/drivers/available-vans', { signal: ctrl.signal });
        setAvailableVans(Array.isArray(data) ? data : []);
      } catch (err) {
        if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
        setVansError('Could not load available vans. Pull to refresh or try again shortly.');
      } finally {
        setVansLoading(false);
      }
    })();
    return () => ctrl.abort();
  }, []);

  const change = (e) => {
    const { name, value } = e.target;
    setForm((p) => ({ ...p, [name]: value }));
    setErrors((p) => ({ ...p, [name]: '' }));
    if (serverError) setServerError('');
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const allowed = ['image/jpeg', 'image/png', 'application/pdf'];
    if (!allowed.includes(file.type)) {
      setErrors((p) => ({ ...p, license: 'Only JPG, PNG, or PDF files are allowed.' }));
      return;
    }
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      setErrors((p) => ({ ...p, license: `File must be ${MAX_FILE_MB}MB or smaller.` }));
      return;
    }

    setErrors((p) => ({ ...p, license: '' }));
    setLicenseFile(file);
    if (file.type.startsWith('image/')) {
      setPreviewUrl(URL.createObjectURL(file));
    } else {
      setPreviewUrl(null);
    }
  };

  const clearFile = () => {
    setLicenseFile(null);
    setPreviewUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const validate = () => {
    const e = {};
    const name = form.name.trim();
    const driverId = form.driverId.trim();
    const contact = form.contactNumber.trim();

    if (!name) e.name = 'Full name is required.';
    if (!driverId) e.driverId = 'Choose a login ID.';
    else if (!DRIVER_ID_RE.test(driverId)) e.driverId = 'Format: DRV- followed by at least 3 digits (e.g. DRV-001).';

    if (!contact) e.contactNumber = 'Contact number is required.';
    else if (!PHONE_RE.test(contact)) e.contactNumber = 'Enter a valid PH mobile number (e.g. 09171234567).';

    if (!form.pin) e.pin = 'A PIN is required.';
    else if (form.pin.length < PIN_MIN) e.pin = `PIN must be at least ${PIN_MIN} characters.`;

    if (form.confirmPin !== form.pin) e.confirmPin = 'PINs do not match.';

    if (!form.vanId) e.vanId = 'Select the van you\'ll be driving.';

    if (!licenseFile) e.license = "A photo of your driver's license is required.";

    return e;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const validationErrors = validate();
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    setSubmitting(true);
    setServerError('');

    try {
      const payload = new FormData();
      payload.append('name', form.name.trim());
      payload.append('driverId', form.driverId.trim().toUpperCase());
      payload.append('contactNumber', form.contactNumber.trim());
      payload.append('pin', form.pin);
      payload.append('vanId', form.vanId);
      payload.append('licensePhoto', licenseFile);

      const { data } = await apiClient.post('/drivers/register', payload, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      setAssignedPlate(data?.driver?.assignedVan?.plateNumber ?? '');
      setSubmitted(true);
    } catch (err) {
      const msg = extractErrorMessage(err);
      setServerError(msg);
      // If the van was taken by someone else moments ago, refresh the list
      // so the driver can immediately pick another one instead of retrying blind.
      if (err?.response?.status === 409) {
        try {
          const { data } = await apiClient.get('/drivers/available-vans');
          setAvailableVans(Array.isArray(data) ? data : []);
          setForm((p) => ({ ...p, vanId: '' }));
        } catch { /* ignore refresh failure */ }
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center px-4">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-8 text-center">
          <div className="text-5xl mb-3" aria-hidden="true">✅</div>
          <h1 className="text-xl font-black text-slate-900">Registration submitted</h1>
          <p className="text-sm text-slate-500 mt-3 leading-relaxed">
            An admin will review your details and license photo.
            {assignedPlate && <> You've been assigned to van <strong>{assignedPlate}</strong>.</>}
            {' '}Once approved, you can log in with the Login ID and PIN you just created.
          </p>
          <button
            onClick={() => navigate('/login')}
            className="mt-6 w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-lg transition"
          >
            Back to login
          </button>
        </div>
      </div>
    );
  }

  const noVansAvailable = !vansLoading && !vansError && availableVans.length === 0;

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-6 sm:p-8">
        <div className="text-center mb-6">
          <h1 className="text-2xl sm:text-3xl font-black text-slate-900">Driver Registration</h1>
          <p className="text-sm text-slate-500 mt-2">
            Apply for a driver account — an admin reviews every application before it's active.
          </p>
        </div>

        {serverError && (
          <div className="mb-4 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3">
            ⚠️ {serverError}
          </div>
        )}

        {noVansAvailable && (
          <div className="mb-4 bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg p-3">
            No vans are available to assign right now. Please contact the admin to register a van before applying, then come back.
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <FormField label="Full Name" required error={errors.name}>
            <input
              name="name" type="text" value={form.name} onChange={change}
              placeholder="e.g. Juan dela Cruz" autoComplete="name"
              className={inputCls(errors.name)}
            />
          </FormField>

          <FormField label="Choose a Login ID" required error={errors.driverId} hint="Format: DRV- followed by numbers, e.g. DRV-001">
            <input
              name="driverId" type="text" value={form.driverId} onChange={change}
              placeholder="DRV-001" autoComplete="off"
              className={`${inputCls(errors.driverId)} uppercase`}
            />
          </FormField>

          <FormField label="Contact Number" required error={errors.contactNumber} hint="Used by dispatch and admin to reach you">
            <input
              name="contactNumber" type="tel" value={form.contactNumber} onChange={change}
              placeholder="09171234567" autoComplete="tel"
              className={inputCls(errors.contactNumber)}
            />
          </FormField>

          <FormField label="Assign Yourself a Van" required error={errors.vanId} hint="You'll be the driver on record for this van once approved">
            {vansLoading ? (
              <div className="text-sm text-slate-400 py-2">Loading available vans…</div>
            ) : vansError ? (
              <div className="text-sm text-red-500 py-1">{vansError}</div>
            ) : (
              <select
                name="vanId" value={form.vanId} onChange={change} disabled={noVansAvailable}
                className={`${inputCls(errors.vanId)} bg-white disabled:bg-gray-100 disabled:text-gray-400`}
              >
                <option value="">— Select a van —</option>
                {availableVans.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.plateNumber} — {v.capacity} pax
                  </option>
                ))}
              </select>
            )}
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="PIN" required error={errors.pin}>
              <input
                name="pin" type="password" value={form.pin} onChange={change}
                placeholder="At least 4 digits" autoComplete="new-password"
                className={inputCls(errors.pin)}
              />
            </FormField>
            <FormField label="Confirm PIN" required error={errors.confirmPin}>
              <input
                name="confirmPin" type="password" value={form.confirmPin} onChange={change}
                placeholder="Re-enter PIN" autoComplete="new-password"
                className={inputCls(errors.confirmPin)}
              />
            </FormField>
          </div>

          <FormField label="Driver's License Photo" required error={errors.license} hint="JPG, PNG, or PDF — max 5MB">
            {!licenseFile ? (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full border-2 border-dashed border-slate-300 rounded-lg py-6 flex flex-col items-center gap-2 text-slate-500 hover:border-blue-400 hover:text-blue-600 transition"
              >
                <span className="text-2xl" aria-hidden="true">📄</span>
                <span className="text-sm font-semibold">Tap to upload a photo</span>
              </button>
            ) : (
              <div className="border border-slate-200 rounded-lg p-3 flex items-center gap-3">
                {previewUrl ? (
                  <img src={previewUrl} alt="License preview" className="w-16 h-16 object-cover rounded-lg border" />
                ) : (
                  <div className="w-16 h-16 rounded-lg border bg-slate-50 flex items-center justify-center text-2xl">📄</div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-slate-800 truncate">{licenseFile.name}</p>
                  <p className="text-xs text-slate-400">{(licenseFile.size / 1024 / 1024).toFixed(1)} MB</p>
                </div>
                <button type="button" onClick={clearFile} className="text-xs font-bold text-red-500 hover:text-red-700 px-2">Remove</button>
              </div>
            )}
            <input
              ref={fileInputRef} type="file" accept="image/jpeg,image/png,application/pdf"
              onChange={handleFileChange} className="hidden"
            />
          </FormField>

          <button
            type="submit"
            disabled={submitting || noVansAvailable}
            className={`w-full py-3 rounded-lg font-bold text-white transition mt-2 ${
              submitting || noVansAvailable ? 'bg-slate-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {submitting ? 'Submitting…' : 'Submit application'}
          </button>
        </form>

        <div className="mt-6 text-center">
          <button
            type="button"
            onClick={() => navigate('/login')}
            className="text-sm text-blue-600 hover:text-blue-800 font-medium"
          >
            Already have an account? Log in
          </button>
        </div>
      </div>
    </div>
  );
}

function inputCls(hasError) {
  return `w-full border rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 transition ${
    hasError
      ? 'border-red-400 bg-red-50 focus:ring-red-300'
      : 'border-slate-300 focus:ring-blue-400 focus:border-blue-400'
  }`;
}

function FormField({ label, required, error, hint, children }) {
  return (
    <div>
      <label className="block text-sm font-semibold text-slate-700 mb-1.5">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-slate-400 mt-1">{hint}</p>}
      {error && <p role="alert" className="text-xs text-red-500 mt-1">{error}</p>}
    </div>
  );
}
