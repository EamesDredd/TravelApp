/* Deciding which map search result is the place a trip means, without asking the user.
 * Pure functions: the background locator (autoLocate.ts) does the searching. */
import { distanceKm } from './geo';
import { toSimplified } from './t2s';
import type { LatLng } from '../types';

const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/;

/** Comparable form of a name: simplified Chinese, NFKC, lower case, no spaces, punctuation or symbols. */
export function normName(s: string): string {
  return toSimplified(s.normalize('NFKC'))
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

// Words that describe an activity rather than a place (compared in normName form).
const ACTIVITY = [
  '自由活动', '自由行', '早午餐', '下午茶', '回酒店', '回饭店', '回民宿', '回住宿', 'checkin', 'checkout',
  '早餐', '午餐', '晚餐', '宵夜', '夜宵', '用餐', '吃饭', 'breakfast', 'lunch', 'dinner',
  '休息', '午休', '机动', '弹性', '待定', '自理', '自行', '随意', '附近', '周边', '一带',
  '购物', '逛街', '散步', '集合', '出发', '抵达', '到达', '返回', '回程', '回家', '入住', '退房',
  '交通', '移动', '前往', '接机', '送机', '登机', '航班', '寄放', '行李',
].sort((a, b) => b.length - a.length);

// Kinds of place that alone name no particular place ("飯店", "機場").
const BARE_KIND = ['饭店', '酒店', '旅馆', '宾馆', '民宿', '住宿', '餐厅', '机场', '车站', '飞机', 'hotel', 'hostel', 'airbnb'];

// Names in other scripts are generic when made only of these words ("Free time", "Check-in").
const LATIN_GENERIC = new Set([
  'free', 'time', 'rest', 'break', 'hotel', 'hostel', 'airbnb', 'check', 'in', 'out', 'checkin', 'checkout',
  'breakfast', 'brunch', 'lunch', 'dinner', 'meal', 'airport', 'station', 'shopping', 'transfer', 'leisure',
  'back', 'to', 'the', 'at', 'and', 'tbd', 'nearby',
]);

const FILLER = /[的去到在及和与或找吃逛看买住回往]/g;

const strip = (s: string, words: string[]) => words.reduce((acc, w) => acc.split(w).join(''), s);

/** What is left of a name once activity words are removed ("晚餐：南翔饅頭店" → "南翔馒头店"). */
export function specificPart(name: string): string {
  return strip(normName(name), ACTIVITY);
}

/**
 * Names that are not a findable place: "飯店", "午餐（附近找）", "自由活動", "Check-in".
 * Searching for them would just pick some random hotel or restaurant nearby.
 */
export function isGenericName(name: string): boolean {
  if (!CJK.test(name)) {
    const words = name.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return words.every((w) => LATIN_GENERIC.has(w));
  }
  const rest = strip(specificPart(name), BARE_KIND).replace(FILLER, '').replace(/\d+/g, '');
  return CJK.test(rest) ? rest.length < 2 : rest.length < 3;
}

/**
 * Search queries to try, most specific first, at most `max`:
 * "磁浮列車 龍陽路站" → the full name, then "龍陽路站", then "龍陽路" (map data often leaves out 站).
 */
export function queryVariants(name: string, max = 3): string[] {
  const out: string[] = [];
  const add = (q: string) => {
    const t = q.replace(/\s+/g, ' ').trim();
    if (normName(t).length < 2) return;
    if (!out.some((o) => normName(o) === normName(t))) out.push(t);
  };
  const base = name.normalize('NFKC').replace(/\s+/g, ' ').trim();
  add(base);
  const noParen = base.replace(/[(（【[「『][^)）】\]」』]*[)）】\]」』]/g, ' ').trim();
  add(noParen);
  if (CJK.test(noParen)) {
    // "磁浮列車 龍陽路站", "晚餐：南翔饅頭店": the last part names the actual place.
    const parts = noParen.split(/[\s:：・·|｜/、,，]+/).filter((p) => normName(p).length >= 2);
    const last = parts[parts.length - 1];
    if (last) {
      add(last);
      const noStation = last.replace(/(站|駅|車站|车站)$/, '');
      if (noStation !== last) add(noStation);
    }
    const rest = specificPart(noParen);
    if (rest && rest !== normName(noParen)) add(rest);
  }
  return out.slice(0, max);
}

function bigrams(s: string): string[] {
  const chars = [...s];
  if (chars.length < 2) return chars;
  return chars.slice(1).map((c, i) => chars[i] + c);
}

