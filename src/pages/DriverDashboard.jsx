import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import apiClient from '../api/axios';
import { socket } from '../api/socket';
import { VIRAC_HUB } from '../components/townCoordinates';

// ─── constants ────────────────────────────────────────────────────────────────
//
// A trip is a ROUND TRIP made of two legs, tracked by `trip.direction`:
//
//   OUTBOUND  municipality → terminal
//     BOARDING → DEPARTING → DEPARTED → ARRIVING
//     At ARRIVING the driver shows a QR code. The dispatcher's scan checks
//     the van into its cooperative's terminal line: first in line goes
//     straight to BOARDING (RETURN leg), otherwise QUEUED.
//
//   RETURN    terminal → municipality
//     (QUEUED →) BOARDING → DEPARTING → DEPARTED → ARRIVING
//     At DEPARTING the driver shows a QR code again. The dispatcher's scan
//     releases the van from the terminal (DEPARTED). There is no scan at
//     the municipality — the driver taps "Finish Trip".

const GPS_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 };

const GPS_LOCKED_STATUSES = ['SCHEDULED', 'COMPLETED', 'CANCELLED'];

const HOME_TERMINAL_NAME = 'Provincial Integrated Transport Terminal and Business Complex';
const HOME_TERMINAL_SHORT = 'Terminal';

const PHONE_RE = /^[+\d][\d\s-]{6,14}$/;
const MAX_CONTACT_NUMBERS = 5;
const SEAT_PERSIST_DEBOUNCE_MS = 500;

function isHomeTerminal(name) {
  return typeof name === 'string' && name.trim().toLowerCase() === HOME_TERMINAL_NAME.toLowerCase();
}

const STATUS_COPY = {
  SCHEDULED:  { label: 'Scheduled',           icon: '🗓️' },
  BOARDING:   { label: 'Boarding Passengers', icon: '🧍' },
  DEPARTING:  { label: 'Preparing to Depart', icon: '🚦' },
  DEPARTED:   { label: 'On the Road',         icon: '🚐' },
  ARRIVING:   { label: 'Arriving Soon',       icon: '📍' },
  QUEUED:     { label: 'Queued at Terminal',  icon: '🅿️' },
  DELAYED:    { label: 'Delayed',             icon: '⏱️' },
  COMPLETED:  { label: 'Trip Completed',      icon: '✅' },
  CANCELLED:  { label: 'Cancelled',           icon: '✕' },
};

const STATUS_STYLES = {
  BOARDING:   'bg-green-100  text-green-800  border border-green-200',
  DEPARTING:  'bg-amber-100  text-amber-800  border border-amber-200',
  DEPARTED:   'bg-blue-100   text-blue-800   border border-blue-200',
  ARRIVING:   'bg-indigo-100 text-indigo-800 border border-indigo-200',
  QUEUED:     'bg-amber-100  text-amber-800  border border-amber-300',
  DELAYED:    'bg-orange-100 text-orange-800 border border-orange-200',
  COMPLETED:  'bg-gray-100   text-gray-600   border border-gray-200',
  CANCELLED:  'bg-red-100    text-red-700    border border-red-200',
  SCHEDULED:  'bg-yellow-100 text-yellow-800 border border-yellow-200',
};

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

const DEFAULT_ROUTE_DURATION = 60;
const DELAY_OPTIONS = [5, 10, 15, 30];

const ETA_STATUSES = ['DEPARTING', 'DEPARTED', 'ARRIVING', 'DELAYED'];
const DELAY_REPORT_STATUSES = ['DEPARTING', 'DEPARTED', 'ARRIVING', 'DELAYED'];
const MAP_VISIBLE_STATUSES = ['BOARDING', 'QUEUED', 'DEPARTING', 'DEPARTED', 'ARRIVING', 'DELAYED'];

const GPS_STATE = { IDLE: 'IDLE', ACQUIRING: 'ACQUIRING', LIVE: 'LIVE', ERROR: 'ERROR' };

const MAX_PLAUSIBLE_SPEED_MPS = 55;
const MIN_DT_FOR_FALLBACK_SECONDS = 2;
const MIN_DISTANCE_FOR_FALLBACK_M = 3;

const FLEET_REFETCH_INTERVAL_MS = 30_000;
const FLEET_GPS_STALE_THRESHOLD_MS = 120_000;

// ── Per-status marker styling — identical palette to PublicTracking.jsx ────
const STATUS_MARKER_STYLE = {
  BOARDING:  { glyph: '🧍', color: '#16a34a' },
  QUEUED:    { glyph: '🅿️', color: '#d97706' },
  DEPARTING: { glyph: '🚦', color: '#d97706' },
  DEPARTED:  { glyph: '🚐', color: '#2563eb' },
  ARRIVING:  { glyph: '📍', color: '#059669' },
  DELAYED:   { glyph: '⏱️', color: '#ea580c' },
};
const DEFAULT_MARKER_STYLE = { glyph: '🚐', color: '#6b7280' };

const statusIconCache = new Map();
function getVanIconForStatus(status, isOwn) {
  const cacheKey = `${status}-${isOwn ? 'own' : 'other'}`;
  if (statusIconCache.has(cacheKey)) return statusIconCache.get(cacheKey);

  const { glyph, color } = STATUS_MARKER_STYLE[status] ?? DEFAULT_MARKER_STYLE;
  const borderWidth = isOwn ? 4 : 3;
  const size = isOwn ? 40 : 36;

  const icon = L.divIcon({
    className: '',
    html: `
      <div style="
        font-size:${isOwn ? '20px' : '18px'};
        background:white;
        border-radius:50%;
        padding:4px;
        border:${borderWidth}px solid ${color};
        width:${size}px;
        height:${size}px;
        display:flex;
        align-items:center;
        justify-content:center;
        box-shadow:0 4px 12px ${color}59;
      ">${glyph}</div>
    `,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -(size / 2 + 4)],
  });

  statusIconCache.set(cacheKey, icon);
  return icon;
}

