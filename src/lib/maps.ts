import type { Day, LatLng, Spot, TravelMode, Trip } from '../types';
import { CATEGORY_LABEL } from '../types';
import { hasCoords, wgsToGcj } from './geo';

/** Text Google Maps can resolve: name plus address, or the trip destination as context. */
export function placeQuery(spot: Spot, destination?: string): string {
  const ctx = spot.address?.trim() || destination?.trim() || '';
  if (!ctx || spot.name.includes(ctx)) return spot.name;
  return `${spot.name} ${ctx}`;
}

const enc = encodeURIComponent;

// ---------------------------------------------------------------- Google Maps

const GOOGLE_MODE: Record<TravelMode, string> = {
  driving: 'driving',
  transit: 'transit',
  walking: 'walking',
};

export function googleSearchUrl(spot: Spot, destination?: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${enc(placeQuery(spot, destination))}`;
}

/**
 * Google Maps directions link. Waypoints are ignored by Google for transit,
 * so callers should use per-leg links (two stops) in transit mode.
 */
export function googleDirectionsUrl(stops: Spot[], mode: TravelMode, destination?: string): string {
  const q = stops.map((s) => placeQuery(s, destination));
  const params = new URLSearchParams({ api: '1', travelmode: GOOGLE_MODE[mode] });
  if (q.length === 1) {
    params.set('destination', q[0]);
  } else {
    params.set('origin', q[0]);
    params.set('destination', q[q.length - 1]);
    const via = mode === 'transit' ? [] : q.slice(1, -1);
    if (via.length) params.set('waypoints', via.join('|'));
  }
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/**
 * Splits a day's stops into overlapping chunks that Google Maps can open in one
 * link (mobile browsers accept at most 3 waypoints = 5 stops per link).
 */
export function chunkStops<T>(stops: T[], maxStops = 5): T[][] {
  if (stops.length <= maxStops) return [stops];
  const out: T[][] = [];
  for (let i = 0; i < stops.length - 1; i += maxStops - 1) {
    out.push(stops.slice(i, i + maxStops));
  }
  return out;
}

/** Embeddable single-place map. Uses the Maps Embed API when a key is configured. */
export function googleEmbedPlaceUrl(spot: Spot, destination: string | undefined, key?: string): string {
  const q = hasCoords(spot) && !spot.address ? `${spot.lat},${spot.lng}` : placeQuery(spot, destination);
  if (key) {
    return `https://www.google.com/maps/embed/v1/place?key=${enc(key)}&q=${enc(q)}&language=zh-TW`;
  }
  return `https://maps.google.com/maps?q=${enc(q)}&hl=zh-TW&z=15&output=embed`;
}

const LEGACY_DIRFLG: Record<TravelMode, string> = { driving: 'd', transit: 'r', walking: 'w' };

/** Embeddable directions map for a list of stops (use two stops for transit). */
export function googleEmbedDirectionsUrl(
  stops: Spot[],
  mode: TravelMode,
  destination: string | undefined,
  key?: string,
): string {
  const q = stops.map((s) => placeQuery(s, destination));
  if (q.length < 2) return googleEmbedPlaceUrl(stops[0], destination, key);
  if (key) {
    const params = new URLSearchParams({
      key,
      origin: q[0],
      destination: q[q.length - 1],
      mode: GOOGLE_MODE[mode],
      language: 'zh-TW',
    });
    const via = mode === 'transit' ? [] : q.slice(1, -1);
    if (via.length) params.set('waypoints', via.join('|'));
    return `https://www.google.com/maps/embed/v1/directions?${params.toString()}`;
  }
  const daddr = (mode === 'transit' ? [q[q.length - 1]] : q.slice(1)).join(' to:');
  return `https://maps.google.com/maps?saddr=${enc(q[0])}&daddr=${enc(daddr)}&dirflg=${LEGACY_DIRFLG[mode]}&hl=zh-TW&output=embed`;
}

// ---------------------------------------------------------------- Amap (高德)

const AMAP_MODE: Record<TravelMode, string> = { driving: 'car', transit: 'bus', walking: 'walk' };
const SRC = 'travel-planner';

function amapPoint(spot: Spot): string {
  const g = wgsToGcj({ lat: spot.lat!, lng: spot.lng! });
  return `${g.lng.toFixed(6)},${g.lat.toFixed(6)},${spot.name.replace(/,/g, ' ')}`;
}

export function amapSearchUrl(spot: Spot, destination?: string): string {
  const params = new URLSearchParams({ keyword: spot.name, src: SRC, callnative: '1' });
  const city = destination?.trim();
  if (city) params.set('city', city);
  return `https://uri.amap.com/search?${params.toString()}`;
}

