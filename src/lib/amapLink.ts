/* Reading a place out of what the Amap app shares: a link, or the text 「复制链接」 copies. */
import type { LatLng } from '../types';
import { gcjToWgs } from './geo';

export interface AmapShare {
  name?: string;
  address?: string;
  /** WGS-84, when the link carries the place's position. */
  at?: LatLng;
  /** A surl.amap.com short link. It hides the position, and a web page cannot follow it to find out. */
  shortUrl?: string;
}

const URL_RE = /(?:https?|iosamap|androidamap|amapuri):\/\/[^\s<>"'，。、）)】]+/gi;
const AMAP_HOST = /(^|\.)(amap\.com|autonavi\.com)$/i;
const NUM = /^-?\d{1,3}(\.\d+)?$/;

/** Mainland China lies roughly within these, so the smaller number of a pair is the latitude. */
const isLat = (n: number) => n >= 3 && n <= 54;
const isLng = (n: number) => n >= 73 && n <= 136;

/** The first two neighbouring numbers that make a position, in either order. */
function pairIn(parts: string[]): { at: LatLng; end: number } | null {
  for (let i = 0; i + 1 < parts.length; i++) {
    if (!NUM.test(parts[i].trim()) || !NUM.test(parts[i + 1].trim())) continue;
    const a = Number(parts[i]);
    const b = Number(parts[i + 1]);
    if (isLat(a) && isLng(b)) return { at: { lat: a, lng: b }, end: i + 2 };
    if (isLng(a) && isLat(b)) return { at: { lat: b, lng: a }, end: i + 2 };
  }
  return null;
}

const clean = (s: string | null | undefined) => {
  const t = s?.trim();
  return t ? t : undefined;
};

/** Position, name and address from one Amap link (empty when it has none); null for other links. */
function fromUrl(raw: string): AmapShare | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const app = /^(iosamap|androidamap|amapuri):$/i.test(u.protocol);
  if (!app && !AMAP_HOST.test(u.hostname)) return null;
  if (/^surl\.amap\.com$/i.test(u.hostname)) return { shortUrl: raw };

  const q = u.searchParams;
  const out: AmapShare = {};
  // m.amap.com/poi/detail?__p=<id>,<lat>,<lng>,<name>,<address> (also p=…), and the URI API's
  // position= / location= / to= ("<lng>,<lat>[,<name>]").
  for (const key of ['__p', 'p', 'position', 'location', 'lnglat', 'q', 'to', 'dest']) {
    const v = q.get(key);
    if (!v) continue;
    const parts = v.split(',');
    const found = pairIn(parts);
    if (!found) continue;
    out.at = found.at;
    const rest = parts.slice(found.end).map((s) => s.trim());
    out.name = clean(rest[0]);
    out.address = clean(rest.slice(1).join(','));
    break;
  }
  if (!out.at) {
    const lat = Number(q.get('lat') ?? q.get('dlat'));
    const lng = Number(q.get('lon') ?? q.get('lng') ?? q.get('dlon'));
    if (isLat(lat) && isLng(lng)) out.at = { lat, lng };
  }
  out.name ??= clean(q.get('name') ?? q.get('poiname') ?? q.get('dname'));
  out.address ??= clean(q.get('address') ?? q.get('addr'));
  if (out.at) {
    // Amap uses GCJ-02 unless the link says the position is plain GPS (WGS-84).
    const wgs = q.get('coordinate') === 'wgs84' || (app && q.get('dev') === '1');
    out.at = wgs ? out.at : gcjToWgs(out.at);
  }
  return out;
}

/** Things in shared text that are not the place's name or address. */
const NOISE = /^(【[^】]*】|我在高德地图|高德地图|分享|推荐)[：:\s]*/;
const ADDRESS_LIKE = /(路|街|道|号|號|巷|弄|区|區|县|縣|镇|鎮|乡|鄉|村|大厦|大廈|广场|廣場|中心|楼|樓|层|層|室|市|省|站)/;

/** Name and address from the lines of text around the link. */
function fromText(text: string): Pick<AmapShare, 'name' | 'address'> {
  const lines = text
    .replace(URL_RE, '\n')
    .split(/\r?\n/)
    .map((l) => l.replace(NOISE, '').trim())
    .filter(Boolean);
  let name: string | undefined;
  let address: string | undefined;
  for (const line of lines) {
    const m = /^(.*?)\s*地址[：:]\s*(.+)$/.exec(line);
    if (m) {
      name ??= clean(m[1]);
      address ??= clean(m[2]);
    }
  }
  name ??= lines[0];
  if (!address) address = [...lines.slice(1)].reverse().find((l) => l !== name && ADDRESS_LIKE.test(l));
  return { name, address };
}

/**
 * Reads a place shared from the Amap app: its link (m.amap.com/…, uri.amap.com/…) or the text
 * 「复制链接」 copies (name, kind, address and a surl.amap.com short link). Null when the text has
 * no Amap link.
 */
export function parseAmapShare(text: string): AmapShare | null {
  const urls = text.match(URL_RE) ?? [];
  const found = urls.map(fromUrl).filter((x): x is AmapShare => !!x);
  if (!found.length) return null;
  const withAt = found.find((f) => f.at);
  const short = found.find((f) => f.shortUrl)?.shortUrl;
  const words = fromText(text);
  return {
    name: withAt?.name ?? words.name,
    address: withAt?.address ?? words.address,
    ...(withAt?.at ? { at: withAt.at } : {}),
    ...(!withAt?.at && short ? { shortUrl: short } : {}),
  };
}

/** The road (路、街、大道…) in a Chinese address, to show the area when the exact place is unknown. */
export function roadOf(address: string): string | undefined {
  // Drop the district / subdistrict in front: 「曹杨新村街道武宁路501号」 → 「武宁路501号」.
  const tail = address.split(/(?:省|市|区|區|县|縣|街道|镇|鎮|乡|鄉)/).pop() ?? address;
  return /^([㐀-鿿\w]{1,10}?(?:大道|路|街|巷|弄))/.exec(tail.trim())?.[1];
}
