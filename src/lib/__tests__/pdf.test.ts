import { describe, expect, it } from 'vitest';
import { buildItinerary } from '../pdf/itinerary';
import { fitText, layoutDoc, PAGE, wrapText, type Measure, type Op } from '../pdf/layout';
import { planMap } from '../pdf/mapPlan';
import { buildPdf } from '../pdf/writer';
import type { Spot, Trip } from '../../types';

/** CJK and emoji are square, everything else half as wide. */
const measure: Measure = (text, size) => [...text].reduce((w, ch) => w + (/[\x00-\x7f]/.test(ch) ? size * 0.5 : size), 0);

const SPOTS: Spot[] = [
  { id: 's_yang', name: '小楊生煎', category: 'breakfast', lat: 31.2286, lng: 121.4802 },
  { id: 's_pearl', name: '東方明珠廣播電視塔', category: 'sight', lat: 31.2397, lng: 121.4998, note: '建議傍晚上塔' },
  { id: 's_maglev', name: '磁浮列車 龍陽路站', category: 'sight' },
  { id: 's_pvg', name: '浦東國際機場', category: 'sight', lat: 31.1443, lng: 121.8083, address: '上海市浦東新區' },
  { id: 's_kiyo', name: '清水寺', category: 'sight', lat: 34.9949, lng: 135.785 },
];

function trip(extra: Partial<Trip> = {}): Trip {
  return {
    id: 't1',
    name: '上海五日遊',
    destination: '上海',
    startDate: '2026-10-24',
    days: [
      { id: 'd1', title: '外灘與浦東', items: [
        { id: 'i1', spotId: 's_yang', time: '08:30' },
        { id: 'i2', spotId: 's_pearl', time: '10:00', note: '先買票' },
        { id: 'i3', spotId: 's_maglev' },
        { id: 'i4', spotId: 's_pvg', time: '15:00' },
      ] },
      { id: 'd2', items: [] },
    ],
    spots: SPOTS,
    mapRegion: 'auto',
    chat: [],
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  };
}

const texts = (ops: Op[]) => ops.filter((o): o is Extract<Op, { t: 'text' }> => o.t === 'text').map((o) => o.text);

describe('wrapText', () => {
  it('breaks Chinese anywhere and keeps closing punctuation on the line', () => {
    expect(wrapText('一二三四五六', 40, 10, 400, measure)).toEqual(['一二三四', '五六']);
    expect(wrapText('一二三四。五六', 40, 10, 400, measure)).toEqual(['一二三四。', '五六']);
  });
  it('breaks between words, and breaks a word longer than the line', () => {
    expect(wrapText('hello big world', 40, 10, 400, measure)).toEqual(['hello', 'big', 'world']);
    expect(wrapText('https://example.com/abc', 40, 10, 400, measure)).toEqual(['https://', 'example.', 'com/abc']);
  });
  it('keeps explicit line breaks and empty text', () => {
    expect(wrapText('甲\n乙', 100, 10, 400, measure)).toEqual(['甲', '乙']);
    expect(wrapText('', 100, 10, 400, measure)).toEqual(['']);
  });
  it('shortens with an ellipsis', () => {
    expect(fitText('一二三四五六', 40, 10, 400, measure)).toBe('一二三…');
    expect(fitText('一二', 40, 10, 400, measure)).toBe('一二');
  });
});

