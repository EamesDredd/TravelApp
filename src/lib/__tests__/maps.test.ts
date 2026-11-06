import { describe, expect, it } from 'vitest';
import {
  amapNavigationUrl,
  chunkStops,
  googleDirectionsUrl,
  googleEmbedDirectionsUrl,
  placeQuery,
  spotsToKml,
  tripToKml,
} from '../maps';
import { newTrip } from '../tripOps';
import type { Spot } from '../../types';

const kiyomizu: Spot = { id: 's_1', name: '清水寺', category: 'sight', lat: 34.9949, lng: 135.785 };
const inari: Spot = { id: 's_2', name: '伏見稻荷大社', category: 'sight', address: '京都市伏見區', lat: 34.9671, lng: 135.7727 };
const ramen: Spot = { id: 's_3', name: '拉麵 <本店> & 分店', category: 'meal', lat: 34.9858, lng: 135.7588 };

describe('placeQuery', () => {
  it('adds the address, or the destination when there is none', () => {
    expect(placeQuery(inari, '京都')).toBe('伏見稻荷大社 京都市伏見區');
    expect(placeQuery(kiyomizu, '京都')).toBe('清水寺 京都');
    expect(placeQuery(kiyomizu)).toBe('清水寺');
  });
});

describe('Google Maps links', () => {
  it('routes driving through waypoints', () => {
    const u = new URL(googleDirectionsUrl([kiyomizu, ramen, inari], 'driving', '京都'));
    expect(u.searchParams.get('origin')).toBe('清水寺 京都');
    expect(u.searchParams.get('destination')).toBe('伏見稻荷大社 京都市伏見區');
    expect(u.searchParams.get('waypoints')).toBe('拉麵 <本店> & 分店 京都');
    expect(u.searchParams.get('travelmode')).toBe('driving');
  });

  it('drops waypoints for transit', () => {
    const u = new URL(googleDirectionsUrl([kiyomizu, ramen, inari], 'transit'));
    expect(u.searchParams.get('waypoints')).toBeNull();
    expect(u.searchParams.get('travelmode')).toBe('transit');
  });

  it('builds Embed API directions when a key is set', () => {
    const u = new URL(googleEmbedDirectionsUrl([kiyomizu, ramen, inari], 'walking', '京都', 'KEY'));
    expect(u.pathname).toBe('/maps/embed/v1/directions');
    expect(u.searchParams.get('key')).toBe('KEY');
    expect(u.searchParams.get('mode')).toBe('walking');
    expect(u.searchParams.get('waypoints')).toBe('拉麵 <本店> & 分店 京都');
  });

  it('falls back to the keyless embed', () => {
    const url = googleEmbedDirectionsUrl([kiyomizu, inari], 'transit', '京都');
    expect(url).toContain('output=embed');
    expect(url).toContain('dirflg=r');
  });
});