/** Marker page for a located spot, otherwise a keyword search. */
export function amapPlaceUrl(spot: Spot, destination?: string): string {
  if (!hasCoords(spot)) return amapSearchUrl(spot, destination);
  const g = wgsToGcj(spot);
  const params = new URLSearchParams({
    position: `${g.lng.toFixed(6)},${g.lat.toFixed(6)}`,
    name: spot.name,
    src: SRC,
    coordinate: 'gaode',
    callnative: '1',
  });
  return `https://uri.amap.com/marker?${params.toString()}`;
}

/** Route between located spots; both endpoints need coordinates. */
export function amapNavigationUrl(from: Spot | null, to: Spot, mode: TravelMode, via?: Spot): string | null {
  if (!hasCoords(to) || (from && !hasCoords(from))) return null;
  const params = new URLSearchParams();
  if (from) params.set('from', amapPoint(from));
  params.set('to', amapPoint(to));
  if (via && hasCoords(via) && mode === 'driving') params.set('via', amapPoint(via));
  params.set('mode', AMAP_MODE[mode]);
  params.set('policy', '1');
  params.set('src', SRC);
  params.set('coordinate', 'gaode');
  params.set('callnative', '1');
  return `https://uri.amap.com/navigation?${params.toString()}`;
}

// ---------------------------------------------------------------- opening the apps

/**
 * A map link that can open the Google Maps or Amap app instead of the web page.
 * `web` is for the browser (and desktop); `ios` is the app's URL scheme on iPhone; `android`
 * is a Chrome intent that opens the app, or `web` when the app is not installed.
 */
export interface AppLink {
  app: 'google' | 'amap';
  web: string;
  ios?: string;
  android?: string;
}

const GOOGLE_PACKAGE = 'com.google.android.apps.maps';
const AMAP_PACKAGE = 'com.autonavi.minimap';

/** Chrome intent for `native` (scheme://rest) in `pkg`, with `fallback` when the app is missing. */
export function intentUrl(native: string, pkg: string, fallback: string): string {
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(native);
  if (!m) return fallback;
  return `intent://${m[2]}#Intent;scheme=${m[1]};package=${pkg};S.browser_fallback_url=${enc(fallback)};end`;
}

function googleApp(web: string, ios: string): AppLink {
  return { app: 'google', web, ios, android: intentUrl(web, GOOGLE_PACKAGE, web) };
}

export function googleSearchLink(spot: Spot, destination?: string): AppLink {
  return googleApp(googleSearchUrl(spot, destination), `comgooglemaps://?q=${enc(placeQuery(spot, destination))}`);
}

/** Directions in the app; like the web link, transit goes straight from the first stop to the last. */
export function googleDirectionsLink(stops: Spot[], mode: TravelMode, destination?: string): AppLink {
  const q = stops.map((s) => placeQuery(s, destination));
  const params = [`directionsmode=${GOOGLE_MODE[mode]}`];
  if (q.length === 1) {
    params.unshift(`daddr=${enc(q[0])}`);
  } else {
    const via = mode === 'transit' ? [] : q.slice(1, -1);
    params.unshift(`saddr=${enc(q[0])}`, `daddr=${[...via, q[q.length - 1]].map(enc).join('+to:')}`);
  }
  return googleApp(googleDirectionsUrl(stops, mode, destination), `comgooglemaps://?${params.join('&')}`);
}

function amapApp(web: string, ios: string, android: string): AppLink {
  return { app: 'amap', web, ios, android: intentUrl(android, AMAP_PACKAGE, web) };
}

const AMAP_APP_MODE: Record<TravelMode, string> = { driving: '0', transit: '1', walking: '2' };

/** Search by name in the Amap app. */
export function amapSearchLink(spot: Spot, destination?: string): AppLink {
  const ios = new URLSearchParams({ sourceApplication: SRC, name: spot.name, dev: '0' });
  const android = new URLSearchParams({ sourceApplication: SRC, keywords: spot.name, dev: '0' });
  return amapApp(amapSearchUrl(spot, destination), `iosamap://poi?${ios}`, `androidamap://poi?${android}`);
}

/** The place on the Amap app's map, or a search when it has no coordinates. */
export function amapPlaceLink(spot: Spot, destination?: string): AppLink {
  if (!hasCoords(spot)) return amapSearchLink(spot, destination);
  const g = wgsToGcj(spot);
  const params = new URLSearchParams({
    sourceApplication: SRC,
    poiname: spot.name,
    lat: g.lat.toFixed(6),
    lon: g.lng.toFixed(6),
    dev: '0', // already GCJ-02
  });
  return amapApp(amapPlaceUrl(spot, destination), `iosamap://viewMap?${params}`, `androidamap://viewMap?${params}`);
}

