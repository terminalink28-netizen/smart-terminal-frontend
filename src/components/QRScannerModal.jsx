import { useState } from 'react';
import { Scanner } from '@yudiel/react-qr-scanner';
import apiClient from '../api/axios';

export default function QRScannerModal({ isOpen, onClose, onSuccess }) {
  const [error, setError] = useState('');
  const [isScanning, setIsScanning] = useState(false);

  if (!isOpen) return null;

  const handleScan = async (scannedData) => {
    // Prevent multiple API calls if the camera reads it 5 times in a second
    if (isScanning) return; 
    setIsScanning(true);
    setError('');

    try {
      // The QR code will literally just be a JSON string from our system
      const payload = JSON.parse(scannedData[0].rawValue);
      
      if (!payload.tripId || !payload.vanId || !payload.action) {
        throw new Error("Invalid QR Code format.");
      }

      // Hit our secure state machine endpoint
      const response = await apiClient.post('/trips/scan', payload);
      
      // Close the modal and tell the dashboard to refresh!
      onSuccess(response.data.message);
      onClose();
    } catch (err) {
      console.error(err);
      setError(err.response?.data?.error || err.message || 'Scan failed. Try again.');
      
      // Allow them to try scanning again after an error
      setTimeout(() => setIsScanning(false), 2000); 
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[9999] p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden relative">
        
        {/* Header */}
        <div className="bg-blue-900 text-white p-4 flex justify-between items-center">
          <h2 className="font-bold">Scan Van QR Code</h2>
          <button onClick={onClose} className="text-white hover:text-gray-300 text-xl font-bold">
            &times;
          </button>
        </div>

        {/* Camera Area */}
        <div className="p-4 bg-black relative">
          <Scanner 
            onScan={handleScan} 
            onError={(err) => setError('Camera error. Please check permissions.')} 
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

        {/* Error Messages */}
        {error && (
          <div className="bg-red-100 text-red-700 p-3 text-center text-sm font-semibold border-t border-red-200">
            {error}
          </div>
        )}
        
        <div className="p-4 text-center text-sm text-gray-500">
          Point the camera at the driver's arrival or departure QR code.
        </div>
      </div>
    </div>
  );
}