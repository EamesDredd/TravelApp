import type { LatLng, MapRegion, Spot, Trip, TravelMode } from '../types';

type Ring = [number, number][]; // [lng, lat]

// Simplified outline of mainland China (lng, lat), clockwise from the Amur river.
// Accurate to a few km along land borders, generous over open sea, and drawn
// through the Taiwan Strait so Taiwan and Penghu stay outside.
const MAINLAND: Ring = [
  [121.2, 53.3], [122.4, 53.5], [123.6, 53.55], [125.0, 53.2], [125.7, 52.9], [126.5, 52.1],
  [127.1, 51.2], [127.6, 50.2], [128.2, 49.6], [129.5, 49.4], [130.6, 48.9], [130.8, 48.0],
  [132.5, 47.7], [133.5, 48.1], [134.7, 48.3], [134.5, 47.6], [134.2, 47.2], [133.9, 46.3],
  [133.4, 45.6], [133.1, 45.1], [132.0, 45.3], [131.6, 44.9], [131.0, 44.8], [131.3, 44.0],
  [131.2, 43.4], [130.8, 42.9], [130.6, 42.4], [130.2, 42.75], [129.8, 42.98], [129.3, 42.45],
  [128.9, 42.05], [128.0, 41.98], [127.1, 41.5], [126.5, 41.4], [125.9, 40.9], [125.0, 40.45],
  [124.3, 39.85], [123.5, 38.5], [123.2, 37.3], [123.0, 35.0], [123.2, 32.0], [123.0, 29.5],
  [121.5, 27.5], [120.5, 26.5], [120.0, 25.6], [119.3, 24.5], [118.0, 23.0], [116.5, 22.5],
  [115.0, 22.3], [114.6, 21.9], [113.0, 21.5], [111.0, 20.8], [111.4, 19.6], [111.0, 18.2],
  [109.5, 17.9], [108.4, 18.4], [108.5, 20.5], [108.0, 21.45], [107.4, 21.6], [106.7, 22.0],
  [106.6, 22.4], [106.7, 22.85], [105.8, 23.0], [105.3, 23.35], [104.8, 22.95], [103.95, 22.5],
  [103.0, 22.6], [102.4, 22.4], [101.8, 22.45], [101.6, 21.2], [101.15, 21.5], [100.6, 21.45],
  [100.1, 21.7], [99.6, 22.3], [99.25, 23.1], [98.8, 23.8], [97.85, 24.0], [97.55, 24.75],
  [97.7, 25.0], [98.2, 25.5], [98.7, 26.0], [98.7, 27.5], [98.3, 27.8], [97.4, 28.3],
  [96.4, 29.1], [95.4, 29.0], [94.6, 29.2], [93.8, 28.3], [92.6, 27.9], [91.6, 27.9],
  [90.3, 28.25], [89.6, 28.1], [89.0, 27.3], [88.8, 27.6], [88.6, 28.1], [88.0, 27.9],
  [87.0, 28.1], [86.0, 28.1], [85.2, 28.45], [84.2, 28.85], [83.2, 29.5], [82.1, 30.2],
  [81.2, 30.15], [80.4, 30.6], [79.0, 31.3], [78.7, 32.2], [78.5, 32.6], [79.3, 32.5],
  [78.9, 33.6], [79.4, 34.1], [78.0, 35.5], [76.5, 35.9], [75.4, 36.9], [74.8, 37.1],
  [74.9, 37.4], [74.8, 38.6], [73.8, 38.9], [73.5, 39.5], [73.9, 39.7], [75.6, 40.6],
  [76.9, 41.1], [78.1, 41.4], [80.2, 42.1], [80.3, 42.9], [80.8, 43.2], [80.5, 44.7],
  [79.9, 44.9], [82.5, 45.5], [83.0, 47.2], [85.6, 47.1], [86.6, 48.6], [87.4, 49.2],
  [88.0, 48.6], [90.0, 47.9], [91.0, 46.6], [90.9, 45.3], [93.5, 44.9], [95.4, 44.3],
  [96.4, 42.8], [100.3, 42.6], [101.8, 42.5], [103.8, 41.8], [105.0, 41.6], [107.3, 42.4],
  [109.3, 42.4], [110.4, 42.8], [112.0, 43.7], [114.0, 44.9], [115.5, 45.4], [116.6, 46.3],
  [118.3, 46.7], [119.7, 46.6], [119.9, 47.6], [118.5, 47.9], [117.4, 47.6], [115.6, 47.9],
  [116.7, 49.8], [117.8, 49.5], [119.3, 50.3], [120.0, 51.6], [121.0, 52.5],
];

