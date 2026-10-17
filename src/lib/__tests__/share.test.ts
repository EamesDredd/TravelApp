import { compressToEncodedURIComponent } from 'lz-string';
import { describe, expect, it } from 'vitest';
import type { Trip } from '../../types';
import {
  checkImport,
  exportJson,
  importedAsNew,
  importTarget,
  looksLikeTrip,
  mergeImported,
  parseTrip,
  syncStamp,
  updateByDefault,
} from '../share';
import { formatStamp } from '../util';

function phoneTrip(): Trip {
  return {
    id: 't_phone001',
    name: '上海之旅',
    destination: '上海',
    startDate: '2026-11-18',
    mapRegion: 'cn',
    center: { lat: 31.23, lng: 121.47 },
    days: [
      { id: 'd1', items: [{ id: 'i1', spotId: 's_bund', time: '09:00' }] },
      { id: 'd2', items: [{ id: 'i2', spotId: 's_yuyu' }] },
    ],
    spots: [
      { id: 's_bund', name: '外灘', category: 'sight', lat: 31.24, lng: 121.49, geo: 'auto' },
      { id: 's_yuyu', name: '豫園', category: 'sight', search: { summary: '明代園林', sources: [], provider: 'claude', at: 1 } },
      { id: 's_hotel', name: '上海武宁筑格酒店', category: 'sight', address: '武宁路501号' },
    ],
    chat: [{ id: 'm1', role: 'user', text: '幫我排行程', at: 1 }],
    createdAt: 100,
    updatedAt: 1000,
  };
}

/** What 🔗 分享連結 sends: no web-search results. */
function link(t: Trip): string {
  const d = JSON.parse(exportJson(t));
  d.spots = d.spots.map(({ search: _s, ...s }: { search?: unknown }) => s);
  return `https://eamesdredd.github.io/TravelApp/#trip=${compressToEncodedURIComponent(JSON.stringify(d))}`;
}

/** The device shares the trip (TripsModal calls markSynced). */
const share = (t: Trip): Trip => ({ ...t, synced: syncStamp(t) });

/** An edit on a device: the plan changes and updatedAt moves on. */
function edit(t: Trip, at: number): Trip {
  return { ...t, days: [...t.days, { id: `d_${at}`, title: '新的一天', items: [] }], updatedAt: at };
}

describe('parseTrip', () => {
  it('reads a share link with the trip id and when it changed', () => {
    const t = phoneTrip();
    const got = parseTrip(link(t));
    expect(got.linked).toBe(true);
    expect(got.trip.id).toBe('t_phone001');
    expect(got.changedAt).toBe(1000);
    expect(got.trip.spots.map((s) => s.name)).toEqual(['外灘', '豫園', '上海武宁筑格酒店']);
    expect(got.trip.chat).toEqual([]);
  });

  it('finds the link inside a pasted message, also percent-encoded', () => {
    const url = link(phoneTrip());
    expect(parseTrip(`上海之旅\n${url}  傳給你`).trip.name).toBe('上海之旅');
    const [base, code] = url.split('#trip=');
    expect(parseTrip(`${base}#trip=${encodeURIComponent(code).replace(/\$/g, '%24')}`).trip.days).toHaveLength(2);
  });

  it('reads an exported JSON file, keeping web-search results', () => {
    const got = parseTrip(exportJson(phoneTrip()));
    expect(got.linked).toBe(true);
    expect(got.trip.spots[1].search?.summary).toBe('明代園林');
  });

  it('gives links and files from before ids were shared a fresh id', () => {
    const d = JSON.parse(exportJson(phoneTrip()));
    delete d.id;
    delete d.updatedAt;
    const got = parseTrip(JSON.stringify(d));
    expect(got.linked).toBe(false);
    expect(got.trip.id).not.toBe('t_phone001');
    expect(got.changedAt).toBeUndefined();
  });

  it('does not trust odd ids', () => {
    for (const id of ['<b>x</b>', 'a'.repeat(80), 42, '']) {
      const d = JSON.parse(exportJson(phoneTrip()));
      d.id = id;
      expect(parseTrip(JSON.stringify(d)).linked).toBe(false);
    }
  });

  it('explains broken or unrelated text', () => {
    expect(() => parseTrip('https://eamesdredd.github.io/TravelApp/#trip=N4Ig')).toThrow('連結內容不完整');
    expect(() => parseTrip('https://eamesdredd.github.io/TravelApp/#trip=')).toThrow('連結內容不完整');
    expect(() => parseTrip('今天天氣很好')).toThrow('不是行程的分享連結');
    expect(() => parseTrip('{"name":')).toThrow('檔案內容不是有效的行程資料');
    expect(() => parseTrip('{"name":"x"}')).toThrow('不是有效的行程資料');
  });

  it('recognises pasted links and files', () => {
    expect(looksLikeTrip(link(phoneTrip()))).toBe(true);
    expect(looksLikeTrip('  {"days":[]}')).toBe(true);
    expect(looksLikeTrip('https://example.com')).toBe(false);
  });
});