const hubIcon = L.divIcon({
  className: '',
  html: `
    <div style="
      font-size:16px;
      background:#1e3a2f;
      border-radius:50%;
      padding:5px;
      border:3px solid #6ee7b7;
      width:34px;
      height:34px;
      display:flex;
      align-items:center;
      justify-content:center;
      box-shadow:0 4px 8px rgba(0,0,0,0.3);
    ">🏛️</div>
  `,
  iconSize: [34, 34],
  iconAnchor: [17, 17],
  popupAnchor: [0, -20],
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function getStoredUserId() {
  try {
    const raw = localStorage.getItem('user');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.id ?? parsed?.userId ?? null;
  } catch {
    return null;
  }
}

function getStoredContactNumbers() {
  try {
    const raw = localStorage.getItem('user');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.contactNumbers) && parsed.contactNumbers.length) {
      return parsed.contactNumbers;
    }
    if (typeof parsed?.contactNumber === 'string' && parsed.contactNumber) {
      return [parsed.contactNumber];
    }
    return [];
  } catch {
    return [];
  }
}

function persistContactNumbersLocally(numbers) {
  try {
    const raw = localStorage.getItem('user');
    if (!raw) return;
    const parsed = JSON.parse(raw);
    parsed.contactNumbers = numbers;
    localStorage.setItem('user', JSON.stringify(parsed));
  } catch {
    // ignore storage errors
  }
}

function geolocationErrorMessage(err) {
  if (!err) return 'GPS error. Please try again.';
  switch (err.code) {
    case 1: return 'Location permission denied. Open browser settings and allow location access, then try again.';
    case 2: return 'GPS signal unavailable. Move to an open area and try again.';
    case 3: return 'GPS timed out acquiring a fix. Try again.';
    default: return `GPS error (code ${err.code}). Please try again.`;
  }
}

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

function getDirection(trip) {
  return trip?.direction === 'RETURN' ? 'RETURN' : 'OUTBOUND';
}

function shortPlace(name) {
  if (isHomeTerminal(name)) return HOME_TERMINAL_SHORT;
  return (name ?? 'Unknown').replace(/\s*Terminal$/i, '');
}

function originName(trip) {
  return trip?.route?.origin ?? trip?.route?.name?.split('→')[0]?.trim() ?? 'Unknown';
}

// Where the van is heading on its CURRENT leg.
function legDestinationLabel(trip) {
  return getDirection(trip) === 'RETURN' ? shortPlace(originName(trip)) : HOME_TERMINAL_SHORT;
}

// Where the van started its CURRENT leg.
function legOriginLabel(trip) {
  return getDirection(trip) === 'RETURN' ? HOME_TERMINAL_SHORT : shortPlace(originName(trip));
}

// The single driver-facing button for the current status (null when the
// driver has nothing to tap — e.g. waiting for a dispatcher scan).
function getAdvanceStep(trip) {
  if (!trip) return null;
  const dest = legDestinationLabel(trip);
  switch (trip.status) {
    case 'BOARDING':
      return { next: 'DEPARTING', actionLabel: '🚦 Ready to Depart', actionHint: 'Tap once all passengers are seated.' };
    case 'DEPARTING':
      // On the RETURN leg the dispatcher's exit scan confirms departure —
      // the driver just shows their QR code.
      if (getDirection(trip) === 'RETURN') return null;
      return { next: 'DEPARTED', actionLabel: '🚐 Confirm Departure', actionHint: 'Tap the moment you actually pull out.' };
    case 'DEPARTED':
      return { next: 'ARRIVING', actionLabel: `📍 Approaching ${dest}`, actionHint: `Tap when you're close to ${dest}.` };
    default:
      return null;
  }
}

function getStepperSteps(trip) {
  return [
    { key: 'BOARDING',  icon: '🧍' },
    { key: 'DEPARTING', icon: '🚦' },
    { key: 'DEPARTED',  icon: '🚐' },
    { key: 'ARRIVING',  icon: '📍' },
    getDirection(trip) === 'RETURN'
      ? { key: 'COMPLETED', icon: '✅' }
      : { key: 'CHECKIN',   icon: '🅿️' },
  ];
}

// Keeps the van's QR token when a socket broadcast (which doesn't carry it)
// replaces the trip object.
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

