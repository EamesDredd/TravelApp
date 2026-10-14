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
const planRev = (base: string, rev: number, ...days: object[]) =>
  `好的。\n\n${block({ base, rev, ops: [{ tool: 'set_day_plans', input: { days } }] })}`;

/** Mirrors what ChatPanel commits for an accepted 'apply' decision. */
function commit(t: Trip, d: RelayDecision): Trip {
  if (d.kind !== 'apply') throw new Error(`expected apply, got ${d.kind}`);
  const resultFp = tripFingerprint(d.result.trip);
  const chat = t.chat.map((m) => (m.id === d.replaces ? { ...m, superseded: true } : m));
  return {
    ...t,
    ...d.result.trip,
    chat: [
      ...chat,
      {
        id: `a${t.chat.length}`,
        role: 'assistant',
        text: '',
        at: 0,
        relayBase: d.parsed.base,
        relayRev: d.parsed.rev,
        relayResult: resultFp,
        relayOps: d.opsFp,
        undo: d.before,
      },
    ],
  };
}

/** Mirrors ChatPanel's undo: restore the snapshot and retire this and every later undo point. */
function undoAt(t: Trip, id: string): Trip {
  const idx = t.chat.findIndex((m) => m.id === id);
  const snap = t.chat[idx].undo!;
  return {
    ...t,
    ...snap,
    chat: t.chat.map((m, i) => (i >= idx && m.undo ? { ...m, undo: undefined, undone: true } : m)),
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
    expect(p).toContain('```travelplan\n{"base":"abc123","rev":1,"ops":[');
    expect(p).toContain('列出這個請求「全部」的修改');
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
    const first = JSON.stringify({ base: 'b', ops: [{ tool: 'update_trip', input: { name: '舊' } }] });
    const cut = '{"base":"b","ops":[{"tool":"set_day';
    const variants = [
      `\`\`\`travelplan\n${first}\n\`\`\`\n修正：\n\`\`\`travelplan\n${cut}`,
      `\`\`\`json\n${first}\n\`\`\`\n修正：\n\`\`\`json\n${cut}`,
      `travelplan\n複製程式碼\n${first}\n修正：\ntravelplan\n複製程式碼\n${cut}`,
      `\`\`\`TravelPlan\n${first}\n\`\`\`\n修正：\n\`\`\`TravelPlan\n`,
    ];
    for (const v of variants) {
      const r = parseRelayReply(v);
      expect(r.ops, v).toBeNull();
      expect(r.problems.join(), v).toContain('不完整');
    }
  });

  it('reports a lone cut-off block copied without fences', () => {
    const r = parseRelayReply('說明\ntravelplan\n{"base":"b","ops":[{"tool":"set_day_plans"');
    expect(r.ops).toBeNull();
    expect(r.problems.join()).toContain('不完整');
  });

  it('reports a block without an ops list', () => {
    const r = parseRelayReply(block({ base: 'b', ops: { tool: 'update_trip' } }));
    expect(r.ops).toBeNull();
    expect(r.problems.join()).toContain('ops');
  });

  it('reads the block version', () => {
    expect(parseRelayReply(block({ base: 'b', rev: 3, ops })).rev).toBe(3);
    expect(parseRelayReply(block({ base: 'b', rev: '2', ops })).rev).toBe(2);
    expect(parseRelayReply(block({ base: 'b', ops })).rev).toBeUndefined();
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

  it('does not count reused places as problems, and deleting a missing place is fine', () => {
    const r = applyRelayOps(sample(), [
      { tool: 'add_candidates', input: { spots: [{ name: '清水寺', category: 'sight' }, { name: '無類別' }] } },
      { tool: 'update_spots', input: { updates: [{ spot_id: 's_gone', delete: true }] } },
    ]);
    expect(r.errors).toEqual(['「無類別」的 category 必須是 sight / breakfast / meal']);
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

  it('a newer reply to the same request replaces the earlier one', () => {
    let t = sent(trip(), 'tag001');
    t = commit(t, planRelayApply(planRev('tag001', 1, day(1, 's_kiyo'), day(3, 's_kink')), t, []));
    // rev 2 keeps day 1, drops the day-3 idea and adds day 2.
    const d = planRelayApply(planRev('tag001', 2, day(1, 's_kiyo'), day(2, 's_inar', 's_kink')), t, []);
    if (d.kind !== 'apply') throw new Error(d.kind);
    expect(d.confirm).toBeNull();
    expect(d.replaces).toBe('a1');
    expect(dayIds(d.result.trip)).toEqual([['s_kiyo'], ['s_inar', 's_kink'], []]);
    expect(dayIds(d.before)).toEqual([['s_kiyo'], ['s_inar'], ['s_kink']]);
  });

  it('pasting only the final reply of a conversation still brings every change', () => {
    const t = sent(trip(), 'tag001');
    const d = planRelayApply(planRev('tag001', 2, day(1, 's_kiyo'), day(3, 's_kink')), t, []);
    if (d.kind !== 'apply') throw new Error(d.kind);
    expect(d.confirm).toBeNull();
    expect(dayIds(d.result.trip)).toEqual([['s_kiyo'], ['s_inar'], ['s_kink']]);
  });

  it('asks before switching back to an older version', () => {
    let t = sent(trip(), 'tag001');
    t = commit(t, planRelayApply(planRev('tag001', 2, day(1, 's_kink')), t, []));
    const d = planRelayApply(planRev('tag001', 1, day(1, 's_kiyo')), t, []);
    if (d.kind !== 'apply') throw new Error(d.kind);
    expect(d.confirm).toBe('older-version');
    expect(d.replacesRev).toBe(2);
  });

  it('keeps research saved since the earlier reply when replacing it', () => {
    let t = sent(trip(), 'tag001');
    t = commit(t, planRelayApply(planRev('tag001', 1, day(1, 's_kiyo')), t, []));
    t = { ...t, spots: t.spots.map((s) => (s.id === 's_kink' ? { ...s, search: { summary: '筆記', sources: [], provider: 'p', at: 1 } } : s)) };
    const d = planRelayApply(planRev('tag001', 2, day(1, 's_kiyo', 's_kink')), t, []);
    if (d.kind !== 'apply') throw new Error(d.kind);
    expect(d.replaces).toBeDefined();
    expect(d.result.trip.spots.find((s) => s.id === 's_kink')?.search?.summary).toBe('筆記');
  });

  it('applies on top (after asking) when the trip changed after an earlier reply', () => {
    let t = sent(trip(), 'tag001');
    t = commit(t, planRelayApply(planRev('tag001', 1, day(1, 's_kiyo')), t, []));
    t = { ...t, days: t.days.map((d, i) => (i === 2 ? { ...d, items: [{ id: 'm1', spotId: 's_kink' }] } : d)) };
    const d = planRelayApply(planRev('tag001', 2, day(1, 's_kiyo', 's_inar')), t, []);
    if (d.kind !== 'apply') throw new Error(d.kind);
    expect(d.confirm).toBe('edited-after-reply');
    expect(d.replaces).toBeUndefined();
    expect(dayIds(d.result.trip)).toEqual([['s_kiyo', 's_inar'], ['s_inar'], ['s_kink']]);
  });

  it('two requests from the same version: the second asks, and the first one survives', () => {
    let t = sent(sent(trip(), 'aaaaaa'), 'bbbbbb');
    t = commit(t, planRelayApply(plan('aaaaaa', day(1, 's_kiyo')), t, []));
    const d = planRelayApply(plan('bbbbbb', day(3, 's_kink')), t, []);
    if (d.kind !== 'apply') throw new Error(d.kind);
    expect(d.confirm).toBe('edited-since-send');
    expect(dayIds(d.result.trip)).toEqual([['s_kiyo'], ['s_inar'], ['s_kink']]);
  });

  it('asks when the trip was edited after sending', () => {
    let t = sent(trip(), 'tag001');
    t = { ...t, days: t.days.map((d, i) => (i === 1 ? { ...d, items: [] } : d)) };
    const d = planRelayApply(plan('tag001', day(1, 's_kiyo')), t, []);
    expect(d.kind === 'apply' && d.confirm).toBe('edited-since-send');
  });

  it('is a duplicate only while that block is what the trip shows', () => {
    let t = sent(trip(), 'tag001');
    const reply = plan('tag001', day(1, 's_kiyo'));
    t = commit(t, planRelayApply(reply, t, []));
    expect(planRelayApply(reply, t, []).kind).toBe('duplicate');
    // Edited by hand afterwards: the same block may be applied again (after asking).
    const edited = { ...t, days: t.days.map((d, i) => (i === 0 ? { ...d, items: [] } : d)) };
    const again = planRelayApply(reply, edited, []);
    expect(again.kind === 'apply' && again.confirm).toBe('edited-after-reply');
    // Undone: it applies cleanly again.
    const undone = undoAt(t, 'a1');
    const after = planRelayApply(reply, undone, []);
    expect(after.kind === 'apply' && after.confirm).toBeNull();
  });

  it('the same operations for a different request are not a duplicate', () => {
    let t = sent(trip(), 'req001');
    t = commit(t, planRelayApply(plan('req001', day(1, 's_kiyo')), t, []));
    t = sent({ ...t, days: t.days.map((d, i) => (i === 0 ? { ...d, items: [] } : d)) }, 'req002');
    const d = planRelayApply(plan('req002', day(1, 's_kiyo')), t, []);
    expect(d.kind === 'apply' && d.confirm).toBeNull();
  });

  it('after undoing an earlier reply, later replies are retired too and can be pasted again', () => {
    let t = sent(trip(), 'tag001');
    const r1 = planRev('tag001', 1, day(1, 's_kiyo'));
    const r2 = planRev('tag001', 2, day(1, 's_kiyo'), day(3, 's_kink'));
    t = commit(t, planRelayApply(r1, t, []));
    t = commit(t, planRelayApply(r2, t, []));
    t = undoAt(t, 'a1');
    expect(dayIds(t)).toEqual([[], ['s_inar'], []]);
    const d = planRelayApply(r2, t, []);
    expect(d.kind === 'apply' && d.confirm).toBeNull();
    if (d.kind === 'apply') expect(dayIds(d.result.trip)).toEqual([['s_kiyo'], ['s_inar'], ['s_kink']]);
  });

  it("refuses a reply that belongs to another trip's request", () => {
    const other = sent(trip(), 'osaka1');
    const d = planRelayApply(plan('osaka1', day(1, 's_kiyo')), trip(), [{ ...other, name: '大阪' }]);
    expect(d).toEqual({ kind: 'other-trip', tripName: '大阪' });
  });

  it('asks before applying a reply whose request is unknown here', () => {
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

  it('a corrected block after a partial apply replaces it cleanly', () => {
    let t = sent(trip(), 'tag001');
    const broken = block({
      base: 'tag001',
      rev: 1,
      ops: [
        { tool: 'update_spots', input: { updates: [{ spot_id: 's_kink', delete: true }] } },
        { tool: 'set_day_plans', input: { days: [{ day: 3, items: [{ new_spot: { name: '無類別' } }] }] } },
      ],
    });
    t = commit(t, planRelayApply(broken, t, []));
    expect(t.spots.some((s) => s.id === 's_kink')).toBe(false);
    const fixed = block({
      base: 'tag001',
      rev: 2,
      ops: [
        { tool: 'update_spots', input: { updates: [{ spot_id: 's_kink', delete: true }] } },
        { tool: 'set_day_plans', input: { days: [{ day: 3, items: [{ new_spot: { name: '有類別', category: 'meal' } }] }] } },
      ],
    });
    const d = planRelayApply(fixed, t, []);
    if (d.kind !== 'apply') throw new Error(d.kind);
    expect(d.issues).toEqual([]);
    expect(d.replaces).toBeDefined();
    expect(d.result.trip.spots.map((s) => s.name)).toEqual(['清水寺', '伏見稻荷大社', '有類別']);
  });

  it('treats a broken block as a message with problems, and plain text as a message', () => {
    const broken = planRelayApply('好\n```travelplan\n{"base":"t","ops":[', trip(), []);
    expect(broken.kind === 'message-only' && broken.parsed.problems.length).toBe(1);
    const plain = planRelayApply('第二天可以早點出門', trip(), []);
    expect(plain.kind === 'message-only' && plain.parsed.problems.length).toBe(0);
  });
});
