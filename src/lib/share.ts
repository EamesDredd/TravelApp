import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string';
import type { Trip } from '../types';
import { tripFingerprint } from './ai/relay';
import { keepLocations, nameKey, newTrip } from './tripOps';

const PREFIX = '#trip=';
/** Trip ids come from uid(); anything else in the data is not trusted as one. */
const TRIP_ID = /^[\w-]{1,40}$/;

type SyncStamp = NonNullable<Trip['synced']>;

/**
 * The trip's plan fingerprint and when that plan last changed. While the plan is the one last
 * synced, that version's time is kept: chatting and found locations also bump `updatedAt`.
 */
export function syncStamp(trip: Trip): SyncStamp {
  const fp = tripFingerprint(trip);
  return { fp, at: trip.synced?.fp === fp && trip.synced.at ? trip.synced.at : trip.updatedAt };
}

/** Everything needed to rebuild the trip elsewhere; chat and cached searches stay local. */
function portable(trip: Trip) {
  return {
    v: 1,
    // The same trip on another device keeps this id, so importing it again updates that copy.
    id: trip.id,
    updatedAt: syncStamp(trip).at,
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

export interface IncomingTrip {
  /** Ready to add; its id is the one on the other device, or a fresh one for older links and files. */
  trip: Trip;
  /** The id came with the data, so a trip here with that id is the same trip. */
  linked: boolean;
  /** When the plan last changed on the other device, if the data says. */
  changedAt?: number;
}

const BROKEN_LINK = '連結內容不完整，請重新複製整個連結';

/** Parses a share link (or text containing one) or an exported JSON file. */
export function parseTrip(text: string): IncomingTrip {
  const src = text.trim();
  const isJson = src.startsWith('{');
  let raw: string | null = src;
  if (!isJson) {
    const at = src.indexOf(PREFIX);
    if (at < 0) throw new Error('這不是行程的分享連結或檔案');
    // Messaging apps may put text after the link, or percent-encode it.
    let code = src.slice(at + PREFIX.length).split(/\s/)[0];
    try {
      if (code.includes('%')) code = decodeURIComponent(code);
      raw = decompressFromEncodedURIComponent(code);
    } catch {
      raw = null;
    }
    if (!raw) throw new Error(BROKEN_LINK);
  }
  let d;
  try {
    d = JSON.parse(raw);
  } catch {
    throw new Error(isJson ? '檔案內容不是有效的行程資料' : BROKEN_LINK);
  }
  if (!d || !Array.isArray(d.days) || !Array.isArray(d.spots)) throw new Error('不是有效的行程資料');
  const t = newTrip({ name: String(d.name ?? '匯入的行程'), destination: String(d.destination ?? ''), dayCount: 1 });
  const linked = typeof d.id === 'string' && TRIP_ID.test(d.id);
  const changedAt = typeof d.updatedAt === 'number' && Number.isFinite(d.updatedAt) && d.updatedAt > 0 ? d.updatedAt : undefined;
  return {
    trip: {
      ...t,
      id: linked ? d.id : t.id,
      startDate: typeof d.startDate === 'string' ? d.startDate : undefined,
      mapRegion: d.mapRegion === 'cn' || d.mapRegion === 'intl' ? d.mapRegion : 'auto',
      center: d.center,
      days: d.days.length ? d.days : t.days,
      spots: d.spots,
    },
    linked,
    changedAt,
  };
}

/** Text that holds a share link or an exported trip (not checked any further). */
export function looksLikeTrip(text: string): boolean {
  return text.includes(PREFIX) || text.trim().startsWith('{');
}

export function sharedTripInHash(): string | null {
  return location.hash.startsWith(PREFIX) ? location.hash : null;
}

export interface ImportTarget {
  trip: Trip;
  /**
   * Matched by name only: a copy made before trips carried their id (it has no `synced`), or a
   * different trip that happens to have the same name.
   */
  byName: boolean;
}

/** The trip on this device that an import would update: the same trip, else the latest one with its name. */
export function importTarget(trips: Trip[], incoming: IncomingTrip): ImportTarget | null {
  const same = incoming.linked ? trips.find((t) => t.id === incoming.trip.id) : undefined;
  if (same) return { trip: same, byName: false };
  const key = nameKey(incoming.trip.name);
  const named = trips.filter((t) => nameKey(t.name) === key).sort((a, b) => b.updatedAt - a.updatedAt);
  return named.length ? { trip: named[0], byName: true } : null;
}

/** Whether updating is the likely intent: the same trip, or a copy from before trips carried their id. */
export function updateByDefault(target: ImportTarget): boolean {
  return !target.byName || !target.trip.synced;
}

export interface ImportCheck {
  /** The plans are the same. */
  same: boolean;
  /** This copy was edited after it was last shared or imported; undefined when not known. */
  editedHere?: boolean;
  /** When the incoming version is older than the one this copy last synced with: that one's time. */
  olderThan?: number;
}

export function checkImport(local: Trip, incoming: IncomingTrip): ImportCheck {
  const fp = tripFingerprint(local);
  const syncedAt = local.synced?.at;
  return {
    same: fp === tripFingerprint(incoming.trip),
    editedHere: local.synced ? fp !== local.synced.fp : undefined,
    olderThan: syncedAt && incoming.changedAt && incoming.changedAt < syncedAt ? syncedAt : undefined,
  };
}

/** A new trip from the import (the store gives it a fresh id if this one is taken). */
export function importedAsNew(incoming: IncomingTrip, now = Date.now()): Trip {
  const t: Trip = { ...incoming.trip, createdAt: now, updatedAt: now };
  return { ...t, synced: { fp: tripFingerprint(t), at: incoming.changedAt ?? 0 } };
}

/**
 * The local trip with the imported plan. The AI chat stays, and so do web-search results and
 * locations found here for places the import has no coordinates for. A trip matched by name takes
 * the incoming id, so the next import of that trip finds it directly.
 */
export function mergeImported(local: Trip, incoming: IncomingTrip, now = Date.now()): Trip {
  const before = new Map(local.spots.map((s) => [s.id, s]));
  const spots = incoming.trip.spots.map((s) => {
    const cur = before.get(s.id);
    return !s.search && cur?.search && nameKey(cur.name) === nameKey(s.name) ? { ...s, search: cur.search } : s;
  });
  const plan = keepLocations({ ...incoming.trip, spots }, local);
  const merged: Trip = {
    ...local,
    id: incoming.linked ? plan.id : local.id,
    name: plan.name,
    destination: plan.destination,
    startDate: plan.startDate,
    days: plan.days,
    spots: plan.spots,
    mapRegion: plan.mapRegion,
    center: plan.center ?? (nameKey(plan.destination) === nameKey(local.destination) ? local.center : undefined),
    updatedAt: now,
  };
  return { ...merged, synced: { fp: tripFingerprint(merged), at: incoming.changedAt ?? 0 } };
}
