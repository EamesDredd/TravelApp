/* Reading places back from a KML or KMZ file, such as a map exported from Google My Maps. */
import type { Category, LatLng, PlanItem, Spot, TripSnapshot } from '../types';
import { CATEGORY_ICON, CATEGORY_LABEL } from '../types';
import { distanceKm, gcjToWgs, hasCoords } from './geo';
import { normName } from './placeMatch';
import { CATEGORIES, makeItem, makeSpot, newDay } from './tripOps';

export interface KmlPlace {
  name: string;
  description?: string;
  /** The folder (My Maps layer) it is in. */
  folder?: string;
  /** WGS-84. A position in mainland China is read as GCJ-02, which Google's street map there uses. */
  at: LatLng;
}

export interface KmlContent {
  places: KmlPlace[];
  /** Lines, shapes and placemarks without a usable position. */
  skipped: number;
}

/** Why a file could not be read, worded for the user. */
export class KmlError extends Error {}

// ---------------------------------------------------------------- XML

interface XmlNode {
  tag: string;
  children: XmlNode[];
  text: string;
  /** Some of the text was CDATA, which My Maps uses for HTML descriptions. */
  cdata?: boolean;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: '\u00a0' };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });
}

/** Element names without a namespace prefix (kml:Placemark → Placemark). */
const local = (name: string) => name.slice(name.indexOf(':') + 1);

const TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s/>!?]+)(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>|([^<]+)/g;

/** A forgiving XML reader: elements and their text, nothing else. */
function parseXml(src: string): XmlNode {
  const root: XmlNode = { tag: '', children: [], text: '' };
  const stack = [root];
  for (const m of src.matchAll(TOKEN)) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) {
      top.text += m[1];
      top.cdata = true;
    } else if (m[2] !== undefined) {
      const tag = local(m[2]);
      let at = stack.length - 1;
      while (at > 0 && stack[at].tag !== tag) at--;
      if (at > 0) stack.length = at;
    } else if (m[3] !== undefined) {
      const node: XmlNode = { tag: local(m[3]), children: [], text: '' };
      top.children.push(node);
      if (!m[4]) stack.push(node);
    } else if (m[5] !== undefined) top.text += decode(m[5]);
  }
  return root;
}

const child = (n: XmlNode, tag: string) => n.children.find((c) => c.tag === tag);
const childText = (n: XmlNode, tag: string) => child(n, tag)?.text.trim() || undefined;

