import type { LatLng } from '../types';
import { amapPlaceSearch, loadAmap } from './amap';
import { gcjToWgs } from './geo';

export interface PlaceResult {
  name: string;
  address: string;
  /** WGS-84 */
  lat: number;
  lng: number;
  source: 'osm' | 'amap';
  /** Other names of the place (local, Chinese, English…), for matching. */
  names?: string[];
  /** e.g. "railway:station" (OSM) or "交通设施服务;地铁站" (Amap). */
  kind?: string;
}

// Nominatim's usage policy allows at most one request per second.
let lastNominatim = 0;
async function nominatimSlot() {
  const wait = lastNominatim + 1100 - Date.now();
  lastNominatim = Date.now() + Math.max(0, wait);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export interface OsmOptions {
  /** Prefer results around here (~150 km box). */
  near?: LatLng;
  /** Only return results inside that box. */
  bounded?: boolean;
  limit?: number;
}

export async function searchOsm(query: string, opts: OsmOptions | LatLng = {}): Promise<PlaceResult[]> {
  const o: OsmOptions = 'lat' in opts ? { near: opts } : opts;
  await nominatimSlot();
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: String(o.limit ?? 8),
    namedetails: '1',
    'accept-language': 'zh-TW,zh,en',
  });
  if (o.near) {
    const d = 1.5; // ~150 km box
    const { lat, lng } = o.near;
    params.set('viewbox', `${lng - d},${lat + d},${lng + d},${lat - d}`);
    if (o.bounded) params.set('bounded', '1');
  }
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
  if (!res.ok) throw new Error(`OpenStreetMap 搜尋失敗（${res.status}）`);
  const data = (await res.json()) as Array<{
    name?: string;
    display_name: string;
    lat: string;
    lon: string;
    category?: string;
    type?: string;
    namedetails?: Record<string, string> | null;
  }>;
  return data.map((r) => {
    const parts = r.display_name.split(',').map((x) => x.trim());
    const names = r.namedetails ? Object.values(r.namedetails).filter((v) => typeof v === 'string' && v) : [];
    return {
      name: r.name || parts[0],
      address: parts.slice(1, 5).join(', '),
      lat: Number(r.lat),
      lng: Number(r.lon),
      source: 'osm' as const,
      names,
      ...(r.category || r.type ? { kind: `${r.category ?? ''}:${r.type ?? ''}` } : {}),
    };
  });
}

export async function searchAmap(
  query: string,
  city: string | undefined,
  key: string,
  securityCode: string,
): Promise<PlaceResult[]> {
  const AMap = await loadAmap(key, securityCode);
  const pois = await amapPlaceSearch(AMap, query, city);
  return pois.map((p) => {
    const w = gcjToWgs({ lat: p.lat, lng: p.lng });
    return { name: p.name, address: p.address, lat: w.lat, lng: w.lng, source: 'amap' as const, ...(p.type ? { kind: p.type } : {}) };
  });
}

/** Centre of a destination; null when nothing is found. Throws when the service cannot be reached. */
export async function findDestinationCenter(dest: string): Promise<LatLng | null> {
  if (!dest.trim()) return null;
  const r = await searchOsm(dest, { limit: 1 });
  return r[0] ? { lat: r[0].lat, lng: r[0].lng } : null;
}

/** Best-effort centre of a destination name, for region detection. */
export async function geocodeDestination(dest: string): Promise<LatLng | null> {
  if (!dest.trim()) return null;
  try {
    const r = await searchOsm(dest);
    return r[0] ? { lat: r[0].lat, lng: r[0].lng } : null;
  } catch {
    return null;
  }
}
