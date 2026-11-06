import { describe, expect, it } from 'vitest';
import { filterLabel, filterSpots, newTrip } from '../tripOps';

describe('filterSpots', () => {
  const trip = newTrip({ name: '上海', destination: '上海', dayCount: 2 });
  trip.spots = [
    { id: 'a', name: '外灘', category: 'sight' },
    { id: 'b', name: '南翔小籠包', category: 'meal' },
    { id: 'c', name: '蔥油拌麵', category: 'meal' },
    { id: 'd', name: '粢飯糰', category: 'breakfast' },
  ];
  trip.days[1].items = [{ id: 'i1', spotId: 'b' }];
  const ids = (f: Parameters<typeof filterSpots>[1]) => filterSpots(trip, f).map((s) => s.id);

  it('keeps every place when nothing is chosen', () => {
    const all = { category: 'all', unscheduled: false, query: '' } as const;
    expect(ids(all)).toEqual(['a', 'b', 'c', 'd']);
    expect(filterLabel(all)).toBe('');
    expect(filterLabel({ ...all, query: '  ' })).toBe('');
  });

  it('combines the category, places on no day and the name search', () => {
    expect(ids({ category: 'meal', unscheduled: false, query: '' })).toEqual(['b', 'c']);
    expect(ids({ category: 'meal', unscheduled: true, query: '' })).toEqual(['c']);
    expect(ids({ category: 'all', unscheduled: false, query: ' 麵 ' })).toEqual(['c']);
    expect(filterLabel({ category: 'meal', unscheduled: true, query: ' 麵 ' })).toBe('午晚餐・未排入・「麵」');
  });
});
