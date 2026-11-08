import { describe, expect, it } from 'vitest';
import { distanceKm, wgsToGcj } from '../geo';
import { applyKmlImport, dayChanges, dayOfLayer, KmlError, layerCategory, parseKml, planKmlImport, readKmlFile, type ImportChoice } from '../kml';
import { spotsToKml, tripToKml } from '../maps';
import { newTrip } from '../tripOps';
import type { Spot } from '../../types';

const gcj = (lat: number, lng: number) => {
  const g = wgsToGcj({ lat, lng });
  return `${g.lng},${g.lat},0`;
};

// A map as Google My Maps exports it: layers as folders, HTML descriptions as CDATA.
const MY_MAPS = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>上海五日遊 候選地點</name>
    <Style id="icon-1899-0288D1-normal"><IconStyle><color>ffd18802</color></IconStyle></Style>
    <Folder>
      <name>景點</name>
      <Placemark>
        <name>📍 外灘</name>
        <description><![CDATA[景點 / 第1天 10/24（六）<br>看夜景 &amp; 拍照]]></description>
        <styleUrl>#icon-1899-0288D1</styleUrl>
        <Point>
          <coordinates>
            ${gcj(31.24, 121.49)}
          </coordinates>
        </Point>
      </Placemark>
      <Placemark>
        <name>第1天路線</name>
        <LineString><coordinates>121.49,31.23,0 121.48,31.22,0</coordinates></LineString>
      </Placemark>
    </Folder>
    <Folder>
      <name>午晚餐</name>
      <Placemark>
        <name>拉麵 &lt;本店&gt; &amp; 分店</name>
        <Point><coordinates>${gcj(31.2272, 121.4921)}</coordinates></Point>
      </Placemark>
      <Placemark><name>沒有位置</name></Placemark>
    </Folder>
  </Document>