describe('importing on another device', () => {
  it('round trip phone → computer → phone updates the same trip without warnings', () => {
    // Phone shares; the computer adds it as a new trip with the same id.
    let phone = share(phoneTrip());
    let computer = importedAsNew(parseTrip(link(phone)), 1500);
    expect(computer.id).toBe(phone.id);
    expect(importTarget([], parseTrip(link(phone)))).toBeNull();

    // Edited on the computer, shared back.
    computer = share(edit(computer, 2000));
    const incoming = parseTrip(link(computer));
    const target = importTarget([phone], incoming)!;
    expect(target).toEqual({ trip: phone, byName: false });
    expect(updateByDefault(target)).toBe(true);
    expect(checkImport(phone, incoming)).toEqual({ same: false, editedHere: false, olderThan: undefined });

    phone = mergeImported(phone, incoming, 2500);
    expect(phone.id).toBe('t_phone001');
    expect(phone.days).toHaveLength(3);
    expect(phone.chat).toHaveLength(1);
    expect(phone.createdAt).toBe(100);
    expect(phone.updatedAt).toBe(2500);
    // Nothing changed since: importing the same link again is a no-op.
    expect(checkImport(phone, incoming)).toEqual({ same: true, editedHere: false, olderThan: undefined });
  });

  it('warns when this copy was edited after the last share', () => {
    const phone = share(phoneTrip());
    const computer = share(edit(importedAsNew(parseTrip(link(phone)), 1500), 2000));
    const phoneEdited = { ...phone, days: phone.days.slice(0, 1), updatedAt: 1800 };
    expect(checkImport(phoneEdited, parseTrip(link(computer))).editedHere).toBe(true);
  });

  it('warns when an older link is opened again', () => {
    const phone = share(phoneTrip());
    const oldLink = link(phone);
    const computer = share(edit(importedAsNew(parseTrip(oldLink), 1500), 2000));
    const updated = mergeImported(phone, parseTrip(link(computer)), 2500);
    const check = checkImport(updated, parseTrip(oldLink));
    expect(check.olderThan).toBe(2000);
    expect(check.same).toBe(false);
    expect(check.editedHere).toBe(false);
  });

  it('keeps the plan time while only chat or found locations changed', () => {
    const t = share(phoneTrip());
    const chatted = { ...t, chat: [...t.chat, { id: 'm2', role: 'user' as const, text: 'hi', at: 2 }], updatedAt: 5000 };
    expect(syncStamp(chatted)).toEqual(t.synced);
    const located = {
      ...t,
      spots: t.spots.map((s) => (s.id === 's_hotel' ? { ...s, lat: 31.25, lng: 121.42, geo: 'auto' as const } : s)),
      updatedAt: 6000,
    };
    expect(syncStamp(located)).toEqual(t.synced);
    expect(syncStamp(edit(t, 7000)).at).toBe(7000);
    // Never synced: the trip's own time.
    expect(syncStamp(phoneTrip()).at).toBe(1000);
  });

  it('counts the same plan as the same, even with different found locations', () => {
    const phone = share(phoneTrip());
    const incoming = parseTrip(link(phone));
    incoming.trip.spots[0] = { ...incoming.trip.spots[0], lat: 31.2401, lng: 121.4901 };
    expect(checkImport(phone, incoming).same).toBe(true);
  });

  it('matches a copy made before ids were shared by name, and links it', () => {
    const phone = phoneTrip(); // legacy: never synced
    const computerCopy = share({ ...phoneTrip(), id: 't_comp0001', chat: [] });
    const incoming = parseTrip(link(edit(computerCopy, 3000)));
    const target = importTarget([phone], incoming)!;
    expect(target.byName).toBe(true);
    expect(updateByDefault(target)).toBe(true);
    const merged = mergeImported(phone, incoming, 3500);
    expect(merged.id).toBe('t_comp0001');
    expect(merged.chat).toHaveLength(1);
  });

  it('keeps the local id for links from before ids were shared', () => {
    const d = JSON.parse(exportJson(phoneTrip()));
    delete d.id;
    const incoming = parseTrip(JSON.stringify(d));
    const local = { ...phoneTrip(), id: 't_local001' };
    expect(importTarget([local], incoming)?.byName).toBe(true);
    expect(mergeImported(local, incoming).id).toBe('t_local001');
  });

  it('does not update a different synced trip by default just because the name matches', () => {
    const other = share({ ...phoneTrip(), id: 't_other001', startDate: '2025-04-01' });
    const incoming = parseTrip(link(phoneTrip()));
    const target = importTarget([other], incoming)!;
    expect(target.byName).toBe(true);
    expect(updateByDefault(target)).toBe(false);
  });

  it('prefers the same id, then the latest trip with the name', () => {
    const a = { ...phoneTrip(), id: 't_a', updatedAt: 10 };
    const b = { ...phoneTrip(), id: 't_b', updatedAt: 30 };
    const c = { ...phoneTrip(), id: 't_c', name: ' 上海 之旅 ', updatedAt: 20 };
    const incoming = parseTrip(link({ ...phoneTrip(), id: 't_new' }));
    expect(importTarget([a, b, c], incoming)?.trip.id).toBe('t_b');
    const same = parseTrip(link({ ...phoneTrip(), id: 't_a' }));
    expect(importTarget([a, b, c], same)).toEqual({ trip: a, byName: false });
    expect(importTarget([{ ...a, name: '京都' }], incoming)).toBeNull();
  });
});

