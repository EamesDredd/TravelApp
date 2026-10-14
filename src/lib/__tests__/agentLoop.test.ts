import { afterEach, describe, expect, it, vi } from 'vitest';
import { runChatTurn } from '../ai';
import { DEFAULT_SETTINGS } from '../../store';
import type { Settings, TripSnapshot } from '../../types';

const trip: TripSnapshot = {
  name: '京都',
  destination: '京都',
  days: [{ id: 'd1', items: [] }],
  spots: [
    { id: 's_kiyo', name: '清水寺', category: 'sight', lat: 34.9949, lng: 135.785 },
    { id: 's_inar', name: '伏見稻荷大社', category: 'sight', lat: 34.9671, lng: 135.7727 },
  ],
};

function sse(events: Array<Record<string, unknown>>, named = true): Response {
  const body = events
    .map((e) => (named ? `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n` : `data: ${JSON.stringify(e)}\n\n`))
    .join('');
  return new Response(named ? body : `${body}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function claudeMessage(blocks: Array<Record<string, unknown>>, stop: string) {
  const ev: Array<Record<string, unknown>> = [
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
  ];
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      ev.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      ev.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
    } else {
      ev.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      for (const part of b.json as string[]) {
        ev.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: part } });
      }
    }
    ev.push({ type: 'content_block_stop', index });
  });
  ev.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  ev.push({ type: 'message_stop' });
  return sse(ev);
}

const settings = (patch: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...patch });

afterEach(() => vi.unstubAllGlobals());

function run(s: Settings) {
  const applied: TripSnapshot[] = [];
  const texts: string[] = [];
  const promise = runChatTurn({
    settings: s,
    trip,
    chat: [],
    userText: '幫我排第一天',
    signal: new AbortController().signal,
    cb: { onText: (t) => texts.push(t), onStatus: () => {}, onApply: (t) => applied.push(t) },
  });
  return { promise, applied, texts };
}

describe('Claude agent loop', () => {
  it('streams, applies a tool call, returns the result and finishes', async () => {
    const requests: Array<{ url: string; headers: Headers; body: any }> = [];
    const replies = [
      claudeMessage(
        [
          { type: 'text', text: '好的，' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'set_day_plans',
            json: ['{"days":[{"day":1,"title":"南禪', '寺一帶","items":[{"spot_id":"s_kiyo","time":"09:00"},', '{"spot_id":"s_inar","time":"13:00"}]}]}'],
          },
        ],
        'tool_use',
      ),
      claudeMessage([{ type: 'text', text: '已排好第一天。' }], 'end_turn'),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        requests.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
        return replies.shift()!;
      }),
    );

    const { promise, applied, texts } = run(settings({ provider: 'claude', claudeKey: 'sk-ant-test' }));
    const res = await promise;

    expect(res.text).toBe('好的，\n\n已排好第一天。');
    expect(res.actions).toEqual(['更新第 1 天行程']);
    expect(applied).toHaveLength(1);
    expect(applied[0].days[0].title).toBe('南禪寺一帶');
    expect(applied[0].days[0].items.map((i) => i.spotId)).toEqual(['s_kiyo', 's_inar']);
    expect(texts.at(-1)).toBe('好的，\n\n已排好第一天。');

    expect(requests).toHaveLength(2);
    const [first, second] = requests;
    expect(first.url).toContain('/v1/messages');
    expect(first.headers.get('x-api-key')).toBe('sk-ant-test');
    expect(first.headers.get('anthropic-dangerous-direct-browser-access')).toBe('true');
    expect(first.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(first.body).toMatchObject({ model: 'claude-opus-5-5', stream: true, fallbacks: 'default', output_config: { effort: 'medium' } });
    expect(first.body.thinking).toBeUndefined();
    expect(first.body.system[0].text).toContain('s_kiyo | 景點 | 清水寺');
    const tools = first.body.tools as Array<Record<string, unknown>>;
    expect(tools.map((t) => t.name)).toEqual(['add_candidates', 'set_day_plans', 'update_spots', 'update_trip', 'web_search']);
    expect(tools.find((t) => t.name === 'web_search')).toMatchObject({ type: 'web_search_20260209' });
    expect(tools[0].eager_input_streaming).toBe(true);

    // Second call: same system prompt, assistant turn echoed back, then the tool result.
    expect(second.body.system).toEqual(first.body.system);
    const msgs = second.body.messages;
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].content[1]).toMatchObject({ type: 'tool_use', id: 'toolu_1', name: 'set_day_plans' });
    expect(msgs[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
    expect(msgs[2].content[0].content).toContain('[s_inar]');
  });

  it('refuses to apply a tool call whose JSON is malformed', async () => {
    const replies = [
      claudeMessage(
        [{ type: 'tool_use', id: 'toolu_1', name: 'set_day_plans', json: ['{"days":[{"day":1,"items":[{"spot_id":"s_kiyo"}'] }],
        'tool_use',
      ),
      claudeMessage([{ type: 'text', text: '抱歉，我重新整理。' }], 'end_turn'),
    ];
    const bodies: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return replies.shift()!;
      }),
    );
    const { promise, applied } = run(settings({ provider: 'claude', claudeKey: 'k', claudeModel: 'claude-haiku-5-5' }));
    const res = await promise;
    expect(applied).toHaveLength(0);
    expect(res.actions).toEqual([]);
    const result = bodies[1].messages[2].content[0];
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('INVALID_JSON');
    // Haiku: no refusal fallbacks, basic web search tool.
    expect(bodies[0].fallbacks).toBeUndefined();
    expect(bodies[0].tools.at(-1).type).toBe('web_search_20250305');
  });
});

describe('OpenAI-compatible agent loop', () => {
  it('accumulates streamed tool calls and applies them', async () => {
    const replies = [
      sse(
        [
          { choices: [{ index: 0, delta: { role: 'assistant', content: '我先加入候選。' } }] },
          {
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'add_candidates', arguments: '' } }] },
              },
            ],
          },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"spots":[{"name":"金閣寺",' } }] } }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"category":"sight"}]}' } }] } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ],
        false,
      ),
      sse([{ choices: [{ index: 0, delta: { content: '完成！' }, finish_reason: 'stop' }] }], false),
    ];
    const requests: Array<{ url: string; headers: Headers; body: any }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        requests.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
        return replies.shift()!;
      }),
    );
    const { promise, applied } = run(
      settings({ provider: 'openai', openaiKey: 'sk-test', openaiModel: 'gpt-5.5', openaiBaseUrl: 'https://api.openai.com/v1/' }),
    );
    const res = await promise;
    expect(res.text).toBe('我先加入候選。\n\n完成！');
    expect(res.actions).toEqual(['新增 1 個候選地點']);
    expect(applied[0].spots.map((s) => s.name)).toContain('金閣寺');
    expect(requests[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(requests[0].headers.get('authorization')).toBe('Bearer sk-test');
    expect(requests[0].body.messages[0].role).toBe('system');
    const second = requests[1].body.messages;
    expect(second.at(-2)).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'add_candidates' } }] });
    expect(second.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
  });

  it('reports a bad key in plain language', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })));
    const { promise } = run(settings({ provider: 'openai', openaiKey: 'x' }));
    await expect(promise).rejects.toThrow('API 金鑰無效');
  });
});
