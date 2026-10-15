import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ChatMessage, Day, LatLng, MapRegion, PlanItem, Settings, Spot, Trip, TripSnapshot } from './types';
import { hasCoords } from './lib/geo';
import { keepLocations, makeItem, makeSpot, nameKey, newDay, newTrip, removeSpotEverywhere, resizeDays } from './lib/tripOps';

export const DEFAULT_SETTINGS: Settings = {
  provider: 'relay',
  claudeKey: '',
  claudeModel: 'claude-opus-5-5',
  openaiKey: '',
  openaiModel: 'gpt-5.5',
  openaiBaseUrl: 'https://api.openai.com/v1',
  chatWebSearch: true,
  googleMapsKey: '',
  amapKey: '',
  amapSecurityCode: '',
};

/** Keep undo snapshots only on the most recent assistant turns so storage stays small. */
const UNDO_KEEP = 5;

export type View = 'plan' | 'spots';

interface State {
  trips: Trip[];
  currentTripId: string | null;
  settings: Settings;
  /** -1 = all days */
  selectedDay: number;
  view: View;
  chatOpen: boolean;

  setSettings(patch: Partial<Settings>): void;
  setView(v: View): void;
  setChatOpen(open: boolean): void;
  selectDay(i: number): void;

  createTrip(init: { name: string; destination: string; startDate?: string; dayCount: number }): string;
  importTrip(trip: Trip): string;
  selectTrip(id: string): void;
  deleteTrip(id: string): void;
  updateTrip(patch: Partial<Pick<Trip, 'name' | 'destination' | 'startDate' | 'mapRegion' | 'center'>>): void;
  setDayCount(n: number): void;
  /**
   * Replace the editable parts of the trip (used by the AI agent and undo). Coordinates found
   * since `s` was taken are kept; with `restore` (undo) so is a location the user picked by hand.
   */
  replaceSnapshot(s: TripSnapshot, opts?: { restore?: boolean }): void;

  addSpot(fields: Omit<Spot, 'id'>): string;
  updateSpot(id: string, patch: Partial<Omit<Spot, 'id'>>): void;
  /**
   * Saves an automatically found location into a trip (not necessarily the open one), only
   * if the place still has that name and no coordinates. Returns whether it was saved.
   */
  setSpotLocation(tripId: string, spotId: string, name: string, at: LatLng): boolean;
  setTripCenter(tripId: string, center: LatLng): void;
  removeSpot(id: string): void;

  addDay(at?: number): void;
  removeDay(i: number): void;
  updateDay(i: number, patch: Partial<Pick<Day, 'title'>>): void;
  addToDay(dayIdx: number, spotId: string, time?: string): void;
  updateItem(dayIdx: number, itemId: string, patch: Partial<Pick<PlanItem, 'time' | 'note'>>): void;
  removeItem(dayIdx: number, itemId: string): void;
  moveItem(dayIdx: number, itemId: string, delta: -1 | 1): void;
  moveItemToDay(fromDay: number, itemId: string, toDay: number): void;
  sortDayByTime(dayIdx: number): void;

  appendChat(msg: ChatMessage): void;
  updateChat(id: string, patch: Partial<ChatMessage>): void;
  clearChat(): void;
}

function touch(t: Trip): Trip {
  return { ...t, updatedAt: Date.now() };
}

