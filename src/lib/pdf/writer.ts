/* A minimal PDF writer: one JPEG image per page plus clickable links. The pages are drawn
 * with the browser's own fonts first, so Chinese text and emoji need no embedded fonts. */

export interface PdfLink {
  /** Top-left origin, in points. */
  x: number;
  y: number;
  w: number;
  h: number;
  url: string;
}

export interface PdfPage {
  jpeg: Uint8Array;
  /** Pixel size of the JPEG. */
  pxWidth: number;
  pxHeight: number;
  links: PdfLink[];
}

export interface PdfMeta {
  title: string;
  /** Page size in points (A4: 595.28 × 841.89). */
  width: number;
  height: number;
  created?: Date;
}

const num = (n: number) => (Math.round(n * 100) / 100).toString();

/** Text string for the document info: UTF-16BE with a byte order mark, as hex. */
function textString(s: string): string {
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

/** Literal string holding ASCII only (non-ASCII percent-encoded, as URIs must be 7-bit). */
function asciiString(s: string): string {
  const ascii = s.replace(/[^\x20-\x7e]/g, (c) => encodeURIComponent(c));
  return `(${ascii.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `(D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z)`;
}

export function buildPdf(pages: PdfPage[], meta: PdfMeta): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 0;
  const put = (part: string | Uint8Array) => {
    const bytes = typeof part === 'string' ? enc.encode(part) : part;
    chunks.push(bytes);
    size += bytes.length;
  };
  const obj = (id: number, body: string | (() => void)) => {
    offsets[id] = size;
    put(`${id} 0 obj\n`);
    if (typeof body === 'string') put(body);
    else body();
    put('\nendobj\n');
  };

  // Object numbers: 1 catalog, 2 page tree, 3 info, then for each page: page, image, content, links.
  let next = 4;
  const plan = pages.map((p) => {
    const page = next++;
    const image = next++;
    const content = next++;
    const links = p.links.map(() => next++);
    return { page, image, content, links };
  });

  // Header, then a comment with high bytes so tools treat the file as binary.
  put('%PDF-1.4\n%');
  put(new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  obj(1, '<< /Type /Catalog /Pages 2 0 R /ViewerPreferences << /DisplayDocTitle true >> >>');
  obj(2, `<< /Type /Pages /Kids [${plan.map((p) => `${p.page} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  obj(3, `<< /Title ${textString(meta.title)} /Producer (Travel Planner) /CreationDate ${pdfDate(meta.created ?? new Date())} >>`);

  const W = num(meta.width);
  const H = num(meta.height);
  pages.forEach((p, i) => {
    const ids = plan[i];
    const annots = ids.links.length ? ` /Annots [${ids.links.map((l) => `${l} 0 R`).join(' ')}]` : '';
    obj(
      ids.page,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${ids.image} 0 R >> >> /Contents ${ids.content} 0 R${annots} >>`,
    );
    obj(ids.image, () => {
      put(
        `<< /Type /XObject /Subtype /Image /Width ${p.pxWidth} /Height ${p.pxHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`,
      );
      put(p.jpeg);
      put('\nendstream');
    });
    const draw = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    obj(ids.content, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
    p.links.forEach((l, j) => {
      const rect = [l.x, meta.height - l.y - l.h, l.x + l.w, meta.height - l.y].map(num).join(' ');
      obj(ids.links[j], `<< /Type /Annot /Subtype /Link /Rect [${rect}] /Border [0 0 0] /A << /S /URI /URI ${asciiString(l.url)} >> >>`);
    });
  });

  const xref = size;
  const count = next;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) table += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  put(table);
  put(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
