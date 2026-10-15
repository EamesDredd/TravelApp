/* What goes into the itinerary PDF, worked out from the trip (no drawing here). */
import { distanceKm, estimateMinutes, formatKm, formatMinutes, hasCoords, spotRegion, stopsRegion, type ResolvedRegion } from '../geo';
import { amapNavigationUrl, amapPlaceUrl, googleDirectionsUrl, googleSearchUrl } from '../maps';
import { dayDate, formatDayDate } from '../util';
import { CATEGORY_ICON, CATEGORY_LABEL, type Category, type Spot, type Trip } from '../../types';

export interface PdfOptions {
  /** Day indexes to include, in order. */
  days: number[];
  /** Draw a route map for each day. */
  maps: boolean;
  /** Start every day on a new page. */
  newPagePerDay: boolean;
}

export const PIN_COLORS: Record<Category, string> = { sight: '#0f766e', breakfast: '#b45309', meal: '#be185d' };

export interface MapPin {
  lat: number;
  lng: number;
  label: string;
  color: string;
}

export interface MapSpec {
  region: ResolvedRegion;
  pins: MapPin[];
}

export interface ItemModel {
  no: number;
  time?: string;
  icon: string;
  name: string;
  /** Opens the place in Google Maps / Amap. */
  url: string;
  color: string;
  /** Category, suggested stay, address. */
  meta: string;
  notes: string[];
  /** Getting here from the previous stop. */
  leg?: { text: string; url?: string };
}

export interface DayModel {
  heading: string;
  date: string;
  title?: string;
  items: ItemModel[];
  map?: MapSpec;
  /** Places of the day that have no coordinates (not on the map). */
  unlocated: string[];
}

export interface DocModel {
  title: string;
  subtitle: string;
  generated: string;
  /** Short list of the days, when there is more than one. */
  overview: { label: string; title?: string; count: number }[];
  days: DayModel[];
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function fullDate(start: string | undefined, i: number): string {
  const d = dayDate(start, i);
  return d ? `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}（${WEEKDAYS[d.getDay()]}）` : '';
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function legBetween(a: Spot, b: Spot, region: ResolvedRegion, destination: string): ItemModel['leg'] {
  if (a.id === b.id || !hasCoords(a) || !hasCoords(b)) return undefined;
  const km = distanceKm(a, b);
  const walk = km <= 1.5;
  const mode = walk ? 'walking' : 'transit';
  const text = `${walk ? '🚶' : '🚇'} ${formatKm(km)} · 約 ${formatMinutes(estimateMinutes(km, mode))}`;
  const url = region === 'cn' ? amapNavigationUrl(a, b, mode) : googleDirectionsUrl([a, b], mode, destination);
  return { text, ...(url ? { url } : {}) };
}

export function buildItinerary(trip: Trip, opts: PdfOptions, now = new Date()): DocModel {
  const byId = new Map(trip.spots.map((s) => [s.id, s]));
  const indexes = opts.days.filter((i) => i >= 0 && i < trip.days.length);

  const days: DayModel[] = indexes.map((i) => {
    const day = trip.days[i];
    const entries = day.items.map((it) => ({ it, s: byId.get(it.spotId) })).filter((x): x is { it: typeof x.it; s: Spot } => !!x.s);
    const region = stopsRegion(
      entries.map((x) => x.s),
      trip,
    );
    const items: ItemModel[] = entries.map(({ it, s }, n) => {
      const prev = entries[n - 1]?.s;
      const meta = [CATEGORY_LABEL[s.category], s.durationMin ? `停留約 ${formatMinutes(s.durationMin)}` : '', s.address ?? '']
        .filter(Boolean)
        .join(' · ');
      const notes = [it.note ? `📝 ${it.note}` : '', s.note ?? ''].filter(Boolean);
      const url = spotRegion(s, trip) === 'cn' ? amapPlaceUrl(s, trip.destination) : googleSearchUrl(s, trip.destination);
      const leg = prev ? legBetween(prev, s, region, trip.destination) : undefined;
      return {
        no: n + 1,
        ...(it.time ? { time: it.time } : {}),
        icon: CATEGORY_ICON[s.category],
        name: s.name,
        url,
        color: PIN_COLORS[s.category],
        meta,
        notes,
        ...(leg ? { leg } : {}),
      };
    });
    const pins: MapPin[] = entries
      .map(({ s }, n) => ({ s, n }))
      .filter(({ s }) => hasCoords(s))
      .map(({ s, n }) => ({ lat: s.lat!, lng: s.lng!, label: String(n + 1), color: PIN_COLORS[s.category] }));
    const unlocated = [...new Set(entries.filter(({ s }) => !hasCoords(s)).map(({ s }) => s.name))];
    return {
      heading: `第 ${i + 1} 天`,
      date: formatDayDate(trip.startDate, i),
      ...(day.title ? { title: day.title } : {}),
      items,
      ...(opts.maps && pins.length ? { map: { region, pins } } : {}),
      unlocated,
    };
  });

  const all = indexes.length === trip.days.length;
  let when: string;
  if (indexes.length === 1) {
    when = [`第 ${indexes[0] + 1} 天`, fullDate(trip.startDate, indexes[0])].filter(Boolean).join(' · ');
  } else {
    const first = fullDate(trip.startDate, indexes[0]);
    const last = formatDayDate(trip.startDate, indexes[indexes.length - 1]);
    when = [first && last ? `${first} – ${last}` : '', all ? `${trip.days.length} 天` : `${indexes.length} 天`].filter(Boolean).join(' · ');
  }

  return {
    title: trip.name,
    subtitle: [trip.destination !== trip.name ? trip.destination : '', when].filter(Boolean).join(' · '),
    generated: `匯出於 ${stamp(now)}`,
    overview:
      indexes.length > 1
        ? days.map((d) => ({ label: [d.heading, d.date].filter(Boolean).join(' '), ...(d.title ? { title: d.title } : {}), count: d.items.length }))
        : [],
    days,
  };
}
