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
  /** Informational lines about how the reply was read (e.g. several blocks merged). */
  notes: string[];
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

/** JSON.parse with repairs for what chat apps commonly produce: smart quotes, trailing commas. */
function tryJson(raw: string): unknown {
  const quotes = raw.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const attempts = [raw, quotes, quotes.replace(/,(\s*[}\]])/g, '$1')];
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
  bodyAt: number;
  full: string;
  start: number;
  end: number;
}

/** Closed fenced code blocks, in order. */
function fences(text: string): Fence[] {
  const out: Fence[] = [];
  const re = /(^|\n)([ \t]*(`{3,}|~{3,})[ \t]*([\w-]*)[^\n]*\n)([\s\S]*?)\n[ \t]*\3[ \t]*(?=\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index + m[1].length;
    out.push({
      lang: m[4].toLowerCase(),
      body: m[5],
      bodyAt: start + m[2].length,
      full: m[0].slice(m[1].length),
      start,
      end: m.index + m[0].length,
    });
  }
  return out;
}

const TRUNCATED = '修改區塊不完整（可能被截斷），請 AI 重新輸出完整區塊。';
const BAD_JSON = '修改區塊的 JSON 格式錯誤（例如多餘的逗號或註解），請 AI 重新輸出。';
const NO_OPS = '修改區塊格式不正確（缺少 ops 清單），請 AI 重新輸出。';

/** Where a block object can start: {"base": …, {"ops": … or {"rev": … (straight or smart quotes). */
const BLOCK_START = /\{\s*["“](?:base|ops|rev)["”]\s*:/g;
/** Labels some apps leave behind when a code block is copied as plain text. */
const COPY_LABEL = /^\s*(travelplan|json|複製程式碼|複製代碼|复制代码|copy code|copy|コピーする)\s*$/i;

interface Candidate {
  /** Where the JSON starts (or where it should have started). */
  at: number;
  /** Text to drop from the chat message. */
  remove: string;
  json: string | null;
}

interface Block {
  at: number;
  obj: Record<string, unknown>;
  rev?: number;
}

function revOf(obj: Record<string, unknown>): number | undefined {
  const n = Number(obj.rev);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Finds the operations block(s) in a pasted AI reply: the whole reply or just the block,
 * fenced or copied as plain text. If the AI's last block is cut off or broken, nothing is
 * applied rather than falling back to an earlier, superseded block.
 */
export function parseRelayReply(raw: string): ParsedReply {
  const text = raw.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim();
  const problems: string[] = [];
  const notes: string[] = [];
  const cands: Candidate[] = [];
  const allFences = fences(text);
  const inFence = (i: number) => allFences.some((f) => f.start <= i && i < f.end);

  // 1) Closed fences: ```travelplan always; other fences only when they hold a block.
  for (const f of allFences) {
    const bs = new RegExp(BLOCK_START.source).exec(f.body);
    if (f.lang !== RELAY_FENCE && !bs) continue;
    const local = bs ? bs.index : f.body.indexOf('{');
    cands.push({ at: f.bodyAt + Math.max(local, 0), remove: f.full, json: local >= 0 ? balancedObject(f.body, local) : null });
  }
  // 2) A travelplan fence that never closes (the reply was cut off, or the closing ``` was lost).
  for (const m of text.matchAll(new RegExp(`(^|\\n)[ \\t]*(\`{3,}|~{3,})[ \\t]*${RELAY_FENCE}[^\\n]*`, 'gi'))) {
    const at = m.index + m[1].length;
    if (inFence(at)) continue;
    const brace = text.indexOf('{', at);
    const json = brace >= 0 ? balancedObject(text, brace) : null;
    cands.push({ at: brace >= 0 ? brace : at, remove: json ? text.slice(at, brace + json.length) : text.slice(at), json });
  }
  // 3) Copied as plain text: a bare "travelplan" label line, then the JSON.
  for (const m of text.matchAll(new RegExp(`(^|\\n)[ \\t]*${RELAY_FENCE}[ \\t]*(?=\\n|$)`, 'gi'))) {
    const at = m.index + m[1].length;
    if (inFence(at)) continue;
    const brace = text.indexOf('{', at);
    const json = brace >= 0 ? balancedObject(text, brace) : null;
    cands.push({ at: brace >= 0 ? brace : at, remove: json ? text.slice(at, brace + json.length) : text.slice(at), json });
  }
  // 4) Bare JSON objects elsewhere. Without any marked block, only a complete, valid one counts
  //    (an example written in prose is never mistaken for a broken block). Next to marked blocks,
  //    one that never closes means the AI's later block was cut off (e.g. an unclosed ```json fence).
  const strict = cands.length > 0;
  const covered = (i: number) => inFence(i) || cands.some((c) => c.json && c.at <= i && i < c.at + c.json.length);
  for (const m of text.matchAll(BLOCK_START)) {
    if (covered(m.index)) continue;
    const json = balancedObject(text, m.index);
    const v = json ? tryJson(json) : undefined;
    if (json && isObj(v) && Array.isArray(v.ops)) cands.push({ at: m.index, remove: json, json });
    else if (strict && !json) cands.push({ at: m.index, remove: text.slice(m.index), json: null });
  }

  cands.sort((a, b) => a.at - b.at);
  const blocks: Block[] = [];
  let lastFailure: { at: number; reason: string } | null = null;
  for (const c of cands) {
    const v = c.json ? tryJson(c.json) : undefined;
    if (isObj(v) && Array.isArray(v.ops)) blocks.push({ at: c.at, obj: v, rev: revOf(v) });
    else lastFailure = { at: c.at, reason: !c.json ? TRUNCATED : isObj(v) ? NO_OPS : BAD_JSON };
  }
  const lastValid = blocks.length ? blocks[blocks.length - 1].at : -1;
  if (lastFailure && lastFailure.at > lastValid) {
    problems.push(lastFailure.reason);
    blocks.length = 0;
  }

  let message = text;
  for (const c of cands) message = message.replace(c.remove, '\n');
  message = message
    .split('\n')
    .filter((l) => !COPY_LABEL.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!blocks.length) return { message, ops: null, problems, notes };

  // Several blocks: a higher rev supersedes; blocks of the same rev are parts of one answer.
  const revs = blocks.map((b) => b.rev).filter((r): r is number => r !== undefined);
  const top = revs.length ? Math.max(...revs) : undefined;
  // Blocks without a rev are parts of the same answer; only an explicitly lower rev is superseded.
  const chosen = top === undefined ? blocks : blocks.filter((b) => b.rev === undefined || b.rev === top);
  if (chosen.length > 1) notes.push(`回覆裡有 ${chosen.length} 個修改區塊，已依序合併套用`);
  if (chosen.length < blocks.length) notes.push(`回覆裡較舊版本的修改區塊已略過，只套用第 ${top} 版`);

  const ops: RelayOp[] = [];
  chosen.forEach((b) =>
    (b.obj.ops as unknown[]).forEach((op, i) => {
      if (!isObj(op) || typeof op.tool !== 'string') {
        problems.push(`第 ${i + 1} 個指令格式錯誤`);
        return;
      }
      if (!TOOL_NAMES.has(op.tool)) {
        problems.push(`未知的指令：${op.tool}`);
        return;
      }
      ops.push({ tool: op.tool, input: op.input });
    }),
  );
  const last = chosen[chosen.length - 1].obj;
  const base = typeof last.base === 'string' && last.base.trim() ? last.base.trim() : undefined;
  return { message, base, rev: top, ops, problems, notes };
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
  /** This block is an older version than the one it would replace. */
  | 'older-version';

export type RelayDecision =
  /** The clipboard held our own outgoing message. */
  | { kind: 'own-prompt' }
  | { kind: 'empty' }
  /** The reply answers a request sent from another trip. */
  | { kind: 'other-trip'; tripName: string }
  /** This exact block is already what the trip shows. */
  | { kind: 'duplicate' }
  /**
   * No operations to apply: a discussion reply, a broken block, or an empty block. For an empty
   * block, `cannotRevert` means an earlier reply to this request still has changes in the trip
   * that this one cannot take back (the trip has moved on since).
   */
  | { kind: 'message-only'; parsed: ParsedReply; cannotRevert?: boolean }
  | {
      kind: 'apply';
      parsed: ParsedReply;
      /** The trip right now, for undo. */
      before: TripSnapshot;
      /** The trip as it was before this request's first applied reply; replies replace each other on top of it. */
      requestBase: TripSnapshot;
      confirm: RelayConfirm | null;
      /** Id of the earlier reply to the same request that this one replaces, if any. */
      replaces?: string;
      replacesRev?: number;
      /** The reply being replaced had problems itself, so a version with problems may still improve on it. */
      replacesBroken?: boolean;
      /** An empty block: applying it undoes everything this request changed. */
      revertsRequest?: boolean;
      result: RelayApplyResult;
      opsFp: string;
      /** Problems with the block plus operations that failed. */
      issues: string[];
      /**
       * When replacing: changes of the earlier reply that this block quietly drops (days that go back
       * to how they were, places that disappear), and the alternative of applying it on top instead.
       */
      dropped: string[];
      onCurrent?: RelayApplyResult;
      onCurrentIssues?: string[];
    };

const nameKey = (n: string) => n.replace(/\s+/g, '').toLowerCase();

/** Keeps place research saved since `base` was taken (it is not part of the plan), matching by id or name. */
function withResearch(target: TripSnapshot, current: TripSnapshot): TripSnapshot {
  const byId = new Map(current.spots.filter((s) => s.search).map((s) => [s.id, s.search]));
  const byName = new Map(current.spots.filter((s) => s.search).map((s) => [nameKey(s.name), s.search]));
  return {
    ...target,
    spots: target.spots.map((s) => (s.search ? s : { ...s, search: byId.get(s.id) ?? byName.get(nameKey(s.name)) ?? s.search })),
  };
}

/** A day described by place names (new places get new ids each time a block is applied). */
function daySig(t: TripSnapshot, i: number): string {
  const d = t.days[i];
  if (!d) return '∅';
  const names = new Map(t.spots.map((s) => [s.id, s.name]));
  return JSON.stringify([d.title ?? '', d.items.map((it) => [names.get(it.spotId) ?? it.spotId, it.time ?? '', it.note ?? ''])]);
}

function daysMentioned(ops: RelayOp[]): Set<number> {
  const out = new Set<number>();
  for (const op of ops) {
    const days = isObj(op.input) && Array.isArray(op.input.days) ? op.input.days : [];
    for (const d of days) if (isObj(d) && Number.isInteger(Number(d.day))) out.add(Number(d.day));
  }
  return out;
}

/** Spot fields the plan cares about (research is kept separately). */
const spotSig = (s: TripSnapshot['spots'][number]) =>
  JSON.stringify([s.name, s.category, s.address ?? '', s.lat ?? null, s.lng ?? null, s.note ?? '', s.durationMin ?? null]);

/**
 * What the earlier reply changed (base → current) that the new result quietly puts back,
 * described for the confirm dialog. Days the new block mentions are its own decision.
 */
function droppedChanges(base: TripSnapshot, current: TripSnapshot, result: TripSnapshot, ops: RelayOp[]): string[] {
  const out: string[] = [];
  const reverted = (b: unknown, c: unknown, r: unknown) => c !== b && r === b;

  if (reverted(base.name, current.name, result.name)) out.push(`旅程名稱會改回「${base.name}」`);
  if (reverted(base.destination, current.destination, result.destination)) out.push(`目的地會改回「${base.destination || '未設定'}」`);
  if (reverted(base.startDate, current.startDate, result.startDate)) out.push(`出發日期會改回 ${base.startDate ?? '未設定'}`);

  const mentioned = daysMentioned(ops);
  const back: number[] = [];
  const removed: number[] = [];
  for (let i = 0; i < Math.max(base.days.length, current.days.length); i++) {
    if (mentioned.has(i + 1)) continue;
    if (i < current.days.length && i >= result.days.length) removed.push(i + 1);
    else if (daySig(current, i) !== daySig(base, i) && daySig(result, i) === daySig(base, i)) back.push(i + 1);
  }
  if (removed.length) out.push(`第 ${removed.join('、')} 天會被刪除`);
  if (back.length) out.push(`第 ${back.join('、')} 天會回到原本的安排`);

  const byName = (t: TripSnapshot) => new Map(t.spots.map((s) => [nameKey(s.name), s]));
  const b = byName(base);
  const r = byName(result);
  const gone: string[] = [];
  const undone: string[] = [];
  for (const s of current.spots) {
    const k = nameKey(s.name);
    const was = b.get(k);
    if (!was && !r.has(k)) gone.push(s.name);
    else if (was && spotSig(s) !== spotSig(was) && r.get(k) && spotSig(r.get(k)!) === spotSig(was)) undone.push(s.name);
  }
  const cur = byName(current);
  const restored = base.spots.filter((s) => !cur.has(nameKey(s.name)) && r.has(nameKey(s.name))).map((s) => s.name);
  if (gone.length) out.push(`先前新增的「${gone.join('、')}」會被移除`);
  if (undone.length) out.push(`「${undone.join('、')}」先前改過的資料會還原`);
  if (restored.length) out.push(`先前刪除的「${restored.join('、')}」會恢復`);
  return out;
}

/**
 * Re-applying a block from the request's starting point creates its new places again with new
 * ids; give them back the ids they already have in the trip, so other requests' references hold.
 */
function keepPlaceIds(result: TripSnapshot, requestBase: TripSnapshot, current: TripSnapshot): TripSnapshot {
  const baseIds = new Set(requestBase.spots.map((s) => s.id));
  const taken = new Set(result.spots.map((s) => s.id));
  const existing = new Map(current.spots.map((s) => [nameKey(s.name), s.id]));
  const remap = new Map<string, string>();
  for (const s of result.spots) {
    if (baseIds.has(s.id)) continue;
    const old = existing.get(nameKey(s.name));
    if (old && old !== s.id && !taken.has(old)) {
      remap.set(s.id, old);
      taken.add(old);
    }
  }
  if (!remap.size) return result;
  return {
    ...result,
    spots: result.spots.map((s) => (remap.has(s.id) ? { ...s, id: remap.get(s.id)! } : s)),
    days: result.days.map((d) => ({ ...d, items: d.items.map((it) => (remap.has(it.spotId) ? { ...it, spotId: remap.get(it.spotId)! } : it)) })),
  };
}

/**
 * Decides what pasting `raw` into `trip` should do.
 *
 * Each block holds ALL changes for its request, so a newer reply to the same request
 * replaces the one applied before: when that reply is still exactly what the trip shows,
 * the trip goes back to how it was before the request and the new block applies there.
 * Otherwise blocks apply to the current trip, and anything surprising asks first.
 */
export function planRelayApply(raw: string, trip: Trip, otherTrips: Pick<Trip, 'name' | 'chat'>[]): RelayDecision {
  if (looksLikeOwnPrompt(raw)) return { kind: 'own-prompt' };
  const parsed = parseRelayReply(raw);
  if (!parsed.message && !parsed.ops && !parsed.problems.length) return { kind: 'empty' };
  if (!parsed.ops) return { kind: 'message-only', parsed };

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

  const canReplace = !!latest && latest.relayResult === currentFp && !!latest.relayStart;
  // An empty block only means something as "drop this request's changes"; one whose operations
  // were all unusable is a broken block, never a revert.
  if (!parsed.ops.length && (parsed.problems.length || !canReplace)) {
    return { kind: 'message-only', parsed, cannotRevert: !parsed.problems.length && !!latest };
  }

  let requestBase = current;
  let start = current;
  let confirm: RelayConfirm | null = null;
  let replaces: string | undefined;
  if (!sent) {
    confirm = 'unknown-send';
  } else if (latest) {
    if (canReplace) {
      requestBase = latest.relayStart!;
      start = withResearch(requestBase, current);
      replaces = latest.id;
      if (parsed.rev && latest.relayRev && parsed.rev < latest.relayRev) confirm = 'older-version';
    } else {
      confirm = 'edited-after-reply';
    }
  } else if (sent.relay!.fp !== currentFp) {
    confirm = 'edited-since-send';
  }

  const applyAt = (from: TripSnapshot) => {
    const r = applyRelayOps(from, parsed.ops!);
    const trip = from === current ? r.trip : keepPlaceIds(r.trip, requestBase, current);
    return { ...r, trip: withResearch(trip, current) };
  };
  const result = applyAt(start);
  const dropped = replaces && parsed.ops.length ? droppedChanges(requestBase, current, result.trip, parsed.ops) : [];
  const onCurrent = dropped.length ? applyAt(current) : undefined;
  return {
    kind: 'apply',
    parsed,
    before: current,
    requestBase,
    confirm,
    replaces,
    replacesRev: latest?.relayRev,
    replacesBroken: !!replaces && !!latest?.relayFix,
    revertsRequest: !!replaces && !parsed.ops.length,
    result,
    opsFp,
    issues: [...parsed.problems, ...result.errors],
    dropped,
    onCurrent,
    onCurrentIssues: onCurrent ? [...parsed.problems, ...onCurrent.errors] : undefined,
  };
}
