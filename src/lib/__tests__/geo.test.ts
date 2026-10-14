import { describe, expect, it } from 'vitest';
import { distanceKm, gcjToWgs, isMainlandChina, tripRegion, wgsToGcj } from '../geo';

const at = (lat: number, lng: number) => ({ lat, lng });

describe('isMainlandChina', () => {
  const inside: Record<string, [number, number]> = {
    北京: [39.9042, 116.4074],
    上海: [31.2304, 121.4737],
    深圳福田: [22.5333, 114.055],
    廣州: [23.1291, 113.2644],
    橫琴: [22.12, 113.52],
    珠海: [22.27, 113.57],
    廈門: [24.4798, 118.0894],
    福州: [26.0745, 119.2965],
    三亞: [18.25, 109.51],
    海口: [20.04, 110.34],
    大連: [38.91, 121.6],
    青島: [36.07, 120.38],
    瀋陽: [41.8, 123.43],
    哈爾濱: [45.75, 126.65],
    拉薩: [29.65, 91.1],
    烏魯木齊: [43.825, 87.6168],
    喀什: [39.47, 75.99],
    昆明: [25.04, 102.71],
    景洪: [22.0, 100.8],
    成都: [30.5728, 104.0668],
  };
  const outside: Record<string, [number, number]> = {
    香港中環: [22.2819, 114.1582],
    尖沙咀: [22.2976, 114.1722],
    澳門: [22.1987, 113.5439],
    台北: [25.033, 121.5654],
    高雄: [22.6273, 120.3014],
    澎湖: [23.57, 119.58],
    金門: [24.43, 118.32],
    首爾: [37.5665, 126.978],
    平壤: [39.03, 125.75],
    東京: [35.6762, 139.6503],
    京都: [35.0116, 135.7681],
    河內: [21.0278, 105.8342],
    加德滿都: [27.7172, 85.324],
    海參崴: [43.1155, 131.8855],
    烏蘭巴托: [47.886, 106.9057],
    曼谷: [13.7563, 100.5018],
  };
  for (const [name, [lat, lng]] of Object.entries(inside)) {
    it(`${name} is mainland`, () => expect(isMainlandChina(at(lat, lng))).toBe(true));
  }
  for (const [name, [lat, lng]] of Object.entries(outside)) {
    it(`${name} is not mainland`, () => expect(isMainlandChina(at(lat, lng))).toBe(false));
  }
});

describe('GCJ-02', () => {
  it('offsets mainland points by a few hundred metres and round-trips', () => {
    const p = at(39.9042, 116.4074);
    const g = wgsToGcj(p);
    const m = distanceKm(p, g) * 1000;
    expect(m).toBeGreaterThan(100);
    expect(m).toBeLessThan(800);
    const back = gcjToWgs(g);
    expect(Math.abs(back.lat - p.lat)).toBeLessThan(1e-6);
    expect(Math.abs(back.lng - p.lng)).toBeLessThan(1e-6);
  });

  it('leaves points outside mainland China unchanged', () => {
    const tokyo = at(35.6762, 139.6503);
    expect(wgsToGcj(tokyo)).toEqual(tokyo);
    const hk = at(22.2819, 114.1582);
    expect(wgsToGcj(hk)).toEqual(hk);
  });
});

describe('distanceKm', () => {
  it('measures Tokyo–Osaka as ~400 km', () => {
    const d = distanceKm(at(35.6812, 139.7671), at(34.7025, 135.4959));
    expect(d).toBeGreaterThan(390);
    expect(d).toBeLessThan(410);
  });
});

describe('tripRegion', () => {
  const base = { mapRegion: 'auto' as const, center: undefined };
  it('uses the majority of located spots', () => {
    const spots = [
      { id: 'a', name: 'a', category: 'sight' as const, ...at(31.23, 121.47) },
      { id: 'b', name: 'b', category: 'sight' as const, ...at(31.24, 121.49) },
      { id: 'c', name: 'c', category: 'sight' as const, ...at(22.28, 114.16) },
    ];
    expect(tripRegion({ ...base, spots })).toBe('cn');
  });
  it('falls back to the destination centre, then to Google', () => {
    expect(tripRegion({ ...base, spots: [], center: at(30.25, 120.16) })).toBe('cn');
    expect(tripRegion({ ...base, spots: [] })).toBe('intl');
  });
  it('respects a manual override', () => {
    expect(tripRegion({ mapRegion: 'cn', spots: [] })).toBe('cn');
  });
});
