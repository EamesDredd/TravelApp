/*
 * The place being located while the user looks it up in the Amap app. iPhone often closes a web
 * app in the background, so coming back reloads it; this brings the dialog back.
 */
import type { AddSpotOpts } from '../ui';

const KEY = 'travel-planner-pending-locate';
/** Older than this, opening the app is not coming back from Amap. */
const MAX_AGE = 20 * 60_000;

export interface PendingLocate {
  tripId: string;
  opts: AddSpotOpts;
  at: number;
}

export function rememberLocate(tripId: string, opts: AddSpotOpts, now = Date.now()) {
  try {
    const { restored: _restored, ...rest } = opts;
    localStorage.setItem(KEY, JSON.stringify({ tripId, opts: rest, at: now }));
  } catch {
    /* the dialog just will not come back */
  }
}

export function pendingLocate(now = Date.now()): PendingLocate | null {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? 'null') as PendingLocate | null;
    if (p && typeof p.tripId === 'string' && p.opts && typeof p.at === 'number' && now - p.at <= MAX_AGE && now >= p.at) return p;
    if (p) forgetLocate();
  } catch {
    /* nothing usable */
  }
  return null;
}

export function forgetLocate() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
}
