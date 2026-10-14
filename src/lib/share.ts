import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string';
import type { Trip } from '../types';
import { newTrip } from './tripOps';

const PREFIX = '#trip=';

/** Everything needed to rebuild the trip elsewhere; chat and cached searches stay local. */
function portable(trip: Trip) {
  return {
    v: 1,
    name: trip.name,
    destination: trip.destination,
    startDate: trip.startDate,
    mapRegion: trip.mapRegion,
    center: trip.center,
    days: trip.days,
    spots: trip.spots.map(({ search: _search, ...s }) => s),
  };
}

export function shareUrl(trip: Trip): string {
  const base = `${location.origin}${location.pathname}`;
  return `${base}${PREFIX}${compressToEncodedURIComponent(JSON.stringify(portable(trip)))}`;
}

export function exportJson(trip: Trip): string {
  return JSON.stringify({ ...portable(trip), spots: trip.spots }, null, 2);
}

/** Parses a shared link hash or an exported JSON file into a fresh Trip. */
export function parseTrip(text: string): Trip {
  const raw = text.startsWith(PREFIX) ? decompressFromEncodedURIComponent(text.slice(PREFIX.length)) : text;
  if (!raw) throw new Error('連結內容不完整');
  const d = JSON.parse(raw);
  if (!d || !Array.isArray(d.days) || !Array.isArray(d.spots)) throw new Error('不是有效的行程資料');
  const t = newTrip({ name: String(d.name ?? '匯入的行程'), destination: String(d.destination ?? ''), dayCount: 1 });
  return {
    ...t,
    startDate: typeof d.startDate === 'string' ? d.startDate : undefined,
    mapRegion: d.mapRegion === 'cn' || d.mapRegion === 'intl' ? d.mapRegion : 'auto',
    center: d.center,
    days: d.days.length ? d.days : t.days,
    spots: d.spots,
  };
}

export function sharedTripInHash(): string | null {
  return location.hash.startsWith(PREFIX) ? location.hash : null;
}
