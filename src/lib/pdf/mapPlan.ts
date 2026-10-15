/* Which map tiles cover a day's places, and where each place falls on the picture
 * (Web Mercator, like the map in the app). */
import { wgsToGcj, type ResolvedRegion } from '../geo';
import type { LatLng } from '../../types';

const TILE = 256;

export interface TilePlacement {
  url: string;
  /** Top-left corner on the picture, in pixels, and the drawn size. */
  dx: number;
  dy: number;
  size: number;
}

export interface MapPlan {
  zoom: number;
  tiles: TilePlacement[];
  /** Picture position of a WGS-84 point. */
  project(p: LatLng): { x: number; y: number };
  attribution: string;
}

function world(p: LatLng, zoom: number): { x: number; y: number } {
  const scale = TILE * 2 ** zoom;
  const lat = Math.max(-85.05, Math.min(85.05, p.lat));
  const s = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((p.lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale,
  };
}

export function tileUrl(region: ResolvedRegion, x: number, y: number, z: number): string {
  if (region === 'cn') {
    // Same Amap tiles as the map in the app (GCJ-02).
    return `https://webrd0${1 + ((x + y) % 4)}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=${x}&y=${y}&z=${z}`;
  }
  return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
}

/**
 * Plans a `width` × `height` pixel picture showing all points with `pad` pixels to spare.
 * Tiles are drawn `tileScale` times their size (sharp enough for print at fewer tiles).
 */
export function planMap(
  points: LatLng[],
  region: ResolvedRegion,
  width: number,
  height: number,
  opts: { tileScale?: number; pad?: number; maxZoom?: number } = {},
): MapPlan {
  const k = opts.tileScale ?? 2;
  const pad = opts.pad ?? 40;
  const maxZoom = opts.maxZoom ?? 16;
  // Amap tiles are in GCJ-02 inside mainland China.
  const toMap = (p: LatLng) => (region === 'cn' ? wgsToGcj(p) : p);
  const pts = points.map(toMap);

  let zoom = 3;
  for (let z = maxZoom; z >= 3; z--) {
    const w = pts.map((p) => world(p, z));
    const spanX = (Math.max(...w.map((p) => p.x)) - Math.min(...w.map((p) => p.x))) * k;
    const spanY = (Math.max(...w.map((p) => p.y)) - Math.min(...w.map((p) => p.y))) * k;
    if (spanX <= width - 2 * pad && spanY <= height - 2 * pad) {
      zoom = z;
      break;
    }
  }
  if (pts.length === 1) zoom = Math.min(zoom, 15);

  const w = pts.map((p) => world(p, zoom));
  const cx = (Math.max(...w.map((p) => p.x)) + Math.min(...w.map((p) => p.x))) / 2;
  const cy = (Math.max(...w.map((p) => p.y)) + Math.min(...w.map((p) => p.y))) / 2;
  // World pixel at the picture's top-left corner.
  const x0 = cx - width / k / 2;
  const y0 = cy - height / k / 2;
  const n = 2 ** zoom;

  const tiles: TilePlacement[] = [];
  for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y0 + height / k) / TILE); ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x0 + width / k) / TILE); tx++) {
      const wrapped = ((tx % n) + n) % n;
      tiles.push({ url: tileUrl(region, wrapped, ty, zoom), dx: (tx * TILE - x0) * k, dy: (ty * TILE - y0) * k, size: TILE * k });
    }
  }

  return {
    zoom,
    tiles,
    project: (p) => {
      const q = world(toMap(p), zoom);
      return { x: (q.x - x0) * k, y: (q.y - y0) * k };
    },
    attribution: region === 'cn' ? '© 高德地圖' : '© OpenStreetMap',
  };
}