describe('buildItinerary', () => {
  const now = new Date(2026, 9, 15, 9, 5);

  it('describes the trip, each stop and the way between stops', () => {
    const doc = buildItinerary(trip(), { days: [0, 1], maps: true, newPagePerDay: false }, now);
    expect(doc.title).toBe('上海五日遊');
    expect(doc.subtitle).toBe('上海 · 2026/10/24（六） – 10/25（日） · 2 天');
    expect(doc.generated).toBe('匯出於 2026/10/15 09:05');
    expect(doc.overview).toEqual([
      { label: '第 1 天 10/24（六）', title: '外灘與浦東', count: 4 },
      { label: '第 2 天 10/25（日）', count: 0 },
    ]);
    const [d1] = doc.days;
    expect(d1.items.map((i) => [i.no, i.time ?? '', i.name])).toEqual([
      [1, '08:30', '小楊生煎'],
      [2, '10:00', '東方明珠廣播電視塔'],
      [3, '', '磁浮列車 龍陽路站'],
      [4, '15:00', '浦東國際機場'],
    ]);
    expect(d1.items[1].notes).toEqual(['📝 先買票', '建議傍晚上塔']);
    expect(d1.items[3].meta).toBe('景點 · 上海市浦東新區');
    // Mainland China: Amap links; no leg to or from a place without coordinates.
    expect(d1.items[0].url).toContain('uri.amap.com/marker');
    expect(d1.items[1].leg?.text).toMatch(/^🚶 2\.\d km|^🚇/);
    expect(d1.items[1].leg?.url).toContain('uri.amap.com/navigation');
    expect(d1.items[2].leg).toBeUndefined();
    expect(d1.items[3].leg).toBeUndefined();
    expect(d1.map?.region).toBe('cn');
    expect(d1.map?.pins.map((p) => p.label)).toEqual(['1', '2', '4']);
    expect(d1.unlocated).toEqual(['磁浮列車 龍陽路站']);
    expect(doc.days[1].items).toEqual([]);
    expect(doc.days[1].map).toBeUndefined();
  });

  it('a single day, without maps', () => {
    const doc = buildItinerary(trip(), { days: [0], maps: false, newPagePerDay: false }, now);
    expect(doc.subtitle).toBe('上海 · 第 1 天 · 2026/10/24（六）');
    expect(doc.overview).toEqual([]);
    expect(doc.days[0].map).toBeUndefined();
  });

  it('uses Google Maps outside mainland China', () => {
    const t = trip({ name: '京都', destination: '京都', days: [{ id: 'd1', items: [{ id: 'a', spotId: 's_kiyo' }] }] });
    const doc = buildItinerary(t, { days: [0], maps: true, newPagePerDay: false }, now);
    expect(doc.subtitle).toBe('第 1 天 · 2026/10/24（六）');
    expect(doc.days[0].items[0].url).toContain('google.com/maps/search');
    expect(doc.days[0].map?.region).toBe('intl');
  });
});

describe('layoutDoc', () => {
  const doc = buildItinerary(trip(), { days: [0, 1], maps: true, newPagePerDay: false }, new Date(2026, 9, 15));

  it('lays out the title, days, stops, links and page numbers', () => {
    const pages = layoutDoc(doc, measure, { newPagePerDay: false });
    expect(pages).toHaveLength(1);
    const t = texts(pages[0]);
    for (const s of ['上海五日遊', '行程總覽', '第 1 天', '10/24（六）', '外灘與浦東', '08:30', '🥐 小楊生煎', '📝 先買票', '1 / 1', '（這天還沒有行程）']) {
      expect(t, s).toContain(s);
    }
    expect(t.some((x) => x.startsWith('⚠️ 沒有座標'))).toBe(true);
    expect(pages[0].filter((o) => o.t === 'map')).toHaveLength(1);
    const links = pages[0].filter((o): o is Extract<Op, { t: 'link' }> => o.t === 'link');
    expect(links.map((l) => l.url).filter((u) => u.includes('/marker'))).toHaveLength(3);
    expect(links.some((l) => l.url.includes('/navigation'))).toBe(true);
    // Everything stays inside the printable area.
    for (const o of pages[0]) {
      if (o.t === 'text') {
        expect(o.x).toBeGreaterThanOrEqual(PAGE.left - 0.01);
        expect(o.x + measure(o.text, o.size, o.weight)).toBeLessThanOrEqual(PAGE.w - PAGE.right + 0.01);
        expect(o.y).toBeLessThanOrEqual(PAGE.h);
      }
    }
  });

  it('flows onto more pages, keeps a day heading with its first stop, and can start each day on a new page', () => {
    const many = trip({
      days: Array.from({ length: 4 }, (_, d) => ({
        id: `d${d}`,
        items: Array.from({ length: 9 }, (_, i) => ({ id: `i${d}-${i}`, spotId: SPOTS[i % 4].id, time: `${10 + (i % 10)}:00` })),
      })),
    });
    const big = buildItinerary(many, { days: [0, 1, 2, 3], maps: true, newPagePerDay: false });
    const pages = layoutDoc(big, measure, { newPagePerDay: false });
    expect(pages.length).toBeGreaterThan(2);
    pages.forEach((ops, i) => expect(texts(ops)).toContain(`${i + 1} / ${pages.length}`));
    for (const ops of pages) {
      const t = texts(ops);
      const heads = t.filter((x) => /^第 \d 天$/.test(x));
      // A heading on a page always has its map and first stop on the same page.
      for (const h of heads) expect(t.indexOf(h)).toBeLessThan(t.lastIndexOf('🥐 小楊生煎'));
      for (const o of ops) if (o.t !== 'text' && o.t !== 'line' && 'y' in o) expect(o.y + ('h' in o ? o.h : 0)).toBeLessThanOrEqual(PAGE.h - PAGE.bottom + 0.01);
    }
    const perDay = layoutDoc(big, measure, { newPagePerDay: true });
    const starts = perDay.map((ops) => texts(ops).find((x) => /^第 \d 天$/.test(x)));
    expect(starts.filter(Boolean)).toEqual(['第 1 天', '第 2 天', '第 3 天', '第 4 天']);
  });
});

