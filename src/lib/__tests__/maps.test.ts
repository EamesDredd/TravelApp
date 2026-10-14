import { describe, expect, it } from 'vitest';
import {
  amapNavigationUrl,
  chunkStops,
  googleDirectionsUrl,
  googleEmbedDirectionsUrl,
  placeQuery,
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
