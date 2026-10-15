/* Background locating of places that have no coordinates (added by the AI without them,
 * typed in by hand, imported…), so distances and route maps cover every stop. */
import { create } from 'zustand';
import { distanceKm, hasCoords, tripRegion, type ResolvedRegion } from './geo';
import { searchAmap, searchOsm, type PlaceResult } from './geocode';
import { centroid, isGenericName, MAX_KM_PARTIAL, normName, pickPlaceDetailed, queryVariants } from './placeMatch';
import type { LatLng, Settings, Spot, Trip } from '../types';

/**
 * queued / locating: waiting or searching; found: located automatically this session;
 * not-found: no confident match (locate by hand); skipped: not a place ("午餐（附近找）");
 * no-area: the trip has no destination or located place yet to tell where to search.
 */
export type LocateStatus = 'queued' | 'locating' | 'found' | 'not-found' | 'skipped' | 'no-area';

export const useLocateStatus = create<{
  byKey: Record<string, LocateStatus>;
  /** The map search service failed; queued places wait for a retry instead of being searched now. */
  paused: boolean;
}>(() => ({ byKey: {}, paused: false }));

/** Whether a status means the place is being (or about to be) searched right now. */
export const inProgress = (st: LocateStatus | undefined, online: boolean, paused: boolean) =>
  online && !paused && (st === 'queued' || st === 'locating');

/** A spot is looked up again when it is renamed. */
export const locateKey = (tripId: string, spot: Pick<Spot, 'id' | 'name'>) => `${tripId}|${spot.id}|${normName(spot.name)}`;

export function statusOf(tripId: string, spot: Pick<Spot, 'id' | 'name'>): LocateStatus | undefined {
  return useLocateStatus.getState().byKey[locateKey(tripId, spot)];
}

export interface FindContext {
  region: ResolvedRegion;
  destination: string;
  /** Where the trip is (its other places and destination); matches far from all of them are rejected. */
  anchors: LatLng[];
  /** Search around here. */
  center?: LatLng;
  amap?: { key: string; securityCode: string };
}

export interface Searchers {
  osm: typeof searchOsm;
  amap: typeof searchAmap;
}

export interface FindResult {
  place: PlaceResult | null;
  /** Nothing matched only because the matches were too far from the trip (try again later). */
  far: boolean;
}

/** An exact name match may be this far away: the trip's second city (Tokyo and Osaka). */
const EXACT_KM = 1000;

/**
 * Finds the place a spot names; `place` is null when nothing matches confidently.
 * Throws when OpenStreetMap cannot be reached (so the caller can try again later).
 */
export async function findPlace(
  spot: { name: string; address?: string },
  ctx: FindContext,
  s: Searchers = { osm: searchOsm, amap: searchAmap },
): Promise<FindResult> {
  const name = spot.name;
  const variants = queryVariants(name);
  let far = false;
  const pick = (results: PlaceResult[], q: string, exactKm?: number) => {
    const p = pickPlaceDetailed(results, name, q, ctx.anchors, { address: spot.address, exactKm });
    far ||= p.far;
    return p.place;
  };
  if (!variants.length) return { place: null, far };
  if (ctx.amap && ctx.region === 'cn') {
    for (const q of variants.slice(0, 2)) {
      let results: PlaceResult[];
      try {
        results = await s.amap(q, ctx.destination || undefined, ctx.amap.key, ctx.amap.securityCode);
      } catch {
        break; // key not working here: OpenStreetMap below
      }
      const hit = pick(results, q);
      if (hit) return { place: hit, far: false };
    }
  }
  for (const q of variants) {
    const hit = pick(await s.osm(q, { near: ctx.center, bounded: !!ctx.center }), q);
    if (hit) return { place: hit, far: false };
  }
  if (ctx.center) {
    // Outside the box around the trip: a day trip further out, or the trip's second city.
    const hit = pick(await s.osm(variants[0], {}), variants[0], EXACT_KM);
    if (hit) return { place: hit, far: false };
  }
  // A small place missing from the map under its name: its street address, if near the trip.
  const address = spot.address?.trim();
  if (address && normName(address).length >= 4 && normName(address) !== normName(ctx.destination)) {
    const [r] = await s.osm(address, { near: ctx.center, bounded: !!ctx.center, limit: 1 });
    if (r && ctx.anchors.some((a) => distanceKm(a, r) <= MAX_KM_PARTIAL)) return { place: r, far: false };
  }
  return { place: null, far };
}

