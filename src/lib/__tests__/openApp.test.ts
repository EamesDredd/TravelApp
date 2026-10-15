import { describe, expect, it } from 'vitest';
import {
  amapNavigationLink,
  amapPlaceLink,
  amapSearchLink,
  googleDirectionsLink,
  googleSearchLink,
  intentUrl,
} from '../maps';
import { detectPlatform, planOpen } from '../openApp';
import type { Spot } from '../../types';

const bund: Spot = { id: 'a', name: '外灘', category: 'sight', lat: 31.24, lng: 121.49 };
const yu: Spot = { id: 'b', name: '豫園', category: 'sight', lat: 31.2272, lng: 121.4921 };
const pvg: Spot = { id: 'c', name: '浦東國際機場', category: 'sight', lat: 31.1443, lng: 121.8083 };
const noCoords: Spot = { id: 'd', name: '小楊生煎', category: 'breakfast' };
const kiyo: Spot = { id: 'k', name: '清水寺', category: 'sight', lat: 34.9949, lng: 135.785, address: '京都市東山區' };

describe('app links', () => {
  it('builds Chrome intents that fall back to the web page', () => {
    expect(intentUrl('amapuri://route/plan/?a=1&b=2', 'com.autonavi.minimap', 'https://uri.amap.com/x?y=1')).toBe(
      'intent://route/plan/?a=1&b=2#Intent;scheme=amapuri;package=com.autonavi.minimap;S.browser_fallback_url=https%3A%2F%2Furi.amap.com%2Fx%3Fy%3D1;end',
    );
    expect(intentUrl('not a url', 'p', 'https://w')).toBe('https://w');
  });

  it('Google Maps: search and directions in the app', () => {
    const s = googleSearchLink(kiyo, '京都');
    expect(s.app).toBe('google');
    expect(s.web).toContain('https://www.google.com/maps/search/');
    expect(s.ios).toBe(`comgooglemaps://?q=${encodeURIComponent('清水寺 京都市東山區')}`);
    expect(s.android).toMatch(/^intent:\/\/www\.google\.com\/maps\/search\/\?.*#Intent;scheme=https;package=com\.google\.android\.apps\.maps;S\.browser_fallback_url=https%3A%2F%2Fwww\.google\.com%2Fmaps%2Fsearch%2F.*;end$/);

    const drive = googleDirectionsLink([bund, yu, pvg], 'driving', '上海');
    expect(drive.ios).toBe(
      `comgooglemaps://?saddr=${encodeURIComponent('外灘 上海')}&daddr=${encodeURIComponent('豫園 上海')}+to:${encodeURIComponent('浦東國際機場 上海')}&directionsmode=driving`,
    );
    // Transit takes no stops on the way, like the web link.
    const transit = googleDirectionsLink([bund, yu, pvg], 'transit', '上海');
    expect(transit.ios).toBe(`comgooglemaps://?saddr=${encodeURIComponent('外灘 上海')}&daddr=${encodeURIComponent('浦東國際機場 上海')}&directionsmode=transit`);
    expect(transit.web).not.toContain('waypoints');
  });

  it('Amap: route, place and search in the app, in GCJ-02', () => {
    const nav = amapNavigationLink(bund, pvg, 'transit')!;
    expect(nav.app).toBe('amap');
    expect(nav.web).toContain('https://uri.amap.com/navigation');
    const ios = new URL(nav.ios!.replace('iosamap://', 'https://x/'));
    expect(nav.ios!.startsWith('iosamap://path?')).toBe(true);
    expect(ios.searchParams.get('t')).toBe('1');
    expect(ios.searchParams.get('dev')).toBe('0');
    expect(ios.searchParams.get('sname')).toBe('外灘');
    // Converted to GCJ-02 (Amap's coordinates), a few hundred metres off WGS-84.
    expect(Number(ios.searchParams.get('slat'))).not.toBeCloseTo(31.24, 3);
    expect(Number(ios.searchParams.get('slat'))).toBeCloseTo(31.24, 1);
    expect(nav.android).toMatch(/^intent:\/\/route\/plan\/\?.*#Intent;scheme=amapuri;package=com\.autonavi\.minimap;S\.browser_fallback_url=https%3A%2F%2Furi\.amap\.com%2Fnavigation.*;end$/);
    expect(amapNavigationLink(bund, pvg, 'driving')!.ios).toContain('t=0');
    expect(amapNavigationLink(bund, pvg, 'walking')!.ios).toContain('t=2');
    expect(amapNavigationLink(bund, noCoords, 'driving')).toBeNull();
    // A stop on the way: only the web page takes it.
    expect(amapNavigationLink(bund, pvg, 'driving', yu)).toEqual({ app: 'amap', web: expect.stringContaining('via=') });

    expect(amapPlaceLink(yu, '上海').ios).toMatch(/^iosamap:\/\/viewMap\?sourceApplication=travel-planner&poiname=/);
    expect(amapPlaceLink(yu, '上海').android).toMatch(/^intent:\/\/viewMap\?.*#Intent;scheme=androidamap;/);
    expect(amapPlaceLink(noCoords, '上海')).toEqual(amapSearchLink(noCoords, '上海'));
    // The app searches where the phone is: the trip's city goes in front of the name.
    expect(amapSearchLink(noCoords, '上海').ios).toBe(`iosamap://poi?sourceApplication=travel-planner&name=${encodeURIComponent('上海 小楊生煎')}&dev=0`);
    expect(amapSearchLink({ ...noCoords, name: '上海小楊生煎' }, '上海').ios).toContain(`name=${encodeURIComponent('上海小楊生煎')}&`);
    // Spaces as %20, never '+', in app URLs.
    expect(amapNavigationLink({ ...bund, name: 'Shake Shack' }, pvg, 'walking')!.ios).toContain('sname=Shake%20Shack');
    expect(amapPlaceLink({ ...yu, name: 'M Stand' }).android).toContain('poiname=M%20Stand');
    expect(amapSearchLink(noCoords, '上海').android).toContain('intent://poi?sourceApplication=travel-planner&keywords=');
  });
});

describe('opening', () => {
  const link = googleSearchLink(kiyo, '京都');

  it('detects the platform', () => {
    expect(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5)).toBe('ios');
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe('ios'); // iPad
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe('other');
    expect(detectPlatform('Mozilla/5.0 (Linux; Android 15; Pixel 9)', 5)).toBe('android');
    // LINE / Facebook in-app browser (a WebView): plain web links.
    expect(detectPlatform('Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36 Line/14.16.0', 5)).toBe('other');
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 0)).toBe('other');
  });

  it('Android opens the app (Chrome falls back to the web page by itself)', () => {
    expect(planOpen(link, 'android', true, {})).toEqual({ kind: 'app', url: link.android });
  });

  it('iPhone asks once, then follows the answer', () => {
    expect(planOpen(link, 'ios', true, {})).toEqual({ kind: 'ask' });
    expect(planOpen(link, 'ios', true, { google: true })).toEqual({ kind: 'app', url: link.ios });
    expect(planOpen(link, 'ios', true, { google: false })).toEqual({ kind: 'web' });
    // The answer is per app.
    expect(planOpen(amapPlaceLink(yu), 'ios', true, { google: true })).toEqual({ kind: 'ask' });
  });

  it('desktop, the setting off, or a link without an app version stay on the web', () => {
    expect(planOpen(link, 'other', true, {})).toEqual({ kind: 'web' });
    expect(planOpen(link, 'android', false, {})).toEqual({ kind: 'web' });
    expect(planOpen(link, 'ios', false, { google: true })).toEqual({ kind: 'web' });
    expect(planOpen({ app: 'amap', web: 'https://uri.amap.com/x' }, 'ios', true, { amap: true })).toEqual({ kind: 'web' });
  });
});