/** Route in the Amap app; null without coordinates. A stop on the way is left to the web page. */
export function amapNavigationLink(from: Spot, to: Spot, mode: TravelMode, via?: Spot): AppLink | null {
  const web = amapNavigationUrl(from, to, mode, via);
  if (!web) return null;
  if (via && hasCoords(via) && mode === 'driving') return { app: 'amap', web };
  const a = wgsToGcj(from as LatLng);
  const b = wgsToGcj(to as LatLng);
  const params = new URLSearchParams({
    sourceApplication: SRC,
    slat: a.lat.toFixed(6),
    slon: a.lng.toFixed(6),
    sname: from.name,
    dlat: b.lat.toFixed(6),
    dlon: b.lng.toFixed(6),
    dname: to.name,
    dev: '0',
    t: AMAP_APP_MODE[mode],
  });
  return amapApp(web, `iosamap://path?${params}`, `amapuri://route/plan/?${params}`);
}

// ---------------------------------------------------------------- KML (Google 我的地圖)

function xml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

const DAY_COLORS = ['ff0f766e', 'ffd97706', 'ff2563eb', 'ffdb2777', 'ff7c3aed', 'ff16a34a', 'ffdc2626'];

/**
 * KML for Google My Maps (我的地圖 → 匯入). One folder per day with numbered
 * placemarks and a line joining the stops in visiting order.
 */
export function tripToKml(trip: Trip, dayIndexes?: number[], dayLabel?: (i: number) => string): string {
  const spotById = new Map(trip.spots.map((s) => [s.id, s]));
  const days = (dayIndexes ?? trip.days.map((_, i) => i)).map((i) => [i, trip.days[i]] as [number, Day]);
  const styles = DAY_COLORS.map(
    (c, i) =>
      `<Style id="d${i}"><IconStyle><color>${c}</color></IconStyle><LineStyle><color>${c}</color><width>4</width></LineStyle></Style>`,
  ).join('');
  const folders = days
    .map(([i, day]) => {
      const style = `#d${i % DAY_COLORS.length}`;
      const stops = day.items.map((it) => ({ it, s: spotById.get(it.spotId) })).filter((x) => x.s && hasCoords(x.s));
      const marks = stops
        .map(({ it, s }, n) => {
          const desc = [CATEGORY_LABEL[s!.category], it.time, s!.address, s!.note, it.note].filter(Boolean).join(' / ');
          return `<Placemark><name>${n + 1}. ${xml(s!.name)}</name><description>${xml(desc)}</description><styleUrl>${style}</styleUrl><Point><coordinates>${s!.lng},${s!.lat},0</coordinates></Point></Placemark>`;
        })
        .join('');
      const line =
        stops.length > 1
          ? `<Placemark><name>${xml(`第${i + 1}天路線`)}</name><styleUrl>${style}</styleUrl><LineString><tessellate>1</tessellate><coordinates>${stops
              .map(({ s }) => `${s!.lng},${s!.lat},0`)
              .join(' ')}</coordinates></LineString></Placemark>`
          : '';
      const label = dayLabel ? dayLabel(i) : `第${i + 1}天`;
      return `<Folder><name>${xml(label + (day.title ? ` ${day.title}` : ''))}</name>${marks}${line}</Folder>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${xml(trip.name)}</name>${styles}${folders}</Document></kml>
`;
}

// ---------------------------------------------------------------- search links

export interface QuickLink {
  label: string;
  url: string;
  /** Opens the map app when there is one. */
  app?: AppLink;
}

export function quickSearchLinks(spot: Spot, destination: string | undefined, region: 'cn' | 'intl'): QuickLink[] {
  const q = placeQuery(spot, destination);
  const links: QuickLink[] = [];
  if (region === 'cn') {
    links.push({ label: '百度', url: `https://www.baidu.com/s?wd=${enc(q)}` });
    links.push({ label: '小紅書', url: `https://www.xiaohongshu.com/search_result?keyword=${enc(q)}` });
    links.push({ label: '高德', url: amapPlaceUrl(spot, destination), app: amapPlaceLink(spot, destination) });
    links.push({ label: 'Google', url: `https://www.google.com/search?q=${enc(q)}` });
  } else {
    links.push({ label: 'Google', url: `https://www.google.com/search?q=${enc(q)}` });
    links.push({ label: 'Google 地圖評論', url: googleSearchUrl(spot, destination), app: googleSearchLink(spot, destination) });
    links.push({ label: '小紅書', url: `https://www.xiaohongshu.com/search_result?keyword=${enc(q)}` });
    links.push({ label: 'TripAdvisor', url: `https://www.tripadvisor.com.tw/Search?q=${enc(q)}` });
  }
  links.push({ label: 'YouTube', url: `https://www.youtube.com/results?search_query=${enc(q)}` });
  return links;
}