export const useStore = create<State>()(
  persist(
    (set, get) => {
      /** Apply a change to the current trip. */
      const mutate = (fn: (t: Trip) => Trip) =>
        set((st) => ({
          trips: st.trips.map((t) => (t.id === st.currentTripId ? touch(fn(t)) : t)),
        }));

      const mutateDay = (i: number, fn: (d: Day) => Day) =>
        mutate((t) => ({ ...t, days: t.days.map((d, j) => (j === i ? fn(d) : d)) }));

      return {
        trips: [],
        currentTripId: null,
        settings: DEFAULT_SETTINGS,
        selectedDay: 0,
        view: 'plan',
        chatOpen: false,

        setSettings: (patch) => set((st) => ({ settings: { ...st.settings, ...patch } })),
        setView: (view) => set({ view }),
        setChatOpen: (chatOpen) => set({ chatOpen }),
        selectDay: (selectedDay) => set({ selectedDay }),

        createTrip: (init) => {
          const trip = newTrip(init);
          set((st) => ({ trips: [...st.trips, trip], currentTripId: trip.id, selectedDay: 0, view: 'plan' }));
          return trip.id;
        },
        importTrip: (trip) => {
          const exists = get().trips.some((t) => t.id === trip.id);
          const t: Trip = { ...trip, id: exists ? newTrip({ name: '', destination: '', dayCount: 1 }).id : trip.id };
          set((st) => ({ trips: [...st.trips, t], currentTripId: t.id, selectedDay: 0 }));
          return t.id;
        },
        selectTrip: (id) => set({ currentTripId: id, selectedDay: 0 }),
        deleteTrip: (id) =>
          set((st) => {
            const trips = st.trips.filter((t) => t.id !== id);
            return {
              trips,
              currentTripId: st.currentTripId === id ? (trips[0]?.id ?? null) : st.currentTripId,
              selectedDay: 0,
            };
          }),
        updateTrip: (patch) => mutate((t) => ({ ...t, ...patch })),
        setDayCount: (n) => {
          mutate((t) => ({ ...t, days: resizeDays(t.days, n) }));
          set((st) => ({ selectedDay: Math.min(st.selectedDay, n - 1) }));
        },
        replaceSnapshot: (s, opts) => {
          mutate((t) => ({ ...t, ...structuredClone(keepLocations(s, t, !!opts?.restore)) }));
          set((st) => {
            const trip = st.trips.find((t) => t.id === st.currentTripId);
            return trip && st.selectedDay >= trip.days.length ? { selectedDay: trip.days.length - 1 } : {};
          });
        },

        addSpot: (fields) => {
          let id = '';
          mutate((t) => {
            const spot = makeSpot(fields, t.spots);
            id = spot.id;
            return { ...t, spots: [...t.spots, spot] };
          });
          return id;
        },
        updateSpot: (id, patch) =>
          mutate((t) => ({ ...t, spots: t.spots.map((s) => (s.id === id ? { ...s, ...patch } : s)) })),
        setSpotLocation: (tripId, spotId, name, at) => {
          const trip = get().trips.find((t) => t.id === tripId);
          const spot = trip?.spots.find((s) => s.id === spotId);
          if (!trip || !spot || hasCoords(spot) || nameKey(spot.name) !== nameKey(name)) return false;
          set((st) => ({
            trips: st.trips.map((t) =>
              t.id === tripId
                ? touch({
                    ...t,
                    spots: t.spots.map((s) => (s.id === spotId ? { ...s, lat: at.lat, lng: at.lng, geo: 'auto' as const } : s)),
                  })
                : t,
            ),
          }));
          return true;
        },
        setTripCenter: (tripId, center) =>
          set((st) => ({ trips: st.trips.map((t) => (t.id === tripId ? { ...t, center } : t)) })),
        removeSpot: (id) => mutate((t) => removeSpotEverywhere(t, id)),

        addDay: (at) =>
          mutate((t) => {
            const days = [...t.days];
            days.splice(at ?? days.length, 0, newDay());
            return { ...t, days };
          }),
        removeDay: (i) => {
          mutate((t) => (t.days.length <= 1 ? t : { ...t, days: t.days.filter((_, j) => j !== i) }));
          set((st) => ({ selectedDay: Math.max(0, Math.min(st.selectedDay, i - 1)) }));
        },
        updateDay: (i, patch) => mutateDay(i, (d) => ({ ...d, ...patch })),
        addToDay: (dayIdx, spotId, time) =>
          mutateDay(dayIdx, (d) => {
            const item = makeItem(spotId, time);
            if (!time) return { ...d, items: [...d.items, item] };
            // Insert in time order when a time is given.
            const at = d.items.findIndex((it) => it.time && it.time > time);
            const items = [...d.items];
            items.splice(at === -1 ? items.length : at, 0, item);
            return { ...d, items };
          }),
        updateItem: (dayIdx, itemId, patch) =>
          mutateDay(dayIdx, (d) => ({
            ...d,
            items: d.items.map((it) => (it.id === itemId ? { ...it, ...patch } : it)),
          })),
        removeItem: (dayIdx, itemId) =>
          mutateDay(dayIdx, (d) => ({ ...d, items: d.items.filter((it) => it.id !== itemId) })),
        moveItem: (dayIdx, itemId, delta) =>
          mutateDay(dayIdx, (d) => {
            const i = d.items.findIndex((it) => it.id === itemId);
            const j = i + delta;
            if (i < 0 || j < 0 || j >= d.items.length) return d;
            const items = [...d.items];
            [items[i], items[j]] = [items[j], items[i]];
            return { ...d, items };
          }),
        moveItemToDay: (fromDay, itemId, toDay) =>
          mutate((t) => {
            const item = t.days[fromDay]?.items.find((it) => it.id === itemId);
            if (!item || !t.days[toDay] || fromDay === toDay) return t;
            return {
              ...t,
              days: t.days.map((d, j) =>
                j === fromDay
                  ? { ...d, items: d.items.filter((it) => it.id !== itemId) }
                  : j === toDay
                    ? { ...d, items: [...d.items, item] }
                    : d,
              ),
            };
          }),
        sortDayByTime: (dayIdx) =>
          mutateDay(dayIdx, (d) => ({
            ...d,
            items: [...d.items].sort((a, b) => (a.time ?? '99:99').localeCompare(b.time ?? '99:99')),
          })),

        appendChat: (msg) =>
          mutate((t) => {
            const chat = [...t.chat, msg];
            // Drop undo / relay-start snapshots from older turns.
            let undos = 0;
            let starts = 0;
            for (let i = chat.length - 1; i >= 0; i--) {
              if (chat[i].undo && ++undos > UNDO_KEEP) chat[i] = { ...chat[i], undo: undefined };
              if (chat[i].relayStart && ++starts > UNDO_KEEP) chat[i] = { ...chat[i], relayStart: undefined };
            }
            return { ...t, chat };
          }),
        updateChat: (id, patch) =>
          mutate((t) => ({ ...t, chat: t.chat.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),
        clearChat: () => mutate((t) => ({ ...t, chat: [] })),
      };
    },
    {
      name: 'travel-planner-v1',
      version: 1,
      partialize: (st) => ({
        trips: st.trips,
        currentTripId: st.currentTripId,
        settings: st.settings,
        selectedDay: st.selectedDay,
        view: st.view,
        chatOpen: st.chatOpen,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<State>;
        return { ...current, ...p, settings: { ...DEFAULT_SETTINGS, ...(p.settings ?? {}) } };
      },
    },
  ),
);

export function useCurrentTrip(): Trip | null {
  return useStore((st) => st.trips.find((t) => t.id === st.currentTripId) ?? null);
}

export function getCurrentTrip(): Trip | null {
  const st = useStore.getState();
  return st.trips.find((t) => t.id === st.currentTripId) ?? null;
}

export function setMapRegion(r: MapRegion) {
  useStore.getState().updateTrip({ mapRegion: r });
}
