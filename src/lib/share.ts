import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string';
import type { Day, LatLng, PlanItem, Spot, SpotSearchResult, Trip, TripSnapshot } from '../types';
import { hasCoords } from './geo';
import { isCategory, nameKey, newTrip } from './tripOps';
import { uid } from './util';

const PREFIX = '#trip=';
/** Trip ids come from uid(); anything else in the data is not trusted as one. */
const TRIP_ID = /^[\w-]{1,40}$/;
/** How many plan versions a copy remembers (and sends along) to tell which of two copies is newer. */
const SEEN_MAX = 20;

// ---------------------------------------------------------------- plan versions

type Synced = NonNullable<Trip['synced']>;

function fnv(data: string, basis: number): string {
  let h = basis;
  for (let i = 0; i < data.length; i++) {
    h ^= data.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, '0');
}

/** The same data gives the same text on every device: keys sorted, unset fields left out. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => [k, canonical(o[k])]),
  );
}

/**
 * Version of the plan, the same on every device that has it. Web searches and coordinates are
 * facts about places, merged on their own when importing (see mergeImported), so they are not
 * part of it: each copy may have located places differently.
 */
export function planFingerprint(t: TripSnapshot): string {
  const spots = t.spots.map(({ search: _search, lat: _lat, lng: _lng, geo: _geo, ...plan }) => plan);
  const data = JSON.stringify(canonical({ n: t.name, d: t.destination, s: t.startDate ?? null, days: t.days, spots }));
  return fnv(data, 0x811c9dc5) + fnv(data, 0x5bd1e995);
}

const uniq = (list: string[]) => [...new Set(list)].slice(0, SEEN_MAX);

/** After sharing the trip's current plan: that version joins the ones this copy is built on. */
export function sharedStamp(trip: Trip): Synced {
  const fp = planFingerprint(trip);
  const seen = trip.synced?.seen ?? [];
  // Unchanged since the last share or import: keep that version's time (chatting and found
  // locations also bump updatedAt).
  if (seen[0] === fp && trip.synced) return trip.synced;
  return { seen: uniq([fp, ...seen]), at: trip.updatedAt };
}

// ---------------------------------------------------------------- links and files

