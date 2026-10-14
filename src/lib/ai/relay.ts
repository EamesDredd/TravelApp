/* "Relay" mode: no API key. The app hands the trip and the request to the
 * user's own Claude / ChatGPT app (share sheet or clipboard); the reply ends
 * with a ```travelplan block of operations that the app applies when the
 * user pastes the reply back. Pure functions only, so they are unit-tested. */
import type { TripSnapshot } from '../../types';
import { applyToolCall, describeTrip, TOOL_DEFS } from './agentTools';

export const RELAY_FENCE = 'travelplan';

const TOOL_NAMES = new Set(TOOL_DEFS.map((t) => t.name));

export interface RelayOp {
  tool: string;
  input: unknown;
}

export interface ParsedReply {
  /** The reply with the operations block removed, for the chat log. */
  message: string;
  /** Version tag the AI echoed back, if any. */
  base?: string;
  /** Operations found in the reply; null when the reply has no block. */
  ops: RelayOp[] | null;
  /** Problems with the block itself (bad JSON, unknown tool...). */
  problems: string[];
}

function fnv(data: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, '0');
}

/** Short, stable tag for a trip version (FNV-1a over the editable data, minus cached searches). */
export function tripFingerprint(t: TripSnapshot): string {
  return fnv(
    JSON.stringify({
      n: t.name,
      d: t.destination,
      s: t.startDate ?? null,
      days: t.days,
      spots: t.spots.map(({ search: _search, ...rest }) => rest),
    }),
  );
}

/** Tag for a list of operations, so the same reply pasted twice is recognised. */
export function opsFingerprint(ops: RelayOp[]): string {
  return fnv(JSON.stringify(ops));
}

const RULES = `- 「目前行程狀態」裡的資料以這則訊息為準。
- 我要你安排、調整、新增或刪除時，直接給出修改區塊，不必先問我；只是詢問意見或資訊時，用文字回答就好，不要附修改區塊。
- 依遠近安排時，用候選地點的座標把鄰近的地點排在同一天，依順路的動線排序、避免來回折返；考慮開放時間、停留時間、交通時間與用餐時段（早餐約 07:00–09:30、午餐 11:30–13:30、晚餐 17:30–20:00），填入合理的開始時間。
- 優先使用既有候選地點的 spot_id。需要新地點（例如補上順路的餐廳）時，在 set_day_plans 的項目裡用 new_spot，盡量附上地址與大略座標；不確定的座標寧可省略。App 會依名稱自動把同名的地點視為同一個，所以同一個新地點在不同天出現時，new_spot 的 name 要寫得一模一樣。
- add_candidates 只用在「加入候選但先不排進行程」的地點。
- set_day_plans 會用你給的清單完整取代那一天，所以要列出那天所有項目，包含原本要保留的。
- 一天不要排得太滿，保留彈性時間。
- 回答使用繁體中文（台灣用語），精簡、以條列為主。`;

// In relay mode the AI never sees the ids the app assigns, so new places are referenced by name.
const RELAY_NOTES: Record<string, string> = {
  add_candidates: '新增地點到候選清單（不會排進每日行程）。你看不到 App 給新地點的 id；要把新地點排進行程，請直接在 set_day_plans 用 new_spot。',
};

function toolDocs(): string {
  return TOOL_DEFS.map(
    (t) => `### ${t.name}\n${RELAY_NOTES[t.name] ?? t.description}\ninput 的 JSON Schema：${JSON.stringify(t.parameters)}`,
  ).join('\n\n');
}

/** The whole message the user sends to their AI app. */
export function buildRelayPrompt(trip: TripSnapshot, request: string, base: string, today = new Date()): string {
  const example = JSON.stringify({
    base,
    ops: [
      {
        tool: 'set_day_plans',
        input: { days: [{ day: 1, title: '當天主題', items: [{ spot_id: 's_xxxx', time: '09:00' }] }] },
      },
    ],
  });
  return `你是旅遊行程規劃助理。我正在用一個旅遊行程 App 安排旅程，下面附上 App 目前的行程資料。請依照我的需求回答；需要修改行程時，在回覆最後附上一個讓 App 自動套用的修改區塊。

## 我的需求
${request.trim()}

## 原則
${RULES}

## 修改區塊格式（App 會讀取）
1. 先用幾句話說明你做了什麼、為什麼。
2. 最後附上「一個」程式碼區塊，語言標記寫 ${RELAY_FENCE}，內容是一個 JSON 物件，例如：
\`\`\`${RELAY_FENCE}
${example}
\`\`\`
3. "base" 固定寫 "${base}"（代表我這次傳給你的行程版本）；"ops" 依序列出要執行的指令。
4. JSON 要完整有效：雙引號、不要註解、不要用「…」省略任何內容。
5. 如果之後在這個對話裡我繼續要求修改，每次的區塊都要包含「相對於 base ${base} 的全部修改」（把之前提過、仍然要保留的修改一起列進去），因為 App 只會套用最新的那一個區塊。

## 可用的指令
${toolDocs()}

${describeTrip(trip, today)}`;
}

/** True when pasted text is one of our own outgoing prompts rather than the AI's reply. */
export function looksLikeOwnPrompt(text: string): boolean {
  return text.includes('## 我的需求') && text.includes('## 可用的指令');
}

