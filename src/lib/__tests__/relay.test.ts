import { describe, expect, it } from 'vitest';
import {
  applyRelayOps,
  buildFixPrompt,
  buildRelayPrompt,
  buildRelaySearchPrompt,
  looksLikeOwnPrompt,
  newRelayTag,
  parseRelayReply,
  planRelayApply,
  RELAY_MARKER,
  tripFingerprint,
  type RelayDecision,
} from '../ai/relay';
import type { ChatMessage, Trip, TripSnapshot } from '../../types';

function sample(): TripSnapshot {
  return {
    name: '京都',
    destination: '京都',
    startDate: '2026-11-18',
    days: [
      { id: 'd1', items: [] },
      { id: 'd2', items: [{ id: 'i1', spotId: 's_inar' }] },
      { id: 'd3', items: [] },
    ],
    spots: [
      { id: 's_kiyo', name: '清水寺', category: 'sight', lat: 34.9949, lng: 135.785 },
      { id: 's_inar', name: '伏見稻荷大社', category: 'sight', lat: 34.9671, lng: 135.7727 },
      { id: 's_kink', name: '金閣寺', category: 'sight', lat: 35.0394, lng: 135.7292 },
    ],
  };
}

function trip(snap = sample(), chat: ChatMessage[] = []): Trip {
  return { ...snap, id: 't1', mapRegion: 'auto', chat, createdAt: 0, updatedAt: 0 };
}

const block = (obj: unknown) => '```travelplan\n' + JSON.stringify(obj, null, 2) + '\n```';
const day = (n: number, ...ids: string[]) => ({ day: n, items: ids.map((id) => ({ spot_id: id })) });
const plan = (base: string | undefined, ...days: object[]) =>
  `好的。\n\n${block({ ...(base ? { base } : {}), ops: [{ tool: 'set_day_plans', input: { days } }] })}`;

/** Mirrors what ChatPanel commits for an accepted 'apply' decision. */
function commit(t: Trip, d: RelayDecision): Trip {
  if (d.kind !== 'apply') throw new Error(`expected apply, got ${d.kind}`);
  const resultFp = tripFingerprint(d.result.trip);
  return {
    ...t,
    ...d.result.trip,
    chat: [
      ...t.chat,
      { id: `a${t.chat.length}`, role: 'assistant', text: '', at: 0, relayBase: d.parsed.base, relayResult: resultFp, relayOps: d.opsFp, undo: d.before },
    ],
  };
}

function sent(t: Trip, tag: string): Trip {
  return { ...t, chat: [...t.chat, { id: `u${t.chat.length}`, role: 'user', text: 'req', at: 0, relay: { tag, fp: tripFingerprint(t) } }] };
}

const dayIds = (t: TripSnapshot) => t.days.map((d) => d.items.map((i) => i.spotId));

describe('fingerprints and tags', () => {
  it('trip fingerprint is stable, ignores cached searches and changes with the plan', () => {
    const a = sample();
    const b = structuredClone(a);
    b.spots[0].search = { summary: 'x', sources: [], provider: 'p', at: 1 };
    expect(tripFingerprint(a)).toBe(tripFingerprint(b));
    b.days[0].items.push({ id: 'i9', spotId: 's_kiyo' });
    expect(tripFingerprint(b)).not.toBe(tripFingerprint(a));
  });

  it('makes distinct short tags', () => {
    const tags = new Set(Array.from({ length: 50 }, newRelayTag));
    expect(tags.size).toBe(50);
    for (const t of tags) expect(t).toMatch(/^[a-z0-9]{6}$/);
  });
});

