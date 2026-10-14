import { describe, expect, it } from 'vitest';
import { applyToolCall, describeTrip } from '../ai/agentTools';
import { buildHistory } from '../ai';
import type { ChatMessage, TripSnapshot } from '../../types';

function sample(): TripSnapshot {
  return {
    name: '京都',
    destination: '京都',
    startDate: '2026-10-20',
    days: [
      { id: 'd1', items: [] },
      { id: 'd2', items: [{ id: 'i1', spotId: 's_inar' }] },
    ],
    spots: [
      { id: 's_kiyo', name: '清水寺', category: 'sight', lat: 34.9949, lng: 135.785 },
      { id: 's_inar', name: '伏見稻荷大社', category: 'sight', lat: 34.9671, lng: 135.7727 },
      { id: 's_cafe', name: '%ARABICA', category: 'breakfast' },
    ],
  };
}

describe('set_day_plans', () => {
  it('replaces listed days, creates new spots and extends the trip', () => {
    const r = applyToolCall(sample(), 'set_day_plans', {
      days: [
        {
          day: 1,
          title: '東山',
          items: [
            { spot_id: 's_cafe', time: '8:00' },
            { spot_id: 's_kiyo', time: '09:30', note: '搭公車' },
            { new_spot: { name: '奧丹 清水', category: 'meal', address: '京都市東山區' }, time: '12:00' },
          ],
        },
        { day: 3, items: [{ spot_id: 's_inar' }] },
      ],
    });
    expect(r.isError).toBe(false);
    expect(r.trip.days).toHaveLength(3);
    expect(r.trip.days[0].title).toBe('東山');
    expect(r.trip.days[0].items.map((i) => i.time)).toEqual(['08:00', '09:30', '12:00']);
    expect(r.trip.days[0].items[1].note).toBe('搭公車');
    const added = r.trip.spots.find((s) => s.name === '奧丹 清水');
    expect(added?.category).toBe('meal');
    expect(r.trip.days[0].items[2].spotId).toBe(added?.id);
    // Day 2 was not listed, so it is untouched.
    expect(r.trip.days[1].items.map((i) => i.spotId)).toEqual(['s_inar']);
    expect(r.summary.join()).toContain('更新第 1、3 天行程');
    expect(r.result).toContain('[s_kiyo]');
  });

  it('reuses an existing spot instead of duplicating it by name', () => {
    const r = applyToolCall(sample(), 'set_day_plans', {
      days: [{ day: 1, items: [{ new_spot: { name: '清水寺', category: 'sight' } }] }],
    });
    expect(r.trip.spots).toHaveLength(3);
    expect(r.trip.days[0].items[0].spotId).toBe('s_kiyo');
  });

  it('leaves a day untouched when any item is invalid', () => {
    const before = sample();
    const r = applyToolCall(before, 'set_day_plans', {
      days: [{ day: 2, items: [{ spot_id: 's_kiyo' }, { spot_id: 's_nope' }] }],
    });
    expect(r.isError).toBe(true);
    expect(r.trip.days[1].items.map((i) => i.spotId)).toEqual(['s_inar']);
    expect(r.result).toContain('s_nope');
    expect(before.days[1].items).toHaveLength(1);
  });

  it('rejects malformed input', () => {
    expect(applyToolCall(sample(), 'set_day_plans', { days: 'x' }).isError).toBe(true);
    expect(applyToolCall(sample(), 'set_day_plans', null).isError).toBe(true);
    expect(applyToolCall(sample(), 'nope', {}).isError).toBe(true);
  });
});

describe('add_candidates / update_spots / update_trip', () => {
  it('adds new spots and skips duplicates', () => {
    const r = applyToolCall(sample(), 'add_candidates', {
      spots: [
        { name: '金閣寺', category: 'sight', lat: 35.0394, lng: 135.7292, duration_min: 60 },
        { name: '清水寺', category: 'sight' },
        { name: '壞類別', category: 'bar' },
      ],
    });
    expect(r.trip.spots).toHaveLength(4);
    const kinkaku = r.trip.spots[3];
    expect(kinkaku).toMatchObject({ name: '金閣寺', lat: 35.0394, durationMin: 60 });
    expect(kinkaku.id).toMatch(/^s_/);
    expect(r.result).toContain('已存在');
    expect(r.result).toContain('錯誤');
  });

  it('deleting a spot also removes it from the days', () => {
    const r = applyToolCall(sample(), 'update_spots', { updates: [{ spot_id: 's_inar', delete: true }] });
    expect(r.trip.spots.map((s) => s.id)).not.toContain('s_inar');
    expect(r.trip.days[1].items).toHaveLength(0);
  });

  it('edits spot fields', () => {
    const r = applyToolCall(sample(), 'update_spots', {
      updates: [{ spot_id: 's_cafe', category: 'meal', note: '拿鐵', lat: 35.0, lng: 135.77 }],
    });
    expect(r.trip.spots[2]).toMatchObject({ category: 'meal', note: '拿鐵', lat: 35.0 });
  });

  it('changes the day count and start date', () => {
    const r = applyToolCall(sample(), 'update_trip', { day_count: 4, start_date: '2026-11-01' });
    expect(r.trip.days).toHaveLength(4);
    expect(r.trip.startDate).toBe('2026-11-01');
    expect(applyToolCall(sample(), 'update_trip', { start_date: '11/1' }).isError).toBe(true);
  });
});

describe('describeTrip', () => {
  it('lists spots with ids, coordinates and schedule', () => {
    const text = describeTrip(sample(), new Date(2026, 9, 14));
    expect(text).toContain('今天日期：2026-10-14');
    expect(text).toContain('第1天是週二');
    expect(text).toContain('s_kiyo | 景點 | 清水寺 | 34.99490,135.78500');
    expect(text).toContain('s_inar | 景點 | 伏見稻荷大社 | 34.96710,135.77270 |  |  |  | 第2天');
    expect(text).toContain('第1天 10/20（二）：（尚未安排）');
    expect(text).toContain('1. --:-- [s_inar] 景點・伏見稻荷大社');
  });
});

describe('buildHistory', () => {
  it('keeps text turns, folds in actions, drops errors and leading assistant turns', () => {
    const chat: ChatMessage[] = [
      { id: '0', role: 'assistant', text: '歡迎', at: 0 },
      { id: '1', role: 'user', text: '排行程', at: 1 },
      { id: '2', role: 'assistant', text: '排好了', actions: ['更新第 1 天行程'], at: 2 },
      { id: '3', role: 'error', text: '網路錯誤', at: 3 },
      { id: '4', role: 'user', text: '再試', at: 4 },
      { id: '5', role: 'user', text: '一次', at: 5 },
    ];
    expect(buildHistory(chat)).toEqual([
      { role: 'user', text: '排行程' },
      { role: 'assistant', text: '排好了\n\n（這一輪已在 App 中執行：更新第 1 天行程）' },
      { role: 'user', text: '再試\n\n一次' },
    ]);
  });
});
