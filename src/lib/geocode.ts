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
}

// Nominatim's usage policy allows at most one request per second.
let lastNominatim = 0;
async function nominatimSlot() {
  const wait = lastNominatim + 1100 - Date.now();
  lastNominatim = Date.now() + Math.max(0, wait);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export async function searchOsm(query: string, near?: LatLng): Promise<PlaceResult[]> {
  await nominatimSlot();
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: '8',
    'accept-language': 'zh-TW,zh,en',
  });
  if (near) {
    const d = 1.5; // ~150 km box, preferred but not enforced
    params.set('viewbox', `${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`);
  }
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
  if (!res.ok) throw new Error(`OpenStreetMap 搜尋失敗（${res.status}）`);
  const data = (await res.json()) as Array<{ name?: string; display_name: string; lat: string; lon: string }>;
  return data.map((r) => {
    const parts = r.display_name.split(',').map((x) => x.trim());
    return {
      name: r.name || parts[0],
      address: parts.slice(1, 5).join(', '),
      lat: Number(r.lat),
      lng: Number(r.lon),
      source: 'osm' as const,
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
    return { name: p.name, address: p.address, lat: w.lat, lng: w.lng, source: 'amap' as const };
  });
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