describe('outgoing messages', () => {
  it('chat prompt carries the marker, request, tag, format, tools and the trip', () => {
    const p = buildRelayPrompt(sample(), '  幫我按遠近排 ', 'abc123', new Date(2026, 9, 14));
    expect(p.startsWith(RELAY_MARKER)).toBe(true);
    expect(p).toContain('## 我的需求\n幫我按遠近排\n');
    expect(p).toContain('"base" 固定寫 "abc123"');
    expect(p).toContain('```travelplan\n{"base":"abc123","ops":[');
    expect(p).toContain('只要列出「這次要做的修改」');
    for (const t of ['add_candidates', 'set_day_plans', 'update_spots', 'update_trip']) expect(p).toContain(`### ${t}`);
    expect(p).toContain('s_kiyo | 景點 | 清水寺 | 34.99490,135.78500');
  });

  it('every outgoing message is recognised if pasted back', () => {
    expect(looksLikeOwnPrompt(buildRelayPrompt(sample(), 'x', 'abc123'))).toBe(true);
    expect(looksLikeOwnPrompt(buildRelaySearchPrompt('請搜尋清水寺'))).toBe(true);
    expect(looksLikeOwnPrompt(buildFixPrompt('abc123', ['找不到 spot_id s_x']))).toBe(true);
    expect(looksLikeOwnPrompt('好的，以下是安排')).toBe(false);
  });

  it('fix prompt lists the problems and keeps the tag', () => {
    const f = buildFixPrompt('abc123', ['第3天未更新：缺少 name']);
    expect(f).toContain('- 第3天未更新：缺少 name');
    expect(f).toContain('base 一樣寫 "abc123"');
  });
});

describe('parseRelayReply', () => {
  const ops = [{ tool: 'set_day_plans', input: { days: [day(1, 's_kiyo')] } }];

  it('splits the explanation from the block', () => {
    const r = parseRelayReply(`好的，第 1 天先去清水寺。\n\n${block({ base: 'abc123', ops })}\n`);
    expect(r).toMatchObject({ base: 'abc123', ops, problems: [], message: '好的，第 1 天先去清水寺。' });
  });

  it('accepts just the block, or bare JSON', () => {
    expect(parseRelayReply(block({ base: 'x', ops })).ops).toEqual(ops);
    expect(parseRelayReply(JSON.stringify({ ops })).ops).toEqual(ops);
  });

  it('accepts text copied without the fence markers', () => {
    const r = parseRelayReply(`說明文字\n\ntravelplan\n${JSON.stringify({ base: 'b', ops }, null, 2)}\n\n祝旅途愉快`);
    expect(r.ops).toEqual(ops);
    expect(r.message).toBe('說明文字\n\n祝旅途愉快');
  });

  it('uses the last block when the reply has several', () => {
    const first = [{ tool: 'update_trip', input: { name: '舊' } }];
    expect(parseRelayReply(`${block({ base: 'b', ops: first })}\n修正：\n${block({ base: 'b', ops })}`).ops).toEqual(ops);
  });

  it('never falls back to an earlier block when the latest one is cut off', () => {
    const first = [{ tool: 'update_trip', input: { name: '舊' } }];
    const r = parseRelayReply(`${block({ base: 'b', ops: first })}\n修正：\n\`\`\`travelplan\n{"base":"b","ops":[{"tool":"set_day`);
    expect(r.ops).toBeNull();
    expect(r.problems.join()).toContain('不完整');
  });

  it('ignores braces inside strings and other code blocks', () => {
    const tricky = [{ tool: 'update_spots', input: { updates: [{ spot_id: 's_kiyo', note: 'a } { b' }] } }];
    expect(parseRelayReply('```js\nconst x = {a: 1}\n```\n' + block({ base: 'b', ops: tricky })).ops).toEqual(tricky);
  });

  it('tolerates smart quotes', () => {
    const r = parseRelayReply('```travelplan\n{“base”:“b”,“ops”:[{“tool”:“update_trip”,“input”:{“name”:“新”}}]}\n```');
    expect(r.ops).toEqual([{ tool: 'update_trip', input: { name: '新' } }]);
  });

  it('reports a truncated block instead of applying it', () => {
    const r = parseRelayReply('好的\n```travelplan\n{"base":"b","ops":[{"tool":"set_day_plans","input":{"days":[');
    expect(r.ops).toBeNull();
    expect(r.problems.join()).toContain('不完整');
  });

  it('keeps known operations and reports unknown ones', () => {
    const r = parseRelayReply(block({ ops: [{ tool: 'drop_tables', input: {} }, ...ops, 'x'] }));
    expect(r.ops).toEqual(ops);
    expect(r.problems).toHaveLength(2);
  });

  it('treats a discussion-only reply as having no operations', () => {
    const r = parseRelayReply('我建議第二天別排太滿，可以把伏見稻荷改到清晨。');
    expect(r).toMatchObject({ ops: null, problems: [] });
  });
});

