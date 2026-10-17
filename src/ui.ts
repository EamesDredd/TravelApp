import { create } from 'zustand';
import type { IncomingTrip } from './lib/share';
import type { Category } from './types';

export interface AddSpotOpts {
  day?: number;
  category?: Category;
  locateId?: string;
  /** Name typed so far (when the dialog comes back after looking the place up in the Amap app). */
  name?: string;
  /** Reopened after coming back from the Amap app. */
  restored?: boolean;
}

interface UIState {
  spotId: string | null;
  routeDay: number | null;
  settingsOpen: boolean;
  tripsOpen: boolean;
  /** Open the add-place dialog; `day` also schedules the new place on that day,
   * `locateId` sets the position of an existing place instead. */
  addSpot: AddSpotOpts | null;
  /** Pick candidates to add to this day. */
  pickSpotsForDay: number | null;
  /** Choose a day for this spot. */
  pickDayFor: string | null;
  /** Export the itinerary as PDF; `day` preselects one day. */
  pdfExport: { day?: number } | null;
  /** A shared or exported trip waiting for the user to choose: update the same trip here, or add it. */
  importing: IncomingTrip | null;
  toast: string | null;
  openSpot(id: string | null): void;
  openRoute(day: number | null): void;
  openSettings(open: boolean): void;
  openTrips(open: boolean): void;
  openAddSpot(v: UIState['addSpot']): void;
  openPickDay(spotId: string | null): void;
  openPickSpots(day: number | null): void;
  openPdfExport(v: UIState['pdfExport']): void;
  openImport(v: IncomingTrip | null): void;
  showToast(msg: string): void;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export const useUI = create<UIState>()((set) => ({
  spotId: null,
  routeDay: null,
  settingsOpen: false,
  tripsOpen: false,
  addSpot: null,
  pickDayFor: null,
  pickSpotsForDay: null,
  pdfExport: null,
  importing: null,
  toast: null,
  openSpot: (spotId) => set({ spotId }),
  openRoute: (routeDay) => set({ routeDay }),
  openSettings: (settingsOpen) => set({ settingsOpen }),
  openTrips: (tripsOpen) => set({ tripsOpen }),
  openAddSpot: (addSpot) => set({ addSpot }),
  openPickDay: (pickDayFor) => set({ pickDayFor }),
  openPickSpots: (pickSpotsForDay) => set({ pickSpotsForDay }),
  openPdfExport: (pdfExport) => set({ pdfExport }),
  openImport: (importing) => set({ importing }),
  showToast: (toast) => {
    clearTimeout(toastTimer);
    set({ toast });
    toastTimer = setTimeout(() => set({ toast: null }), 2600);
  },
}));
