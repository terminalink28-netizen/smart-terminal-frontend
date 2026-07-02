import { useState, useEffect } from 'react';
import apiClient from '../api/axios';

export default function CreateTripModal({ isOpen, onClose, onSuccess }) {
  const [resources, setResources] = useState({ routes: [], vans: [], drivers: [] });
  const [formData, setFormData] = useState({ routeId: '', vanId: '', driverId: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen) {
      apiClient.get('/trips/resources')
        .then(res => setResources(res.data))
        .catch(err => setError('Failed to load resources.'));
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const response = await apiClient.post('/trips', formData);
      onSuccess(response.data.message);
      setFormData({ routeId: '', vanId: '', driverId: '' }); // Reset form
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to dispatch.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[9999] p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden">
        
        <div className="bg-blue-900 text-white p-4 flex justify-between items-center">
          <h2 className="font-bold">➕ Dispatch New Van</h2>
          <button onClick={onClose} className="text-white hover:text-gray-300 font-bold text-xl">&times;</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && <div className="p-2 bg-red-100 text-red-700 text-sm rounded">{error}</div>}

          <div>
            <label className="block text-sm font-bold text-gray-700 mb-1">Destination Route</label>
            <select required className="w-full border p-2 rounded" onChange={e => setFormData({...formData, routeId: e.target.value})}>
              <option value="">Select a Route...</option>
              {resources.routes.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm font-bold text-gray-700 mb-1">Assign Idle Van</label>
            <select required className="w-full border p-2 rounded" onChange={e => setFormData({...formData, vanId: e.target.value})}>
              <option value="">Select a Van...</option>
              {resources.vans.map(v => <option key={v.id} value={v.id}>{v.plateNumber} ({v.capacity} pax)</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm font-bold text-gray-700 mb-1">Assign Driver</label>
            <select required className="w-full border p-2 rounded" onChange={e => setFormData({...formData, driverId: e.target.value})}>
              <option value="">Select a Driver...</option>
              {resources.drivers.map(d => <option key={d.id} value={d.id}>{d.name} ({d.driverId})</option>)}
            </select>
          </div>

          <button type="submit" disabled={loading} className="w-full bg-blue-600 text-white font-bold py-3 rounded-lg hover:bg-blue-700 transition mt-4">
            {loading ? 'Dispatching...' : 'Launch Trip'}
          </button>
        </form>
      </div>
    </div>
  );
}