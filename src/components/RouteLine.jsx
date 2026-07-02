import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet-routing-machine';

export default function RouteLine({ startCoords, endCoords, color = '#0ea5e9' }) {
  const map = useMap();

  useEffect(() => {
    if (!map || !startCoords || !endCoords) return;

    // Initialize the Leaflet Routing Machine
    const routingControl = L.Routing.control({
      waypoints: [
        L.latLng(startCoords[0], startCoords[1]),
        L.latLng(endCoords[0], endCoords[1])
      ],
      routeWhileDragging: false,
      addWaypoints: false,
      fitSelectedRoutes: false,
      showAlternatives: false,
      // Style the line to look like your reference image (thick, colored, slightly transparent)
      lineOptions: {
        styles: [{ color: color, weight: 6, opacity: 0.7 }]
      },
      // We return null here because we ALREADY have our own custom Van and Terminal markers!
      createMarker: () => null 
    }).addTo(map);

    // CRITICAL HACK: The plugin automatically adds a big ugly white box with text instructions 
    // ("Turn left in 100ft"). We don't want that, we just want the painted line.
    const routingContainer = routingControl.getContainer();
    if (routingContainer) {
      routingContainer.style.display = 'none';
    }

    // Cleanup when the route is removed
    return () => map.removeControl(routingControl);
  }, [map, startCoords, endCoords, color]);

  return null;
}