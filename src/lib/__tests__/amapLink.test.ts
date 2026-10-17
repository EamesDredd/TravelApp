import { describe, expect, it } from 'vitest';
import { parseAmapShare, roadOf } from '../amapLink';
import { distanceKm, wgsToGcj } from '../geo';

const LONG =
  'https://m.amap.com/poi/detail?__p=B0LGXZ8EDQ%2C31.243855363352264%2C121.41574993729587%2C上海武宁筑格酒店%2C曹杨新村街道武宁路501号鸿运大厦&src=app_share&share_type=url&share_from=poi_poi&share_from_type=AJX&share_bizParams=%7B%22poiid%22%3A%22B0LGXZ8EDQ%22%2C%22trigger%22%3A%22click%22%2C%22is_rank%22%3A0%7D&share_lastClickSpm=amap.11100.0.D1360&poiid=B0LGXZ8EDQ';
const GCJ = { lat: 31.243855363352264, lng: 121.41574993729587 };

describe('parseAmapShare', () => {
  it('reads the position, name and address from the link the short link leads to', () => {
    const got = parseAmapShare(LONG)!;
    expect(got.name).toBe('上海武宁筑格酒店');
    expect(got.address).toBe('曹杨新村街道武宁路501号鸿运大厦');
    expect(got.shortUrl).toBeUndefined();
    // Stored as GPS (WGS-84): converted back, it is Amap's point to within a metre.
    expect(distanceKm(wgsToGcj(got.at!), GCJ)).toBeLessThan(0.001);
    // …and a few hundred metres from Amap's raw numbers, which are offset in China.
    expect(distanceKm(got.at!, GCJ)).toBeGreaterThan(0.2);
  });

  it('reads the text 「复制链接」 copies: name, address and the short link', () => {
    const got = parseAmapShare('上海武宁筑格酒店\n豪华型\n曹杨新村街道武宁路501号鸿运大厦\nhttps://surl.amap.com/aXgCt7M119ar')!;
    expect(got).toEqual({ name: '上海武宁筑格酒店', address: '曹杨新村街道武宁路501号鸿运大厦', shortUrl: 'https://surl.amap.com/aXgCt7M119ar' });
  });

  it('reads one-line shares and links inside other text', () => {
    expect(parseAmapShare('【高德地图】南翔馒头店 地址：豫园路85号 https://surl.amap.com/abc123')).toEqual({
      name: '南翔馒头店',
      address: '豫园路85号',
      shortUrl: 'https://surl.amap.com/abc123',
    });
    expect(parseAmapShare(`看這間 ${LONG} 不錯`)?.name).toBe('上海武宁筑格酒店');
  });

  it('prefers the long link when both are pasted', () => {
    const got = parseAmapShare(`上海武宁筑格酒店\nhttps://surl.amap.com/aXgCt7M119ar\n${LONG}`)!;
    expect(got.at).toBeDefined();
    expect(got.shortUrl).toBeUndefined();
  });

  it('reads URI API and app links, in either coordinate order and system', () => {
    const marker = parseAmapShare('https://uri.amap.com/marker?position=121.4157,31.2438&name=筑格酒店')!;
    expect(marker.name).toBe('筑格酒店');
    expect(distanceKm(wgsToGcj(marker.at!), { lat: 31.2438, lng: 121.4157 })).toBeLessThan(0.001);
    const gps = parseAmapShare('https://uri.amap.com/marker?position=121.4157,31.2438&coordinate=wgs84')!;
    expect(gps.at).toEqual({ lat: 31.2438, lng: 121.4157 });
    const app = parseAmapShare('iosamap://viewMap?sourceApplication=x&poiname=外灘&lat=31.24&lon=121.49&dev=0')!;
    expect(app.name).toBe('外灘');
    expect(distanceKm(wgsToGcj(app.at!), { lat: 31.24, lng: 121.49 })).toBeLessThan(0.001);
  });

  it('knows an Amap link without a position, and ignores other links', () => {
    expect(parseAmapShare('上海武宁筑格酒店 https://www.amap.com/place/B0LGXZ8EDQ')).toEqual({ name: '上海武宁筑格酒店', address: undefined });
    expect(parseAmapShare('https://maps.google.com/?q=31.2,121.4')).toBeNull();
    expect(parseAmapShare('上海武宁筑格酒店')).toBeNull();
    expect(parseAmapShare('https://evil.example/amap.com?__p=x,31.2,121.4')).toBeNull();
  });

  it('does not mistake other numbers in the link for a position', () => {
    const got = parseAmapShare('https://m.amap.com/poi/detail?__p=B0X%2C0%2C0%2C店&share_bizParams=%7B%22is_rank%22%3A0%7D')!;
    expect(got.at).toBeUndefined();
  });
});

describe('roadOf', () => {
  it('finds the road after the district', () => {
    expect(roadOf('曹杨新村街道武宁路501号鸿运大厦')).toBe('武宁路');
    expect(roadOf('上海市黄浦区南京东路299号')).toBe('南京东路');
    expect(roadOf('浦东新区世纪大道1号')).toBe('世纪大道');
    expect(roadOf('豫园路85号')).toBe('豫园路');
    expect(roadOf('鸿运大厦')).toBeUndefined();
  });
});
