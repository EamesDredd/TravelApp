import type { Category, Day, PlanItem, Spot, Trip, TripSnapshot } from '../types';
import { hasCoords } from './geo';
import { formatDayDate, uid } from './util';

export const CATEGORIES: Category[] = ['sight', 'breakfast', 'meal'];

export function isCategory(v: unknown): v is Category {
  return typeof v === 'string' && (CATEGORIES as string[]).includes(v);
}

export function newDay(): Day {
  return { id: uid('d'), items: [] };
}

export function newTrip(init: { name: string; destination: string; startDate?: string; dayCount: number }): Trip {
  const now = Date.now();
  return {
    id: uid('t', 8),
    name: init.name.trim() || init.destination.trim() || '我的旅程',
    destination: init.destination.trim(),
    startDate: init.startDate || undefined,
    days: Array.from({ length: Math.max(1, init.dayCount) }, newDay),
    spots: [],
    mapRegion: 'auto',
    chat: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** "上海 · 10/20（一） 出發 · 5 天 · 32 個地點" */
export function tripSummary(t: Trip): string {
  return [t.destination, t.startDate && `${formatDayDate(t.startDate, 0)} 出發`, `${t.days.length} 天`, `${t.spots.length} 個地點`]
    .filter(Boolean)
    .join(' · ');
}

export function snapshotOf(t: TripSnapshot): TripSnapshot {
  return structuredClone({
    name: t.name,
    destination: t.destination,
    startDate: t.startDate,
    days: t.days,
    spots: t.spots,
  });
}

/** Days (0-based) on which a spot is scheduled. */
export function scheduledDays(trip: TripSnapshot, spotId: string): number[] {
  const out: number[] = [];
  trip.days.forEach((d, i) => {
    if (d.items.some((it) => it.spotId === spotId)) out.push(i);
  });
  return out;
}

export function makeSpot(fields: Omit<Spot, 'id'>, existing: Spot[]): Spot {
  const taken = new Set(existing.map((s) => s.id));
  let id = uid('s', 4);
  while (taken.has(id)) id = uid('s', 4);
  return { ...fields, id };
}

export function makeItem(spotId: string, time?: string, note?: string): PlanItem {
  return { id: uid('i'), spotId, ...(time ? { time } : {}), ...(note ? { note } : {}) };
}

/** Sort a day's items by time; untimed items keep their relative position after timed ones before them. */
export function sortItemsByTime(items: PlanItem[]): PlanItem[] {
  const timed = items.filter((i) => i.time);
  if (timed.length !== items.length) return items;
  return [...items].sort((a, b) => a.time!.localeCompare(b.time!));
}

export function resizeDays(days: Day[], count: number): Day[] {
  const n = Math.max(1, Math.min(60, Math.floor(count)));
  if (n === days.length) return days;
  if (n < days.length) return days.slice(0, n);
  return [...days, ...Array.from({ length: n - days.length }, newDay)];
}

export function removeSpotEverywhere<T extends TripSnapshot>(trip: T, spotId: string): T {
  return {
    ...trip,
    spots: trip.spots.filter((s) => s.id !== spotId),
    days: trip.days.map((d) => ({ ...d, items: d.items.filter((it) => it.spotId !== spotId) })),
  };
}

/** Same place name, ignoring spaces and case. */
export const nameKey = (n: string) => n.replace(/\s+/g, '').toLowerCase();

/**
 * Locations the app found or the user picked (`geo`) are facts about places, not plan
 * decisions. When `target` (a snapshot being restored or applied) has no coordinates for a
 * place the current trip has located that way, keep them; coordinates the AI gave are part of
 * its change and are not kept. With `keepManual` (restoring or re-applying an older version), a
 * location the user picked by hand, and the address picked with it, also wins over older ones.
 * Matches by id (same name), or by name for places `target` re-created under a new id.
 */
export function keepLocations<T extends TripSnapshot>(target: T, current: TripSnapshot, keepManual = false): T {
  const byId = new Map(current.spots.map((s) => [s.id, s]));
  const targetIds = new Set(target.spots.map((s) => s.id));
  const byName = new Map(
    current.spots.filter((s) => hasCoords(s) && !targetIds.has(s.id)).map((s) => [nameKey(s.name), s]),
  );
  let changed = false;
  const spots = target.spots.map((s) => {
    const same = byId.get(s.id);
    const cur = same ? (nameKey(same.name) === nameKey(s.name) ? same : undefined) : byName.get(nameKey(s.name));
    if (!cur || !hasCoords(cur) || !cur.geo) return s;
    const manual = keepManual && cur.geo === 'manual';
    if (hasCoords(s) && !manual) return s;
    const address = manual && cur.address ? cur.address : s.address;
    if (s.lat === cur.lat && s.lng === cur.lng && s.geo === cur.geo && s.address === address) return s;
    changed = true;
    return { ...s, lat: cur.lat, lng: cur.lng, geo: cur.geo, ...(address !== undefined ? { address } : {}) };
  });
  return changed ? { ...target, spots } : target;
}

/**
 * A patch that renames a place the app located automatically, without giving coordinates,
 * also drops those coordinates: they were found for the old name. The place is then located
 * again under its new name.
 */
export function withRelocation(spot: Spot, patch: Partial<Spot>, sameName: (a: string, b: string) => boolean): Partial<Spot> {
  if (spot.geo !== 'auto' || patch.name === undefined || sameName(patch.name, spot.name) || 'lat' in patch) return patch;
  return { ...patch, lat: undefined, lng: undefined, geo: undefined };
}
