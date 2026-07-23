import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import apiClient from '../api/axios';
import { socket } from '../api/socket';

// ─── constants ────────────────────────────────────────────────────────────────

const GPS_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 };

// GPS is only locked (disabled) when there is nothing to broadcast
const GPS_LOCKED_STATUSES = ['SCHEDULED', 'COMPLETED', 'CANCELLED'];

// Friendly, plain-language copy for each status — shown to the driver
// instead of raw backend enum values like "ARRIVING".
const STATUS_COPY = {
  SCHEDULED:  { label: 'Scheduled',           icon: '🗓️' },
  BOARDING:   { label: 'Boarding Passengers', icon: '🧍' },
  DEPARTING:  { label: 'Preparing to Depart', icon: '🚦' },
  DEPARTED:   { label: 'On the Road',         icon: '🚐' },
  ARRIVING:   { label: 'Arriving Soon',       icon: '📍' },
  DELAYED:    { label: 'Delayed',             icon: '⏱️' },
  COMPLETED:  { label: 'Trip Completed',      icon: '✅' },
  CANCELLED:  { label: 'Cancelled',           icon: '✕' },
};

const STATUS_STYLES = {
  BOARDING:   'bg-green-100  text-green-800  border border-green-200',
  DEPARTING:  'bg-amber-100  text-amber-800  border border-amber-200',
  DEPARTED:   'bg-blue-100   text-blue-800   border border-blue-200',
  ARRIVING:   'bg-indigo-100 text-indigo-800 border border-indigo-200',
  DELAYED:    'bg-orange-100 text-orange-800 border border-orange-200',
  COMPLETED:  'bg-gray-100   text-gray-600   border border-gray-200',
  CANCELLED:  'bg-red-100    text-red-700    border border-red-200',
  SCHEDULED:  'bg-yellow-100 text-yellow-800 border border-yellow-200',
};

// The forward-moving trip lifecycle a driver walks through manually.
// Each entry knows what button to show to advance to the *next* step.
// ARRIVING is handled separately (see CompletionQrPanel) — that final
// step is confirmed by the dispatcher scanning the van's QR code rather
// than a driver self-tap button.
const STATUS_FLOW = [
  { key: 'BOARDING',  next: 'DEPARTING', actionLabel: '🚦 Ready to Depart',      actionHint: 'Tap once all passengers are seated.' },
  { key: 'DEPARTING', next: 'DEPARTED',  actionLabel: '🚐 Confirm Departure',    actionHint: "Tap the moment you actually pull out." },
  { key: 'DEPARTED',  next: 'ARRIVING',  actionLabel: '📍 Approaching Terminal', actionHint: "Tap when you're close to Virac Terminal." },
];

const MUNICIPALITIES = [
  { name: 'Bato',       minutes: 30,  emoji: '🏘️' },
  { name: 'Baras',      minutes: 25,  emoji: '🌾' },
  { name: 'San Andres', minutes: 45,  emoji: '⛵' },
  { name: 'Gigmoto',    minutes: 90,  emoji: '🏔️' },
  { name: 'Panganiban', minutes: 55,  emoji: '🌊' },
  { name: 'Caramoran',  minutes: 100, emoji: '🐚' },
  { name: 'Bagamanoc',  minutes: 110, emoji: '🌿' },
  { name: 'Viga',       minutes: 130, emoji: '🛖' },
  { name: 'Pandan',     minutes: 145, emoji: '🌴' },
];

const DESTINATION = 'Virac Central Terminal';
const DEFAULT_ROUTE_DURATION = 60;
const DELAY_OPTIONS = [5, 10, 15, 30];

// Statuses where the ETA panel is relevant (boarding + all en-route states)
const ETA_ACTIVE_STATUSES = ['BOARDING', 'DEPARTING', 'DEPARTED', 'ARRIVING', 'DELAYED'];

// Used to build the visual step tracker (includes the final COMPLETED dot,
// even though there's no button for it — it's confirmed by QR scan).
const STEPPER_KEYS = ['BOARDING', 'DEPARTING', 'DEPARTED', 'ARRIVING', 'COMPLETED'];

const GPS_STATE = { IDLE: 'IDLE', ACQUIRING: 'ACQUIRING', LIVE: 'LIVE', ERROR: 'ERROR' };

// Speed/position trust thresholds — mirrors the backend's gating so the
// driver sees an honest reading of what will actually be broadcast.
const MAX_PLAUSIBLE_SPEED_MPS = 55;      // ~198 km/h ceiling
const MIN_DT_FOR_FALLBACK_SECONDS = 2;    // don't compute speed from fixes closer than this
const MIN_DISTANCE_FOR_FALLBACK_M = 3;    // ignore GPS jitter smaller than this

// ─── helpers ──────────────────────────────────────────────────────────────────

function geolocationErrorMessage(err) {
  if (!err) return 'GPS error. Please try again.';
  switch (err.code) {
    case 1: return 'Location permission denied. Open browser settings and allow location access, then try again.';
    case 2: return 'GPS signal unavailable. Move to an open area and try again.';
    case 3: return 'GPS timed out acquiring a fix. Try again.';
    default: return `GPS error (code ${err.code}). Please try again.`;
  }
}

