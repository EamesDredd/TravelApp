import type { Category, Day, PlanItem, Spot, Trip, TripSnapshot } from '../types';
import { uid } from './util';

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