describe('planMap', () => {
  const pts = SPOTS.filter((s) => s.lat !== undefined && s.id !== 's_kiyo').map((s) => ({ lat: s.lat!, lng: s.lng! }));

  it('fits every place inside the picture with room to spare, covered by tiles', () => {
    const W = 1500;
    const H = 560;
    const plan = planMap(pts, 'cn', W, H, { tileScale: 2, pad: 60 });
    for (const p of pts) {
      const q = plan.project(p);
      expect(q.x).toBeGreaterThanOrEqual(60 - 0.5);
      expect(q.x).toBeLessThanOrEqual(W - 60 + 0.5);
      expect(q.y).toBeGreaterThanOrEqual(60 - 0.5);
      expect(q.y).toBeLessThanOrEqual(H - 60 + 0.5);
    }
    expect(plan.tiles[0].url).toContain('autonavi.com');
    expect(plan.attribution).toBe('© 高德地圖');
    const covers = (x: number, y: number) => plan.tiles.some((t) => t.dx <= x && x < t.dx + t.size && t.dy <= y && y < t.dy + t.size);
    for (const [x, y] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1], [W / 2, H / 2]]) expect(covers(x, y)).toBe(true);
    expect(plan.tiles.length).toBeLessThanOrEqual(12);
  });

  it('zooms in on a single place and uses OpenStreetMap elsewhere', () => {
    const plan = planMap([{ lat: 34.9949, lng: 135.785 }], 'intl', 800, 300);
    expect(plan.zoom).toBe(15);
    expect(plan.tiles[0].url).toMatch(/^https:\/\/tile\.openstreetmap\.org\/15\//);
    const c = plan.project({ lat: 34.9949, lng: 135.785 });
    expect(Math.round(c.x)).toBe(400);
    expect(Math.round(c.y)).toBe(150);
  });
});

describe('buildPdf', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const pdf = buildPdf(
    [
      { jpeg, pxWidth: 10, pxHeight: 14, links: [{ x: 40, y: 100, w: 80, h: 16, url: 'https://example.com/a(b)?q=上海' }] },
      { jpeg, pxWidth: 10, pxHeight: 14, links: [] },
    ],
    { title: '上海 Trip', width: 595.28, height: 841.89, created: new Date(Date.UTC(2026, 9, 15, 1, 2, 3)) },
  );
  const text = new TextDecoder('latin1').decode(pdf);

  it('has a valid cross-reference table', () => {
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    const startxref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
    const entries = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(entries.length).toBe(Number(/\/Size (\d+)/.exec(text)![1]) - 1);
    entries.forEach((off, i) => expect(text.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    expect(text).toContain('/Count 2');
  });

  it('stores the title as UTF-16 and links as 7-bit URIs in PDF coordinates', () => {
    expect(text).toContain('/Title <FEFF4E0A6D7700200054007200690070>');
    expect(text).toContain('/CreationDate (D:20261015010203Z)');
    expect(text).toContain('/URI (https://example.com/a\\(b\\)?q=%E4%B8%8A%E6%B5%B7)');
    expect(text).toContain('/Rect [40 725.89 120 741.89]');
    expect(text).toContain('/Width 10 /Height 14');
  });
});