describe('chunkStops', () => {
  it('keeps short days in one link', () => {
    expect(chunkStops([1, 2, 3, 4, 5])).toEqual([[1, 2, 3, 4, 5]]);
  });
  it('splits long days into overlapping links', () => {
    expect(chunkStops([1, 2, 3, 4, 5, 6, 7, 8])).toEqual([
      [1, 2, 3, 4, 5],
      [5, 6, 7, 8],
    ]);
    expect(chunkStops([1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual([
      [1, 2, 3, 4, 5],
      [5, 6, 7, 8, 9],
    ]);
  });
});

describe('Amap links', () => {
  const bund: Spot = { id: 'a', name: '外灘', category: 'sight', lat: 31.2400, lng: 121.4900 };
  const yuyuan: Spot = { id: 'b', name: '豫園', category: 'sight', lat: 31.2272, lng: 121.4921 };

  it('converts to GCJ-02 and maps the travel mode', () => {
    const u = new URL(amapNavigationUrl(bund, yuyuan, 'transit')!);
    expect(u.hostname).toBe('uri.amap.com');
    expect(u.searchParams.get('mode')).toBe('bus');
    expect(u.searchParams.get('coordinate')).toBe('gaode');
    const [lng, lat, name] = u.searchParams.get('to')!.split(',');
    expect(name).toBe('豫園');
    // Shanghai's GCJ offset is roughly +0.0045 lng, -0.002 lat.
    expect(Number(lng)).toBeGreaterThan(yuyuan.lng! + 0.003);
    expect(Number(lat)).toBeLessThan(yuyuan.lat!);
  });

  it('needs coordinates', () => {
    expect(amapNavigationUrl(bund, { id: 'x', name: '無座標', category: 'meal' }, 'driving')).toBeNull();
  });
});

describe('tripToKml', () => {
  it('writes escaped placemarks and a route line per day', () => {
    const trip = newTrip({ name: '京都 & 大阪', destination: '京都', dayCount: 2 });
    trip.spots = [kiyomizu, inari, ramen, { id: 's_4', name: '沒座標', category: 'sight' }];
    trip.days[0].items = [
      { id: 'i1', spotId: 's_1', time: '09:00' },
      { id: 'i2', spotId: 's_3' },
      { id: 'i3', spotId: 's_4' },
      { id: 'i4', spotId: 's_2' },
    ];
    const kml = tripToKml(trip);
    expect(kml).toContain('<name>京都 &amp; 大阪</name>');
    expect(kml).toContain('<name>2. 拉麵 &lt;本店&gt; &amp; 分店</name>');
    expect(kml).not.toContain('沒座標');
    expect(kml).toContain('<coordinates>135.785,34.9949,0 135.7588,34.9858,0 135.7727,34.9671,0</coordinates>');
    expect(kml.match(/<Folder>/g)).toHaveLength(2);
  });
});

/** Every [lng, lat] written in a KML document. */
const kmlCoords = (kml: string) =>
  [...kml.matchAll(/<coordinates>([^<]*)<\/coordinates>/g)].flatMap((m) => m[1].split(' ').map((p) => p.split(',').slice(0, 2).map(Number)));

// 上海武宁筑格酒店: Amap (GCJ-02) puts it at 31.243855, 121.415750; this is its GPS position.
const hotel: Spot = { id: 's_h', name: '上海武宁筑格酒店', category: 'sight', lat: 31.24569, lng: 121.4111 };
const peak: Spot = { id: 's_p', name: '太平山頂', category: 'sight', lat: 22.2759, lng: 114.1455 };

describe('KML for China', () => {
  it('moves mainland places onto Google’s street map there, in placemarks and route lines', () => {
    const trip = newTrip({ name: '上海', destination: '上海', dayCount: 1 });
    trip.spots = [hotel, peak];
    trip.days[0].items = [
      { id: 'i1', spotId: 's_h' },
      { id: 'i2', spotId: 's_p' },
    ];
    const pts = kmlCoords(tripToKml(trip));
    expect(pts).toHaveLength(4);
    for (const [lng, lat] of [pts[0], pts[2]]) {
      expect(lng).toBeCloseTo(121.41575, 4);
      expect(lat).toBeCloseTo(31.243855, 4);
    }
    // Hong Kong is not shifted.
    expect(pts[1]).toEqual([114.1455, 22.2759]);
    expect(pts[3]).toEqual([114.1455, 22.2759]);
    expect(kmlCoords(spotsToKml(trip, [hotel], '上海'))[0]).toEqual(pts[0]);
  });
});

describe('spotsToKml', () => {
  it('writes the given places by category, with the days they are on', () => {
    const trip = newTrip({ name: '京都', destination: '京都', dayCount: 3 });
    const tea: Spot = { id: 's_5', name: '早餐 & 茶', category: 'breakfast', lat: 35.0037, lng: 135.7788, note: '7 點開' };
    trip.spots = [kiyomizu, inari, ramen, tea, { id: 's_4', name: '沒座標', category: 'meal' }];
    trip.days[0].items = [{ id: 'i1', spotId: 's_1' }];
    trip.days[2].items = [{ id: 'i2', spotId: 's_1' }];
    const kml = spotsToKml(trip, trip.spots.filter((s) => s.id !== 's_2'), '京都 候選地點（午晚餐）', (i) => `D${i + 1}`);
    expect(kml).toContain('<Document><name>京都 候選地點（午晚餐）</name>');
    expect(kml).toContain('<name>📍 清水寺</name><description>景點 / D1、D3</description><styleUrl>#sight</styleUrl>');
    expect(kml).toContain('<name>🍜 拉麵 &lt;本店&gt; &amp; 分店</name><description>午晚餐 / 未排入</description>');
    expect(kml).toContain('<name>🥐 早餐 &amp; 茶</name><description>早餐 / 未排入 / 7 點開</description>');
    expect(kml).toContain('<Style id="meal"><IconStyle><color>ff5d18be</color></IconStyle></Style>');
    expect(kml).not.toContain('伏見稻荷大社');
    expect(kml).not.toContain('沒座標');
    expect([...kml.matchAll(/<Folder><name>([^<]*)</g)].map((m) => m[1])).toEqual(['景點', '早餐', '午晚餐']);
    expect(kmlCoords(kml)[0]).toEqual([135.785, 34.9949]);
  });

  it('leaves out a category with no located places', () => {
    const trip = newTrip({ name: '京都', destination: '京都', dayCount: 1 });
    trip.spots = [kiyomizu, { id: 's_4', name: '沒座標', category: 'meal' }];
    const kml = spotsToKml(trip, trip.spots, '京都');
    expect(kml.match(/<Folder>/g)).toHaveLength(1);
    expect(kml).not.toContain('午晚餐</name>');
  });
});