describe('applyRelayOps', () => {
  it('maps a repeated new place to one spot and reports failures', () => {
    const newSpot = { name: '奧丹 清水', category: 'meal', lat: 34.995, lng: 135.781 };
    const r = applyRelayOps(sample(), [
      { tool: 'set_day_plans', input: { days: [{ day: 1, items: [{ new_spot: newSpot }] }, { day: 4, items: [{ new_spot: newSpot }] }] } },
      { tool: 'update_spots', input: { updates: [{ spot_id: 's_nope', note: 'x' }] } },
    ]);
    const added = r.trip.spots.filter((s) => s.name === '奧丹 清水');
    expect(added).toHaveLength(1);
    expect(r.trip.days[3].items[0].spotId).toBe(added[0].id);
    expect(r.errors).toEqual(['找不到 spot_id s_nope']);
  });
});

describe('planRelayApply', () => {
  it('refuses our own outgoing message and empty text', () => {
    expect(planRelayApply(buildRelayPrompt(sample(), 'x', 'abc123'), trip(), []).kind).toBe('own-prompt');
    expect(planRelayApply('   ', trip(), []).kind).toBe('empty');
  });

  it('applies a reply to the request it answers without asking', () => {
    const t = sent(trip(), 'tag001');
    const d = planRelayApply(plan('tag001', day(1, 's_kiyo')), t, []);
    expect(d.kind).toBe('apply');
    if (d.kind !== 'apply') return;
    expect(d.confirm).toBeNull();
    expect(d.issues).toEqual([]);
    expect(dayIds(d.result.trip)).toEqual([['s_kiyo'], ['s_inar'], []]);
  });

  it('builds a follow-up reply on top of the earlier one instead of reverting it', () => {
    let t = sent(trip(), 'tag001');
    t = commit(t, planRelayApply(plan('tag001', day(1, 's_kiyo'), day(3, 's_kink')), t, []));
    const d = planRelayApply(plan('tag001', day(2, 's_inar', 's_kink')), t, []);
    if (d.kind !== 'apply') throw new Error(d.kind);
    expect(d.confirm).toBeNull();
    expect(dayIds(d.result.trip)).toEqual([['s_kiyo'], ['s_inar', 's_kink'], ['s_kink']]);
  });

  it('keeps replies from two separate requests made from the same version', () => {
    let t = sent(sent(trip(), 'aaaaaa'), 'bbbbbb');
    t = commit(t, planRelayApply(plan('aaaaaa', day(1, 's_kiyo')), t, []));
    const d = planRelayApply(plan('bbbbbb', day(3, 's_kink')), t, []);
    if (d.kind !== 'apply') throw new Error(d.kind);
    // The trip moved on through request A's reply, so B asks before applying — and A's change survives.
    expect(d.confirm).toBe('edited-since-send');
    expect(dayIds(d.result.trip)).toEqual([['s_kiyo'], ['s_inar'], ['s_kink']]);
  });

  it('asks when the trip was edited after sending', () => {
    let t = sent(trip(), 'tag001');
    t = { ...t, days: t.days.map((d, i) => (i === 1 ? { ...d, items: [] } : d)) };
    const d = planRelayApply(plan('tag001', day(1, 's_kiyo')), t, []);
    expect(d.kind === 'apply' && d.confirm).toBe('edited-since-send');
  });

  it('does not ask again after undoing a later reply to the same request', () => {
    let t = sent(trip(), 'tag001');
    t = commit(t, planRelayApply(plan('tag001', day(1, 's_kiyo')), t, []));
    const afterFirst = structuredClone(t);
    t = commit(t, planRelayApply(plan('tag001', day(3, 's_kink')), t, []));
    // Undo the second reply.
    const second = t.chat[t.chat.length - 1];
    t = { ...t, ...second.undo!, chat: t.chat.map((m) => (m === second ? { ...m, undo: undefined, undone: true } : m)) };
    expect(dayIds(t)).toEqual(dayIds(afterFirst));
    const d = planRelayApply(plan('tag001', day(2, 's_kink')), t, []);
    expect(d.kind === 'apply' && d.confirm).toBeNull();
  });

  it('recognises the same reply pasted twice, but allows it again after undo', () => {
    let t = sent(trip(), 'tag001');
    const reply = plan('tag001', day(1, 's_kiyo'));
    t = commit(t, planRelayApply(reply, t, []));
    expect(planRelayApply(reply, t, []).kind).toBe('duplicate');
    t = { ...t, chat: t.chat.map((m) => (m.relayOps ? { ...m, undone: true, undo: undefined } : m)) };
    expect(planRelayApply(reply, t, []).kind).toBe('apply');
  });

  it("refuses a reply that belongs to another trip's request", () => {
    const other = sent(trip(), 'osaka1');
    const d = planRelayApply(plan('osaka1', day(1, 's_kiyo')), trip(), [{ ...other, name: '大阪' }]);
    expect(d).toEqual({ kind: 'other-trip', tripName: '大阪' });
  });

  it('asks before applying a reply whose request is unknown here', () => {
    expect(planRelayApply(plan('zzzzzz', day(1, 's_kiyo')), trip(), []).kind === 'apply').toBe(true);
    const d1 = planRelayApply(plan('zzzzzz', day(1, 's_kiyo')), trip(), []);
    const d2 = planRelayApply(plan(undefined, day(1, 's_kiyo')), trip(), []);
    expect(d1.kind === 'apply' && d1.confirm).toBe('unknown-send');
    expect(d2.kind === 'apply' && d2.confirm).toBe('unknown-send');
  });

  it('keeps research saved on places while the request was out', () => {
    let t = sent(trip(), 'tag001');
    t = { ...t, spots: t.spots.map((s) => (s.id === 's_kiyo' ? { ...s, search: { summary: '筆記', sources: [], provider: 'p', at: 1 } } : s)) };
    const d = planRelayApply(plan('tag001', day(1, 's_kiyo')), t, []);
    if (d.kind !== 'apply') throw new Error(d.kind);
    expect(d.confirm).toBeNull();
    expect(d.result.trip.spots.find((s) => s.id === 's_kiyo')?.search?.summary).toBe('筆記');
  });

  it('lists every problem so the caller can ask before a partial apply', () => {
    const t = sent(trip(), 'tag001');
    const reply = `好\n${block({
      base: 'tag001',
      ops: [
        { tool: 'set_day_plans', input: { days: [day(2, 's_kiyo'), { day: 3, items: [{ spot_id: 's_inar' }, { new_spot: { name: '無類別餐廳' } }] }] } },
        { tool: 'nope', input: {} },
      ],
    })}`;
    const d = planRelayApply(reply, t, []);
    if (d.kind !== 'apply') throw new Error(d.kind);
    expect(d.issues).toHaveLength(2);
    expect(d.issues.join()).toContain('未知的指令：nope');
    expect(d.issues.join()).toContain('第3天未更新');
    expect(dayIds(d.result.trip)).toEqual([[], ['s_kiyo'], []]);
    expect(dayIds(d.before)).toEqual([[], ['s_inar'], []]);
  });

  it('treats a broken block as a message with problems, and plain text as a message', () => {
    const broken = planRelayApply('好\n```travelplan\n{"base":"t","ops":[', trip(), []);
    expect(broken.kind === 'message-only' && broken.parsed.problems.length).toBe(1);
    const plain = planRelayApply('第二天可以早點出門', trip(), []);
    expect(plain.kind === 'message-only' && plain.parsed.problems.length).toBe(0);
  });
});
