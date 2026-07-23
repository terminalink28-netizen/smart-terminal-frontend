import { useState } from 'react';
import { Scanner } from '@yudiel/react-qr-scanner';
import apiClient from '../api/axios';

export default function QRScannerModal({ isOpen, onClose, onSuccess }) {
  const [error, setError] = useState('');
  const [isScanning, setIsScanning] = useState(false);

  if (!isOpen) return null;

  const handleScan = async (scannedData) => {
    if (isScanning) return;
    setIsScanning(true);
    setError('');

    try {
      // The QR code is just the raw signed token string — e.g. "abc123.9f8e7d..."
      // No JSON parsing needed: it's not a JSON payload, and it never
      // contains tripId/action anymore. The backend derives both from
      // the van's current trip state, so the same printed sticker keeps
      // working correctly at every stage of every future trip.
      const qrToken = scannedData?.[0]?.rawValue?.trim();

      if (!qrToken) {
        throw new Error('Could not read a QR code from the camera.');
      }

      // Fixed: was posting to '/trips/scan', which doesn't exist —
      // the registered route is '/trips/qr-scan'.
      const response = await apiClient.post('/trips/qr-scan', { qrToken });

      onSuccess(response.data.message);
      onClose();
    } catch (err) {
      console.error(err);
      setError(err.response?.data?.error || err.message || 'Scan failed. Try again.');
      setTimeout(() => setIsScanning(false), 2000);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[9999] p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden relative">
        <div className="bg-blue-900 text-white p-4 flex justify-between items-center">
          <h2 className="font-bold">Scan Van QR Code</h2>
          <button onClick={onClose} className="text-white hover:text-gray-300 text-xl font-bold">
            &times;
          </button>
        </div>

        <div className="p-4 bg-black relative">
          <Scanner
            onScan={handleScan}
            onError={() => setError('Camera error. Please check permissions.')}
            components={{ tracker: true, audio: true }}
          />
          {isScanning && (
            <div className="absolute inset-0 bg-white/20 flex items-center justify-center backdrop-blur-sm">
              <span className="bg-blue-600 text-white px-4 py-2 rounded-full font-bold animate-pulse">
                Processing Scan...
              </span>
            </div>
          )}
        </div>

        {error && (
          <div className="bg-red-100 text-red-700 p-3 text-center text-sm font-semibold border-t border-red-200">
            {error}
          </div>
        )}

        <div className="p-4 text-center text-sm text-gray-500">
          Point the camera at the van's QR sticker — one scan advances it to its next stage automatically.
        </div>
      </div>
    </div>
  );
}