describe('mergeImported', () => {
  it('keeps web searches and found locations the import does not have', () => {
    const local = phoneTrip();
    local.spots[2] = { ...local.spots[2], lat: 31.25, lng: 121.42, geo: 'manual' };
    const remote = { ...phoneTrip(), spots: phoneTrip().spots.map((s) => (s.id === 's_bund' ? { ...s, lat: 31.2, lng: 121.5, geo: undefined } : s)) };
    const merged = mergeImported(local, parseTrip(link(remote)));
    const byId = Object.fromEntries(merged.spots.map((s) => [s.id, s]));
    expect(byId.s_yuyu.search?.summary).toBe('明代園林');
    expect(byId.s_hotel).toMatchObject({ lat: 31.25, lng: 121.42, geo: 'manual' });
    // Coordinates that came with the import win.
    expect(byId.s_bund).toMatchObject({ lat: 31.2, lng: 121.5 });
    expect(byId.s_bund.geo).toBeUndefined();
  });

  it('drops what belonged to a place that was renamed on the other device', () => {
    const local = phoneTrip();
    local.spots[2] = { ...local.spots[2], lat: 31.25, lng: 121.42, geo: 'auto' };
    const remote = phoneTrip();
    remote.spots = remote.spots.map((s) =>
      s.id === 's_yuyu' ? { ...s, name: '城隍廟' } : s.id === 's_hotel' ? { ...s, name: '和平飯店' } : s,
    );
    const byId = Object.fromEntries(mergeImported(local, parseTrip(link(remote))).spots.map((s) => [s.id, s]));
    expect(byId.s_yuyu.search).toBeUndefined();
    expect(byId.s_hotel.lat).toBeUndefined();
  });

  it('takes the imported trip details, keeping the centre only for the same destination', () => {
    const local = phoneTrip();
    const remote = { ...phoneTrip(), name: '上海＋杭州', startDate: undefined, mapRegion: 'auto' as const, center: undefined };
    const merged = mergeImported(local, parseTrip(link(remote)));
    expect(merged).toMatchObject({ name: '上海＋杭州', mapRegion: 'auto', center: local.center });
    expect(merged.startDate).toBeUndefined();
    const moved = mergeImported(local, parseTrip(link({ ...remote, destination: '杭州' })));
    expect(moved.center).toBeUndefined();
  });
});

describe('formatStamp', () => {
  it('shows the year only when it is not this year', () => {
    const now = new Date(2026, 9, 17);
    expect(formatStamp(new Date(2026, 9, 17, 15, 5).getTime(), now)).toBe('10/17 15:05');
    expect(formatStamp(new Date(2025, 0, 2, 9, 0).getTime(), now)).toBe('2025/1/2 09:00');
  });
});