/** Everything needed to rebuild the trip elsewhere; chat and cached searches stay local. */
function portable(trip: Trip) {
  return {
    v: 1,
    // The same trip on another device keeps this id, so importing it again updates that copy.
    id: trip.id,
    updatedAt: sharedStamp(trip).at,
    // Earlier versions this plan was built on: tells the other device whether its copy is older.
    seen: trip.synced?.seen ?? [],
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
  /** Plan versions it was built on (links from before this was sent have none). */
  seen?: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Drops unset fields, so cleaned data looks like what the app stores. */
function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function cleanSearch(v: unknown): SpotSearchResult | undefined {
  if (!isObj(v) || typeof v.summary !== 'string') return undefined;
  const sources = (Array.isArray(v.sources) ? v.sources : [])
    .filter(isObj)
    .filter((s) => typeof s.title === 'string' && typeof s.url === 'string' && /^https?:\/\//i.test(s.url))
    .map((s) => ({ title: s.title as string, url: s.url as string }));
  return { summary: v.summary, sources, provider: str(v.provider) ?? '', at: num(v.at) ?? 0 };
}

function cleanSpot(v: unknown): Spot | null {
  if (!isObj(v) || typeof v.id !== 'string' || !v.id || typeof v.name !== 'string') return null;
  const lat = num(v.lat);
  const lng = num(v.lng);
  const at = lat !== undefined && lng !== undefined && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  return compact<Spot>({
    id: v.id,
    name: v.name,
    category: isCategory(v.category) ? v.category : 'sight',
    address: str(v.address),
    lat: at ? lat : undefined,
    lng: at ? lng : undefined,
    geo: at && (v.geo === 'auto' || v.geo === 'manual') ? v.geo : undefined,
    note: str(v.note),
    durationMin: num(v.durationMin),
    search: cleanSearch(v.search),
  });
}

function cleanDay(v: Record<string, unknown>, spotIds: Set<string>): Day {
  const items = (Array.isArray(v.items) ? v.items : [])
    .filter(isObj)
    .filter((it) => typeof it.id === 'string' && !!it.id && typeof it.spotId === 'string' && spotIds.has(it.spotId))
    .map((it) =>
      compact<PlanItem>({ id: it.id as string, spotId: it.spotId as string, time: str(it.time), note: str(it.note) }),
    );
  return compact<Day>({ id: typeof v.id === 'string' && v.id ? v.id : uid('d'), title: str(v.title), items });
}

const BROKEN_LINK = '連結內容不完整，請重新複製整個連結';

/**
 * Parses a share link (or text containing one) or an exported JSON file. Links and files can be
 * edited by hand, so only what the app can show is kept.
 */
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
  let d: unknown;
  try {
    d = JSON.parse(raw);
  } catch {
    throw new Error(isJson ? '檔案內容不是有效的行程資料' : BROKEN_LINK);
  }
  if (!isObj(d) || !Array.isArray(d.days) || !Array.isArray(d.spots)) throw new Error('不是有效的行程資料');

  const spots: Spot[] = [];
  for (const s of d.spots.map(cleanSpot)) if (s && !spots.some((x) => x.id === s.id)) spots.push(s);
  const spotIds = new Set(spots.map((s) => s.id));
  const days = d.days.filter(isObj).map((day) => cleanDay(day, spotIds));
  const c = isObj(d.center) ? { lat: num(d.center.lat), lng: num(d.center.lng) } : {};
  const center: LatLng | undefined = c.lat !== undefined && c.lng !== undefined ? { lat: c.lat, lng: c.lng } : undefined;

  const t = newTrip({ name: str(d.name) || '匯入的行程', destination: str(d.destination) ?? '', dayCount: 1 });
  const linked = typeof d.id === 'string' && TRIP_ID.test(d.id);
  const changedAt = num(d.updatedAt);
  return {
    trip: {
      ...t,
      id: linked ? (d.id as string) : t.id,
      startDate: typeof d.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.startDate) ? d.startDate : undefined,
      mapRegion: d.mapRegion === 'cn' || d.mapRegion === 'intl' ? d.mapRegion : 'auto',
      center,
      days: days.length ? days : t.days,
      spots,
    },
    linked,
    changedAt: changedAt && changedAt > 0 && changedAt < 8.64e15 ? changedAt : undefined,
    seen: Array.isArray(d.seen) ? uniq(d.seen.filter((x): x is string => typeof x === 'string' && x.length <= 32)) : undefined,
  };
}

/** Text that holds a share link or an exported trip (not checked any further). */
export function looksLikeTrip(text: string): boolean {
  return text.includes(PREFIX) || text.trim().startsWith('{');
}

export function sharedTripInHash(): string | null {
  return location.hash.startsWith(PREFIX) ? location.hash : null;
}

// ---------------------------------------------------------------- importing

export interface ImportTarget {
  trip: Trip;
  /**
   * id: the same trip. copy: shares days or places with it (a copy imported before trips carried
   * their id, or one saved as a new trip). name: only the name is the same, maybe a different trip.
   */
  match: 'id' | 'copy' | 'name';
}

/** Copies keep the days' and places' ids; unrelated trips share none (a place id may clash by chance). */
function sharesPlan(a: TripSnapshot, b: TripSnapshot): boolean {
  const days = new Set(a.days.map((d) => d.id));
  const spots = new Set(a.spots.map((s) => s.id));
  return b.days.some((d) => days.has(d.id)) || b.spots.filter((s) => spots.has(s.id)).length >= 2;
}

/** The trip on this device that an import would update. */
export function importTarget(trips: Trip[], incoming: IncomingTrip): ImportTarget | null {
  const same = incoming.linked ? trips.find((t) => t.id === incoming.trip.id) : undefined;
  if (same) return { trip: same, match: 'id' };
  const key = nameKey(incoming.trip.name);
  const latest = (list: Trip[]) => list.reduce<Trip | undefined>((a, b) => (a && a.updatedAt >= b.updatedAt ? a : b), undefined);
  const copies = trips.filter((t) => sharesPlan(t, incoming.trip));
  const copy = latest(copies.filter((t) => nameKey(t.name) === key)) ?? latest(copies);
  if (copy) return { trip: copy, match: 'copy' };
  const named = latest(trips.filter((t) => nameKey(t.name) === key));
  return named ? { trip: named, match: 'name' } : null;
}

/**
 * How the incoming version relates to this copy. newer: built on this copy's plan. older: this
 * copy is built on it. diverged: each has changes the other lacks. unknown: not enough history
 * (links, files or copies from before versions were tracked).
 */
export type ImportRelation = 'same' | 'newer' | 'older' | 'diverged' | 'unknown';

export function compareImport(local: Trip, incoming: IncomingTrip): ImportRelation {
  const here = planFingerprint(local);
  const there = planFingerprint(incoming.trip);
  if (here === there) return 'same';
  if (incoming.seen?.includes(here)) return 'newer';
  if (local.synced?.seen.includes(there)) return 'older';
  return incoming.seen && local.synced ? 'diverged' : 'unknown';
}

/** Update when nothing here would be lost and it is surely the same trip; otherwise keep both. */
export function updateByDefault(target: ImportTarget, relation: ImportRelation): boolean {
  if (relation === 'same' || relation === 'newer') return true;
  if (relation === 'older' || relation === 'diverged') return false;
  return target.match !== 'name';
}

/** A new trip from the import (the store gives it a fresh id if this one is taken). */
export function importedAsNew(incoming: IncomingTrip, now = Date.now()): Trip {
  const t: Trip = { ...incoming.trip, createdAt: now, updatedAt: now };
  return { ...t, synced: { seen: uniq([planFingerprint(t), ...(incoming.seen ?? [])]), at: incoming.changedAt ?? 0 } };
}

/**
 * The local trip with the imported plan. The AI chat stays, and so do web searches and the
 * locations found here when the import has none, or only one the user did not pick. A trip matched another
 * way takes the incoming id, so the next import of that trip finds it directly.
 */
export function mergeImported(local: Trip, incoming: IncomingTrip, now = Date.now()): Trip {
  const before = new Map(local.spots.map((s) => [s.id, s]));
  const spots = incoming.trip.spots.map((s) => {
    const cur = before.get(s.id);
    if (!cur || nameKey(cur.name) !== nameKey(s.name)) return s;
    let out = !s.search && cur.search ? { ...s, search: cur.search } : s;
    if (hasCoords(cur) && cur.geo && (!hasCoords(s) || (cur.geo === 'manual' && s.geo !== 'manual'))) {
      out = { ...out, lat: cur.lat, lng: cur.lng, geo: cur.geo };
    }
    return out;
  });
  const t = incoming.trip;
  const merged: Trip = {
    ...local,
    id: incoming.linked ? t.id : local.id,
    name: t.name,
    destination: t.destination,
    startDate: t.startDate,
    days: t.days,
    spots,
    mapRegion: t.mapRegion,
    center: t.center ?? (nameKey(t.destination) === nameKey(local.destination) ? local.center : undefined),
    updatedAt: now,
  };
  // The versions this copy had are replaced by the import, so they count as seen too: a link
  // with one of them is older than this copy now.
  const seen = uniq([planFingerprint(merged), ...(incoming.seen ?? []), ...(local.synced?.seen ?? [])]);
  return { ...merged, synced: { seen, at: incoming.changedAt ?? 0 } };
}
