/* OpenAI (ChatGPT) and OpenAI-compatible endpoints, called with fetch so any
 * base URL works (OpenAI, Azure-style proxies, DeepSeek, Qwen, OpenRouter...). */
import type { SearchSource, SpotSearchResult } from '../../types';
import { applyToolCall, TOOL_DEFS } from './agentTools';
import { FriendlyError, MAX_AGENT_STEPS, type TurnInput, type TurnResult } from './types';

interface OAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type OAIMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OAIToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export function isOfficialOpenAI(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

function base(url: string) {
  return url.replace(/\/+$/, '');
}

async function post(baseUrl: string, path: string, key: string, body: unknown, signal?: AbortSignal) {
  let res: Response;
  try {
    res = await fetch(`${base(baseUrl)}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new FriendlyError('無法連線到 API，請檢查網路或 Base URL（服務需允許瀏覽器跨網域請求）。');
  }
  if (!res.ok) throw await httpError(res);
  return res;
}

async function httpError(res: Response): Promise<Error> {
  let detail = '';
  try {
    const j = await res.json();
    detail = j?.error?.message ?? JSON.stringify(j);
  } catch {
    detail = res.statusText;
  }
  if (res.status === 401) return new FriendlyError('API 金鑰無效，請到設定檢查。');
  if (res.status === 404) return new FriendlyError(`找不到模型或端點：${detail}`);
  if (res.status === 429) return new FriendlyError(`請求太頻繁或額度不足：${detail}`);
  return new FriendlyError(`API 錯誤（${res.status}）：${detail}`);
}

async function* sse(res: Response): AsyncGenerator<Record<string, any>> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        yield JSON.parse(data);
      } catch {
        /* keep-alive or partial line */
      }
    }
  }
}

export async function openaiChatTurn(
  apiKey: string,
  model: string,
  baseUrl: string,
  input: TurnInput,
): Promise<TurnResult> {
  const tools = TOOL_DEFS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const messages: OAIMessage[] = [
    { role: 'system', content: input.system },
    ...input.history.map((h) => ({ role: h.role, content: h.text }) as OAIMessage),
    { role: 'user', content: input.userText },
  ];
  let trip = input.trip;
  let shown = '';
  const actions: string[] = [];

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    const res = await post(baseUrl, '/chat/completions', apiKey, { model, messages, tools, stream: true }, input.signal);
    const prefix = shown ? `${shown}\n\n` : '';
    let content = '';
    const calls: { id: string; name: string; args: string }[] = [];
    let finish = '';
    for await (const chunk of sse(res)) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const d = choice.delta ?? {};
      if (typeof d.content === 'string' && d.content) {
        content += d.content;
        input.cb.onText(prefix + content);
      }
      for (const tc of d.tool_calls ?? []) {
        const c = (calls[tc.index ?? 0] ??= { id: '', name: '', args: '' });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
        input.cb.onStatus('正在更新行程…');
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    content = content.trim();
    if (content) shown = prefix + content;
    input.cb.onText(shown);

    const valid = calls.filter(Boolean);
    if (!valid.length) break;
    if (finish === 'length') {
      shown += `${shown ? '\n\n' : ''}（回覆太長被截斷，行程沒有修改。請把需求拆小一點再試。）`;
      break;
    }
    messages.push({
      role: 'assistant',
      content: content || null,
      tool_calls: valid.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })),
    });
    for (const c of valid) {
      let args: unknown;
      try {
        args = JSON.parse(c.args || '{}');
      } catch {
        messages.push({ role: 'tool', tool_call_id: c.id, content: 'INVALID_JSON：參數不是有效的 JSON，沒有套用。請重新送出。' });
        continue;
      }
      const r = applyToolCall(trip, c.name, args);
      trip = r.trip;
      if (r.summary.length) {
        actions.push(...r.summary);
        input.cb.onApply(trip, r.summary);
      }
      messages.push({ role: 'tool', tool_call_id: c.id, content: r.isError ? `錯誤：${r.result}` : r.result });
    }
    input.cb.onStatus('');
  }
  return { text: shown, actions, sources: [] };
}

/** Uses the Responses API web search on api.openai.com; plain model knowledge elsewhere. */
export async function openaiSearchSpot(
  apiKey: string,
  model: string,
  baseUrl: string,
  prompt: string,
): Promise<SpotSearchResult> {
  if (isOfficialOpenAI(baseUrl)) {
    let lastErr: unknown;
    for (const toolType of ['web_search', 'web_search_preview']) {
      try {
        const res = await post(baseUrl, '/responses', apiKey, { model, input: prompt, tools: [{ type: toolType }] });
        const data = await res.json();
        const sources = new Map<string, SearchSource>();
        let summary = '';
        for (const item of data.output ?? []) {
          if (item.type !== 'message') continue;
          for (const part of item.content ?? []) {
            if (part.type !== 'output_text') continue;
            summary += part.text;
            for (const a of part.annotations ?? []) {
              if (a.type === 'url_citation' && a.url && !sources.has(a.url)) {
                sources.set(a.url, { title: a.title || a.url, url: a.url });
              }
            }
          }
        }
        return { summary: summary.trim(), sources: [...sources.values()], provider: `ChatGPT（${model}）`, at: Date.now() };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }
  const res = await post(baseUrl, '/chat/completions', apiKey, {
    model,
    messages: [{ role: 'user', content: `${prompt}\n\n（目前無法連網搜尋，請依你已知的資訊回答，並提醒資訊可能過時。）` }],
  });
  const data = await res.json();
  const summary = String(data?.choices?.[0]?.message?.content ?? '').trim();
  return { summary, sources: [], provider: `${model}（未連網）`, at: Date.now() };
}

export async function openaiListModels(apiKey: string, baseUrl: string): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`${base(baseUrl)}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  } catch {
    throw new FriendlyError('無法連線到 API，請檢查網路或 Base URL。');
  }
  if (!res.ok) throw await httpError(res);
  const data = await res.json();
  return ((data?.data ?? []) as { id: string }[]).map((m) => m.id).sort();
}
