/* Lays out the itinerary on A4 pages as simple drawing operations (points, top-left origin).
 * Text width comes from `measure`, so the same layout is drawn on a canvas and tested in Node. */
import type { DayModel, DocModel, ItemModel, MapSpec } from './itinerary';

export const PAGE = { w: 595.28, h: 841.89, left: 40, right: 40, top: 44, bottom: 54 };
const CW = PAGE.w - PAGE.left - PAGE.right;
const BOTTOM = PAGE.h - PAGE.bottom;

export const COLORS = {
  text: '#1c1b19',
  body: '#3f3d38',
  muted: '#6b6860',
  accent: '#0f766e',
  soft: '#eef7f5',
  border: '#d9d6cf',
  white: '#ffffff',
};

export type Op =
  | { t: 'text'; x: number; y: number; text: string; size: number; weight: number; color: string }
  | { t: 'rect'; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; radius?: number }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; color: string; width: number; dash?: number[] }
  | { t: 'circle'; x: number; y: number; r: number; fill: string }
  | { t: 'map'; x: number; y: number; w: number; h: number; map: MapSpec }
  | { t: 'link'; x: number; y: number; w: number; h: number; url: string };

/** Width of `text` in points at `size` points. */
export type Measure = (text: string, size: number, weight: number) => number;

export interface LayoutOptions {
  newPagePerDay: boolean;
  mapHeight?: number;
}

// ------------------------------------------------------------------ text

const CJK = '\\u2e80-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef\\u3000-\\u303f\\uac00-\\ud7af';
const TOKEN = new RegExp(`\\s+|[^\\s${CJK}]+|.`, 'gsu');
// Never start a line with these (they stay with the text before them).
const NO_START = /^[，。、；：！？）」』》〉】,.;:!?)\]}%…・ー〜~]/;

/** Breaks text into lines no wider than `maxW`: between CJK characters, or between words. */
export function wrapText(text: string, maxW: number, size: number, weight: number, measure: Measure): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    const fits = (s: string) => measure(s, size, weight) <= maxW;
    const flush = () => {
      lines.push(line.trimEnd());
      line = '';
    };
    for (const tok of para.match(TOKEN) ?? []) {
      const space = /^\s+$/.test(tok);
      if (!line && space) continue;
      if (fits(line + tok) || (NO_START.test(tok) && line)) {
        line += tok;
        continue;
      }
      if (space) {
        flush();
        continue;
      }
      if (line) flush();
      if (fits(tok)) {
        line = tok;
        continue;
      }
      // One word wider than the line (a long URL): break it anywhere.
      for (const ch of tok) {
        if (line && !fits(line + ch)) flush();
        line += ch;
      }
    }
    if (line || !lines.length) flush();
  }
  return lines;
}

/** Shortens text with an ellipsis to fit `maxW`. */
export function fitText(text: string, maxW: number, size: number, weight: number, measure: Measure): string {
  if (measure(text, size, weight) <= maxW) return text;
  const chars = [...text];
  while (chars.length && measure(chars.join('') + '…', size, weight) > maxW) chars.pop();
  return chars.join('') + '…';
}

// ------------------------------------------------------------------ blocks

interface Block {
  h: number;
  draw(y: number): Op[];
  /** Empty space: dropped at the top of a page, never the reason for a new one. */
  spacer?: boolean;
}

interface Group {
  blocks: Block[];
  /** Move the whole group to the next page rather than splitting it. */
  keep?: boolean;
  newPage?: boolean;
}

const gap = (h: number): Block => ({ h, draw: () => [], spacer: true });

function textBlock(
  lines: string[],
  x: number,
  size: number,
  weight: number,
  color: string,
  measure: Measure,
  opts: { lineHeight?: number; url?: string; after?: number } = {},
): Block {
  const lh = opts.lineHeight ?? size * 1.45;
  return {
    h: lines.length * lh + (opts.after ?? 0),
    draw: (y) => {
      const ops: Op[] = lines.map((text, i) => ({ t: 'text', x, y: y + i * lh + size * 1.05, text, size, weight, color }));
      if (opts.url) {
        const w = Math.max(...lines.map((l) => measure(l, size, weight)));
        ops.push({ t: 'link', x, y, w, h: lines.length * lh, url: opts.url });
      }
      return ops;
    },
  };
}

// Item columns: number badge, time, then the place.
const BADGE_X = PAGE.left + 9;
const TIME_X = PAGE.left + 25;
const BODY_X = PAGE.left + 70;
const BODY_W = PAGE.left + CW - BODY_X;

