export function uid(prefix: string, len = 6): string {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += chars[b % chars.length];
  return `${prefix}_${out}`;
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

export function parseDate(iso?: string): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function dayDate(startDate: string | undefined, index: number): Date | null {
  const d = parseDate(startDate);
  if (!d) return null;
  d.setDate(d.getDate() + index);
  return d;
}

/** "10/20（二）" */
export function formatDayDate(startDate: string | undefined, index: number): string {
  const d = dayDate(startDate, index);
  if (!d) return '';
  return `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAYS[d.getDay()]}）`;
}

export function toIsoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function weekdayName(d: Date): string {
  return `週${WEEKDAYS[d.getDay()]}`;
}

export function isValidTime(t: unknown): t is string {
  return typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}

/** Accepts "9:00", "09:00", "0900" and returns "09:00", or undefined. */
export function normalizeTime(t: unknown): string | undefined {
  if (typeof t !== 'string') return undefined;
  const s = t.trim();
  let m = /^(\d{1,2}):(\d{2})$/.exec(s) ?? /^(\d{2})(\d{2})$/.exec(s);
  if (!m) return undefined;
  const out = `${m[1].padStart(2, '0')}:${m[2]}`;
  return isValidTime(out) ? out : undefined;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function downloadFile(filename: string, content: string | Blob, type: string) {
  const blob = typeof content === 'string' ? new Blob([content], { type }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'trip';
}
