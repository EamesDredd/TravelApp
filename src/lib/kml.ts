/* Reading places back from a KML or KMZ file, such as a map exported from Google My Maps. */
import type { Category, LatLng, Spot, TripSnapshot } from '../types';
import { CATEGORY_ICON, CATEGORY_LABEL } from '../types';
import { distanceKm, gcjToWgs, hasCoords } from './geo';
import { normName } from './placeMatch';
import { CATEGORIES } from './tripOps';

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

export interface KmlImportPlan {
  add: PlaceAdd[];
  move: PlaceMove[];
  /** Places already where the file has them. */
  same: number;
  /** Located places of the trip the file does not have (perhaps deleted in My Maps). */
  absent: Spot[];
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
 * the icon, a 「1. 」 numbering from a day's export, spaces and traditional/simplified differences).
 */
export function planKmlImport(trip: TripSnapshot, content: KmlContent): KmlImportPlan {
  const unclaimed = new Map<string, Spot[]>();
  for (const s of trip.spots) {
    const k = normName(s.name);
    unclaimed.set(k, [...(unclaimed.get(k) ?? []), s]);
  }
  const claim = (name: string) => {
    const list = unclaimed.get(normName(name));
    return list?.length ? list.shift() : undefined;
  };

  const plan: KmlImportPlan = { add: [], move: [], same: 0, absent: [] };
  const claimed = new Set<string>();
  content.places.forEach((p, i) => {
    const { name, category: iconCategory } = splitName(p.name);
    const numbered = /^\d+\.\s*(.+)$/.exec(name)?.[1];
    const spot = name ? (claim(name) ?? (numbered ? claim(numbered) : undefined)) : undefined;
    if (spot) {
      claimed.add(spot.id);
      const km = hasCoords(spot) ? distanceKm(spot, p.at) : undefined;
      if (km !== undefined && km < MOVED_KM) plan.same++;
      else plan.move.push({ spot, at: p.at, ...(km !== undefined ? { km } : {}) });
      return;
    }
    const label = name || p.description?.split('\n')[0].slice(0, 40) || '未命名地點';
    // The same place twice in the file (two layers, or exported twice): keep one.
    if (plan.add.some((a) => normName(a.name) === normName(label) && distanceKm(a.at, p.at) < MOVED_KM)) return;
    const desc = readDescription(p.description);
    plan.add.push({
      key: `a${i}`,
      name: label,
      category: iconCategory ?? desc.category ?? byLabel(p.folder) ?? 'sight',
      at: p.at,
      ...(desc.note && desc.note !== label ? { note: desc.note } : {}),
    });
  });
  plan.absent = trip.spots.filter((s) => hasCoords(s) && !claimed.has(s.id));
  return plan;
}
