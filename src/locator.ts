/* The app's background locator: finds coordinates for places that have none. */
import { createLocator, findPlace, localMissMemory } from './lib/autoLocate';
import { findDestinationCenter } from './lib/geocode';
import { useStore } from './store';

export const locator = createLocator({
  getTrip: (id) => useStore.getState().trips.find((t) => t.id === id),
  getSettings: () => useStore.getState().settings,
  find: (spot, ctx) => findPlace(spot, ctx),
  save: (tripId, spotId, name, at) => useStore.getState().setSpotLocation(tripId, spotId, name, at),
  findCenter: findDestinationCenter,
  setCenter: (tripId, center) => useStore.getState().setTripCenter(tripId, center),
  misses: localMissMemory(),
  online: () => navigator.onLine !== false,
});