export function contextFor(trip: Trip, settings: Pick<Settings, 'amapKey' | 'amapSecurityCode'>): FindContext {
  const located = trip.spots.filter(hasCoords).map((s) => ({ lat: s.lat, lng: s.lng }));
  const anchors = trip.center ? [...located, trip.center] : located;
  const key = settings.amapKey.trim();
  return {
    region: tripRegion(trip),
    destination: trip.destination,
    anchors,
    center: trip.center ?? centroid(located),
    ...(key ? { amap: { key, securityCode: settings.amapSecurityCode.trim() } } : {}),
  };
}

/** Spots that found nothing are not searched again for a while (kept per device). */
export interface MissMemory {
  has(key: string): boolean;
  add(key: string): void;
  delete(key: string): void;
}

const MISS_KEY = 'travel-planner-geo-miss';
const MISS_DAYS = 14;

export function localMissMemory(): MissMemory {
  const read = (): Record<string, number> => {
    try {
      const v = JSON.parse(localStorage.getItem(MISS_KEY) ?? '{}');
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  };
  const write = (m: Record<string, number>) => {
    try {
      const entries = Object.entries(m)
        .filter(([, at]) => Date.now() - at < MISS_DAYS * 864e5)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 500);
      localStorage.setItem(MISS_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      /* storage unavailable: just search again next time */
    }
  };
  return {
    has: (key) => {
      const at = read()[key];
      return typeof at === 'number' && Date.now() - at < MISS_DAYS * 864e5;
    },
    add: (key) => write({ ...read(), [key]: Date.now() }),
    delete: (key) => {
      const m = read();
      if (!(key in m)) return;
      delete m[key];
      write(m);
    },
  };
}

export interface LocatorDeps {
  getTrip(id: string): Trip | undefined;
  getSettings(): Pick<Settings, 'amapKey' | 'amapSecurityCode'>;
  find(spot: { name: string; address?: string }, ctx: FindContext): Promise<FindResult>;
  /** Stores the location if the spot still has the same name and no coordinates; false otherwise. */
  save(tripId: string, spotId: string, name: string, place: LatLng): boolean;
  /** Centre of the destination, for trips without any located place yet (throws when offline). */
  findCenter(destination: string): Promise<LatLng | null>;
  setCenter(tripId: string, center: LatLng): void;
  misses: MissMemory;
  online(): boolean;
  /** Wait before trying again after the service failed. */
  retryDelayMs?: number;
}

export interface Locator {
  /** Queues every place of the trip that has no coordinates and was not tried yet. */
  schedule(trip: Trip): void;
  /** Searches these places again, even ones that found nothing before. */
  retry(trip: Trip, spotIds: string[]): void;
  /** Continue after going back online. */
  resume(): void;
  /** Resolves when the queue is empty or paused (for tests). */
  idle(): Promise<void>;
}

export function createLocator(deps: LocatorDeps): Locator {
  const queue: { tripId: string; spotId: string; key: string; errors?: number }[] = [];
  const centers = new Map<string, Promise<void>>();
  let running: Promise<void> | null = null;
  let pausedUntil = 0;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const setStatus = (key: string, st?: LocateStatus) =>
    useLocateStatus.setState((s) => {
      const byKey = { ...s.byKey };
      if (st) byKey[key] = st;
      else delete byKey[key];
      return { byKey };
    });
  const getStatus = (key: string) => useLocateStatus.getState().byKey[key];
  const setPaused = (paused: boolean) => {
    if (useLocateStatus.getState().paused !== paused) useLocateStatus.setState({ paused });
  };

  const hasArea = (trip: Trip) => !!trip.center || trip.spots.some(hasCoords);

  // A destination that cannot be found is not looked up again this session; one that failed
  // because the service could not be reached is.
  const ensureCenter = (trip: Trip) => {
    if (hasArea(trip) || !trip.destination.trim()) return Promise.resolve();
    const key = `${trip.id}|${trip.destination.trim()}`;
    let p = centers.get(key);
    if (!p) {
      p = deps.findCenter(trip.destination).then(
        (c) => {
          if (c) deps.setCenter(trip.id, c);
        },
        (err) => {
          centers.delete(key);
          throw err;
        },
      );
      centers.set(key, p);
    }
    return p;
  };

  const loop = async () => {
    while (queue.length) {
      if (!deps.online() || Date.now() < pausedUntil) return;
      const job = queue[0];
      let trip = deps.getTrip(job.tripId);
      let spot = trip?.spots.find((s) => s.id === job.spotId);
      if (!trip || !spot || hasCoords(spot) || locateKey(trip.id, spot) !== job.key) {
        queue.shift();
        if (getStatus(job.key) === 'queued' || getStatus(job.key) === 'locating') setStatus(job.key);
        continue;
      }
      setStatus(job.key, 'locating');
      try {
        await ensureCenter(trip);
        trip = deps.getTrip(job.tripId) ?? trip;
        spot = trip.spots.find((s) => s.id === job.spotId) ?? spot;
        if (!hasArea(trip)) {
          // Without knowing where the trip is, a same-named place anywhere in the world would
          // be taken. Wait until the trip has a destination or a located place.
          queue.shift();
          setStatus(job.key, 'no-area');
          continue;
        }
        const { place, far } = await deps.find(spot, contextFor(trip, deps.getSettings()));
        queue.shift();
        failures = 0;
        setPaused(false);
        if (!place) {
          if (!far) deps.misses.add(job.key);
          setStatus(job.key, 'not-found');
        } else if (deps.save(job.tripId, job.spotId, spot.name, { lat: place.lat, lng: place.lng })) {
          setStatus(job.key, 'found');
        } else {
          setStatus(job.key); // renamed, located by hand or deleted meanwhile
        }
      } catch {
        // Offline, rate-limited or blocked: keep the place queued and try again later,
        // waiting longer each time. A place that keeps failing waits for the next visit.
        job.errors = (job.errors ?? 0) + 1;
        if (job.errors >= 3) {
          queue.shift();
          setStatus(job.key);
        } else {
          setStatus(job.key, 'queued');
        }
        failures++;
        const delay = Math.min((deps.retryDelayMs ?? 60_000) * 2 ** (failures - 1), 15 * 60_000);
        pausedUntil = Date.now() + delay;
        setPaused(true);
        clearTimeout(timer);
        timer = setTimeout(() => {
          pausedUntil = 0;
          setPaused(false);
          kick();
        }, delay);
        return;
      }
    }
  };

  const kick = () => {
    if (!running) {
      running = loop().finally(() => {
        running = null;
      });
    }
    return running;
  };

  const schedule = (trip: Trip) => {
    let added = false;
    for (const spot of trip.spots) {
      if (hasCoords(spot)) continue;
      const key = locateKey(trip.id, spot);
      const st = getStatus(key);
      // A trip that now has a destination (or a located place) gets its waiting places searched.
      if (st && !(st === 'no-area' && (hasArea(trip) || trip.destination.trim()))) continue;
      if (isGenericName(spot.name)) {
        setStatus(key, 'skipped');
        continue;
      }
      if (deps.misses.has(key)) {
        setStatus(key, 'not-found');
        continue;
      }
      setStatus(key, 'queued');
      queue.push({ tripId: trip.id, spotId: spot.id, key });
      added = true;
    }
    if (added) void kick();
  };

  return {
    schedule,
    retry(trip, spotIds) {
      for (const spot of trip.spots) {
        if (!spotIds.includes(spot.id) || hasCoords(spot)) continue;
        const key = locateKey(trip.id, spot);
        const st = getStatus(key);
        if (st === 'queued' || st === 'locating') continue;
        deps.misses.delete(key);
        setStatus(key);
        if (isGenericName(spot.name)) {
          // Asked for explicitly: try it anyway.
          setStatus(key, 'queued');
          queue.push({ tripId: trip.id, spotId: spot.id, key });
        }
      }
      pausedUntil = 0;
      setPaused(false);
      schedule(trip);
      void kick();
    },
    resume() {
      pausedUntil = 0;
      setPaused(false);
      void kick();
    },
    idle: async () => {
      while (running) await running;
    },
  };
}
