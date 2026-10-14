import type { ChatMessage, Settings, Spot, SpotSearchResult, TripSnapshot } from '../../types';
import { CATEGORY_LABEL } from '../../types';
import { placeQuery } from '../maps';
import { describeTrip, SYSTEM_PROMPT, WEB_SEARCH_NOTE } from './agentTools';
import { isOfficialOpenAI, openaiChatTurn, openaiListModels, openaiSearchSpot } from './openai';
import { FriendlyError, type HistoryTurn, type TurnCallbacks, type TurnResult } from './types';

// The Claude SDK is loaded on first use to keep the initial page light on phones.
const claude = () => import('./claude');

export { FriendlyError };

/** How many earlier chat messages are sent along with each request. */
const HISTORY_LIMIT = 30;

/** True when an API key is set, so the app can talk to the AI directly. Otherwise relay mode applies. */
export function aiConfigured(s: Settings): boolean {
  if (s.provider === 'claude') return !!s.claudeKey.trim();
  if (s.provider === 'openai') return !!s.openaiKey.trim() && !!s.openaiBaseUrl.trim();
  return false;
}

export function providerLabel(s: Settings): string {
  if (!aiConfigured(s)) return '傳到你的 Claude / ChatGPT App（免金鑰）';
  return s.provider === 'claude' ? `Claude · ${s.claudeModel}` : `ChatGPT · ${s.openaiModel}`;
}

export function chatSupportsWebSearch(s: Settings): boolean {
  // Chat Completions has no general web search tool; only Claude searches during chat.
  return s.provider === 'claude';
}

/** Text-only history: earlier turns' tool calls are summarised in the assistant text. */
export function buildHistory(chat: ChatMessage[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  for (const m of chat.slice(-HISTORY_LIMIT)) {
    if (m.role === 'error') continue;
    let text = m.text.trim();
    if (m.role === 'assistant' && m.actions?.length) {
      text += `${text ? '\n\n' : ''}（這一輪已在 App 中執行：${m.actions.join('；')}）`;
    }
    if (!text) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === m.role) last.text += `\n\n${text}`;
    else turns.push({ role: m.role, text });
  }
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns;
}

export function buildSystemPrompt(trip: TripSnapshot, webSearch: boolean): string {
  return `${SYSTEM_PROMPT}${webSearch ? WEB_SEARCH_NOTE : ''}\n\n${describeTrip(trip)}`;
}

export async function runChatTurn(opts: {
  settings: Settings;
  trip: TripSnapshot;
  chat: ChatMessage[];
  userText: string;
  signal: AbortSignal;
  cb: TurnCallbacks;
}): Promise<TurnResult> {
  const s = opts.settings;
  if (!aiConfigured(s)) throw new FriendlyError('請先到「設定」填入 Claude 或 ChatGPT 的 API 金鑰。');
  const webSearch = s.chatWebSearch && chatSupportsWebSearch(s);
  const input = {
    system: buildSystemPrompt(opts.trip, webSearch),
    history: buildHistory(opts.chat),
    userText: opts.userText,
    trip: opts.trip,
    webSearch,
    signal: opts.signal,
    cb: opts.cb,
  };
  return s.provider === 'claude'
    ? (await claude()).claudeChatTurn(s.claudeKey.trim(), s.claudeModel.trim(), input)
    : openaiChatTurn(s.openaiKey.trim(), s.openaiModel.trim(), s.openaiBaseUrl.trim(), input);
}

export function spotSearchPrompt(spot: Spot, destination: string, listSources = false): string {
  const food = spot.category !== 'sight';
  const sections = food
    ? '**簡介**、**營業時間**、**價位**、**招牌菜**、**是否需要訂位**、**交通方式**、**注意事項**'
    : '**簡介**、**開放時間**、**門票**、**建議停留時間**、**交通方式**、**推薦重點**、**注意事項**';
  return `請用網路搜尋這個${CATEGORY_LABEL[spot.category]}的最新資訊：「${placeQuery(spot, destination)}」${
    spot.note ? `（使用者備註：${spot.note}）` : ''
  }。
用繁體中文（台灣用語）整理成以下段落，沒有資料的段落就省略，每段 1–3 行，精簡實用：
${sections}
如果找到的地點可能不是同一個（例如同名分店），請在開頭提醒。${
    listSources ? '請搜尋網路上的最新資訊，並在最後列出參考來源網址。' : '不需要在最後另外列出參考網址。'
  }`;
}

export async function searchSpot(settings: Settings, spot: Spot, destination: string): Promise<SpotSearchResult> {
  if (!aiConfigured(settings)) throw new FriendlyError('請先到「設定」填入 Claude 或 ChatGPT 的 API 金鑰。');
  const prompt = spotSearchPrompt(spot, destination);
  if (settings.provider === 'claude') {
    return (await claude()).claudeSearchSpot(settings.claudeKey.trim(), settings.claudeModel.trim(), prompt);
  }
  return openaiSearchSpot(settings.openaiKey.trim(), settings.openaiModel.trim(), settings.openaiBaseUrl.trim(), prompt);
}

export function spotSearchIsLive(settings: Settings): boolean {
  return settings.provider === 'claude' || isOfficialOpenAI(settings.openaiBaseUrl);
}

export async function listModels(settings: Settings): Promise<string[]> {
  if (settings.provider === 'claude') return (await claude()).claudeListModels(settings.claudeKey.trim());
  return openaiListModels(settings.openaiKey.trim(), settings.openaiBaseUrl.trim());
}
