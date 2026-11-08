import { describe, expect, it } from 'vitest';
import { distanceKm, wgsToGcj } from '../geo';
import { KmlError, parseKml, planKmlImport, readKmlFile } from '../kml';
import { spotsToKml } from '../maps';
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
    expect(plan).toEqual({ add: [], move: [], same: 4, absent: [] });
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