function TripProgressStepper({ trip }) {
  const steps = getStepperSteps(trip);
  const idx = steps.findIndex((s) => s.key === trip.status);
  if (idx === -1) return null;

  return (
    <div className="flex items-center" aria-label="Trip progress">
      {steps.map((step, i) => {
        const isDone    = i < idx;
        const isCurrent = i === idx;
        return (
          <div key={step.key} className="flex items-center flex-1 last:flex-none">
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
                {isDone ? '✓' : step.icon}
              </div>
            </div>
            {i < steps.length - 1 && (
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
  const direction = getDirection(trip);
  const from = legOriginLabel(trip);
  const to   = legDestinationLabel(trip);
  const coop = trip.van?.cooperative?.name;

  const fields = [
    { label: 'Leg',         value: direction === 'RETURN' ? '↩ Return trip' : '↗ Outbound trip' },
    { label: 'From',        value: from },
    { label: 'Destination', value: to },
    { label: 'Van plate',   value: trip.van?.plateNumber ?? 'Unknown' },
    ...(coop ? [{ label: 'Cooperative', value: coop }] : []),
    { label: 'Capacity',    value: trip.van?.capacity ?? '—' },
    { label: 'Status',      value: <StatusBadge status={trip.status} /> },
    {
      label: 'Trip started',
      value: trip.scheduledTime
        ? new Date(trip.scheduledTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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
          {from} <span className="text-slate-300 mx-1">→</span> {to}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-y-3 text-sm">
        {fields.map(({ label, value }) => (
          <Fragment key={label}>
            <dt className="text-slate-500">{label}</dt>
            <dd className="font-semibold text-slate-900">{value}</dd>
          </Fragment>
        ))}
      </dl>
    </section>
  );
}

// ── SeatManagerPanel ───────────────────────────────────────────────────────

function SeatManagerPanel({ seatCounts, saving, onDecrTotal, onIncrTotal, onDecrAvail, onIncrAvail }) {
  return (
    <section className="bg-green-50 p-5 rounded-xl border-2 border-green-200" aria-label="Seat availability controls">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-bold text-green-900 uppercase tracking-wider">
          Seat availability
        </h2>
        {saving && (
          <span className="text-[11px] font-semibold text-green-600 flex items-center gap-1">
            <span className="w-2 h-2 border-2 border-green-600 border-t-transparent rounded-full animate-spin" />
            Saving…
          </span>
        )}
      </div>
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
        <p className="text-[11px] text-green-600 mt-3">
          Counts are saved automatically and reset to full when the return trip begins.
        </p>
      </div>
    </section>
  );
}

// ── ContactNumbersPanel ────────────────────────────────────────────────────

function ContactNumbersPanel({
  numbers,
  newNumber,
  onNewNumberChange,
  onAdd,
  onRemove,
  saving,
  error,
  onClose,
}) {
  const atCap = numbers.length >= MAX_CONTACT_NUMBERS;
  const canAdd = newNumber.trim().length > 0 && PHONE_RE.test(newNumber.trim()) && !atCap;

  return (
    <section className="bg-slate-50 p-4 rounded-xl border border-slate-200 mt-3">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wider">
          📞 My contact numbers
        </h2>
        <div className="flex items-center gap-2">
          {saving && (
            <span className="text-[11px] font-semibold text-slate-500 flex items-center gap-1">
              <span className="w-2 h-2 border-2 border-slate-500 border-t-transparent rounded-full animate-spin" />
              Saving…
            </span>
          )}
          <button
            onClick={onClose}
            className="text-xs font-bold text-slate-400 hover:text-slate-700"
            aria-label="Close contact numbers editor"
          >
            ✕
          </button>
        </div>
      </div>

      {numbers.length === 0 ? (
        <p className="text-xs text-slate-400 mb-3">
          No contact numbers yet. Passengers will see these on the public tracking page.
        </p>
      ) : (
        <ul className="space-y-1.5 mb-3">
          {numbers.map((n) => (
            <li
              key={n}
              className="flex items-center justify-between bg-white px-3 py-2 rounded-lg border border-slate-200"
            >
              <span className="text-sm font-semibold text-slate-800 tabular-nums">{n}</span>
              <button
                onClick={() => onRemove(n)}
                className="text-xs font-bold text-red-500 hover:text-red-700"
                aria-label={`Remove ${n}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {!atCap && (
        <div className="flex gap-2">
          <input
            type="tel"
            inputMode="tel"
            placeholder="09XXXXXXXXX"
            value={newNumber}
            onChange={(e) => onNewNumberChange(e.target.value)}
            className="flex-1 min-w-0 px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            maxLength={15}
            aria-label="New contact number"
          />
          <button
            onClick={onAdd}
            disabled={!canAdd}
            className={`px-4 py-2 rounded-lg font-bold text-sm transition-colors ${
              canAdd
                ? 'bg-blue-600 hover:bg-blue-700 text-white'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
          >
            Add
          </button>
        </div>
      )}

      {atCap && (
        <p className="text-[11px] text-slate-400">
          Maximum of {MAX_CONTACT_NUMBERS} numbers. Remove one to add another.
        </p>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600 font-medium">
          ⚠️ {error}
        </p>
      )}
    </section>
  );
}

// ── FleetMap ───────────────────────────────────────────────────────────────

function FleetMap({ fleetTrips, fleetLiveData, ownTripId }) {
  const now = Date.now();

  const markers = fleetTrips
    .filter((trip) => MAP_VISIBLE_STATUSES.includes(trip.status))
    .map((trip) => {
      const live = fleetLiveData[trip.id];
      const hasGps = typeof live?.lat === 'number' && typeof live?.lng === 'number';
      const isStale = hasGps && live?.lastSeen && now - live.lastSeen > FLEET_GPS_STALE_THRESHOLD_MS;

      if (!hasGps || isStale) return null;

      return {
        tripId: trip.id,
        position: [live.lat, live.lng],
        status: trip.status,
        plateNumber: trip.van?.plateNumber,
        driverName: trip.driver?.name,
        speedKmh: msToKmh(live?.speed),
        isOwn: trip.id === ownTripId,
      };
    })
    .filter(Boolean);

  return (
    <section className="rounded-xl overflow-hidden border border-gray-200 shadow-sm" aria-label="Live fleet map">
      <div className="bg-slate-800 text-white text-xs font-bold uppercase tracking-wide px-3 py-2 flex items-center justify-between">
        <span>🗺️ Live Fleet Map</span>
        <span className="text-slate-300 font-normal normal-case">
          {markers.length} van{markers.length === 1 ? '' : 's'} active
        </span>
      </div>
      <div style={{ height: '220px' }}>
        <MapContainer center={VIRAC_HUB} zoom={11} style={{ height: '100%', width: '100%' }} scrollWheelZoom={false}>
          <TileLayer
            attribution='&copy; OpenStreetMap contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <Marker position={VIRAC_HUB} icon={hubIcon}>
            <Popup>
              <div className="text-xs font-bold">{HOME_TERMINAL_NAME}</div>
            </Popup>
          </Marker>
          {markers.map((m) => (
            <Marker key={m.tripId} position={m.position} icon={getVanIconForStatus(m.status, m.isOwn)}>
              <Popup>
                <div className="text-xs space-y-0.5">
                  <div className="font-bold">
                    {m.plateNumber ?? 'Unknown plate'}{m.isOwn ? ' (You)' : ''}
                  </div>
                  {m.driverName && <div className="text-gray-500">{m.driverName}</div>}
                  <div>{friendlyStatus(m.status).label}</div>
                  {m.speedKmh != null && <div>{m.speedKmh} km/h</div>}
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>
      {markers.length === 0 && (
        <p className="text-xs text-gray-400 text-center py-2 bg-gray-50 border-t border-gray-100">
          No vans currently broadcasting live GPS.
        </p>
      )}
    </section>
  );
}

function LiveTrackingCard({
  trip,
  gpsState,
  gpsError,
  lastCoords,
  maxSpeedKmh,
  autoArmed,
  onStart,
  onStop,
}) {
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
          <span className="text-xs font-bold uppercase tracking-widest text-blue-100">
            Live tracking active · auto-shared
          </span>
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

  return (
    <section className="bg-white border-2 border-dashed border-blue-200 rounded-xl p-5 text-center">
      <p className="text-3xl mb-2" aria-hidden="true">📍</p>
      {autoArmed ? (
        <>
          <p className="text-sm font-bold text-gray-800 mb-1">Waiting for boarding…</p>
          <p className="text-xs text-gray-500 mb-4">
            Your location will start sharing automatically the moment your trip
            enters boarding. You don't need to do anything.
          </p>
        </>
      ) : (
        <>
          <p className="text-sm font-bold text-gray-800 mb-1">Share your live location</p>
          <p className="text-xs text-gray-500 mb-4">
            Passengers and dispatch will see your position and speed in real time.
          </p>
        </>
      )}
      {gpsError && (
        <div role="alert" className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 p-3 rounded-xl mb-4 text-left">
          <span className="text-base leading-none mt-0.5" aria-hidden="true">⚠️</span>
          <span className="font-medium">{gpsError}</span>
        </div>
      )}
      <button onClick={onStart} aria-label="Share live GPS location"
        className="w-full bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-bold text-base py-4 px-4 rounded-xl shadow-lg border-b-4 border-blue-800 transition-colors active:border-b-0 active:translate-y-0.5">
        📍 Start sharing now
      </button>
      <p className="text-[11px] text-gray-400 mt-2">
        Auto-start will kick in when the trip moves to boarding.
      </p>
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

// ── TripQrPanel ────────────────────────────────────────────────────────────
// The van's ticket for a dispatcher scan at the terminal. Shown at TWO points:
//   mode="CHECK_IN" — OUTBOUND leg, ARRIVING (van has reached the terminal)
//   mode="EXIT"     — RETURN leg, DEPARTING (van is ready to leave the terminal)

function TripQrPanel({ trip, onRefresh, mode = 'CHECK_IN' }) {
  const van = trip?.van;
  const isExit = mode === 'EXIT';

  if (!van?.qrToken) {
    return (
      <section className="bg-amber-50 border border-amber-200 rounded-xl p-5 text-center">
        <p className="text-sm font-semibold text-amber-800">QR code unavailable</p>
        <p className="text-xs text-amber-600 mt-1">
          Tap refresh below, or ask your dispatcher to {isExit ? 'release you' : 'check you in'} manually.
        </p>
        <button onClick={onRefresh} className="mt-3 text-xs text-amber-700 hover:text-amber-900 underline underline-offset-2">
          Refresh
        </button>
      </section>
    );
  }

  return (
    <section
      className="bg-white border-2 border-indigo-200 rounded-2xl p-6 text-center"
      aria-label={isExit ? 'Terminal exit QR code' : 'Terminal check-in QR code'}
    >
      <p className="text-sm font-bold text-indigo-900 mb-1">
        {isExit ? 'Ready to leave the terminal 🚐' : "You've reached the terminal 🎉"}
      </p>
      <p className="text-xs text-indigo-500 mb-4">
        {isExit
          ? `Show this to your dispatcher. Once scanned, your trip to ${legDestinationLabel(trip)} starts and you're cleared to leave.`
          : "Show this to your dispatcher. Scanning it checks you into your cooperative's boarding line — first in line starts boarding right away, otherwise you'll be queued."}
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

function StatusControlPanel({
  trip,
  delayMinutes,
  eta,
  statusUpdating,
  statusError,
  onAdvance,
  onAddDelay,
  onRefresh,
}) {
  if (!trip) return null;

  const direction = getDirection(trip);
  const dest = legDestinationLabel(trip);
  const step = getAdvanceStep(trip);

  const awaitingScan     = direction === 'OUTBOUND' && trip.status === 'ARRIVING';
  const awaitingExitScan = direction === 'RETURN' && trip.status === 'DEPARTING';
  const canFinish        = direction === 'RETURN' && trip.status === 'ARRIVING';
  const isQueued         = trip.status === 'QUEUED';
  const showEta          = ETA_STATUSES.includes(trip.status);

  return (
    <section className="bg-indigo-50 p-4 rounded-xl border-2 border-indigo-200" aria-label="Trip status control">
      <h2 className="text-sm font-bold text-indigo-900 uppercase tracking-wider mb-4 text-center">
        Trip status · {direction === 'RETURN' ? 'Return leg' : 'Outbound leg'}
      </h2>

      {!isQueued && (
        <div className="mb-5 px-1">
          <TripProgressStepper trip={trip} />
        </div>
      )}

      {isQueued && (
        <div className="bg-amber-50 border-2 border-amber-200 rounded-xl p-5 text-center mb-2">
          <p className="text-3xl mb-1" aria-hidden="true">🅿️</p>
          <p className="text-sm font-bold text-amber-900">You're checked in and queued</p>
          <p className="text-xs text-amber-700 mt-1">
            Another van from your cooperative is boarding right now. You'll move to
            boarding automatically as soon as it departs — nothing to tap.
          </p>
        </div>
      )}

      {trip.status === 'DELAYED' && (
        <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 text-center text-sm text-orange-800 font-semibold mb-4">
          ⏱️ Trip marked as delayed. Use the buttons below to report further delay, or contact your dispatcher to resume.
        </div>
      )}

      {showEta && (
        <div className="text-center mb-4">
          <p className="text-xs text-indigo-500 mb-0.5">Estimated arrival · {dest}</p>
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

      {awaitingScan && (
        <div className="mt-2">
          <TripQrPanel trip={trip} onRefresh={onRefresh} mode="CHECK_IN" />
        </div>
      )}

      {awaitingExitScan && (
        <div className="mt-2">
          <TripQrPanel trip={trip} onRefresh={onRefresh} mode="EXIT" />
        </div>
      )}

      {canFinish && (
        <div className="mt-2 bg-emerald-50 border-2 border-emerald-200 rounded-xl p-5 text-center">
          <p className="text-3xl mb-1" aria-hidden="true">🏁</p>
          <p className="text-sm font-bold text-emerald-900">Arriving at {dest}</p>
          <p className="text-xs text-emerald-700 mt-1 mb-4">
            No scan needed here. Once your passengers are off, finish the trip.
          </p>
          <button onClick={() => onAdvance('COMPLETED')} disabled={statusUpdating}
            className="w-full bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white font-bold py-4 px-4 rounded-xl shadow-sm transition-colors border-b-4 border-emerald-800 active:border-b-0 active:translate-y-0.5 disabled:opacity-60 disabled:cursor-not-allowed"
            aria-label="Finish trip">
            {statusUpdating ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Finishing…
              </span>
            ) : '✅ Finish Trip'}
          </button>
        </div>
      )}

      {statusError && (
        <div role="alert" className="mt-3 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 p-3 rounded-xl">
          <span className="text-base leading-none mt-0.5" aria-hidden="true">⚠️</span>
          <span className="font-medium">{statusError}</span>
        </div>
      )}

      {DELAY_REPORT_STATUSES.includes(trip.status) && (
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
      destination: HOME_TERMINAL_NAME,
      routeName:   `${selected.name} → ${HOME_TERMINAL_NAME}`,
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
          <span className="font-semibold text-gray-700">{HOME_TERMINAL_SHORT}</span>
          {' '}and bring you back after.
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
              {HOME_TERMINAL_SHORT}
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
  const [seatSaving, setSeatSaving]       = useState(false);
  const [departureTime, setDepartureTime] = useState(null);
  const [delayMinutes, setDelayMinutes]   = useState(0);
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [statusError, setStatusError]     = useState('');

  const [pendingAutoStart, setPendingAutoStart] = useState(null);

  const [fleetTrips, setFleetTrips]       = useState([]);
  const [fleetLiveData, setFleetLiveData] = useState({});

  // ── Contact numbers ──
  const [contactNumbers, setContactNumbers]         = useState(getStoredContactNumbers());
  const [newContactNumber, setNewContactNumber]     = useState('');
  const [contactsSaving, setContactsSaving]         = useState(false);
  const [contactsError, setContactsError]           = useState('');
  const [showContactEditor, setShowContactEditor]   = useState(false);

  const watchIdRef    = useRef(null);
  const tripIdRef     = useRef(null);
  const tripRef       = useRef(null);
  const lastFixRef    = useRef(null);
  const userIdRef     = useRef(getStoredUserId());

  // Tracks which trip's seatCounts have been hydrated from the server.
  // Prevents the initial load from triggering a redundant PATCH.
  const seatHydratedForTripRef = useRef(null);
  const seatPersistTimerRef    = useRef(null);

  useEffect(() => { tripRef.current = trip; }, [trip]);

  const routeDurationMinutes = useMemo(() => {
    const name = trip?.route?.name ?? trip?.route?.origin;
    if (!name) return DEFAULT_ROUTE_DURATION;
    const lower = name.toLowerCase();
    const match = MUNICIPALITIES.find((m) => lower.includes(m.name.toLowerCase()));
    return match?.minutes ?? DEFAULT_ROUTE_DURATION;
  }, [trip?.route?.name, trip?.route?.origin]);

  const eta = useMemo(() => {
    if (!departureTime) return null;
    return new Date(departureTime.getTime() + (routeDurationMinutes + delayMinutes) * 60_000);
  }, [departureTime, routeDurationMinutes, delayMinutes]);

  // ── Load driver's trip (seats come from the trip, not the van default) ──
  const fetchMyTrip = useCallback(async (signal, { silent = false } = {}) => {
    if (!silent) setLoading(true);
    if (!silent) setError('');
    try {
      const response    = await apiClient.get('/trips/my-trips', { signal });
      const currentTrip = response.data?.[0] ?? null;
      tripIdRef.current = currentTrip?.id ?? null;
      setTrip((prev) => (currentTrip ? mergeTrip(prev, currentTrip) : null));
      setDepartureTime(null);
      setDelayMinutes(0);

      const fallbackTotal  = currentTrip?.van?.capacity ?? 14;
      const totalSeats     = currentTrip?.totalSeats     ?? fallbackTotal;
      const availableSeats = currentTrip?.availableSeats ?? totalSeats;
      setSeatCounts({ total: totalSeats, available: availableSeats });

      seatHydratedForTripRef.current = currentTrip?.id ?? null;
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

  const fetchFleetTrips = useCallback(async (signal) => {
    try {
      const response = await apiClient.get('/trips/live', { signal });
      const trips = Array.isArray(response.data) ? response.data : [];
      setFleetTrips(trips);

      setFleetLiveData((prev) => {
        const next = { ...prev };
        for (const t of trips) {
          const loc = t.liveLocation;
          if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') continue;
          const newLastSeen = typeof loc.timestamp === 'number' ? loc.timestamp : Date.now();
          const existing = next[t.id];
          if (!existing || newLastSeen > (existing.lastSeen ?? 0)) {
            next[t.id] = {
              lat: loc.lat,
              lng: loc.lng,
              speed: typeof loc.speed === 'number' ? loc.speed : null,
              accuracy: typeof loc.accuracy === 'number' ? loc.accuracy : null,
              lastSeen: newLastSeen,
            };
          }
        }
        return next;
      });
    } catch (err) {
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
      console.error('[DriverDashboard] fetchFleetTrips error:', err);
    }
  }, []);

  // ── Contact numbers ──
  const fetchContactNumbers = useCallback(async (signal) => {
    try {
      const response = await apiClient.get('/drivers/me/contact-numbers', { signal });
      const numbers = Array.isArray(response.data?.contactNumbers)
        ? response.data.contactNumbers
        : [];
      setContactNumbers(numbers);
      persistContactNumbersLocally(numbers);
    } catch (err) {
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
      console.warn('[DriverDashboard] fetchContactNumbers failed (using local cache):', err?.message);
    }
  }, []);

  const saveContactNumbers = useCallback(async (nextNumbers) => {
    setContactsSaving(true);
    setContactsError('');
    try {
      await apiClient.patch('/drivers/me/contact-numbers', { contactNumbers: nextNumbers });
      persistContactNumbersLocally(nextNumbers);
    } catch (err) {
      const msg = err?.response?.data?.error ?? 'Failed to save. Try again.';
      setContactsError(msg);
      setContactNumbers(contactNumbers);
      console.error('[DriverDashboard] saveContactNumbers failed:', err);
    } finally {
      setContactsSaving(false);
    }
  }, [contactNumbers]);

  const handleAddContact = useCallback(() => {
    const trimmed = newContactNumber.trim();
    if (!trimmed) return;
    if (!PHONE_RE.test(trimmed)) {
      setContactsError('Enter a valid phone number (digits only, 7–15 chars).');
      return;
    }
    if (contactNumbers.includes(trimmed)) {
      setContactsError('That number is already on your list.');
      return;
    }
    if (contactNumbers.length >= MAX_CONTACT_NUMBERS) {
      setContactsError(`Maximum of ${MAX_CONTACT_NUMBERS} numbers.`);
      return;
    }
    const next = [...contactNumbers, trimmed];
    setContactNumbers(next);
    setNewContactNumber('');
    setContactsError('');
    saveContactNumbers(next);
  }, [newContactNumber, contactNumbers, saveContactNumbers]);

  const handleRemoveContact = useCallback((number) => {
    const next = contactNumbers.filter((n) => n !== number);
    setContactNumbers(next);
    setContactsError('');
    saveContactNumbers(next);
  }, [contactNumbers, saveContactNumbers]);

  // ── GPS ──
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

        let resolvedSpeed =
          typeof speed === 'number' && speed >= 0 && speed <= MAX_PLAUSIBLE_SPEED_MPS
            ? speed
            : null;

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

        socket.emit('driver_location', {
          tripId: tripIdRef.current,
          lat,
          lng,
          speed: resolvedSpeed,
          accuracy: typeof accuracy === 'number' ? accuracy : null,
          heading: typeof position.coords.heading === 'number' ? position.coords.heading : null,
        });

        setLastCoords({ lat, lng, accuracy, speed: resolvedSpeed });
        setGpsState(GPS_STATE.LIVE);
        setGpsError('');

        const kmh = msToKmh(resolvedSpeed);
        if (kmh !== null) {
          setMaxSpeedKmh((prev) => Math.max(prev, kmh));
        }

        setFleetLiveData((prev) => ({
          ...prev,
          [tripIdRef.current]: {
            lat, lng, speed: resolvedSpeed, accuracy, lastSeen: Date.now(),
          },
        }));
      },
      (err) => {
        console.error('[DriverDashboard] geolocation error:', err);
        setGpsError(geolocationErrorMessage(err));
        setGpsState(GPS_STATE.ERROR);
        clearWatch();
      },
      GPS_OPTIONS,
    );
  }, [clearWatch]);

  // ── Applies a fresh trip payload from either the driver's own PATCH
  //    response or a socket broadcast (dispatcher scan, queue promotion).
  //    • COMPLETED/CANCELLED  → clean up and go back to the setup screen
  //    • direction flipped    → a new leg began: reset ETA + seats
  //    • RETURN → DEPARTED    → the dispatcher's exit scan: start the ETA clock
  //    • otherwise            → merge, keeping the van's QR token
  const applyTripUpdate = useCallback((updated) => {
    if (!updated?.id) return;

    if (updated.status === 'COMPLETED' || updated.status === 'CANCELLED') {
      stopLocationSharing();
      const finishedTripId = updated.id;
      setFleetTrips((prev) => prev.filter((t) => t.id !== finishedTripId));
      setFleetLiveData((prev) => {
        const next = { ...prev };
        delete next[finishedTripId];
        return next;
      });
      tripIdRef.current = null;
      setTrip(null);
      setDepartureTime(null);
      setDelayMinutes(0);
      setMaxSpeedKmh(0);
      setStatusError('');
      fetchMyTrip(undefined, { silent: true });
      return;
    }

    const prevTrip = tripRef.current;
    const directionChanged =
      prevTrip && prevTrip.id === updated.id && updated.direction && prevTrip.direction !== updated.direction;

    if (directionChanged) {
      setDepartureTime(null);
      setDelayMinutes(0);
      // Passengers got off at the terminal — the van starts the return leg empty.
      setSeatCounts((prev) => ({ ...prev, available: prev.total }));
    }

    // Dispatcher's exit scan moved the RETURN leg to DEPARTED — the van has
    // actually left now, so restart the ETA clock from this moment.
    if (
      prevTrip &&
      prevTrip.id === updated.id &&
      prevTrip.status !== 'DEPARTED' &&
      updated.status === 'DEPARTED' &&
      updated.direction === 'RETURN'
    ) {
      setDepartureTime(new Date());
      setDelayMinutes(0);
    }

    setTrip((prev) => mergeTrip(prev, updated));
  }, [stopLocationSharing, fetchMyTrip]);

  const handleAdvanceStatus = useCallback(async (newStatus) => {
    if (!tripIdRef.current || !newStatus || statusUpdating) return;
    setStatusUpdating(true);
    setStatusError('');
    try {
      const response = await apiClient.patch(`/trips/${tripIdRef.current}/status`, { newStatus });
      const updatedTrip = response.data?.trip ?? response.data;

      if (newStatus === 'DEPARTING') {
        setDepartureTime(new Date());
        setDelayMinutes(0);
      }

      if (updatedTrip?.id) {
        applyTripUpdate(updatedTrip);
      } else {
        setTrip((prev) => (prev ? { ...prev, status: newStatus } : prev));
      }
    } catch (err) {
      console.error('[DriverDashboard] status update error:', err);
      const msg =
        err?.response?.data?.error ??
        err?.response?.data?.message ??
        'Could not update trip status. Try again.';
      setStatusError(msg);
    } finally {
      setStatusUpdating(false);
    }
  }, [statusUpdating, applyTripUpdate]);

  const handleAddDelay = useCallback((minutes) => {
    setDelayMinutes((prev) => prev + minutes);
  }, []);

  const decreaseTotalSeats = useCallback(() => {
    setSeatCounts((prev) => {
      const nextTotal = Math.max(1, prev.total - 1);
      return { total: nextTotal, available: Math.min(prev.available, nextTotal) };
    });
  }, []);

  const increaseTotalSeats  = useCallback(() => setSeatCounts((prev) => ({ ...prev, total: prev.total + 1 })), []);
  const decreaseAvailableSeats = useCallback(() => setSeatCounts((prev) => ({ ...prev, available: Math.max(0, prev.available - 1) })), []);
  const increaseAvailableSeats = useCallback(() => setSeatCounts((prev) => ({ ...prev, available: Math.min(prev.total, prev.available + 1) })), []);

  const handleLogout = useCallback(async () => {
    stopLocationSharing();
    socket.disconnect();

    try {
      await apiClient.post('/auth/logout');
    } catch (err) {
      console.warn('[DriverDashboard] logout request failed:', err);
    }

    try {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
    } catch {
      // ignore storage access errors
    }

    window.location.replace('/login');
  }, [stopLocationSharing]);

  const handleTripStarted = useCallback((newTrip) => {
    tripIdRef.current = newTrip.id;
    setTrip(newTrip);
    setDepartureTime(null);
    setDelayMinutes(0);
    setGpsState(GPS_STATE.IDLE);
    setGpsError('');
    setStatusError('');
    setLastCoords(null);
    setMaxSpeedKmh(0);
    lastFixRef.current = null;

    const fallbackTotal  = newTrip?.van?.capacity ?? 14;
    const totalSeats     = newTrip?.totalSeats     ?? fallbackTotal;
    const availableSeats = newTrip?.availableSeats ?? totalSeats;
    setSeatCounts({ total: totalSeats, available: availableSeats });

    seatHydratedForTripRef.current = newTrip.id;

    setFleetTrips((prev) => (prev.some((t) => t.id === newTrip.id) ? prev : [...prev, newTrip]));
  }, []);

  // ── Effects ──
  useEffect(() => {
    const controller = new AbortController();
    fetchMyTrip(controller.signal);
    fetchContactNumbers(controller.signal);
    return () => { controller.abort(); stopLocationSharing(); socket.disconnect(); };
  }, [fetchMyTrip, fetchContactNumbers, stopLocationSharing]);

  useEffect(() => {
    const controller = new AbortController();
    fetchFleetTrips(controller.signal);
    const id = setInterval(() => {
      const ctrl = new AbortController();
      fetchFleetTrips(ctrl.signal);
    }, FLEET_REFETCH_INTERVAL_MS);
    return () => { controller.abort(); clearInterval(id); };
  }, [fetchFleetTrips]);

  // ── Seat persistence (debounced PATCH on every change after hydration) ──
  useEffect(() => {
    const tripId = trip?.id;
    if (!tripId) {
      seatHydratedForTripRef.current = null;
      return;
    }
    if (seatHydratedForTripRef.current !== tripId) {
      seatHydratedForTripRef.current = tripId;
      return;
    }
    if (GPS_LOCKED_STATUSES.includes(trip?.status)) return;

    if (seatPersistTimerRef.current) clearTimeout(seatPersistTimerRef.current);
    seatPersistTimerRef.current = setTimeout(async () => {
      setSeatSaving(true);
      try {
        await apiClient.patch(`/trips/${tripId}/seats`, {
          availableSeats: seatCounts.available,
          totalSeats:     seatCounts.total,
        });
      } catch (err) {
        console.warn('[DriverDashboard] seat persist failed:', err?.message);
      } finally {
        setSeatSaving(false);
      }
    }, SEAT_PERSIST_DEBOUNCE_MS);

    return () => {
      if (seatPersistTimerRef.current) clearTimeout(seatPersistTimerRef.current);
    };
  }, [trip?.id, trip?.status, seatCounts.available, seatCounts.total]);

  // ── Socket wiring ──
  useEffect(() => {
    const emitRegistration = () => {
      socket.emit('subscribe_to_map');
      const uid = userIdRef.current ?? getStoredUserId();
      if (uid) {
        userIdRef.current = uid;
        socket.emit('register_driver', { userId: uid });
      }
    };

    socket.connect();
    emitRegistration();

    socket.on('connect', emitRegistration);

    const onInitialLocations = (payload = []) => {
      if (!Array.isArray(payload)) return;
      try {
        const seeded = payload.map(([tid, data]) => [
          tid,
          {
            lat: data?.lat,
            lng: data?.lng,
            speed: typeof data?.speed === 'number' ? data.speed : null,
            accuracy: typeof data?.accuracy === 'number' ? data.accuracy : null,
            lastSeen: data?.timestamp ? new Date(data.timestamp).getTime() : Date.now(),
          },
        ]);
        setFleetLiveData(Object.fromEntries(seeded));
      } catch {
        // ignore malformed payloads
      }
    };
    socket.on('initial_locations', onInitialLocations);

    const onVanMoved = (data) => {
      if (!data?.tripId || typeof data.lat !== 'number' || typeof data.lng !== 'number') return;
      setFleetLiveData((prev) => ({
        ...prev,
        [data.tripId]: {
          lat: data.lat,
          lng: data.lng,
          speed: typeof data.speed === 'number' ? data.speed : null,
          accuracy: typeof data.accuracy === 'number' ? data.accuracy : null,
          lastSeen: Date.now(),
        },
      }));
    };
    socket.on('van_moved', onVanMoved);

    const onFleetTripDispatched = ({ trip: newTrip } = {}) => {
      if (!newTrip?.id) return;
      setFleetTrips((prev) => (prev.some((t) => t.id === newTrip.id) ? prev : [...prev, newTrip]));
    };
    socket.on('trip_dispatched', onFleetTripDispatched);

    const onFleetTripStatusChanged = ({ tripId, trip: updated } = {}) => {
      if (!tripId) return;
      setFleetTrips((prev) => {
        if (updated?.status === 'COMPLETED' || updated?.status === 'CANCELLED') {
          return prev.filter((t) => t.id !== tripId);
        }
        const exists = prev.some((t) => t.id === tripId);
        if (exists) return prev.map((t) => (t.id === tripId ? { ...t, ...updated } : t));
        if (updated) return [...prev, updated];
        return prev;
      });
      if (updated?.status === 'COMPLETED' || updated?.status === 'CANCELLED') {
        setFleetLiveData((prev) => {
          const next = { ...prev };
          delete next[tripId];
          return next;
        });
      }
    };
    socket.on('trip_status_changed', onFleetTripStatusChanged);

    const onStartTracking = ({ tripId } = {}) => {
      if (!tripId) return;
      setPendingAutoStart(tripId);
    };
    socket.on('start_tracking', onStartTracking);

    const onStopTracking = ({ tripId } = {}) => {
      if (tripId && tripIdRef.current && tripId !== tripIdRef.current) return;
      setPendingAutoStart(null);
      stopLocationSharing();
    };
    socket.on('stop_tracking', onStopTracking);

    return () => {
      socket.off('connect', emitRegistration);
      socket.off('initial_locations', onInitialLocations);
      socket.off('van_moved', onVanMoved);
      socket.off('trip_dispatched', onFleetTripDispatched);
      socket.off('trip_status_changed', onFleetTripStatusChanged);
      socket.off('start_tracking', onStartTracking);
      socket.off('stop_tracking', onStopTracking);
    };
  }, [stopLocationSharing]);

  useEffect(() => {
    if (!pendingAutoStart) return;
    if (trip?.id !== pendingAutoStart) return;
    if (gpsState === GPS_STATE.LIVE || gpsState === GPS_STATE.ACQUIRING) {
      setPendingAutoStart(null);
      return;
    }
    setPendingAutoStart(null);
    startLocationSharing();
  }, [pendingAutoStart, trip?.id, gpsState, startLocationSharing]);

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
        setGpsError('Disconnected by server. Tap "Start sharing now" to reconnect.');
        setGpsState(GPS_STATE.ERROR);
        clearWatch();
      } else {
        socket.connect();
      }
    };
    socket.on('disconnect', handleDisconnect);
    return () => socket.off('disconnect', handleDisconnect);
  }, [gpsState, clearWatch]);

  // Status changes pushed from the server for MY trip: the dispatcher's
  // terminal check-in scan (ARRIVING → BOARDING/QUEUED, direction flips to
  // RETURN), the dispatcher's exit scan (DEPARTING → DEPARTED on the RETURN
  // leg), queue promotion (QUEUED → BOARDING), etc.
  useEffect(() => {
    const handleRemoteStatusChange = (payload) => {
      if (!payload?.tripId || payload.tripId !== tripIdRef.current) return;
      if (!payload.trip) return;
      applyTripUpdate(payload.trip);
    };
    socket.on('trip_status_changed', handleRemoteStatusChange);
    return () => socket.off('trip_status_changed', handleRemoteStatusChange);
  }, [applyTripUpdate]);

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

  const autoArmed =
    trip?.status === 'BOARDING' &&
    gpsState !== GPS_STATE.LIVE &&
    gpsState !== GPS_STATE.ACQUIRING;

  const showSeatManager = trip && !GPS_LOCKED_STATUSES.includes(trip.status);

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

        {/* Contact numbers — collapsed by default, expandable */}
        <div className="border-b border-gray-100 pb-3">
          <button
            onClick={() => setShowContactEditor((s) => !s)}
            className="flex items-center justify-between w-full text-xs font-bold text-slate-600 hover:text-slate-800 py-1"
            aria-expanded={showContactEditor}
          >
            <span>📞 My contact numbers ({contactNumbers.length})</span>
            <span aria-hidden="true">{showContactEditor ? '▲' : '▼'}</span>
          </button>
          {showContactEditor && (
            <ContactNumbersPanel
              numbers={contactNumbers}
              newNumber={newContactNumber}
              onNewNumberChange={setNewContactNumber}
              onAdd={handleAddContact}
              onRemove={handleRemoveContact}
              saving={contactsSaving}
              error={contactsError}
              onClose={() => setShowContactEditor(false)}
            />
          )}
        </div>

        <FleetMap fleetTrips={fleetTrips} fleetLiveData={fleetLiveData} ownTripId={trip?.id} />

        {!trip ? (
          <TripSetupScreen onTripStarted={handleTripStarted} onRefresh={() => fetchMyTrip()} />
        ) : (
          <div className="flex-1 flex flex-col gap-5">

            <TripManifest trip={trip} eta={eta} delayMinutes={delayMinutes} />

            {showSeatManager && (
              <SeatManagerPanel
                seatCounts={seatCounts}
                saving={seatSaving}
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
              statusError={statusError}
              onAdvance={handleAdvanceStatus}
              onAddDelay={handleAddDelay}
              onRefresh={() => fetchMyTrip(undefined, { silent: true })}
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
                autoArmed={autoArmed}
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