function itemBlock(item: ItemModel, measure: Measure): Block {
  const nameLines = wrapText(`${item.icon} ${item.name}`, BODY_W, 12, 700, measure);
  const metaLines = item.meta ? wrapText(item.meta, BODY_W, 9, 400, measure) : [];
  const noteLines = item.notes.flatMap((n) => wrapText(n, BODY_W, 9, 400, measure));
  const name = textBlock(nameLines, BODY_X, 12, 700, COLORS.text, measure, { lineHeight: 16, url: item.url });
  const meta = textBlock(metaLines, BODY_X, 9, 400, COLORS.muted, measure, { lineHeight: 13 });
  const notes = textBlock(noteLines, BODY_X, 9, 400, COLORS.body, measure, { lineHeight: 13 });
  const h = Math.max(20, name.h + meta.h + (noteLines.length ? notes.h + 2 : 0)) + 4;
  return {
    h,
    draw: (y) => {
      const label = String(item.no);
      const ops: Op[] = [
        { t: 'circle', x: BADGE_X, y: y + 9, r: 9, fill: item.color },
        {
          t: 'text',
          x: BADGE_X - measure(label, 9, 700) / 2,
          y: y + 12.2,
          text: label,
          size: 9,
          weight: 700,
          color: COLORS.white,
        },
      ];
      if (item.time) ops.push({ t: 'text', x: TIME_X, y: y + 13, text: item.time, size: 11, weight: 700, color: COLORS.text });
      ops.push(...name.draw(y), ...meta.draw(y + name.h));
      if (noteLines.length) ops.push(...notes.draw(y + name.h + meta.h + 2));
      return ops;
    },
  };
}

function legBlock(item: ItemModel, measure: Measure): Block {
  const leg = item.leg;
  const h = leg ? 20 : 10;
  return {
    h,
    draw: (y) => {
      const ops: Op[] = [{ t: 'line', x1: BADGE_X, y1: y - 2, x2: BADGE_X, y2: y + h + 1, color: COLORS.border, width: 1.2, dash: [2, 2.5] }];
      if (leg) {
        const text = fitText(leg.url ? `${leg.text} · 路線 ↗` : leg.text, BODY_W, 8.5, 400, measure);
        ops.push({ t: 'text', x: BODY_X, y: y + 13, text, size: 8.5, weight: 400, color: COLORS.muted });
        if (leg.url) ops.push({ t: 'link', x: BODY_X, y: y + 3, w: measure(text, 8.5, 400), h: 14, url: leg.url });
      }
      return ops;
    },
  };
}

function dayGroups(day: DayModel, measure: Measure, opts: LayoutOptions): Group[] {
  const head: Block[] = [];
  const count = day.items.length ? `${day.items.length} 個地點` : '';
  head.push({
    h: 36,
    draw: (y) => {
      const ops: Op[] = [{ t: 'rect', x: PAGE.left, y, w: CW, h: 28, fill: COLORS.accent, radius: 6 }];
      const hx = PAGE.left + 12;
      ops.push({ t: 'text', x: hx, y: y + 19, text: day.heading, size: 13, weight: 700, color: COLORS.white });
      const countW = count ? measure(count, 9.5, 400) : 0;
      if (count) ops.push({ t: 'text', x: PAGE.left + CW - 12 - countW, y: y + 18.5, text: count, size: 9.5, weight: 400, color: COLORS.white });
      if (day.date) {
        const dx = hx + measure(day.heading, 13, 700) + 10;
        const room = PAGE.left + CW - 24 - countW - dx;
        ops.push({ t: 'text', x: dx, y: y + 18.5, text: fitText(day.date, room, 11, 400, measure), size: 11, weight: 400, color: COLORS.white });
      }
      return ops;
    },
  });
  if (day.title) head.push(textBlock(wrapText(day.title, CW, 12.5, 700, measure), PAGE.left, 12.5, 700, COLORS.text, measure, { lineHeight: 17, after: 6 }));
  if (day.map) {
    const mh = opts.mapHeight ?? 190;
    const map = day.map;
    head.push({ h: mh + 8, draw: (y) => [{ t: 'map', x: PAGE.left, y, w: CW, h: mh, map }] });
  }
  if (day.unlocated.length && day.items.length) {
    const note = `⚠️ 沒有座標，不在地圖上：${day.unlocated.join('、')}`;
    head.push(textBlock(wrapText(note, CW, 8.5, 400, measure), PAGE.left, 8.5, 400, COLORS.muted, measure, { lineHeight: 12, after: 6 }));
  }
  if (!day.items.length) {
    head.push(textBlock(['（這天還沒有行程）'], PAGE.left, 10, 400, COLORS.muted, measure, { after: 4 }));
    return [{ blocks: head, keep: true, newPage: opts.newPagePerDay }];
  }
  // The day's heading stays with its first stop.
  const groups: Group[] = [{ blocks: [...head, gap(4), itemBlock(day.items[0], measure)], keep: true, newPage: opts.newPagePerDay }];
  for (const item of day.items.slice(1)) groups.push({ blocks: [legBlock(item, measure), itemBlock(item, measure)], keep: true });
  return groups;
}

