/* Draws the laid-out pages on canvases (the device's own fonts, so Chinese and emoji just
 * work) and packs them into a PDF. Browser only. */
import type { DocModel, MapSpec } from './itinerary';
import { COLORS, layoutDoc, PAGE, type Measure, type Op } from './layout';
import { planMap } from './mapPlan';
import { buildPdf, type PdfLink, type PdfPage } from './writer';

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "PingFang TC", "Noto Sans TC", "Noto Sans CJK TC", "Microsoft JhengHei", ' +
  '"Segoe UI", Roboto, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
const font = (size: number, weight: number) => `${weight} ${size}px ${FONT_STACK}`;

/** Canvas pixels per PDF point (216 dpi: sharp on screen and fine for printing). */
const SCALE = 3;
const JPEG_QUALITY = 0.86;
const TILE_TIMEOUT_MS = 8000;

export type Progress = (message: string) => void;

function abortIf(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ------------------------------------------------------------------ map pictures

const tileCache = new Map<string, Promise<HTMLImageElement | null>>();

/** Loads a map tile for drawing on a canvas; null when it cannot be had (offline, no CORS, slow). */
function loadTile(url: string): Promise<HTMLImageElement | null> {
  let p = tileCache.get(url);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous'; // a tile without CORS fails to load instead of tainting the canvas
      const timer = setTimeout(() => {
        img.src = '';
        resolve(null);
      }, TILE_TIMEOUT_MS);
      img.onload = () => {
        clearTimeout(timer);
        resolve(img);
      };
      img.onerror = () => {
        clearTimeout(timer);
        resolve(null);
      };
      img.src = url;
    });
    tileCache.set(url, p);
    // Failed tiles are tried again next time.
    void p.then((img) => {
      if (!img) tileCache.delete(url);
    });
  }
  return p;
}

async function loadAll(urls: string[], limit = 6): Promise<(HTMLImageElement | null)[]> {
  const out: (HTMLImageElement | null)[] = new Array(urls.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      out[i] = await loadTile(urls[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, urls.length) }, worker));
  return out;
}