// Places inside the outline above that are not mainland China.
const EXCLUDED: Ring[] = [
  // Hong Kong (follows Shenzhen River / Deep Bay so Futian & Shekou stay mainland)
  [
    [113.82, 22.2], [113.9, 22.43], [113.96, 22.48], [114.03, 22.505], [114.08, 22.515],
    [114.11, 22.53], [114.15, 22.545], [114.23, 22.555], [114.32, 22.56], [114.4, 22.47],
    [114.5, 22.4], [114.5, 22.15], [113.83, 22.15],
  ],
  // Macau (Hengqin, west of Taipa/Coloane, stays mainland)
  [
    [113.528, 22.215], [113.558, 22.218], [113.6, 22.17], [113.6, 22.1], [113.548, 22.1],
    [113.548, 22.16], [113.528, 22.19],
  ],
  // Kinmen
  [[118.22, 24.38], [118.5, 24.38], [118.5, 24.52], [118.22, 24.52]],
  // Matsu (Nangan / Beigan, Juguang, Dongyin)
  [[119.9, 26.14], [120.02, 26.14], [120.02, 26.3], [119.9, 26.3]],
  [[119.92, 25.94], [120.0, 25.94], [120.0, 25.99], [119.92, 25.99]],
  [[120.46, 26.34], [120.53, 26.34], [120.53, 26.4], [120.46, 26.4]],
];

function inRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function isMainlandChina(p: LatLng): boolean {
  if (!inRing(p.lng, p.lat, MAINLAND)) return false;
  return !EXCLUDED.some((r) => inRing(p.lng, p.lat, r));
}

// --- WGS-84 <-> GCJ-02 (the offset coordinate system Amap uses inside mainland China)

const A = 6378245.0;
const EE = 0.00669342162296594323;

function tLat(x: number, y: number) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  r += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  r += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return r;
}

function tLng(x: number, y: number) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  r += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  r += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return r;
}

function gcjDelta(p: LatLng): LatLng {
  let dLat = tLat(p.lng - 105, p.lat - 35);
  let dLng = tLng(p.lng - 105, p.lat - 35);
  const radLat = (p.lat / 180) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180) / ((A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lat: dLat, lng: dLng };
}

export function wgsToGcj(p: LatLng): LatLng {
  if (!isMainlandChina(p)) return p;
  const d = gcjDelta(p);
  return { lat: p.lat + d.lat, lng: p.lng + d.lng };
}

export function gcjToWgs(p: LatLng): LatLng {
  if (!isMainlandChina(p)) return p;
  // Fixed-point iteration; converges to well under a metre in a few steps.
  let w = { ...p };
  for (let i = 0; i < 5; i++) {
    const g = wgsToGcj(w);
    w = { lat: w.lat - (g.lat - p.lat), lng: w.lng - (g.lng - p.lng) };
  }
  return w;
}

// --- distances

export function hasCoords<T extends { lat?: number; lng?: number }>(s: T): s is T & LatLng {
  return typeof s.lat === 'number' && typeof s.lng === 'number' && !Number.isNaN(s.lat) && !Number.isNaN(s.lng);
}

export function distanceKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Very rough door-to-door estimate from straight-line distance, in minutes. */
export function estimateMinutes(km: number, mode: TravelMode): number {
  const road = km * 1.35; // streets are never straight
  switch (mode) {
    case 'walking':
      return Math.max(1, Math.round((road / 4.5) * 60));
    case 'driving':
      return Math.max(3, Math.round((road / 28) * 60 + 5));
    case 'transit':
      return Math.max(5, Math.round((road / 18) * 60 + 10));
  }
}

export function formatKm(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(km < 10 ? 1 : 0)} km`;
}

export function formatMinutes(min: number): string {
  if (min < 60) return `${min} 分`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} 小時 ${m} 分` : `${h} 小時`;
}

// --- which map service to use

export type ResolvedRegion = 'cn' | 'intl';

export function tripRegion(trip: Pick<Trip, 'mapRegion' | 'spots' | 'center'>): ResolvedRegion {
  if (trip.mapRegion !== 'auto') return trip.mapRegion;
  const located = trip.spots.filter(hasCoords);
  if (located.length) {
    const cn = located.filter((s) => isMainlandChina(s)).length;
    return cn * 2 >= located.length ? 'cn' : 'intl';
  }
  if (trip.center) return isMainlandChina(trip.center) ? 'cn' : 'intl';
  return 'intl';
}

/** Region for a single spot: its own coordinates win; otherwise fall back to the trip. */
export function spotRegion(spot: Spot, trip: Pick<Trip, 'mapRegion' | 'spots' | 'center'>): ResolvedRegion {
  if (trip.mapRegion !== 'auto') return trip.mapRegion;
  if (hasCoords(spot)) return isMainlandChina(spot) ? 'cn' : 'intl';
  return tripRegion(trip);
}

/** Region for a list of stops (a day's route). */
export function stopsRegion(spots: Spot[], trip: Pick<Trip, 'mapRegion' | 'spots' | 'center'>): ResolvedRegion {
  if (trip.mapRegion !== 'auto') return trip.mapRegion;
  const located = spots.filter(hasCoords);
  if (!located.length) return tripRegion(trip);
  const cn = located.filter((s) => isMainlandChina(s)).length;
  return cn * 2 >= located.length ? 'cn' : 'intl';
}

export function regionOf(mapRegion: MapRegion, p?: LatLng): ResolvedRegion {
  if (mapRegion !== 'auto') return mapRegion;
  return p && isMainlandChina(p) ? 'cn' : 'intl';
}
