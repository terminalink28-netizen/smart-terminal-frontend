// Exact coordinates for the Hub and Spokes in Catanduanes
export const VIRAC_HUB = [13.5820477, 124.2192987];

export const TOWN_COORDINATES = {
  'San Andres': [13.5947, 124.0936],
  'Bato': [13.5992, 124.2981],
  'Baras': [13.6393, 124.3697],
  'San Miguel': [13.6369, 124.3015],
  'Viga': [13.8691, 124.2831],
  'Panganiban': [13.8997, 124.2981],
  'Bagamanoc': [13.9298, 124.2798],
  'Pandan': [14.0458, 124.1694],
  'Caramoran': [13.8569, 124.1283],
  'Gigmoto': [13.7844, 124.3942]
};

// Helper function to extract the town name from your route destination string
export const getCoordinatesForDestination = (destinationString) => {
  for (const town in TOWN_COORDINATES) {
    if (destinationString.includes(town)) {
      return TOWN_COORDINATES[town];
    }
  }
  return VIRAC_HUB; // Fallback
};