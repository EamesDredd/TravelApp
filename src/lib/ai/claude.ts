import Anthropic from '@anthropic-ai/sdk';
import type { SearchSource, SpotSearchResult } from '../../types';
import { applyToolCall, TOOL_DEFS } from './agentTools';
import { FriendlyError, MAX_AGENT_STEPS, type TurnInput, type TurnResult } from './types';

type Beta = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

function client(apiKey: string) {
  // The key belongs to the user and stays in their browser; requests go straight to Anthropic.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
}

/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
const FALLBACK_MODELS = /^claude-(opus-5|sonnet-5-5|fable-5)/;
/** Models that take `output_config.effort`. */
const EFFORT_MODELS = /^claude-(opus-5|opus-4-[5-8]|sonnet-5|sonnet-4-6|haiku-5|fable-5)/;
/** Models that support web search with dynamic filtering. */
const DYNAMIC_SEARCH_MODELS = /^claude-(opus-5|opus-4-[678]|sonnet-5|sonnet-4-6)/;

function modelParams(model: string, effort: 'low' | 'medium'): Partial<Beta> {
  const p: Partial<Beta> = {};
  if (FALLBACK_MODELS.test(model)) {
    // If a safety classifier declines, the API re-runs the request on Anthropic's recommended fallback model.
    p.betas = ['server-side-fallback-2026-07-01'];
    p.fallbacks = 'default';
  }
  if (EFFORT_MODELS.test(model)) p.output_config = { effort };
  return p;
}

function webSearchTool(model: string, maxUses: number): Anthropic.Beta.BetaToolUnion {
  return DYNAMIC_SEARCH_MODELS.test(model)
    ? { type: 'web_search_20260209', name: 'web_search', max_uses: maxUses }
    : { type: 'web_search_20250305', name: 'web_search', max_uses: maxUses };
}