/** Great-circle distance between two lat/lng points, in meters. */
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function msToKmh(mps) {
  if (typeof mps !== 'number' || Number.isNaN(mps)) return null;
  return Math.round(mps * 3.6);
}

function friendlyStatus(status) {
  return STATUS_COPY[status] ?? { label: status ?? 'Unknown', icon: '•' };
}

// ─── sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const cls = STATUS_STYLES[status] ?? 'bg-gray-100 text-gray-600 border border-gray-200';
  const { label, icon } = friendlyStatus(status);
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded ${cls}`}>
      <span aria-hidden="true">{icon}</span> {label}
    </span>
  );
}

// A simple horizontal progress tracker so the driver can see, at a glance,
// where they are in the trip and what's still ahead.
function TripProgressStepper({ status }) {
  const idx = STEPPER_KEYS.indexOf(status);
  if (idx === -1) return null;

  return (
    <div className="flex items-center" aria-label="Trip progress">
      {STEPPER_KEYS.map((key, i) => {
        const isDone    = i < idx;
        const isCurrent = i === idx;
        const { icon } = friendlyStatus(key);
        return (
          <div key={key} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center gap-1">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm border-2 transition-colors ${
                  isDone
                    ? 'bg-green-500 border-green-500 text-white'
                    : isCurrent
                    ? 'bg-blue-600 border-blue-600 text-white shadow-md'
                    : 'bg-white border-gray-200 text-gray-300'
                }`}
                aria-current={isCurrent ? 'step' : undefined}
              >
                {isDone ? '✓' : icon}
              </div>
            </div>
            {i < STEPPER_KEYS.length - 1 && (
              <div className={`flex-1 h-1 mx-1 rounded-full ${isDone ? 'bg-green-500' : 'bg-gray-200'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function SeatProgressBar({ available, total }) {
  const pct   = total === 0 ? 0 : Math.round((available / total) * 100);
  const color = pct > 50 ? 'bg-green-500' : pct > 25 ? 'bg-yellow-400' : 'bg-red-500';
  return (
    <div className="mt-3">
      <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-300 ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-center text-gray-500 mt-1">{available} of {total} seats available</p>
    </div>
  );
}

function TripManifest({ trip, eta, delayMinutes }) {
  const origin = trip.route?.origin ?? trip.route?.name?.split('→')[0]?.trim() ?? 'Unknown';
  const fields = [
    { label: 'From',        value: origin },
    { label: 'Destination', value: trip.route?.destination ?? DESTINATION },
    { label: 'Van plate',   value: trip.van?.plateNumber ?? 'Unknown' },
    { label: 'Capacity',    value: trip.van?.capacity ?? '—' },
    { label: 'Status',      value: <StatusBadge status={trip.status} /> },
    {
      label: 'Departure',
      value: trip.scheduledAt
        ? new Date(trip.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '—',
    },
    ...(eta ? [{
      label: 'Est. Arrival',
      value: (
        <span className="font-black text-indigo-700">
          {eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {delayMinutes > 0 && (
            <span className="text-amber-600 text-xs font-semibold ml-1">(+{delayMinutes}m delay)</span>
          )}
        </span>
      ),
    }] : []),
  ];

  return (
    <section className="bg-slate-50 p-4 rounded-xl border border-slate-200">
      <div className="flex items-center justify-between mb-3 border-b border-slate-200 pb-2">
        <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wider">Trip manifest</h2>
        <span className="text-xs font-semibold text-slate-500">
          {origin} <span className="text-slate-300 mx-1">→</span> {trip.route?.destination ?? DESTINATION}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-y-3 text-sm">
        {fields.map(({ label, value }) => (
          <>
            <dt key={`dt-${label}`} className="text-slate-500">{label}</dt>
            <dd key={`dd-${label}`} className="font-semibold text-slate-900">{value}</dd>
          </>
        ))}
      </dl>
    </section>
  );
}

function BoardingPanel({ seatCounts, onDecrTotal, onIncrTotal, onDecrAvail, onIncrAvail }) {
  return (
    <section className="bg-green-50 p-5 rounded-xl border-2 border-green-200" aria-label="Passenger boarding controls">
      <h2 className="text-sm font-bold text-green-900 text-center uppercase tracking-wider mb-4">
        Passenger boarding
      </h2>
      <div className="flex items-center justify-between bg-white px-4 py-3 rounded-lg border border-green-100 mb-5">
        <span className="text-sm font-semibold text-gray-600">Total capacity</span>
        <div className="flex items-center gap-3">
          <button onClick={onDecrTotal} aria-label="Decrease total capacity"
            className="w-8 h-8 rounded-full bg-gray-200 hover:bg-gray-300 font-bold text-gray-700 flex items-center justify-center transition-colors">−</button>
          <span className="w-6 text-center text-lg font-bold text-gray-800">{seatCounts.total}</span>
          <button onClick={onIncrTotal} aria-label="Increase total capacity"
            className="w-8 h-8 rounded-full bg-gray-200 hover:bg-gray-300 font-bold text-gray-700 flex items-center justify-center transition-colors">+</button>
        </div>
      </div>
      <div className="text-center">
        <p className="text-xs font-bold text-green-800 uppercase tracking-widest mb-3">Available seats</p>
        <div className="flex items-center justify-center gap-6">
          <button onClick={onDecrAvail} aria-label="Mark one seat taken"
            className="w-14 h-14 rounded-full bg-red-100 text-red-600 hover:bg-red-200 font-black text-3xl flex items-center justify-center transition-colors shadow-sm active:scale-95">−</button>
          <span className="text-6xl font-black w-16 text-center tabular-nums text-green-700 leading-none"
            aria-live="polite" aria-atomic="true">{seatCounts.available}</span>
          <button onClick={onIncrAvail} aria-label="Free up one seat"
            className="w-14 h-14 rounded-full bg-green-200 text-green-800 hover:bg-green-300 font-black text-3xl flex items-center justify-center transition-colors shadow-sm active:scale-95">+</button>
        </div>
        <SeatProgressBar available={seatCounts.available} total={seatCounts.total} />
      </div>
    </section>
  );
}

// ── LiveTrackingCard ────────────────────────────────────────────────────────
// A Life360-style live tracking card: big current-speed readout, a pulsing
// "live" indicator, and a small stat row for peak speed / GPS accuracy.

function LiveTrackingCard({ trip, gpsState, gpsError, lastCoords, maxSpeedKmh, onStart, onStop }) {
  const isLocked = !trip || GPS_LOCKED_STATUSES.includes(trip.status);

  if (isLocked) {
    return (
      <section className="bg-gray-50 border border-gray-200 rounded-xl p-5 text-center">
        <p className="text-sm font-semibold text-gray-400">📡 Live tracking unavailable</p>
        <p className="text-xs text-gray-400 mt-1">
          {trip ? `Trip status is "${friendlyStatus(trip.status).label}."` : 'No active trip yet.'}
        </p>
      </section>
    );
  }

  if (gpsState === GPS_STATE.ACQUIRING) {
    return (
      <section className="bg-blue-50 border border-blue-200 rounded-xl p-6 text-center">
        <div className="w-10 h-10 mx-auto border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-3" role="status" />
        <p className="text-sm font-bold text-blue-800">Finding your GPS signal…</p>
        <p className="text-xs text-blue-400 mt-1">This can take a few seconds outdoors, longer indoors.</p>
      </section>
    );
  }

  if (gpsState === GPS_STATE.LIVE) {
    const kmh = msToKmh(lastCoords?.speed);
    return (
      <section className="bg-gradient-to-br from-blue-600 to-indigo-700 rounded-2xl p-6 text-white shadow-lg" aria-label="Live speed tracking">
        <div className="flex items-center justify-center gap-2 mb-1">
          <span className="w-2.5 h-2.5 bg-green-400 rounded-full animate-pulse" aria-hidden="true" />
          <span className="text-xs font-bold uppercase tracking-widest text-blue-100">Live tracking active</span>
        </div>

        <div className="text-center my-4">
          <span className="text-7xl font-black tabular-nums leading-none">
            {kmh === null ? '—' : kmh}
          </span>
          <span className="text-lg font-bold text-blue-200 ml-2">km/h</span>
        </div>

        <div className="grid grid-cols-2 gap-3 text-center mb-5">
          <div className="bg-white/10 rounded-lg py-2">
            <p className="text-[11px] uppercase tracking-wide text-blue-200 font-semibold">Peak speed</p>
            <p className="text-xl font-black tabular-nums">{maxSpeedKmh} <span className="text-xs font-semibold">km/h</span></p>
          </div>
          <div className="bg-white/10 rounded-lg py-2">
            <p className="text-[11px] uppercase tracking-wide text-blue-200 font-semibold">GPS accuracy</p>
            <p className="text-xl font-black tabular-nums">
              {lastCoords?.accuracy != null ? `±${Math.round(lastCoords.accuracy)}m` : '—'}
            </p>
          </div>
        </div>

        {lastCoords && (
          <p className="text-[11px] text-center text-blue-200 font-mono mb-4">
            {lastCoords.lat.toFixed(5)}, {lastCoords.lng.toFixed(5)}
          </p>
        )}

        <button onClick={onStop} aria-label="Stop sharing GPS location"
          className="w-full bg-white/15 hover:bg-white/25 text-white font-bold py-3 px-4 rounded-xl transition-colors active:scale-[0.98] border border-white/20">
          Stop sharing location
        </button>
      </section>
    );
  }

  // IDLE or ERROR
  return (
    <section className="bg-white border-2 border-dashed border-blue-200 rounded-xl p-5 text-center">
      <p className="text-3xl mb-2" aria-hidden="true">📍</p>
      <p className="text-sm font-bold text-gray-800 mb-1">Share your live location</p>
      <p className="text-xs text-gray-500 mb-4">Passengers and dispatch will see your position and speed in real time — just like a delivery tracker.</p>
      {gpsError && (
        <div role="alert" className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 p-3 rounded-xl mb-4 text-left">
          <span className="text-base leading-none mt-0.5" aria-hidden="true">⚠️</span>
          <span className="font-medium">{gpsError}</span>
        </div>
      )}
      <button onClick={onStart} aria-label="Share live GPS location"
        className="w-full bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-bold text-base py-4 px-4 rounded-xl shadow-lg border-b-4 border-blue-800 transition-colors active:border-b-0 active:translate-y-0.5">
        📍 Share live location
      </button>
    </section>
  );
}

function ETACountdown({ eta }) {
  const [label, setLabel] = useState('');

  useEffect(() => {
    if (!eta) return;
    const tick = () => {
      const diff = eta.getTime() - Date.now();
      if (diff <= 0) { setLabel('Arriving now'); return; }
      const h = Math.floor(diff / 3_600_000);
      const m = Math.floor((diff % 3_600_000) / 60_000);
      const s = Math.floor((diff % 60_000) / 1_000);
      setLabel(h > 0 ? `${h}h ${m}m remaining` : m > 0 ? `${m}m ${s}s remaining` : `${s}s remaining`);
    };
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, [eta]);

  if (!eta) return null;
  return (
    <p className="text-sm font-bold text-indigo-700 tabular-nums text-center mt-1" aria-live="polite" aria-atomic="true">
      {label}
    </p>
  );
}

// ── CompletionQrPanel ───────────────────────────────────────────────────────
// Shown instead of a self-tap button once the trip reaches ARRIVING. The
// driver hands their phone (or holds it up) to the dispatcher, who scans
// this code with the existing QRScannerModal to confirm the trip is done.
// The token is the van's permanent scan token — the same one printed on
// the van's physical sticker — so the dispatcher's scanner needs no
// special-casing to handle it.

function CompletionQrPanel({ van, onRefresh }) {
  if (!van?.qrToken) {
    return (
      <section className="bg-amber-50 border border-amber-200 rounded-xl p-5 text-center">
        <p className="text-sm font-semibold text-amber-800">QR code unavailable</p>
        <p className="text-xs text-amber-600 mt-1">Ask your dispatcher to complete this trip manually.</p>
      </section>
    );
  }

  return (
    <section className="bg-white border-2 border-indigo-200 rounded-2xl p-6 text-center" aria-label="Trip completion QR code">
      <p className="text-sm font-bold text-indigo-900 mb-1">You've arrived 🎉</p>
      <p className="text-xs text-indigo-500 mb-4">
        Show this code to your dispatcher — they'll scan it to confirm the trip is complete.
      </p>
      <div className="flex justify-center mb-4">
        <div className="p-4 bg-white rounded-xl border-2 border-indigo-100 shadow-sm">
          <QRCodeSVG value={van.qrToken} size={180} />
        </div>
      </div>
      <p className="text-xs font-mono text-gray-400 mb-3">{van.plateNumber}</p>
      <button onClick={onRefresh} className="text-xs text-indigo-500 hover:text-indigo-700 underline underline-offset-2">
        Already scanned? Tap to refresh
      </button>
    </section>
  );
}

// ── StatusControlPanel ──────────────────────────────────────────────────────
// Boarding → Departing → Departed are self-tap steps. Arriving → Completed
// is confirmed by the dispatcher scanning the van's QR code instead (see
// CompletionQrPanel above), since that's the moment a second person should
// verify the trip actually happened.

function StatusControlPanel({ trip, delayMinutes, eta, statusUpdating, onAdvance, onAddDelay, onRefresh }) {
  if (!trip) return null;

  const step = STATUS_FLOW.find((s) => s.key === trip.status);
  const isArriving = trip.status === 'ARRIVING';
  const showEta = ETA_ACTIVE_STATUSES.includes(trip.status) && ['DEPARTING', 'DEPARTED', 'ARRIVING', 'DELAYED'].includes(trip.status);

  return (
    <section className="bg-indigo-50 p-4 rounded-xl border-2 border-indigo-200" aria-label="Trip status control">
      <h2 className="text-sm font-bold text-indigo-900 uppercase tracking-wider mb-4 text-center">Trip status</h2>

      <div className="mb-5 px-1">
        <TripProgressStepper status={trip.status} />
      </div>

      {trip.status === 'DELAYED' && (
        <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 text-center text-sm text-orange-800 font-semibold mb-4">
          ⏱️ Trip marked as delayed. Use the buttons below to report further delay, or contact your dispatcher to resume.
        </div>
      )}

      {showEta && (
        <div className="text-center mb-4">
          <p className="text-xs text-indigo-500 mb-0.5">Estimated arrival · Virac Terminal</p>
          <p className="text-4xl font-black text-indigo-800 tabular-nums leading-none">
            {eta ? eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
          </p>
          {delayMinutes > 0 && (
            <p className="text-xs text-amber-600 font-bold mt-1">+{delayMinutes} min delay added</p>
          )}
          <ETACountdown eta={eta} />
        </div>
      )}

      {step && (
        <div className="mb-2">
          <button onClick={() => onAdvance(step.next)} disabled={statusUpdating}
            className="w-full bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-bold py-4 px-4 rounded-xl shadow-sm transition-colors active:scale-[0.98] border-b-4 border-indigo-800 active:border-b-0 active:translate-y-0.5 disabled:opacity-60 disabled:cursor-not-allowed"
            aria-label={`Advance trip status to ${friendlyStatus(step.next).label}`}>
            {statusUpdating ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Updating…
              </span>
            ) : step.actionLabel}
          </button>
          <p className="text-xs text-indigo-400 text-center mt-2">{step.actionHint}</p>
        </div>
      )}

      {isArriving && <CompletionQrPanel van={trip.van} onRefresh={onRefresh} />}

      {ETA_ACTIVE_STATUSES.includes(trip.status) && trip.status !== 'BOARDING' && (
        <>
          <hr className="border-indigo-200 my-3" />
          <div>
            <p className="text-xs text-indigo-600 font-semibold text-center mb-2">Running behind? Report a delay:</p>
            <div className="flex gap-2 justify-center" role="group" aria-label="Add delay minutes">
              {DELAY_OPTIONS.map((mins) => (
                <button key={mins} onClick={() => onAddDelay(mins)} aria-label={`Add ${mins} minute delay`}
                  className="px-3 py-1.5 bg-amber-100 hover:bg-amber-200 active:bg-amber-300 text-amber-800 text-xs font-bold rounded-lg border border-amber-300 transition-colors active:scale-95">
                  +{mins}m
                </button>
              ))}
            </div>
            <p className="text-xs text-indigo-400 text-center mt-2">
              Delay is added to your ETA and shown to all passengers in real-time.
            </p>
          </div>
        </>
      )}
    </section>
  );
}

// ─── TripSetupScreen ──────────────────────────────────────────────────────────

function TripSetupScreen({ onTripStarted, onRefresh }) {
  const [selectedMunicipality, setSelectedMunicipality] = useState(null);
  const [submitting, setSubmitting]                     = useState(false);
  const [submitError, setSubmitError]                   = useState('');

  const selected = MUNICIPALITIES.find((m) => m.name === selectedMunicipality) ?? null;

  const extractErrorMessage = (err) => {
    const serverMsg = err?.response?.data?.message ?? err?.response?.data?.error;
    if (serverMsg) {
      const msg = Array.isArray(serverMsg) ? serverMsg.join('. ') : String(serverMsg);
      return `Server error: ${msg}`;
    }
    const status = err?.response?.status;
    if (status === 401) return 'Session expired — please log in again.';
    if (status === 403) return 'You are not authorised to start a trip.';
    if (status === 404) return 'Trip start endpoint not found (404). Contact your administrator.';
    if (status === 409) return 'You already have an active trip. Refresh to load it.';
    if (status >= 500)  return `Server error (${status}). Please try again in a moment.`;
    if (status)         return `Unexpected response (${status}). Please try again.`;
    if (err?.code === 'ECONNABORTED') return 'Request timed out. Check your mobile data and try again.';
    if (err?.message?.toLowerCase().includes('network')) return 'Network error. Check your connection and try again.';
    return `Could not start your trip: ${err?.message ?? 'unknown error'}`;
  };

  const handleStart = async () => {
    if (!selected || submitting) return;
    setSubmitting(true);
    setSubmitError('');

    const payload = {
      origin:      selected.name,
      destination: DESTINATION,
      routeName:   `${selected.name} → ${DESTINATION}`,
    };

    try {
      const response = await apiClient.post('/trips/self-start', payload);
      const tripData = response.data?.trip ?? response.data;
      if (!tripData?.id) throw new Error('Server returned an unexpected response shape — missing trip id.');
      onTripStarted(tripData);
    } catch (err) {
      console.error('[TripSetupScreen] start trip error:', err);
      setSubmitError(extractErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col gap-5">
      <div className="text-center pt-4 pb-2">
        <span className="text-5xl" aria-hidden="true">🚐</span>
        <h2 className="text-lg font-black text-gray-900 mt-3">Ready to roll?</h2>
        <p className="text-sm text-gray-500 mt-1">
          Pick your starting municipality. We'll open a trip to{' '}
          <span className="font-semibold text-gray-700">{DESTINATION}</span>.
        </p>
      </div>

      <div>
        <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Where are you departing from?</p>
        <div className="grid grid-cols-3 gap-2" role="listbox" aria-label="Select origin municipality">
          {MUNICIPALITIES.map((m) => {
            const isSelected = selectedMunicipality === m.name;
            return (
              <button key={m.name} role="option" aria-selected={isSelected}
                onClick={() => setSelectedMunicipality(m.name)}
                className={`flex flex-col items-center gap-1 p-3 rounded-xl border-2 text-center transition-all active:scale-95 ${
                  isSelected ? 'border-blue-500 bg-blue-50 shadow-sm' : 'border-slate-200 bg-white hover:border-slate-300'
                }`}>
                <span className="text-2xl" aria-hidden="true">{m.emoji}</span>
                <span className={`text-xs font-bold leading-tight ${isSelected ? 'text-blue-700' : 'text-slate-700'}`}>{m.name}</span>
                <span className={`text-[10px] ${isSelected ? 'text-blue-500' : 'text-slate-400'}`}>~{m.minutes} min</span>
              </button>
            );
          })}
        </div>
      </div>

      {selected && (
        <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 flex items-center gap-3 text-sm">
          <div className="flex-1">
            <p className="font-semibold text-slate-800">
              {selected.emoji} {selected.name}
              <span className="text-slate-400 font-normal mx-2">→</span>
              Virac Central Terminal
            </p>
            <p className="text-xs text-slate-500 mt-0.5">Estimated travel time: ~{selected.minutes} min</p>
          </div>
          <span className="text-green-600 font-black text-lg" aria-hidden="true">✓</span>
        </div>
      )}

      {submitError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700 font-medium space-y-1" role="alert">
          <p className="font-bold">⚠️ Could not start trip</p>
          <p>{submitError}</p>
          <p className="text-xs text-red-500 mt-1">Check the browser console for the full error details.</p>
        </div>
      )}

      <div className="mt-auto flex flex-col gap-2 pt-2">
        <button onClick={handleStart} disabled={!selected || submitting}
          className={`w-full font-bold text-base py-4 px-4 rounded-xl shadow-lg border-b-4 transition-all active:border-b-0 active:translate-y-0.5 ${
            selected && !submitting
              ? 'bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white border-blue-800'
              : 'bg-gray-200 text-gray-400 border-gray-300 cursor-not-allowed shadow-none'
          }`} aria-disabled={!selected || submitting}>
          {submitting ? (
            <span className="flex items-center justify-center gap-2">
              <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Starting trip…
            </span>
          ) : selected ? `🚀 Start trip from ${selected.name}` : 'Select your municipality above'}
        </button>
        <button onClick={onRefresh} className="text-sm text-slate-500 hover:text-blue-600 underline underline-offset-2 text-center">
          Refresh — check if dispatcher assigned a trip
        </button>
      </div>
    </div>
  );
}

// ─── main component ───────────────────────────────────────────────────────────

export default function DriverDashboard() {
  const [trip, setTrip]                   = useState(null);
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState('');
  const [gpsState, setGpsState]           = useState(GPS_STATE.IDLE);
  const [gpsError, setGpsError]           = useState('');
  const [lastCoords, setLastCoords]       = useState(null);
  const [maxSpeedKmh, setMaxSpeedKmh]     = useState(0);
  const [seatCounts, setSeatCounts]       = useState({ total: 14, available: 14 });
  const [departureTime, setDepartureTime] = useState(null);
  const [delayMinutes, setDelayMinutes]   = useState(0);
  const [statusUpdating, setStatusUpdating] = useState(false);

  const seatSyncedRef = useRef(false);
  const watchIdRef    = useRef(null);
  const tripIdRef     = useRef(null);
  // Tracks the last accepted GPS fix so we can derive speed from position
  // deltas when the device itself doesn't report coords.speed.
  const lastFixRef    = useRef(null); // { lat, lng, timestamp }

  // ── Derived ────────────────────────────────────────────────────────────────

  const routeDurationMinutes = useMemo(() => {
    if (!trip?.route?.name) return DEFAULT_ROUTE_DURATION;
    const lower = trip.route.name.toLowerCase();
    const match = MUNICIPALITIES.find((m) => lower.includes(m.name.toLowerCase()));
    return match?.minutes ?? DEFAULT_ROUTE_DURATION;
  }, [trip?.route?.name]);

  const eta = useMemo(() => {
    if (!departureTime) return null;
    return new Date(departureTime.getTime() + (routeDurationMinutes + delayMinutes) * 60_000);
  }, [departureTime, routeDurationMinutes, delayMinutes]);

  // ── data fetching ──────────────────────────────────────────────────────────

  const fetchMyTrip = useCallback(async (signal, { silent = false } = {}) => {
  if (!silent) setLoading(true);
  setError('');
  try {
    const response    = await apiClient.get('/trips/my-trips', { signal });
    const currentTrip = response.data?.[0] ?? null;
    tripIdRef.current     = currentTrip?.id ?? null;
    seatSyncedRef.current = false;
    setTrip(currentTrip);
    setDepartureTime(null);
    setDelayMinutes(0);
    const capacity = currentTrip?.van?.capacity ?? 14;
    setSeatCounts({ total: capacity, available: capacity });
  } catch (err) {
    if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
    if (!silent) {
      setError('Failed to load your trip. Please check your connection and try again.');
    }
    console.error('[DriverDashboard] fetchMyTrip error:', err);
  } finally {
    if (!silent) setLoading(false);
  }
}, []);

  // ── GPS helpers ────────────────────────────────────────────────────────────

  const clearWatch = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  }, []);

  const stopLocationSharing = useCallback(() => {
    clearWatch();
    lastFixRef.current = null;
    setGpsState(GPS_STATE.IDLE);
    setLastCoords(null);
    socket.disconnect();
  }, [clearWatch]);

  const startLocationSharing = useCallback(() => {
    const tripId = tripIdRef.current;
    if (!tripId) {
      setGpsError('No active trip — select a municipality and start your trip first.');
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
    setGpsState(GPS_STATE.ACQUIRING);
    setMaxSpeedKmh(0);
    lastFixRef.current = null;
    socket.connect();

    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const { latitude: lat, longitude: lng, speed, accuracy } = position.coords;
        const timestamp = position.timestamp;

        // 1. Prefer the device's own speed reading when it's a real, sane number.
        let resolvedSpeed =
          typeof speed === 'number' && speed >= 0 && speed <= MAX_PLAUSIBLE_SPEED_MPS
            ? speed
            : null;

        // 2. Fall back to computing speed from the distance/time between the
        //    last two accepted fixes, when the device doesn't give us one.
        if (resolvedSpeed === null && lastFixRef.current) {
          const dtSeconds = (timestamp - lastFixRef.current.timestamp) / 1000;
          if (dtSeconds >= MIN_DT_FOR_FALLBACK_SECONDS) {
            const distanceMeters = haversineMeters(
              lastFixRef.current.lat, lastFixRef.current.lng, lat, lng
            );
            if (distanceMeters >= MIN_DISTANCE_FOR_FALLBACK_M) {
              const derivedSpeed = distanceMeters / dtSeconds;
              resolvedSpeed = derivedSpeed <= MAX_PLAUSIBLE_SPEED_MPS ? derivedSpeed : null;
            } else {
              resolvedSpeed = 0;
            }
          }
        }

        lastFixRef.current = { lat, lng, timestamp };

        socket.emit('driver_gps_update', {
          tripId: tripIdRef.current,
          lat,
          lng,
          speed: resolvedSpeed,
          accuracy: typeof accuracy === 'number' ? accuracy : null,
          heading: typeof position.coords.heading === 'number' ? position.coords.heading : null,
          timestamp,
        });

        setLastCoords({ lat, lng, accuracy, speed: resolvedSpeed });
        setGpsState(GPS_STATE.LIVE);
        setGpsError('');

        const kmh = msToKmh(resolvedSpeed);
        if (kmh !== null) {
          setMaxSpeedKmh((prev) => Math.max(prev, kmh));
        }
      },
      (err) => {
        console.error('[DriverDashboard] geolocation error:', err);
        setGpsError(geolocationErrorMessage(err));
        setGpsState(GPS_STATE.ERROR);
        clearWatch();
        socket.disconnect();
      },
      GPS_OPTIONS,
    );
  }, [clearWatch]);

  // ── Status control: generic step-forward for Boarding/Departing/Departed ──
  // (ARRIVING → COMPLETED happens via dispatcher QR scan, not this function.)

  const handleAdvanceStatus = useCallback(async (newStatus) => {
    if (!tripIdRef.current || !newStatus || statusUpdating) return;
    setStatusUpdating(true);
    try {
      const response = await apiClient.patch(`/trips/${tripIdRef.current}/status`, { newStatus });
      const updatedTrip = response.data?.trip ?? response.data;
      if (updatedTrip?.id) {
        setTrip(updatedTrip);
      } else {
        setTrip((prev) => prev ? { ...prev, status: newStatus } : prev);
      }

      if (newStatus === 'DEPARTING' && !departureTime) {
        setDepartureTime(new Date());
        setDelayMinutes(0);
      }
    } catch (err) {
      console.error('[DriverDashboard] status update error:', err);
      const msg = err?.response?.data?.error ?? err?.response?.data?.message ?? 'Could not update trip status. Try again.';
      setGpsError(msg);
    } finally {
      setStatusUpdating(false);
    }
  }, [statusUpdating, departureTime]);

  const handleAddDelay = useCallback((minutes) => {
    setDelayMinutes((prev) => prev + minutes);
  }, []);

  // ── seat counter actions ───────────────────────────────────────────────────

  const decreaseTotalSeats = useCallback(() => {
    setSeatCounts((prev) => {
      const nextTotal = Math.max(1, prev.total - 1);
      return { total: nextTotal, available: Math.min(prev.available, nextTotal) };
    });
  }, []);

  const increaseTotalSeats  = useCallback(() => setSeatCounts((prev) => ({ ...prev, total: prev.total + 1 })), []);
  const decreaseAvailableSeats = useCallback(() => setSeatCounts((prev) => ({ ...prev, available: Math.max(0, prev.available - 1) })), []);
  const increaseAvailableSeats = useCallback(() => setSeatCounts((prev) => ({ ...prev, available: Math.min(prev.total, prev.available + 1) })), []);

  // ── auth ───────────────────────────────────────────────────────────────────

  const handleLogout = useCallback(async () => {
    stopLocationSharing();

    try {
      await apiClient.post('/auth/logout');
    } catch (err) {
      console.warn('[DriverDashboard] logout request failed:', err);
    }

    try {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
    } catch {
      // ignore storage access errors (e.g. private browsing restrictions)
    }

    window.location.replace('/login');
  }, [stopLocationSharing]);

  // ── self-start callback ────────────────────────────────────────────────────

  const handleTripStarted = useCallback((newTrip) => {
    tripIdRef.current     = newTrip.id;
    seatSyncedRef.current = false;
    setTrip(newTrip);
    setDepartureTime(null);
    setDelayMinutes(0);
    setGpsState(GPS_STATE.IDLE);
    setGpsError('');
    setLastCoords(null);
    setMaxSpeedKmh(0);
    lastFixRef.current = null;
    const capacity = newTrip?.van?.capacity ?? 14;
    setSeatCounts({ total: capacity, available: capacity });
  }, []);

  // ── effects ────────────────────────────────────────────────────────────────

  useEffect(() => {
    const controller = new AbortController();
    fetchMyTrip(controller.signal);
    return () => { controller.abort(); stopLocationSharing(); };
  }, [fetchMyTrip, stopLocationSharing]);

  useEffect(() => {
    const tripId     = trip?.id;
    const tripStatus = trip?.status;
    if (!tripId || tripStatus !== 'BOARDING') return;
    socket.connect();
    socket.emit('seat_update', {
      tripId,
      availableSeats: seatCounts.available,
      totalSeats:     seatCounts.total,
    });
    seatSyncedRef.current = true;
  }, [trip?.id, trip?.status, seatCounts.available, seatCounts.total]);

  useEffect(() => {
    if (!trip?.id || !eta) return;
    socket.emit('eta_update', {
      tripId:        trip.id,
      eta:           eta.toISOString(),
      departureTime: departureTime?.toISOString() ?? null,
      delayMinutes,
    });
  }, [trip?.id, eta, departureTime, delayMinutes]);

  useEffect(() => {
    if (gpsState !== GPS_STATE.LIVE) return;
    const handleDisconnect = (reason) => {
      if (reason === 'io server disconnect') {
        setGpsError('Disconnected by server. Tap "Share live location" to reconnect.');
        setGpsState(GPS_STATE.ERROR);
        clearWatch();
      } else {
        socket.connect();
      }
    };
    socket.on('disconnect', handleDisconnect);
    return () => socket.off('disconnect', handleDisconnect);
  }, [gpsState, clearWatch]);

  // Keep the socket connected while waiting for the dispatcher's completion
  // scan, even if the driver isn't broadcasting GPS at that moment — this
  // is what lets the "arrived" screen update itself the instant the QR
  // code is scanned, with no manual refresh needed.
  useEffect(() => {
    if (trip?.status !== 'ARRIVING') return;
    socket.connect();
  }, [trip?.status]);

  // Listen for the dispatcher's QR scan completing this trip in real time.
  useEffect(() => {
  const handleRemoteStatusChange = (payload) => {
    if (!payload?.tripId || payload.tripId !== tripIdRef.current) return;
    const updatedTrip = payload.trip;
    if (!updatedTrip) return;

    if (updatedTrip.status === 'COMPLETED') {
      // The dispatcher just scanned this van's QR and closed out the trip.
      // Go straight to the "ready to load again at the terminal" screen
      // instead of rendering a dead-end COMPLETED state (StatusControlPanel
      // has no button or action for it) or flashing a full-page spinner —
      // fetchMyTrip's loading state would otherwise briefly replace this
      // screen entirely before settling back on the same TripSetupScreen.
      stopLocationSharing();
      tripIdRef.current = null;
      setTrip(null);
      setDepartureTime(null);
      setDelayMinutes(0);
      setMaxSpeedKmh(0);

      // Reconcile with the server in the background in case anything else
      // changed — but don't block or replace the UI while doing it.
      fetchMyTrip(undefined, { silent: true });
      return;
    }

    setTrip(updatedTrip);
  };
  socket.on('trip_status_changed', handleRemoteStatusChange);
  return () => socket.off('trip_status_changed', handleRemoteStatusChange);
}, [stopLocationSharing, fetchMyTrip]);

  // ── render: loading ────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" role="status" aria-label="Loading" />
          <p className="text-sm text-gray-500 font-medium">Loading fleet data…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-100 p-4 flex items-center justify-center">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-md p-6 text-center">
          <h1 className="text-xl font-black text-gray-800 mb-1">Driver portal</h1>
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4" role="alert">
            <p className="text-sm text-red-700 font-medium">{error}</p>
          </div>
          <button onClick={() => fetchMyTrip()} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-xl transition-colors">Try again</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100 p-4 font-sans flex flex-col">
      <div className="max-w-md w-full mx-auto bg-white rounded-2xl shadow-md overflow-hidden p-6 flex-1 flex flex-col gap-5">

        <header className="flex justify-between items-center border-b border-gray-100 pb-4">
          <div>
            <h1 className="text-2xl font-black text-gray-900 leading-tight">Driver portal</h1>
            <p className="text-xs text-gray-400 mt-0.5">
              {trip ? `Hi ${trip.driver?.name ?? 'there'} — here's your trip` : 'Secure live tracking'}
            </p>
          </div>
          <button onClick={handleLogout}
            className="text-sm font-semibold text-red-600 bg-red-50 hover:bg-red-100 px-3 py-1.5 rounded-lg transition-colors"
            aria-label="Log out">
            Logout
          </button>
        </header>

        {!trip ? (
          <TripSetupScreen onTripStarted={handleTripStarted} onRefresh={() => fetchMyTrip()} />
        ) : (
          <div className="flex-1 flex flex-col gap-5">

            <TripManifest trip={trip} eta={eta} delayMinutes={delayMinutes} />

            {trip.status === 'BOARDING' && (
              <BoardingPanel
                seatCounts={seatCounts}
                onDecrTotal={decreaseTotalSeats}
                onIncrTotal={increaseTotalSeats}
                onDecrAvail={decreaseAvailableSeats}
                onIncrAvail={increaseAvailableSeats}
              />
            )}

            <StatusControlPanel
              trip={trip}
              delayMinutes={delayMinutes}
              eta={eta}
              statusUpdating={statusUpdating}
              onAdvance={handleAdvanceStatus}
              onAddDelay={handleAddDelay}
              onRefresh={() => fetchMyTrip()}
            />

            {gpsError && gpsState !== GPS_STATE.IDLE && gpsState !== GPS_STATE.ERROR && (
              <div role="alert" className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 p-3 rounded-xl">
                <span className="text-base leading-none mt-0.5" aria-hidden="true">⚠️</span>
                <span className="font-medium">{gpsError}</span>
              </div>
            )}

            <div className="mt-auto pt-2">
              <LiveTrackingCard
                trip={trip}
                gpsState={gpsState}
                gpsError={gpsError}
                lastCoords={lastCoords}
                maxSpeedKmh={maxSpeedKmh}
                onStart={startLocationSharing}
                onStop={stopLocationSharing}
              />
            </div>

          </div>
        )}
      </div>
    </div>
  );
}