function titleGroups(doc: DocModel, measure: Measure): Group[] {
  const blocks: Block[] = [
    textBlock(wrapText(doc.title, CW, 22, 700, measure), PAGE.left, 22, 700, COLORS.text, measure, { lineHeight: 29 }),
  ];
  if (doc.subtitle) blocks.push(textBlock(wrapText(doc.subtitle, CW, 11, 400, measure), PAGE.left, 11, 400, COLORS.muted, measure, { lineHeight: 16 }));
  blocks.push(textBlock([doc.generated], PAGE.left, 8.5, 400, COLORS.muted, measure, { lineHeight: 13, after: 12 }));
  const groups: Group[] = [{ blocks, keep: true }];
  if (doc.overview.length) {
    const rows: Block[] = [textBlock(['行程總覽'], PAGE.left, 11, 700, COLORS.text, measure, { lineHeight: 18 })];
    for (const r of doc.overview) {
      rows.push({
        h: 18,
        draw: (y) => {
          const right = r.count ? `${r.count} 個地點` : '尚未安排';
          const rw = measure(right, 9, 400);
          const lw = measure(r.label, 10, 700);
          const ops: Op[] = [
            { t: 'line', x1: PAGE.left, y1: y, x2: PAGE.left + CW, y2: y, color: COLORS.border, width: 0.6 },
            { t: 'text', x: PAGE.left, y: y + 12.5, text: r.label, size: 10, weight: 700, color: COLORS.text },
            { t: 'text', x: PAGE.left + CW - rw, y: y + 12.5, text: right, size: 9, weight: 400, color: COLORS.muted },
          ];
          if (r.title) {
            const tx = PAGE.left + Math.max(lw + 12, 120);
            ops.push({ t: 'text', x: tx, y: y + 12.5, text: fitText(r.title, PAGE.left + CW - rw - 12 - tx, 10, 400, measure), size: 10, weight: 400, color: COLORS.body });
          }
          return ops;
        },
      });
    }
    rows.push(gap(14));
    groups.push({ blocks: rows });
  }
  return groups;
}

/** Pages of drawing operations, with page numbers in the footer. */
export function layoutDoc(doc: DocModel, measure: Measure, opts: LayoutOptions): Op[][] {
  const groups: Group[] = [...titleGroups(doc, measure)];
  doc.days.forEach((day, i) => {
    const gs = dayGroups(day, measure, opts);
    if (i === 0) gs[0].newPage = false;
    groups.push(...gs);
    groups.push({ blocks: [gap(14)] });
  });

  const pages: Op[][] = [[]];
  let y = PAGE.top;
  const newPage = () => {
    pages.push([]);
    y = PAGE.top;
  };
  for (const g of groups) {
    if (g.newPage && y > PAGE.top) newPage();
    const total = g.blocks.reduce((s, b) => s + b.h, 0);
    if (g.keep && y > PAGE.top && y + total > BOTTOM && total <= BOTTOM - PAGE.top) newPage();
    for (const b of g.blocks) {
      if (b.spacer) {
        if (y > PAGE.top) y = Math.min(y + b.h, BOTTOM);
        continue;
      }
      if (y > PAGE.top && y + b.h > BOTTOM) newPage();
      pages[pages.length - 1].push(...b.draw(y));
      y += b.h;
    }
  }
  while (pages.length > 1 && !pages[pages.length - 1].length) pages.pop();

  pages.forEach((ops, i) => {
    const fy = PAGE.h - 28;
    const num = `${i + 1} / ${pages.length}`;
    ops.push(
      { t: 'line', x1: PAGE.left, y1: fy - 12, x2: PAGE.left + CW, y2: fy - 12, color: COLORS.border, width: 0.6 },
      { t: 'text', x: PAGE.left, y: fy, text: fitText(doc.title, CW - 80, 8, 400, measure), size: 8, weight: 400, color: COLORS.muted },
      { t: 'text', x: PAGE.left + CW - measure(num, 8, 400), y: fy, text: num, size: 8, weight: 400, color: COLORS.muted },
    );
  });
  return pages;
}