/** Links mentioned in a pasted reply, for the place's source list. */
export function extractSources(text: string): { title: string; url: string }[] {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/\[([^\]]{1,200})\]\((https?:\/\/[^)\s]+)\)/g)) if (!out.has(m[2])) out.set(m[2], m[1]);
  for (const m of text.matchAll(/https?:\/\/[^\s)）」』>\]]+/g)) {
    const url = m[0].replace(/[.,;:!?。，、]+$/, '');
    if (!out.has(url)) out.set(url, url);
  }
  return [...out].map(([url, title]) => ({ url, title }));
}

// ------------------------------------------------------------------ parsing

/** Balanced `{...}` starting at `start`, aware of JSON strings. */
function balancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function tryJson(raw: string): unknown {
  const attempts = [raw, raw.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")];
  for (const a of attempts) {
    try {
      return JSON.parse(a);
    } catch {
      /* try the next form */
    }
  }
  return undefined;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Fenced code blocks, in order: [lang, body, fullMatch]. */
function fences(text: string): { lang: string; body: string; full: string }[] {
  const out: { lang: string; body: string; full: string }[] = [];
  const re = /(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*([\w-]*)[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ lang: m[3].toLowerCase(), body: m[4], full: m[0] });
  return out;
}

/** Finds the operations block in a pasted AI reply (whole reply, or just the block). */
export function parseRelayReply(raw: string): ParsedReply {
  const text = raw.replace(/\r\n?/g, '\n').trim();
  const problems: string[] = [];
  let found: { obj: Record<string, unknown>; remove?: string } | null = null;

  // 1) Fenced blocks: prefer the last ```travelplan, then any block holding {"ops": [...]}.
  const blocks = fences(text);
  const ordered = [
    ...blocks.filter((b) => b.lang === RELAY_FENCE).reverse(),
    ...blocks.filter((b) => b.lang !== RELAY_FENCE).reverse(),
  ];
  for (const b of ordered) {
    const start = b.body.indexOf('{');
    const json = start >= 0 ? balancedObject(b.body, start) : null;
    const v = json ? tryJson(json) : undefined;
    if (isObj(v) && Array.isArray(v.ops)) {
      found = { obj: v, remove: b.full };
      break;
    }
    if (b.lang === RELAY_FENCE) problems.push('修改區塊不是完整有效的 JSON（可能被截斷），請請 AI 重新輸出完整區塊。');
  }

  // 2) No usable fence (e.g. copied without the ``` markers): scan for {"base"…} / {"ops"…}.
  if (!found) {
    const re = /\{\s*"(?:base|ops)"\s*:/g;
    let m: RegExpExecArray | null;
    let last: { obj: Record<string, unknown>; remove: string } | null = null;
    while ((m = re.exec(text))) {
      const json = balancedObject(text, m.index);
      const v = json ? tryJson(json) : undefined;
      if (json && isObj(v) && Array.isArray(v.ops)) last = { obj: v, remove: json };
    }
    if (last) {
      found = last;
      problems.length = 0;
    }
  }

  if (!found && new RegExp(`(\`\`\`|~~~)\\s*${RELAY_FENCE}`).test(text) && !problems.length) {
    problems.push('修改區塊不完整（可能被截斷），請請 AI 重新輸出完整區塊。');
  }

  let message = text;
  if (found?.remove) message = message.replace(found.remove, '\n');
  // Drop a dangling language tag left by "copy text" on some apps (e.g. "travelplan\n複製程式碼").
  message = message
    .replace(new RegExp(`(^|\\n)\\s*${RELAY_FENCE}\\s*(\\n|$)`, 'g'), '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!found) return { message, ops: null, problems };

  const ops: RelayOp[] = [];
  const rawOps = found.obj.ops as unknown[];
  rawOps.forEach((op, i) => {
    if (!isObj(op) || typeof op.tool !== 'string') {
      problems.push(`第 ${i + 1} 個指令格式錯誤`);
      return;
    }
    if (!TOOL_NAMES.has(op.tool)) {
      problems.push(`未知的指令：${op.tool}`);
      return;
    }
    ops.push({ tool: op.tool, input: op.input });
  });
  const base = typeof found.obj.base === 'string' && found.obj.base.trim() ? found.obj.base.trim() : undefined;
  return { message, base, ops, problems };
}

// ------------------------------------------------------------------ applying

export interface RelayApplyResult {
  trip: TripSnapshot;
  summary: string[];
  errors: string[];
}

export function applyRelayOps(start: TripSnapshot, ops: RelayOp[]): RelayApplyResult {
  let trip = start;
  const summary: string[] = [];
  const errors: string[] = [];
  for (const op of ops) {
    const r = applyToolCall(trip, op.tool, op.input);
    trip = r.trip;
    summary.push(...r.summary);
    const lines = r.result.split('\n');
    if (r.isError) errors.push(...lines.map((l) => l.replace(/^錯誤：/, '')));
    else errors.push(...lines.filter((l) => l.startsWith('錯誤：')).map((l) => l.slice(3)));
  }
  return { trip, summary, errors };
}
