import { describe, expect, it } from 'vitest';
import { applyRelayOps, buildRelayPrompt, parseRelayReply, tripFingerprint } from '../ai/relay';
import type { TripSnapshot } from '../../types';

function sample(): TripSnapshot {
  return {
    name: '京都',
    destination: '京都',
    startDate: '2026-11-18',
    days: [
      { id: 'd1', items: [] },
      { id: 'd2', items: [{ id: 'i1', spotId: 's_inar' }] },
    ],
    spots: [
      { id: 's_kiyo', name: '清水寺', category: 'sight', lat: 34.9949, lng: 135.785 },
      { id: 's_inar', name: '伏見稻荷大社', category: 'sight', lat: 34.9671, lng: 135.7727 },
    ],
  };
}

const block = (obj: unknown) => '```travelplan\n' + JSON.stringify(obj, null, 2) + '\n```';

describe('tripFingerprint', () => {
  it('is stable, ignores cached searches and changes with the plan', () => {
    const a = sample();
    const b = structuredClone(a);
    b.spots[0].search = { summary: 'x', sources: [], provider: 'p', at: 1 };
    expect(tripFingerprint(a)).toBe(tripFingerprint(b));
    expect(tripFingerprint(a)).toMatch(/^[0-9a-z]{7}$/);
    b.days[0].items.push({ id: 'i9', spotId: 's_kiyo' });
    expect(tripFingerprint(b)).not.toBe(tripFingerprint(a));
  });
});

describe('buildRelayPrompt', () => {
  it('carries the request, version tag, format, tools and the trip', () => {
    const p = buildRelayPrompt(sample(), '  幫我按遠近排 ', 'abc1234', new Date(2026, 9, 14));
    expect(p).toContain('## 我的需求\n幫我按遠近排\n');
    expect(p).toContain('"base" 固定寫 "abc1234"');
    expect(p).toContain('```travelplan\n{"base":"abc1234","ops":[');
    for (const t of ['add_candidates', 'set_day_plans', 'update_spots', 'update_trip']) expect(p).toContain(`### ${t}`);
    expect(p).toContain('s_kiyo | 景點 | 清水寺 | 34.99490,135.78500');
    expect(p).toContain('今天日期：2026-10-14');
  });
});

describe('parseRelayReply', () => {
  const ops = [{ tool: 'set_day_plans', input: { days: [{ day: 1, items: [{ spot_id: 's_kiyo', time: '09:00' }] }] } }];

  it('splits the explanation from the block', () => {
    const r = parseRelayReply(`好的，第 1 天先去清水寺。\n\n${block({ base: 'abc1234', ops })}\n`);
    expect(r.base).toBe('abc1234');
    expect(r.ops).toEqual(ops);
    expect(r.problems).toEqual([]);
    expect(r.message).toBe('好的，第 1 天先去清水寺。');
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
    const r = parseRelayReply(`${block({ base: 'b', ops: first })}\n修正：\n${block({ base: 'b', ops })}`);
    expect(r.ops).toEqual(ops);
  });

  it('ignores braces inside strings and other code blocks', () => {
    const tricky = [{ tool: 'update_spots', input: { updates: [{ spot_id: 's_kiyo', note: 'a } { b' }] } }];
    const r = parseRelayReply('```js\nconst x = {a: 1}\n```\n' + block({ base: 'b', ops: tricky }));
    expect(r.ops).toEqual(tricky);
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
    expect(r.base).toBeUndefined();
  });

  it('treats a discussion-only reply as having no operations', () => {
    const r = parseRelayReply('我建議第二天別排太滿，可以把伏見稻荷改到清晨。');
    expect(r.ops).toBeNull();
    expect(r.problems).toEqual([]);
    expect(r.message).toContain('伏見稻荷');
  });
});

describe('applyRelayOps', () => {
  it('applies cumulative operations and maps repeated new places to one spot', () => {
    const newSpot = { name: '奧丹 清水', category: 'meal', lat: 34.995, lng: 135.781 };
    const r = applyRelayOps(sample(), [
      { tool: 'add_candidates', input: { spots: [{ name: '金閣寺', category: 'sight' }] } },
      {
        tool: 'set_day_plans',
        input: {
          days: [
            { day: 1, items: [{ spot_id: 's_kiyo', time: '09:00' }, { new_spot: newSpot, time: '12:00' }] },
            { day: 3, items: [{ new_spot: newSpot, time: '12:00' }] },
          ],
        },
      },
      { tool: 'update_spots', input: { updates: [{ spot_id: 's_nope', note: 'x' }] } },
    ]);
    const added = r.trip.spots.filter((s) => s.name === '奧丹 清水');
    expect(added).toHaveLength(1);
    expect(r.trip.days).toHaveLength(3);
    expect(r.trip.days[0].items[1].spotId).toBe(added[0].id);
    expect(r.trip.days[2].items[0].spotId).toBe(added[0].id);
    expect(r.trip.spots.map((s) => s.name)).toContain('金閣寺');
    expect(r.summary).toContain('更新第 1、3 天行程');
    expect(r.errors).toEqual(['找不到 spot_id s_nope']);
  });
});