function drawRoute(ctx: CanvasRenderingContext2D, spec: MapSpec, project: (p: { lat: number; lng: number }) => { x: number; y: number }) {
  const pts = spec.pins.map((p) => ({ ...p, ...project(p) }));
  const u = SCALE;
  if (pts.length > 1) {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 5 * u;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
    ctx.strokeStyle = COLORS.accent;
    ctx.lineWidth = 2.2 * u;
    ctx.setLineDash([5 * u, 4 * u]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // Places next to each other (or the same place twice) would hide each other's number:
  // move later pins aside a little; the route line keeps the true positions.
  const r = 9 * u;
  const placed: { x: number; y: number }[] = [];
  const pins = pts.map((p) => {
    const q = { ...p };
    for (let tries = 0; tries < 8 && placed.some((o) => Math.hypot(o.x - q.x, o.y - q.y) < r * 1.8); tries++) {
      const angle = (tries * Math.PI) / 4 - Math.PI / 4;
      q.x = p.x + Math.cos(angle) * r * 2;
      q.y = p.y + Math.sin(angle) * r * 2;
    }
    placed.push(q);
    return q;
  });
  ctx.strokeStyle = COLORS.muted;
  ctx.lineWidth = 1 * u;
  pins.forEach((q, i) => {
    if (q.x === pts[i].x && q.y === pts[i].y) return;
    ctx.beginPath();
    ctx.moveTo(pts[i].x, pts[i].y);
    ctx.lineTo(q.x, q.y);
    ctx.stroke();
  });
  // Later stops underneath, so the first one is never hidden under a revisit.
  for (const p of [...pins].reverse()) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
    ctx.lineWidth = 2 * u;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.font = font(9 * u, 700);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.label, p.x, p.y + 0.5 * u);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function caption(ctx: CanvasRenderingContext2D, text: string, w: number, h: number, align: 'left' | 'right') {
  const u = SCALE;
  ctx.font = font(7 * u, 400);
  const tw = ctx.measureText(text).width;
  const x = align === 'right' ? w - tw - 8 * u : 6 * u;
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.fillRect(x - 3 * u, h - 13 * u, tw + 6 * u, 11 * u);
  ctx.fillStyle = COLORS.muted;
  ctx.fillText(text, x, h - 4.5 * u);
}

/** The day's route on map tiles; just the route on a plain background if tiles cannot be loaded. */
async function renderMap(spec: MapSpec, wPt: number, hPt: number): Promise<HTMLCanvasElement> {
  const w = Math.round(wPt * SCALE);
  const h = Math.round(hPt * SCALE);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const plan = planMap(spec.pins, spec.region, w, h, { tileScale: 2, pad: 22 * SCALE });
  const images = await loadAll(plan.tiles.map((t) => t.url));
  const paint = (withTiles: boolean) => {
    ctx.fillStyle = '#eef0ec';
    ctx.fillRect(0, 0, w, h);
    let drawn = 0;
    if (withTiles) {
      plan.tiles.forEach((t, i) => {
        const img = images[i];
        if (img) {
          ctx.drawImage(img, t.dx, t.dy, t.size, t.size);
          drawn++;
        }
      });
    }
    drawRoute(ctx, spec, plan.project);
    if (drawn) caption(ctx, plan.attribution, w, h, 'right');
    else caption(ctx, '沒有載入地圖底圖（需要網路），只顯示地點的相對位置', w, h, 'left');
  };
  paint(true);
  try {
    ctx.getImageData(0, 0, 1, 1); // a tile that slipped past CORS would make the page unexportable
  } catch {
    paint(false);
  }
  return canvas;
}

// ------------------------------------------------------------------ pages

function drawOps(ctx: CanvasRenderingContext2D, ops: Op[], maps: Map<Op, HTMLCanvasElement>, links: PdfLink[]) {
  for (const op of ops) {
    switch (op.t) {
      case 'text':
        ctx.font = font(op.size, op.weight);
        ctx.fillStyle = op.color;
        ctx.fillText(op.text, op.x, op.y);
        break;
      case 'rect':
        if (op.radius) roundRect(ctx, op.x, op.y, op.w, op.h, op.radius);
        else {
          ctx.beginPath();
          ctx.rect(op.x, op.y, op.w, op.h);
        }
        if (op.fill) {
          ctx.fillStyle = op.fill;
          ctx.fill();
        }
        if (op.stroke) {
          ctx.strokeStyle = op.stroke;
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
        break;
      case 'line':
        ctx.beginPath();
        ctx.setLineDash(op.dash ?? []);
        ctx.strokeStyle = op.color;
        ctx.lineWidth = op.width;
        ctx.moveTo(op.x1, op.y1);
        ctx.lineTo(op.x2, op.y2);
        ctx.stroke();
        ctx.setLineDash([]);
        break;
      case 'circle':
        ctx.beginPath();
        ctx.arc(op.x, op.y, op.r, 0, Math.PI * 2);
        ctx.fillStyle = op.fill;
        ctx.fill();
        break;
      case 'map': {
        const img = maps.get(op);
        ctx.save();
        roundRect(ctx, op.x, op.y, op.w, op.h, 8);
        ctx.clip();
        if (img) ctx.drawImage(img, op.x, op.y, op.w, op.h);
        ctx.restore();
        roundRect(ctx, op.x, op.y, op.w, op.h, 8);
        ctx.strokeStyle = COLORS.border;
        ctx.lineWidth = 0.8;
        ctx.stroke();
        break;
      }
      case 'link':
        links.push({ x: op.x, y: op.y, w: op.w, h: op.h, url: op.url });
        break;
    }
  }
}

function toJpeg(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject) : reject(new Error('無法產生頁面圖片'))),
      'image/jpeg',
      JPEG_QUALITY,
    ),
  );
}

export function canvasMeasure(): Measure {
  const ctx = document.createElement('canvas').getContext('2d')!;
  return (text, size, weight) => {
    ctx.font = font(size, weight);
    return ctx.measureText(text).width;
  };
}

export async function renderPdf(
  doc: DocModel,
  opts: { newPagePerDay: boolean },
  onProgress: Progress = () => {},
  signal?: AbortSignal,
): Promise<{ blob: Blob; pages: number }> {
  onProgress('排版中…');
  await document.fonts?.ready;
  const pages = layoutDoc(doc, canvasMeasure(), opts);

  const mapOps = pages.flat().filter((op): op is Extract<Op, { t: 'map' }> => op.t === 'map');
  const maps = new Map<Op, HTMLCanvasElement>();
  for (const [i, op] of mapOps.entries()) {
    abortIf(signal);
    onProgress(`畫路線地圖 ${i + 1}/${mapOps.length}…`);
    maps.set(op, await renderMap(op.map, op.w, op.h));
  }

  const out: PdfPage[] = [];
  for (const [i, ops] of pages.entries()) {
    abortIf(signal);
    onProgress(`產生第 ${i + 1}/${pages.length} 頁…`);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(PAGE.w * SCALE);
    canvas.height = Math.round(PAGE.h * SCALE);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(SCALE, SCALE);
    const links: PdfLink[] = [];
    drawOps(ctx, ops, maps, links);
    out.push({ jpeg: await toJpeg(canvas), pxWidth: canvas.width, pxHeight: canvas.height, links });
    canvas.width = canvas.height = 0; // free the memory now (phones have little)
  }
  for (const c of maps.values()) c.width = c.height = 0;

  onProgress('組合 PDF…');
  const bytes = buildPdf(out, { title: doc.title, width: PAGE.w, height: PAGE.h });
  return { blob: new Blob([bytes], { type: 'application/pdf' }), pages: out.length };
}