</kml>`;

describe('parseKml', () => {
  it('reads point placemarks with their layer, and Google’s China positions back as GPS', () => {
    const { places, skipped } = parseKml(MY_MAPS);
    expect(skipped).toBe(2);
    expect(places.map((p) => [p.name, p.folder])).toEqual([
      ['📍 外灘', '景點'],
      ['拉麵 <本店> & 分店', '午晚餐'],
    ]);
    expect(places[0].description).toBe('景點 / 第1天 10/24（六）\n看夜景 & 拍照');
    expect(distanceKm(places[0].at, { lat: 31.24, lng: 121.49 })).toBeLessThan(0.001);
    expect(distanceKm(places[1].at, { lat: 31.2272, lng: 121.4921 })).toBeLessThan(0.001);
  });

  it('leaves positions outside mainland China alone and copes with prefixes and stray text', () => {
    const { places } = parseKml(
      `<kml:kml xmlns:kml="http://www.opengis.net/kml/2.2"><kml:Placemark><kml:name>清水寺</kml:name>
       <kml:description>a &lt; b</kml:description><kml:Point><kml:coordinates>135.785,34.9949</kml:coordinates></kml:Point></kml:Placemark></kml:kml>`,
    );
    expect(places).toEqual([{ name: '清水寺', description: 'a < b', folder: undefined, at: { lat: 34.9949, lng: 135.785 } }]);
    expect(parseKml('{"name":"not a map"}')).toEqual({ places: [], skipped: 0 });
  });
});

const KMZ_DEFLATED =
  'UEsDBBQAAAAIAIUbaF37ZPhSCwAAAAkAAAARAAAAaW1hZ2VzL2ljb24tMS5wbmfrDPBzV0hLzE4FAFBLAwQUAAAACACFG2hd5B+UO8sAAAAWAQAABwAAAGRvYy5rbWyzsa/IzVEoSy0qzszPs1Uy1DNQUkjNS85PycxLt1UKDXHTtVCyt+OyyQaqAqrMK7ZVyigpKbDS1y8vL9fLL0jNS88s1stLLdEHqtA30jNSsrNxyU8uzU3NK7GzyUvMTbV7smvNy+a9Nvpgjo1bfk5KahFU6tn0lS+XTIBJBeQkJqfmJhZlo8gqqCXmFlgrvOjZBleXnwkyPDk/vwjozMSS1GI7Q2NTPXNzCwsdIG1gYGyuY2Cjjyxvow/VpI9kiT7MLfoIF4O8YccFAFBLAQIUAxQAAAAIAIUbaF37ZPhSCwAAAAkAAAARAAAAAAAAAAAAAACAAQAAAABpbWFnZXMvaWNvbi0xLnBuZ1BLAQIUAxQAAAAIAIUbaF3kH5Q7ywAAABYBAAAHAAAAAAAAAAAAAACAAToAAABkb2Mua21sUEsFBgAAAAACAAIAdAAAACoBAAAAAA==';
const KMZ_STORED =
  'UEsDBBQAAAAAAIUbaF37ZPhSCQAAAAkAAAARAAAAaW1hZ2VzL2ljb24tMS5wbmeJUE5HIGZha2VQSwMEFAAAAAAAhRtoXeQflDsWAQAAFgEAAAcAAABkb2Mua21sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPGttbCB4bWxucz0iaHR0cDovL3d3dy5vcGVuZ2lzLm5ldC9rbWwvMi4yIj48RG9jdW1lbnQ+PG5hbWU+5Lqs6YO9PC9uYW1lPjxGb2xkZXI+PG5hbWU+5pep6aSQPC9uYW1lPjxQbGFjZW1hcms+PG5hbWU+5pep6aSQICZhbXA7IOiMtjwvbmFtZT48UG9pbnQ+PGNvb3JkaW5hdGVzPjEzNS43Nzg4LDM1LjAwMzcsMDwvY29vcmRpbmF0ZXM+PC9Qb2ludD48L1BsYWNlbWFyaz48L0ZvbGRlcj48L0RvY3VtZW50Pjwva21sPgpQSwECFAMUAAAAAACFG2hd+2T4UgkAAAAJAAAAEQAAAAAAAAAAAAAAgAEAAAAAaW1hZ2VzL2ljb24tMS5wbmdQSwECFAMUAAAAAACFG2hd5B+UOxYBAAAWAQAABwAAAAAAAAAAAAAAgAE4AAAAZG9jLmttbFBLBQYAAAAAAgACAHQAAABzAQAAAAA=';
const blob = (b64: string) => new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]);

describe('readKmlFile', () => {
  it('reads the KML inside a KMZ, compressed or not', async () => {
    for (const kmz of [KMZ_DEFLATED, KMZ_STORED]) {
      const { places } = await readKmlFile(blob(kmz));
      expect(places).toEqual([{ name: '早餐 & 茶', folder: '早餐', at: { lat: 35.0037, lng: 135.7788 } }]);
    }
  });

  it('reads a plain KML file and refuses a broken KMZ', async () => {
    expect((await readKmlFile(new Blob([MY_MAPS]))).places).toHaveLength(2);
    await expect(readKmlFile(blob(KMZ_DEFLATED.slice(0, 200)))).rejects.toBeInstanceOf(KmlError);
  });
});

describe('planKmlImport', () => {
  const bund: Spot = { id: 's_1', name: '外灘', category: 'sight', lat: 31.24, lng: 121.49 };
  const hotel: Spot = { id: 's_2', name: '上海武宁筑格酒店', category: 'sight', lat: 31.24569, lng: 121.4111 };
  const yuyuan: Spot = { id: 's_3', name: '豫園', category: 'sight', lat: 31.2272, lng: 121.4921 };
  const nanxiang: Spot = { id: 's_4', name: '南翔饅頭店', category: 'meal' };
  const cafe: Spot = { id: 's_5', name: '粢飯糰早餐', category: 'breakfast', lat: 31.23, lng: 121.47 };
  const trip = newTrip({ name: '上海', destination: '上海', dayCount: 1 });
  trip.spots = [bund, hotel, yuyuan, nanxiang, cafe];

  it('changes nothing when the exported map comes back as it was', () => {
    const plan = planKmlImport(trip, parseKml(spotsToKml(trip, trip.spots, '上海')));
    expect(plan).toEqual({ add: [], move: [], same: 4, absent: [], days: [] });
  });

  it('finds added, moved, newly located and missing places', () => {
    const kml = `<kml><Document>
      <Folder><name>景點</name>
        <Placemark><name>📍 上海武宁筑格酒店</name><Point><coordinates>${gcj(31.2475, 121.4111)}</coordinates></Point></Placemark>
        <Placemark><name>2. 豫園</name><Point><coordinates>${gcj(31.2272, 121.4921)}</coordinates></Point></Placemark>
        <Placemark><name>新天地</name><Point><coordinates>${gcj(31.2196, 121.4733)}</coordinates></Point></Placemark>
      </Folder>
      <Folder><name>午晚餐</name>
        <Placemark><name>南翔馒头店</name><Point><coordinates>${gcj(31.2269, 121.4919)}</coordinates></Point></Placemark>
        <Placemark><name>老吉士酒家</name><description>要訂位</description><Point><coordinates>${gcj(31.2125, 121.4553)}</coordinates></Point></Placemark>
        <Placemark><name>老吉士酒家</name><Point><coordinates>${gcj(31.2125, 121.4553)}</coordinates></Point></Placemark>
      </Folder>
      <Placemark><name>外灘觀景台</name><description>早餐 / 未排入 / 中山東一路 / 7 點開</description><Point><coordinates>${gcj(31.2405, 121.4905)}</coordinates></Point></Placemark>
    </Document></kml>`;
    const plan = planKmlImport(trip, parseKml(kml));
    expect(plan.same).toBe(1);
    expect(plan.move.map((m) => [m.spot.id, m.km === undefined ? 'located' : Math.round(m.km * 1000)])).toEqual([
      ['s_2', 201],
      ['s_4', 'located'],
    ]);
    expect(distanceKm(plan.move[0].at, { lat: 31.2475, lng: 121.4111 })).toBeLessThan(0.001);
    expect(plan.add.map((a) => [a.name, a.category, a.note])).toEqual([
      ['新天地', 'sight', undefined],
      ['老吉士酒家', 'meal', '要訂位'],
      ['外灘觀景台', 'breakfast', '中山東一路 / 7 點開'],
    ]);
    expect(plan.absent.map((s) => s.id)).toEqual(['s_1', 's_5']);
  });
});

describe('layer names', () => {
  it('finds the day a layer is for', () => {
    const days = ['第1天', '第一天', '第十二天', '第 2 日', '上海五日遊-第3天', '第2天 10/25（日） 外灘一帶', 'Day 4', 'day04', 'D5', 'D1 外灘', '【D2】美食'];
    expect(days.map(dayOfLayer)).toEqual([0, 0, 11, 1, 2, 1, 3, 3, 4, 0, 1]);
    for (const other of ['景點', 'Food2', 'Sunday 1', 'D100', '2D3N', '第0天', undefined]) expect(dayOfLayer(other)).toBeUndefined();
  });

  it('suggests a category', () => {
    const names = ['早餐', '午晚餐', '必吃', '美食清單', '咖啡廳', 'Restaurants', '景點', '飯店', '住宿'];
    expect(names.map(layerCategory)).toEqual(['breakfast', 'meal', 'meal', 'meal', 'meal', 'meal', 'sight', undefined, undefined]);
  });
});

describe('day layers', () => {
  const A = { id: 'A', name: '外灘', category: 'sight', lat: 31.24, lng: 121.49 } satisfies Spot;
  const B = { id: 'B', name: '豫園', category: 'sight', lat: 31.2272, lng: 121.4921 } satisfies Spot;
  const C = { id: 'C', name: '新天地', category: 'sight', lat: 31.2196, lng: 121.4733 } satisfies Spot;
  const L: Spot = { id: 'L', name: '午餐（附近找）', category: 'meal' };
  const H = { id: 'H', name: '酒店', category: 'sight', lat: 31.24569, lng: 121.4111 } satisfies Spot;
  const make = () => {
    const trip = newTrip({ name: '上海', destination: '上海', dayCount: 2 });
    trip.spots = [A, B, C, L, H];
    trip.days[0].items = [
      { id: 'i1', spotId: 'A', time: '09:00' },
      { id: 'i2', spotId: 'L' },
      { id: 'i3', spotId: 'B' },
      { id: 'i4', spotId: 'C', note: '晚上' },
    ];
    trip.days[1].items = [{ id: 'i5', spotId: 'H' }];
    return trip;
  };
  const pin = (name: string, s: { lat: number; lng: number }) =>
    `<Placemark><name>${name}</name><Point><coordinates>${gcj(s.lat, s.lng)}</coordinates></Point></Placemark>`;
  const none: ImportChoice = { skip: new Set(), remove: new Set(), categories: {}, skipDays: new Set() };

  it('puts each day layer’s places on its day, in order, keeping what the map could not show', () => {
    const trip = make();
    const kml = `<kml><Document>
      <Folder><name>第1天</name>${pin('新天地', C)}${pin('1. 外灘', A)}${pin('2. 田子坊', { lat: 31.2087, lng: 121.4689 })}</Folder>
      <Folder><name>第3天</name>${pin('酒店', H)}${pin('田子坊', { lat: 31.2087, lng: 121.4689 })}</Folder>
      <Folder><name>想去</name>${pin('朱家角', { lat: 31.1074, lng: 121.0548 })}</Folder>
    </Document></kml>`;
    const plan = planKmlImport(trip, parseKml(kml));
    expect(plan.add.map((a) => [a.key, a.name])).toEqual([
      ['a2', '田子坊'],
      ['a5', '朱家角'],
    ]);
    expect(plan.days).toEqual([
      { day: 0, stops: [{ spot: 'C' }, { spot: 'A' }, { add: 'a2' }] },
      { day: 2, stops: [{ spot: 'H' }, { add: 'a2' }] },
    ]);
    expect(plan.same).toBe(3);
    expect(plan.absent.map((s) => s.id)).toEqual(['B']);

    const after = applyKmlImport(trip, plan, none);
    const tianzifang = after.spots.find((s) => s.name === '田子坊')!;
    expect(after.days[0].items).toEqual([
      { id: 'i4', spotId: 'C', note: '晚上' },
      { id: 'i2', spotId: 'L' },
      { id: 'i1', spotId: 'A', time: '09:00' },
      { id: expect.any(String), spotId: tianzifang.id },
    ]);
    // A day without a layer is left alone; a later day is added.
    expect(after.days[1].items).toEqual([{ id: 'i5', spotId: 'H' }]);
    expect(after.days).toHaveLength(3);
    expect(after.days[2].items.map((it) => it.spotId)).toEqual(['H', tianzifang.id]);
    expect(after.spots.map((s) => s.name)).toEqual(['外灘', '豫園', '新天地', '午餐（附近找）', '酒店', '田子坊', '朱家角']);

    expect(dayChanges(trip, plan, none)).toEqual([
      {
        day: 0,
        extra: false,
        stops: [
          { name: '新天地', added: false },
          { name: '午餐（附近找）', added: false },
          { name: '外灘', added: false },
          { name: '田子坊', added: true },
        ],
        removed: ['豫園'],
      },
      { day: 2, extra: true, stops: [{ name: '酒店', added: true }, { name: '田子坊', added: true }], removed: [] },
    ]);
  });

  it('follows the choices', () => {
    const trip = make();
    const kml = `<kml><Document><Folder><name>第1天</name>${pin('新天地', C)}${pin('田子坊', { lat: 31.2087, lng: 121.4689 })}</Folder></Document></kml>`;
    const plan = planKmlImport(trip, parseKml(kml));
    const skipped = applyKmlImport(trip, plan, { ...none, skip: new Set(['a1']), remove: new Set(['A']) });
    expect(skipped.spots.map((s) => s.id)).toEqual(['B', 'C', 'L', 'H']);
    expect(skipped.days[0].items.map((it) => it.spotId)).toEqual(['L', 'C']);
    const dayKept = applyKmlImport(trip, plan, { ...none, skipDays: new Set([0]) });
    expect(dayKept.days[0]).toEqual(trip.days[0]);
    expect(dayKept.spots.find((s) => s.name === '田子坊')?.category).toBe('sight');
  });

  it('changes nothing when an exported day comes back as it was', () => {
    const trip = make();
    trip.days[1].items = [{ id: 'i5', spotId: 'H' }, { id: 'i6', spotId: 'B' }, { id: 'i7', spotId: 'H' }];
    const plan = planKmlImport(trip, parseKml(tripToKml(trip)));
    expect(plan.add).toEqual([]);
    expect(plan.move).toEqual([]);
    expect(dayChanges(trip, plan, none)).toEqual([]);
    expect(applyKmlImport(trip, plan, none).days).toEqual(trip.days);
  });
});

