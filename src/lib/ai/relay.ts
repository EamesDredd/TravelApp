/* "Relay" mode: no API key. The app hands the trip and the request to the
 * user's own Claude / ChatGPT app (share sheet or clipboard); the reply ends
 * with a ```travelplan block of operations that the app applies to the
 * current trip when the user pastes the reply back. Everything here is pure,
 * so the decision logic is unit-tested; ChatPanel only asks and commits. */
import type { ChatMessage, Trip, TripSnapshot } from '../../types';
import { snapshotOf } from '../tripOps';
import { applyToolCall, describeTrip, TOOL_DEFS } from './agentTools';

export const RELAY_FENCE = 'travelplan';

/** First line of every message the app sends out, so a pasted copy of it is recognised. */
export const RELAY_MARKER = '〔旅遊行程規劃 App〕';

const TOOL_NAMES = new Set(TOOL_DEFS.map((t) => t.name));

export interface RelayOp {
  tool: string;
  input: unknown;
}

export interface ParsedReply {
  /** The reply with the operations block removed, for the chat log. */
  message: string;
  /** The send tag the AI echoed back, if any. */
  base?: string;
  /** Version of the block within one AI conversation (1, 2, 3...), if given. */
  rev?: number;
  /** Operations found in the reply; null when the reply has no usable block. */
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

/** A fresh tag for one send; replies echo it so the app knows which request they answer. */
export function newRelayTag(): string {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

// ------------------------------------------------------------------ outgoing prompts

const RULES = `- 「目前行程狀態」裡的資料以這則訊息為準。
- 我要你安排、調整、新增或刪除時，直接給出修改區塊，不必先問我；只是詢問意見或資訊時，用文字回答就好，不要附修改區塊。
- 依遠近安排時，用候選地點的座標把鄰近的地點排在同一天，依順路的動線排序、避免來回折返；考慮開放時間、停留時間、交通時間與用餐時段（早餐約 07:00–09:30、午餐 11:30–13:30、晚餐 17:30–20:00），填入合理的開始時間。
- 優先使用既有候選地點的 spot_id。需要新地點（例如補上順路的餐廳）時，在 set_day_plans 的項目裡用 new_spot，並一定要寫 name 和 category，盡量附上地址與大略座標；不確定的座標寧可省略。App 會依名稱把同名的地點視為同一個，所以同一個新地點在不同天出現時，new_spot 的 name 要寫得一模一樣。
- add_candidates 只用在「加入候選但先不排進行程」的地點。
- set_day_plans 會用你給的清單完整取代那一天，所以要列出那天所有項目，包含原本要保留的。
- 一天不要排得太滿，保留彈性時間。
- 修改區塊直接寫在回覆內文的最後，不要放進 Artifact、Canvas 或附件檔案。
- 回答使用繁體中文（台灣用語），精簡、以條列為主。`;

// In relay mode the AI never sees the ids the app assigns, so new places are referenced by name.
const RELAY_NOTES: Record<string, string> = {
  add_candidates:
    '新增地點到候選清單（不會排進每日行程）。你看不到 App 給新地點的 id；要把新地點排進行程，請直接在 set_day_plans 用 new_spot。',
};

function toolDocs(): string {
  return TOOL_DEFS.map(
    (t) => `### ${t.name}\n${RELAY_NOTES[t.name] ?? t.description}\ninput 的 JSON Schema：${JSON.stringify(t.parameters)}`,
  ).join('\n\n');
}

/** The whole message the user sends to their AI app. */
export function buildRelayPrompt(trip: TripSnapshot, request: string, tag: string, today = new Date()): string {
  const example = JSON.stringify({
    base: tag,
    rev: 1,
    ops: [
      {
        tool: 'set_day_plans',
        input: { days: [{ day: 1, title: '當天主題', items: [{ spot_id: 's_xxxx', time: '09:00' }] }] },
      },
    ],
  });
  return `${RELAY_MARKER}
你是旅遊行程規劃助理。我正在用一個旅遊行程 App 安排旅程，下面附上 App 目前的行程資料。請依照我的需求回答；需要修改行程時，在回覆最後附上一個讓 App 自動套用的修改區塊。

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
3. "base" 固定寫 "${tag}"（代表我這次的請求）；"rev" 是這個區塊的版本，第一個區塊寫 1；"ops" 依序列出要執行的指令。範例裡的 s_xxxx 只是示意，請換成真正的 spot_id。
4. JSON 要完整有效：雙引號、不要註解、不要用「…」省略任何內容。
5. 之後在這個對話裡我如果繼續要求修改，每次的區塊都要列出這個請求「全部」的修改（包含先前區塊裡仍要保留的修改），並把 rev 加 1。App 會用最新的區塊取代先前套用的版本，所以我只貼最後一則回覆也不會漏掉。

## 可用的指令
${toolDocs()}

${describeTrip(trip, today)}`;
}

/** Wraps the place-research prompt for sending to the user's AI app. */
export function buildRelaySearchPrompt(searchPrompt: string): string {
  return `${RELAY_MARKER}\n${searchPrompt}`;
}

/** Message asking the AI to fix a block the app could not (fully) apply. */
export function buildFixPrompt(tag: string | undefined, issues: string[]): string {
  return `${RELAY_MARKER}
你剛才的修改區塊有以下問題，App 沒有套用這些部分：
${issues.map((i) => `- ${i}`).join('\n')}

請修正後重新輸出一個完整的 \`\`\`${RELAY_FENCE} 區塊：列出這個請求「全部」的修改（包含沒有問題的部分），rev 加 1${tag ? `，base 一樣寫 "${tag}"` : ''}。App 會用它取代先前套用的版本。new_spot 一定要有 name 和 category（sight / breakfast / meal），spot_id 只能用行程資料裡出現過的 id。`;
}

/** True when pasted text is one of our own outgoing messages rather than the AI's reply. */
export function looksLikeOwnPrompt(text: string): boolean {
  return text.includes(RELAY_MARKER);
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

interface Fence {
  lang: string;
  body: string;
  full: string;
  start: number;
  end: number;
}

/** Closed fenced code blocks, in order. */
function fences(text: string): Fence[] {
  const out: Fence[] = [];
  const re = /(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*([\w-]*)[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({ lang: m[3].toLowerCase(), body: m[4], full: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

const TRUNCATED = '修改區塊不完整（可能被截斷），請 AI 重新輸出完整區塊。';

/** Where a block object can start: {"base": …, {"ops": … or {"rev": … (straight or smart quotes). */
const BLOCK_START = /\{\s*["“](?:base|ops|rev)["”]\s*:/g;

/**
 * Finds the operations block in a pasted AI reply (the whole reply, just the block, fenced
 * or copied as plain text). The LAST block in the reply is the AI's latest word: if it is
 * cut off, nothing is applied rather than falling back to an earlier, superseded block.
 */
export function parseRelayReply(raw: string): ParsedReply {
  const text = raw.replace(/\r\n?/g, '\n').trim();
  const problems: string[] = [];
  let found: { obj: Record<string, unknown>; at: number; json: string } | null = null;

  const starts = [...text.matchAll(BLOCK_START)].map((m) => m.index);
  if (starts.length) {
    const at = starts[starts.length - 1];
    const json = balancedObject(text, at);
    const v = json ? tryJson(json) : undefined;
    if (json && isObj(v) && Array.isArray(v.ops)) found = { obj: v, at, json };
    else problems.push(json && isObj(v) ? '修改區塊格式不正確（缺少 ops 清單），請 AI 重新輸出。' : TRUNCATED);
  }

  // A travelplan fence or tag line after the block we found (or with none found) means the
  // AI's latest block never arrived intact.
  const markers = [
    ...text.matchAll(new RegExp(`(^|\\n)[ \\t]*(\`{3,}|~{3,})[ \\t]*${RELAY_FENCE}`, 'gi')),
    ...text.matchAll(new RegExp(`(^|\\n)[ \\t]*${RELAY_FENCE}[ \\t]*(?=\\n|$)`, 'gi')),
  ].map((m) => m.index);
  const lastMarker = markers.length ? Math.max(...markers) : -1;
  if (lastMarker >= 0 && (!found || lastMarker > found.at)) {
    found = null;
    if (!problems.length) problems.push(TRUNCATED);
  }

  let message = text;
  if (found) {
    const fence = fences(text).find((b) => b.start <= found!.at && found!.at < b.end);
    message = message.replace(fence ? fence.full : found.json, '\n');
  }
  // Drop a dangling language tag left by "copy text" on some apps (e.g. "travelplan\n複製程式碼").
  message = message
    .replace(new RegExp(`(^|\\n)\\s*${RELAY_FENCE}\\s*(\\n|$)`, 'gi'), '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!found) return { message, ops: null, problems };

  const ops: RelayOp[] = [];
  (found.obj.ops as unknown[]).forEach((op, i) => {
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
  const revNum = Number(found.obj.rev);
  const rev = Number.isInteger(revNum) && revNum > 0 ? revNum : undefined;
  return { message, base, rev, ops, problems };
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
    const failed = r.result
      .split('\n')
      .filter((l) => l.startsWith('錯誤：'))
      .map((l) => l.slice(3));
    errors.push(...(failed.length || !r.isError ? failed : [r.result]));
  }
  return { trip, summary, errors };
}

export type RelayConfirm =
  /** No record of the request in this trip (other device, cleared chat, or no tag). */
  | 'unknown-send'
  /** The trip changed after sending and no reply to this request is applied yet. */
  | 'edited-since-send'
  /** A reply to this request was applied, but the trip changed again afterwards. */
  | 'edited-after-reply'
  /** This block is an older version than the one already applied. */
  | 'older-version';

export type RelayDecision =
  /** The clipboard held our own outgoing message. */
  | { kind: 'own-prompt' }
  | { kind: 'empty' }
  /** The reply answers a request sent from another trip. */
  | { kind: 'other-trip'; tripName: string }
  /** This exact block is already what the trip shows. */
  | { kind: 'duplicate' }
  /** No operations to apply: a discussion reply, or a broken block. */
  | { kind: 'message-only'; parsed: ParsedReply }
  | {
      kind: 'apply';
      parsed: ParsedReply;
      /** The trip right now, for undo. */
      before: TripSnapshot;
      confirm: RelayConfirm | null;
      /** Id of the earlier reply to the same request that this one replaces, if any. */
      replaces?: string;
      /** Version number of the block it replaces, for the confirm text. */
      replacesRev?: number;
      result: RelayApplyResult;
      opsFp: string;
      /** Problems with the block plus operations that failed; the rest applied cleanly. */
      issues: string[];
    };

/** Keeps place research saved since `base` was taken (it is not part of the plan). */
function withCurrentResearch(base: TripSnapshot, current: TripSnapshot): TripSnapshot {
  const research = new Map(current.spots.filter((s) => s.search).map((s) => [s.id, s.search]));
  return { ...base, spots: base.spots.map((s) => (research.has(s.id) ? { ...s, search: research.get(s.id) } : s)) };
}

/**
 * Decides what pasting `raw` into `trip` should do.
 *
 * Each block holds ALL changes for its request, so a newer reply to the same request
 * replaces the one applied before it: when nothing else changed since, the earlier
 * reply is rolled back first and the new block applied in its place. Otherwise blocks
 * apply to the current trip, and anything surprising is flagged for confirmation.
 */
export function planRelayApply(raw: string, trip: Trip, otherTrips: Pick<Trip, 'name' | 'chat'>[]): RelayDecision {
  if (looksLikeOwnPrompt(raw)) return { kind: 'own-prompt' };
  const parsed = parseRelayReply(raw);
  if (!parsed.message && !parsed.ops && !parsed.problems.length) return { kind: 'empty' };
  if (!parsed.ops?.length) return { kind: 'message-only', parsed };

  const sent: ChatMessage | undefined = parsed.base ? trip.chat.find((m) => m.relay?.tag === parsed.base) : undefined;
  if (parsed.base && !sent) {
    const other = otherTrips.find((t) => t.chat.some((m) => m.relay?.tag === parsed.base));
    if (other) return { kind: 'other-trip', tripName: other.name };
  }

  const current = snapshotOf(trip);
  const currentFp = tripFingerprint(current);
  const opsFp = opsFingerprint(parsed.ops);
  // Replies to this request whose changes still stand, oldest first.
  const applied = sent
    ? trip.chat.filter((m) => m.role === 'assistant' && m.relayBase === parsed.base && m.relayResult && !m.undone)
    : [];
  const latest = applied[applied.length - 1];
  if (latest && latest.relayOps === opsFp && latest.relayResult === currentFp) return { kind: 'duplicate' };

  let start = current;
  let confirm: RelayConfirm | null = null;
  let replaces: string | undefined;
  if (!sent) {
    confirm = 'unknown-send';
  } else if (latest) {
    if (latest.relayResult === currentFp && latest.undo) {
      start = withCurrentResearch(latest.undo, current);
      replaces = latest.id;
    } else {
      confirm = 'edited-after-reply';
    }
    if (parsed.rev && latest.relayRev && parsed.rev < latest.relayRev) confirm = 'older-version';
  } else if (sent.relay!.fp !== currentFp) {
    confirm = 'edited-since-send';
  }

  const result = applyRelayOps(start, parsed.ops);
  return {
    kind: 'apply',
    parsed,
    before: current,
    confirm,
    replaces,
    replacesRev: latest?.relayRev,
    result,
    opsFp,
    issues: [...parsed.problems, ...result.errors],
  };
}