function friendly(err: unknown): Error {
  if (err instanceof Anthropic.APIUserAbortError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new FriendlyError('Claude API 金鑰無效，請到設定檢查。');
  if (err instanceof Anthropic.PermissionDeniedError)
    return new FriendlyError(`這個 API 金鑰沒有權限使用此模型或功能：${err.message}`);
  if (err instanceof Anthropic.NotFoundError) return new FriendlyError(`找不到模型，請到設定確認模型名稱：${err.message}`);
  if (err instanceof Anthropic.RateLimitError) return new FriendlyError('請求太頻繁或額度不足，請稍後再試。');
  if (err instanceof Anthropic.BadRequestError) return new FriendlyError(`請求被拒絕：${err.message}`);
  if (err instanceof Anthropic.InternalServerError) return new FriendlyError('Claude 服務暫時忙碌，請稍後再試。');
  if (err instanceof Anthropic.APIConnectionError) return new FriendlyError('無法連線到 Claude API，請檢查網路。');
  if (err instanceof Anthropic.APIError) return new FriendlyError(`Claude API 錯誤（${err.status}）：${err.message}`);
  return err instanceof Error ? err : new Error(String(err));
}

function collectSources(blocks: Anthropic.Beta.BetaContentBlock[], into: Map<string, SearchSource>) {
  for (const b of blocks) {
    if (b.type !== 'text') continue;
    for (const c of b.citations ?? []) {
      if (c.type === 'web_search_result_location' && !into.has(c.url)) {
        into.set(c.url, { title: c.title || c.url, url: c.url });
      }
    }
  }
}

const textOf = (blocks: Anthropic.Beta.BetaContentBlock[]) =>
  blocks
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

export async function claudeChatTurn(apiKey: string, model: string, input: TurnInput): Promise<TurnResult> {
  const api = client(apiKey);
  const tools: Anthropic.Beta.BetaToolUnion[] = TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
    eager_input_streaming: true,
  }));
  if (input.webSearch) tools.push(webSearchTool(model, 5));

  // The system prompt (with the trip state) is frozen for the whole turn; changes made
  // by tools are reported back through tool results instead.
  const system: Anthropic.Beta.BetaTextBlockParam[] = [{ type: 'text', text: input.system }];
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...input.history.map((h) => ({ role: h.role, content: h.text })),
    { role: 'user', content: input.userText },
  ];

  let trip = input.trip;
  let shown = '';
  const actions: string[] = [];
  const sources = new Map<string, SearchSource>();

  try {
    for (let step = 0; step < MAX_AGENT_STEPS; step++) {
      const stream = api.beta.messages.stream(
        { model, max_tokens: 16000, system, tools, messages, ...modelParams(model, 'medium') },
        { signal: input.signal },
      );
      // Raw tool-input JSON per content block, so a truncated or malformed input
      // is rejected instead of being half-applied to the trip.
      const rawJson: Record<number, string> = {};
      let stepText = '';
      const prefix = shown ? `${shown}\n\n` : '';
      stream.on('streamEvent', (ev) => {
        if (ev.type === 'content_block_start') {
          if (ev.content_block.type === 'server_tool_use') input.cb.onStatus('正在搜尋網路…');
          else if (ev.content_block.type === 'tool_use') input.cb.onStatus('正在更新行程…');
          else if (ev.content_block.type === 'thinking') input.cb.onStatus('思考中…');
        } else if (ev.type === 'content_block_delta' && ev.delta.type === 'input_json_delta') {
          rawJson[ev.index] = (rawJson[ev.index] ?? '') + ev.delta.partial_json;
        }
      });
      stream.on('text', (delta) => {
        stepText += delta;
        input.cb.onText(prefix + stepText);
      });

      const msg = await stream.finalMessage();
      collectSources(msg.content, sources);
      const text = textOf(msg.content).trim();
      if (text) shown = prefix + text;
      input.cb.onText(shown);

      if (msg.stop_reason === 'refusal') {
        shown += `${shown ? '\n\n' : ''}（模型婉拒了這個請求，請換個說法再試。）`;
        break;
      }
      if (msg.stop_reason === 'pause_turn') {
        // A long server-side web search paused; send the turn back to let it continue.
        messages.push({ role: 'assistant', content: msg.content });
        continue;
      }
      const toolUses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (!toolUses.length) break;
      if (msg.stop_reason === 'max_tokens') {
        shown += `${shown ? '\n\n' : ''}（回覆太長被截斷，行程沒有修改。請把需求拆小一點再試。）`;
        break;
      }

      messages.push({ role: 'assistant', content: msg.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        const raw = rawJson[msg.content.indexOf(tu)];
        let args: unknown = tu.input;
        if (raw) {
          try {
            args = JSON.parse(raw);
          } catch {
            results.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              is_error: true,
              content: 'INVALID_JSON：參數不是完整有效的 JSON，沒有套用。請重新送出完整的呼叫。',
            });
            continue;
          }
        }
        const r = applyToolCall(trip, tu.name, args);
        trip = r.trip;
        if (r.summary.length) {
          actions.push(...r.summary);
          input.cb.onApply(trip, r.summary);
        }
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: r.result, ...(r.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
      input.cb.onStatus('');
    }
  } catch (err) {
    throw friendly(err);
  }
  return { text: shown, actions, sources: [...sources.values()] };
}

export async function claudeSearchSpot(apiKey: string, model: string, prompt: string): Promise<SpotSearchResult> {
  const api = client(apiKey);
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: prompt }];
  const sources = new Map<string, SearchSource>();
  let summary = '';
  try {
    for (let i = 0; i < 4; i++) {
      const msg = await api.beta.messages.create({
        model,
        max_tokens: 8000,
        tools: [webSearchTool(model, 4)],
        messages,
        ...modelParams(model, 'low'),
      });
      collectSources(msg.content, sources);
      summary += textOf(msg.content);
      if (msg.stop_reason === 'refusal') {
        summary ||= '（模型婉拒了這個搜尋請求。）';
        break;
      }
      if (msg.stop_reason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: msg.content });
    }
  } catch (err) {
    throw friendly(err);
  }
  return { summary: summary.trim(), sources: [...sources.values()], provider: `Claude（${model}）`, at: Date.now() };
}

export async function claudeListModels(apiKey: string): Promise<string[]> {
  const api = client(apiKey);
  const ids: string[] = [];
  try {
    for await (const m of api.models.list({ limit: 100 })) ids.push(m.id);
  } catch (err) {
    throw friendly(err);
  }
  return ids;
}