function dice(a: string, b: string): number {
  const x = bigrams(a);
  const pool = bigrams(b);
  const total = x.length + pool.length;
  let common = 0;
  for (const g of x) {
    const i = pool.indexOf(g);
    if (i >= 0) {
      common++;
      pool.splice(i, 1);
    }
  }
  return total ? (2 * common) / total : 0;
}

// Kinds of place at the end of a name. Two different airports share "国际机场", so names are
// compared without them: 浦东国际机场 → 浦东, 虹桥国际机场 → 虹桥.
const KIND_SUFFIXES = [
  '国际机场', '机场', '火车站', '高铁站', '地铁站', '汽车站', '车站', '站', '駅',
  '大酒店', '酒店', '饭店', '宾馆', '公园', '广场', '博物馆', '美术馆', '纪念馆', '大学',
  '寺', '庙', '宫', '塔', '大桥', '桥', '路', '街', '店', '餐厅', '餐馆', '中心', '大厦', '商场', '市场',
  '风景区', '景区', '国际', 'international', 'airport', 'station', 'hotel', 'park', 'museum',
].sort((a, b) => b.length - a.length);

function core(n: string): string {
  let s = n;
  for (let again = true; again; ) {
    again = false;
    for (const w of KIND_SUFFIXES) {
      if (s.endsWith(w) && [...s].length - [...w].length >= 2) {
        s = s.slice(0, -w.length);
        again = true;
        break;
      }
    }
  }
  return s;
}

/**
 * 0–1: how well one of `names` matches `query`. The same name is 1; one containing the other
 * (上海浦东国际机场 / 浦东国际机场, 东方明珠 / 东方明珠广播电视塔) is 0.9; otherwise the overlap of
 * the distinctive parts, so 浦东国际机场 and 虹桥国际机场 do not match.
 */
export function nameScore(query: string, names: string[]): number {
  const q = normName(query);
  if (!q) return 0;
  const qc = core(q);
  let best = 0;
  for (const n of names) {
    const c = normName(n);
    if (!c) continue;
    if (c === q) return 1;
    const cc = core(c);
    if (cc === qc) return 1;
    const short = Math.min([...qc].length, [...cc].length);
    if (short >= 2 && (cc.includes(qc) || qc.includes(cc))) best = Math.max(best, 0.9);
    else best = Math.max(best, dice(qc, cc));
  }
  return best;
}

export interface Candidate extends LatLng {
  name: string;
  /** Other names the place goes by (local, Chinese, English…). */
  names?: string[];
  /** Kind of place, e.g. "railway:station" or Amap's "交通设施服务;地铁站". */
  kind?: string;
}

/** How far from the rest of the trip a match may be. */
export const MAX_KM_FROM_TRIP = 300;
export const MIN_NAME_SCORE = 0.5;

const STATION = /(站|駅|station)$/i;
const STATION_KIND = /railway|station|public_transport|subway|地铁|火车|轻轨|磁浮|车站|機場|机场|aerodrome/i;

/**
 * Picks the result that is the place: its name must match the spot's name (or the query
 * variant that found it), and it must be within reach of the trip's other places.
 */
export function pickPlace<T extends Candidate>(
  results: T[],
  spotName: string,
  query: string,
  anchors: LatLng[],
): T | null {
  let best: { r: T; score: number } | null = null;
  for (const r of results) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lng)) continue;
    const names = [r.name, ...(r.names ?? [])];
    const full = nameScore(spotName, names);
    const part = nameScore(query, names);
    if (Math.max(full, part) < MIN_NAME_SCORE) continue;
    // A result matching the whole name (the right branch of a chain) beats one matching a part.
    const sim = 0.6 * full + 0.4 * part;
    const km = anchors.length ? Math.min(...anchors.map((a) => distanceKm(a, r))) : 0;
    if (km > MAX_KM_FROM_TRIP) continue;
    const wantsStation = STATION.test(spotName.trim()) || STATION.test(query.trim());
    const stationBonus = wantsStation && r.kind && STATION_KIND.test(r.kind) ? 0.2 : 0;
    const score = sim + stationBonus - Math.min(km, MAX_KM_FROM_TRIP) / 3000;
    if (!best || score > best.score) best = { r, score };
  }
  return best?.r ?? null;
}

/** Centre of the places (for biasing a search towards the trip). */
export function centroid(points: LatLng[]): LatLng | undefined {
  if (!points.length) return undefined;
  return {
    lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
    lng: points.reduce((s, p) => s + p.lng, 0) / points.length,
  };
}