/** Description text: My Maps writes line breaks as <br>, and HTML descriptions as CDATA. */
function descriptionText(node: XmlNode | undefined): string {
  if (!node) return '';
  let s = node.text.replace(/<br\s*\/?>/gi, '\n');
  if (node.cdata) s = decode(s.replace(/<[^>]*>/g, ''));
  return s.replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

function position(placemark: XmlNode): LatLng | null {
  const point = child(placemark, 'Point');
  const first = point && childText(point, 'coordinates')?.split(/\s+/)[0];
  if (!first) return null;
  const [lng, lat] = first.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return gcjToWgs({ lat, lng });
}

/** The places (point placemarks) in a KML document, with the folder each is in. */
export function parseKml(text: string): KmlContent {
  const out: KmlContent = { places: [], skipped: 0 };
  const walk = (node: XmlNode, folder: string | undefined) => {
    for (const c of node.children) {
      if (c.tag === 'Placemark') {
        const at = position(c);
        if (!at) {
          out.skipped++;
          continue;
        }
        const description = descriptionText(child(c, 'description'));
        const name = (childText(c, 'name') ?? '').replace(/\s+/g, ' ');
        out.places.push({ name, at, folder, ...(description ? { description } : {}) });
      } else if (c.tag === 'Folder') walk(c, childText(c, 'name') ?? folder);
      else if (c.tag === 'kml' || c.tag === 'Document') walk(c, folder);
    }
  };
  walk(parseXml(text), undefined);
  return out;
}

// ---------------------------------------------------------------- KMZ

/** The KML inside a KMZ (zip) file: doc.kml, or else its first .kml file. */
export async function kmzToKml(data: ArrayBuffer): Promise<string> {
  const v = new DataView(data);
  let end = -1;
  for (let i = data.byteLength - 22; i >= Math.max(0, data.byteLength - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new KmlError('這個 KMZ 檔已損壞，無法讀取。');
  const entries: { name: string; method: number; size: number; offset: number }[] = [];
  let p = v.getUint32(end + 16, true);
  for (let n = v.getUint16(end + 10, true); n > 0; n--) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new KmlError('這個 KMZ 檔已損壞，無法讀取。');
    const nameLen = v.getUint16(p + 28, true);
    entries.push({
      name: new TextDecoder().decode(new Uint8Array(data, p + 46, nameLen)),
      method: v.getUint16(p + 10, true),
      size: v.getUint32(p + 20, true),
      offset: v.getUint32(p + 42, true),
    });
    p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  const e = entries.find((x) => x.name.toLowerCase() === 'doc.kml') ?? entries.find((x) => /\.kml$/i.test(x.name));
  if (!e) throw new KmlError('這個 KMZ 檔裡沒有 KML。');
  const start = e.offset + 30 + v.getUint16(e.offset + 26, true) + v.getUint16(e.offset + 28, true);
  const bytes = new Uint8Array(data, start, e.size);
  if (e.method === 0) return new TextDecoder().decode(bytes);
  if (e.method !== 8 || typeof DecompressionStream === 'undefined') {
    throw new KmlError('這台裝置無法讀取 KMZ。請在我的地圖匯出時勾選「匯出為 KML 而非 KMZ」，再選一次檔案。');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

/** Places in a KML or KMZ file (told apart by content, not by name). */
export async function readKmlFile(file: Blob): Promise<KmlContent> {
  const data = await file.arrayBuffer();
  const head = new Uint8Array(data, 0, Math.min(2, data.byteLength));
  const zip = head[0] === 0x50 && head[1] === 0x4b; // "PK"
  return parseKml(zip ? await kmzToKml(data) : new TextDecoder().decode(data));
}

// ---------------------------------------------------------------- what an import changes

/** Moves shorter than this are rounding, not the user dragging the place. */
const MOVED_KM = 0.005;
/** Pins with one name this close are one place (put in two layers). */
const SAME_PLACE_KM = 0.05;
/** A layer named after a later day is about something else ("D100"). */
const MAX_DAY = 60;

export interface PlaceAdd {
  key: string;
  name: string;
  category: Category;
  at: LatLng;
  note?: string;
}

export interface PlaceMove {
  spot: Spot;
  at: LatLng;
  /** How far it moved; undefined when the place had no position yet. */
  km?: number;
}

/** A place on a day: one of the trip's (by id), or one the import adds (by its key). */
export type DayStop = { spot: string } | { add: string };

export interface DayLayer {
  /** 0-based; may be past the trip's last day. */
  day: number;
  /** The layer's places, in its order. */
  stops: DayStop[];
}

export interface KmlImportPlan {
  add: PlaceAdd[];
  move: PlaceMove[];
  /** Places already where the file has them. */
  same: number;
  /** Located places of the trip the file does not have (perhaps deleted in My Maps). */
  absent: Spot[];
  /** Layers named after a day (第1天, Day 1, D1): the places that day should have, in order. */
  days: DayLayer[];
}

/** What the user chose in the preview. */
export interface ImportChoice {
  /** Additions (by key) and moves (by spot id) not to make. */
  skip: ReadonlySet<string>;
  /** Places missing from the file to delete. */
  remove: ReadonlySet<string>;
  /** Category picked for an addition, by key. */
  categories: Readonly<Record<string, Category>>;
  /** Day layers (0-based days) not to apply. */
  skipDays: ReadonlySet<number>;
}

const DIGITS = '一二三四五六七八九';

/** 1–99 in digits or Chinese numerals (三, 十二, 二十). */
function numberIn(s: string): number | undefined {
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^([一二三四五六七八九])?(十)?([一二三四五六七八九])?$/.exec(s);
  if (!m || !s) return undefined;
  if (!m[2]) return m[3] ? undefined : DIGITS.indexOf(m[1]!) + 1;
  return (m[1] ? DIGITS.indexOf(m[1]) + 1 : 1) * 10 + (m[3] ? DIGITS.indexOf(m[3]) + 1 : 0);
}

/** The day (0-based) a layer is named after: 第1天, 第一天, Day 1, D1, or a day's export 「上海-第1天」. */
export function dayOfLayer(name: string | undefined): number | undefined {
  if (!name) return undefined;
  const s = name.normalize('NFKC');
  const n =
    /第\s*([0-9]+|[一二三四五六七八九十]+)\s*[天日]/.exec(s)?.[1] ??
    /\bday\s*0*([0-9]+)(?![0-9])/i.exec(s)?.[1] ??
    /(?:^|[\s\-_/|·・,，、(（[【])d0*([0-9]+)(?![0-9a-z])/i.exec(s)?.[1];
  const day = n === undefined ? undefined : numberIn(n);
  return day && day <= MAX_DAY ? day - 1 : undefined;
}

/** The category a layer's name suggests (「早餐」, anything about eating, 「景點」). */
export function layerCategory(name: string | undefined): Category | undefined {
  const n = name?.toLowerCase() ?? '';
  if (/早餐|早午餐|breakfast|brunch/.test(n)) return 'breakfast';
  if (/餐|吃|食|麵|咖啡|甜點|甜点|restaurant|food|lunch|dinner|eat|cafe|café/.test(n)) return 'meal';
  if (/景點|景点|觀光|观光|sight|attraction/.test(n)) return 'sight';
  return undefined;
}

const byLabel = (label: string | undefined) => CATEGORIES.find((c) => CATEGORY_LABEL[c] === label?.trim());

/** Name, and the category its icon says (exported names start with 📍, 🥐 or 🍜). */
function splitName(raw: string): { name: string; category?: Category } {
  for (const c of CATEGORIES) {
    if (raw.startsWith(CATEGORY_ICON[c])) return { name: raw.slice(CATEGORY_ICON[c].length).trim(), category: c };
  }
  return { name: raw };
}

/**
 * Category and note from a description: an exported one reads 「景點 / 第1天 10/24（六） / 地址 / 備註」
 * (the dates have no spaces around their slash).
 */
function readDescription(text: string | undefined): { category?: Category; note?: string } {
  if (!text) return {};
  const parts = text.split(' / ');
  const category = byLabel(parts[0]);
  if (category && parts.length > 1 && /^(第\d+天|未排入)/.test(parts[1])) {
    const note = parts.slice(2).join(' / ').trim();
    return note ? { category, note } : { category };
  }
  return { note: text.slice(0, 500) };
}

/**
 * What importing a file into a trip would do. Places are matched to the trip's by name (ignoring
 * the icon, a 「1. 」 numbering from a day's export, spaces and traditional/simplified differences);
 * a place may be in several layers (days).
 */
export function planKmlImport(trip: TripSnapshot, content: KmlContent): KmlImportPlan {
  const byName = new Map<string, Spot[]>();
  for (const s of trip.spots) {
    const k = normName(s.name);
    byName.set(k, [...(byName.get(k) ?? []), s]);
  }
  const seen = new Set<string>();
  const away = (s: Spot, at: LatLng) => (hasCoords(s) ? distanceKm(s, at) : Infinity);
  /** The trip's place with this name: one not matched yet if there is one, the nearest of several. */
  const find = (name: string, at: LatLng) => {
    const list = byName.get(normName(name));
    if (!list?.length) return undefined;
    const fresh = list.filter((s) => !seen.has(s.id));
    return (fresh.length ? fresh : list).reduce((a, b) => (away(b, at) < away(a, at) ? b : a));
  };

  const plan: KmlImportPlan = { add: [], move: [], same: 0, absent: [], days: [] };
  const layers = new Map<number, DayStop[]>();
  content.places.forEach((p, i) => {
    const { name, category: iconCategory } = splitName(p.name);
    const day = dayOfLayer(p.folder);
    const numbered = /^\d+\.\s*(.+)$/.exec(name)?.[1];
    const spot = name ? (find(name, p.at) ?? (numbered ? find(numbered, p.at) : undefined)) : undefined;
    let stop: DayStop;
    if (spot) {
      if (!seen.has(spot.id)) {
        seen.add(spot.id);
        const km = hasCoords(spot) ? distanceKm(spot, p.at) : undefined;
        if (km !== undefined && km < MOVED_KM) plan.same++;
        else plan.move.push({ spot, at: p.at, ...(km !== undefined ? { km } : {}) });
      }
      stop = { spot: spot.id };
    } else {
      const label = (day !== undefined && numbered) || name || p.description?.split('\n')[0].slice(0, 40) || '未命名地點';
      const twin = plan.add.find((a) => normName(a.name) === normName(label) && distanceKm(a.at, p.at) < SAME_PLACE_KM);
      if (twin) stop = { add: twin.key };
      else {
        const desc = readDescription(p.description);
        plan.add.push({
          key: `a${i}`,
          name: label,
          category: iconCategory ?? desc.category ?? layerCategory(p.folder) ?? 'sight',
          at: p.at,
          ...(desc.note && desc.note !== label ? { note: desc.note } : {}),
        });
        stop = { add: `a${i}` };
      }
    }
    if (day !== undefined) layers.set(day, [...(layers.get(day) ?? []), stop]);
  });
  plan.absent = trip.spots.filter((s) => hasCoords(s) && !seen.has(s.id));
  plan.days = [...layers].sort(([a], [b]) => a - b).map(([day, stops]) => ({ day, stops }));
  return plan;
}

/** A day's items in a layer's order: existing items reused (with their times and notes), pinned ones left in place. */
function arrange(items: PlanItem[], ids: string[], pinned: (it: PlanItem) => boolean): PlanItem[] {
  const pool = new Map<string, PlanItem[]>();
  for (const it of items) if (!pinned(it)) pool.set(it.spotId, [...(pool.get(it.spotId) ?? []), it]);
  const out = ids.map((id) => pool.get(id)?.shift() ?? makeItem(id));
  items.forEach((it, i) => {
    if (pinned(it)) out.splice(Math.min(i, out.length), 0, it);
  });
  return out;
}

/**
 * The trip after an import, as chosen: positions updated, places added and deleted, and each day
 * layer's places on its day in the layer's order. A day keeps, where they were, the places that had
 * no position (they could not be on the map).
 */
export function applyKmlImport(trip: TripSnapshot, plan: KmlImportPlan, choice: ImportChoice): TripSnapshot {
  const moved = new Map(plan.move.filter((m) => !choice.skip.has(m.spot.id)).map((m) => [m.spot.id, m.at]));
  const spots: Spot[] = trip.spots
    .filter((s) => !choice.remove.has(s.id))
    .map((s) => {
      const at = moved.get(s.id);
      return at ? { ...s, lat: at.lat, lng: at.lng, geo: 'manual' as const } : s;
    });
  const added = new Map<string, string>();
  for (const a of plan.add) {
    if (choice.skip.has(a.key)) continue;
    const category = choice.categories[a.key] ?? a.category;
    const spot = makeSpot({ name: a.name, category, lat: a.at.lat, lng: a.at.lng, geo: 'manual', ...(a.note ? { note: a.note } : {}) }, spots);
    spots.push(spot);
    added.set(a.key, spot.id);
  }
  const kept = new Set(spots.map((s) => s.id));
  const mapped = new Set(trip.spots.filter(hasCoords).map((s) => s.id));
  const days = trip.days.map((d) => ({ ...d, items: d.items.filter((it) => kept.has(it.spotId)) }));
  for (const layer of plan.days) {
    if (choice.skipDays.has(layer.day)) continue;
    const ids = layer.stops.map((s) => ('spot' in s ? s.spot : added.get(s.add))).filter((id): id is string => !!id && kept.has(id));
    while (days.length <= layer.day) days.push(newDay());
    const d = days[layer.day];
    days[layer.day] = { ...d, items: arrange(d.items, ids, (it) => !mapped.has(it.spotId) && !ids.includes(it.spotId)) };
  }
  return { name: trip.name, destination: trip.destination, startDate: trip.startDate, spots, days };
}

export interface DayChange {
  day: number;
  /** Past the trip's last day: applying it adds days. */
  extra: boolean;
  /** The day's places afterwards, and whether each is new on that day. */
  stops: { name: string; added: boolean }[];
  /** Places taken off the day. */
  removed: string[];
}

/** How each day layer would change its day (days it would leave as they are are left out). */
export function dayChanges(trip: TripSnapshot, plan: KmlImportPlan, choice: ImportChoice): DayChange[] {
  const after = applyKmlImport(trip, plan, { ...choice, skipDays: new Set() });
  const names = new Map([...trip.spots, ...after.spots].map((s) => [s.id, s.name]));
  return plan.days.flatMap(({ day }) => {
    const before = trip.days[day]?.items.map((it) => it.spotId) ?? [];
    const now = after.days[day].items.map((it) => it.spotId);
    if (before.join() === now.join()) return [];
    return [
      {
        day,
        extra: day >= trip.days.length,
        stops: now.map((id) => ({ name: names.get(id) ?? '', added: !before.includes(id) })),
        removed: before.filter((id) => !now.includes(id)).map((id) => names.get(id) ?? ''),
      },
    ];
  });
}
