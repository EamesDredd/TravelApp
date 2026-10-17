import { compressToEncodedURIComponent } from 'lz-string';
import { describe, expect, it } from 'vitest';
import type { Trip } from '../../types';
import {
  compareImport,
  exportJson,
  importRelation,
  importedAsNew,
  importTarget,
  looksLikeTrip,
  mergeImported,
  parseTrip,
  planFingerprint,
  sharedStamp,
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
      { id: 'd_aaaaaa', items: [{ id: 'i1', spotId: 's_bund', time: '09:00' }] },
      { id: 'd_bbbbbb', title: '老城區', items: [{ id: 'i2', spotId: 's_yuyu' }] },
    ],
    spots: [
      // makeSpot puts the id last.
      { name: '外灘', category: 'sight', lat: 31.24, lng: 121.49, geo: 'auto', id: 's_bund' },
      { name: '豫園', category: 'sight', search: { summary: '明代園林', sources: [], provider: 'claude', at: 1 }, id: 's_yuyu' },
      { name: '上海武宁筑格酒店', category: 'sight', address: '武宁路501号', lat: undefined, lng: undefined, id: 's_hotel' },
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

/** The device sends the trip (TripsModal calls markSynced afterwards). */
function share(t: Trip): { url: string; after: Trip } {
  return { url: link(t), after: { ...t, synced: sharedStamp(t) } };
}

/** An edit on a device: the plan changes and updatedAt moves on. */
function edit(t: Trip, at: number, title = `改於 ${at}`): Trip {
  return { ...t, days: t.days.map((d, i) => (i === 0 ? { ...d, title } : d)), updatedAt: at };
}

const relation = (local: Trip, url: string) => compareImport(local, parseTrip(url));

describe('parseTrip', () => {
  it('reads a share link with the trip id, its time and its version history', () => {
    const { url } = share(share(phoneTrip()).after);
    const got = parseTrip(url);
    expect(got.linked).toBe(true);
    expect(got.trip.id).toBe('t_phone001');
    expect(got.changedAt).toBe(1000);
    expect(got.seen).toEqual([planFingerprint(phoneTrip())]);
    expect(got.trip.spots.map((s) => s.name)).toEqual(['外灘', '豫園', '上海武宁筑格酒店']);
    expect(got.trip.chat).toEqual([]);
  });

  it('gives the same plan version on the other device', () => {
    const t = phoneTrip();
    expect(planFingerprint(parseTrip(link(t)).trip)).toBe(planFingerprint(t));
    expect(planFingerprint(parseTrip(exportJson(t)).trip)).toBe(planFingerprint(t));
    expect(planFingerprint(edit(t, 2))).not.toBe(planFingerprint(t));
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

  it('reads links and files from before ids were shared', () => {
    const d = JSON.parse(exportJson(phoneTrip()));
    delete d.id;
    delete d.updatedAt;
    delete d.seen;
    const got = parseTrip(JSON.stringify(d));
    expect(got.linked).toBe(false);
    expect(got.trip.id).not.toBe('t_phone001');
    expect(got.changedAt).toBeUndefined();
    expect(got.seen).toBeUndefined();
  });

  it('does not trust odd ids', () => {
    for (const id of ['<b>x</b>', 'a'.repeat(80), 42, '']) {
      const d = JSON.parse(exportJson(phoneTrip()));
      d.id = id;
      expect(parseTrip(JSON.stringify(d)).linked).toBe(false);
    }
  });

  it('keeps only what the app can show from hand-made data', () => {
    const got = parseTrip(
      JSON.stringify({
        name: { x: 1 },
        destination: 5,
        startDate: 'tomorrow',
        center: { lat: 'a', lng: 1 },
        updatedAt: 1e300,
        seen: ['ok', 7, 'x'.repeat(99)],
        days: [{ title: 3 }, 'x', { id: 'd1', items: [{ id: 'i1', spotId: 's1', note: {} }, { id: 'i2', spotId: 'gone' }, null] }],
        spots: [
          { id: 's1', name: '甲', category: 'shop', note: { a: 1 }, lat: '31', lng: 121, geo: 'auto', search: { summary: 's', sources: [{ title: 't', url: 'javascript:alert(1)' }, { title: 'u', url: 'https://a.b' }] } },
          { id: 's1', name: '重複' },
          { id: 's2' },
          null,
        ],
      }),
    );
    expect(got.trip.name).toBe('匯入的行程');
    expect(got.trip.destination).toBe('');
    expect(got.trip.startDate).toBeUndefined();
    expect(got.trip.center).toBeUndefined();
    expect(got.changedAt).toBeUndefined();
    expect(got.seen).toEqual(['ok']);
    expect(got.trip.spots).toEqual([{ id: 's1', name: '甲', category: 'sight', search: { summary: 's', sources: [{ title: 'u', url: 'https://a.b' }], provider: '', at: 0 } }]);
    expect(got.trip.days).toHaveLength(2);
    expect(got.trip.days[0].items).toEqual([]);
    expect(got.trip.days[1]).toEqual({ id: 'd1', items: [{ id: 'i1', spotId: 's1' }] });
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

describe('which copy is newer', () => {
  it('round trip phone → computer → phone: the update is safe', () => {
    const s1 = share(phoneTrip());
    let phone = s1.after;
    let computer = importedAsNew(parseTrip(s1.url), 1500);
    expect(computer.id).toBe(phone.id);

    const s2 = share(edit(computer, 2000));
    computer = s2.after;
    const target = importTarget([phone], parseTrip(s2.url))!;
    expect(target).toEqual({ trip: phone, match: 'id' });
    expect(relation(phone, s2.url)).toBe('newer');
    expect(updateByDefault(target, 'newer', parseTrip(s2.url))).toBe(true);

    phone = mergeImported(phone, parseTrip(s2.url), 2500);
    expect(phone.id).toBe('t_phone001');
    expect(phone.days[0].title).toBe('改於 2000');
    expect(phone.chat).toHaveLength(1);
    expect(phone.createdAt).toBe(100);
    expect(phone.updatedAt).toBe(2500);
    expect(relation(phone, s2.url)).toBe('same');
    // Back on the computer, the phone's next edit is newer too.
    expect(relation(computer, share(edit(phone, 3000, '手機再改')).url)).toBe('newer');
  });

  it('several rounds keep working', () => {
    let a = phoneTrip();
    let b: Trip | null = null;
    for (let round = 1; round <= 30; round++) {
      const s = share(edit(a, round * 10, `A${round}`));
      a = s.after;
      b = b ? mergeImported(b, parseTrip(s.url)) : importedAsNew(parseTrip(s.url));
      expect(b && relation(b, s.url)).toBe('same');
      const back = share(edit(b!, round * 10 + 5, `B${round}`));
      b = back.after;
      expect(relation(a, back.url)).toBe('newer');
      a = mergeImported(a, parseTrip(back.url));
    }
    expect(a.synced!.seen.length).toBeLessThanOrEqual(40);
  });

  it('crossing shares: both copies changed, so neither update is called safe', () => {
    const s1 = share(phoneTrip());
    const a = s1.after;
    const b = importedAsNew(parseTrip(s1.url));
    const fromB = share(edit(b, 2000, 'B 的修改'));
    const fromA = share(edit(a, 2100, 'A 的修改'));
    expect(relation(fromB.after, fromA.url)).toBe('diverged');
    expect(relation(fromA.after, fromB.url)).toBe('diverged');
    expect(updateByDefault({ trip: a, match: 'id' }, 'diverged', parseTrip(fromA.url))).toBe(false);
  });

  it('a third device: changes that never reached the sender are not lost silently', () => {
    const s1 = share(phoneTrip());
    let a = s1.after;
    const b = importedAsNew(parseTrip(s1.url));
    const c = importedAsNew(parseTrip(s1.url));
    const fromB = share(edit(b, 2000, 'B'));
    a = mergeImported(a, parseTrip(fromB.url));
    const fromC = share(edit(c, 2100, 'C'));
    expect(relation(a, fromC.url)).toBe('diverged');
  });

  it('a share that never arrived does not hide changes made here', () => {
    const s1 = share(phoneTrip());
    const b = importedAsNew(parseTrip(s1.url));
    // The phone edits and starts a share that is cancelled: it still counts as sent here.
    const unsent = share(edit(s1.after, 1500, '手機的修改')).after;
    const fromB = share(edit(b, 2000, '電腦的修改'));
    expect(relation(unsent, fromB.url)).toBe('diverged');
  });

  it('an older link opened again is older, not newer', () => {
    const s1 = share(phoneTrip());
    const computer = importedAsNew(parseTrip(s1.url));
    const s2 = share(edit(computer, 2000));
    const phone = mergeImported(s1.after, parseTrip(s2.url));
    expect(relation(phone, s1.url)).toBe('older');
    expect(updateByDefault({ trip: phone, match: 'id' }, 'older', parseTrip(s1.url))).toBe(false);
    // The computer, too, after a later edit of its own.
    expect(relation(share(edit(s2.after, 3000, '再改')).after, s1.url)).toBe('older');
  });

  it('locations found or picked on either side are not plan changes', () => {
    const s1 = share(phoneTrip());
    const computer = importedAsNew(parseTrip(s1.url));
    computer.spots = computer.spots.map((s) => (s.id === 's_hotel' ? { ...s, lat: 31.25, lng: 121.42, geo: 'auto' as const } : s));
    const phone = { ...s1.after, spots: s1.after.spots.map((s) => (s.id === 's_bund' ? { ...s, lat: 31.2, lng: 121.5, geo: 'manual' as const } : s)) };
    expect(relation(phone, share(computer).url)).toBe('same');
  });

  it('keeps the plan time while only chat or found locations changed', () => {
    const t = share(phoneTrip()).after;
    const chatted = { ...t, chat: [...t.chat, { id: 'm2', role: 'user' as const, text: 'hi', at: 2 }], updatedAt: 5000 };
    expect(sharedStamp(chatted)).toBe(t.synced);
    const changed = sharedStamp(edit(t, 7000));
    expect(changed.at).toBe(7000);
    expect(changed.seen).toEqual([planFingerprint(edit(t, 7000)), planFingerprint(t)]);
    expect(sharedStamp(phoneTrip())).toEqual({ seen: [planFingerprint(phoneTrip())], at: 1000 });
  });
});

describe('importTarget', () => {
  it('matches a copy made before ids were shared by its days and places, and links it', () => {
    const phone = phoneTrip(); // never shared
    const computerCopy = share({ ...phoneTrip(), id: 't_comp0001', name: '上海（電腦）', chat: [] });
    const url = share(edit(computerCopy.after, 3000)).url;
    const target = importTarget([phone], parseTrip(url))!;
    expect(target.match).toBe('copy');
    expect(relation(phone, url)).toBe('unknown');
    expect(updateByDefault(target, 'unknown', parseTrip(url))).toBe(true);
    const merged = mergeImported(phone, parseTrip(url), 3500);
    expect(merged.id).toBe('t_comp0001');
    expect(merged.chat).toHaveLength(1);
  });

  it('does not offer to overwrite a different trip that only has the same name', () => {
    const lastYear: Trip = { ...phoneTrip(), id: 't_2025', startDate: '2025-04-01', days: [{ id: 'd_zzzzzz', items: [] }], spots: [] };
    const url = link({ ...phoneTrip(), id: 't_new' });
    const target = importTarget([lastYear], parseTrip(url))!;
    expect(target.match).toBe('name');
    expect(relation(lastYear, url)).toBe('unknown');
    expect(updateByDefault(target, 'unknown', parseTrip(url))).toBe(false);
  });

  it('a single shared place id is not enough to call it a copy', () => {
    const other: Trip = { ...phoneTrip(), id: 't_other', name: '別的', days: [{ id: 'd_zzzzzz', items: [] }], spots: [phoneTrip().spots[0]] };
    expect(importTarget([other], parseTrip(link(phoneTrip())))).toBeNull();
  });

  it('prefers the same id, then a copy with the name, then any copy, then the latest with the name', () => {
    const unrelated = (id: string, name: string, updatedAt: number): Trip => ({ ...phoneTrip(), id, name, updatedAt, days: [{ id: `d_${id}`, items: [] }], spots: [] });
    const a = unrelated('t_a', '上海之旅', 10);
    const b = unrelated('t_b', ' 上海 之旅 ', 30);
    const copyOther = { ...phoneTrip(), id: 't_c', name: '改名了', updatedAt: 5 };
    const copySame = { ...phoneTrip(), id: 't_d', updatedAt: 1 };
    const incoming = parseTrip(link({ ...phoneTrip(), id: 't_new' }));
    expect(importTarget([a, b], incoming)).toEqual({ trip: b, match: 'name' });
    expect(importTarget([a, b, copyOther], incoming)).toEqual({ trip: copyOther, match: 'copy' });
    expect(importTarget([a, b, copyOther, copySame], incoming)).toEqual({ trip: copySame, match: 'copy' });
    const sameId = parseTrip(link({ ...phoneTrip(), id: 't_a' }));
    expect(importTarget([a, b, copyOther], sameId)).toEqual({ trip: a, match: 'id' });
    // A copy the import is built on wins over a same-id trip with changes of its own.
    expect(importTarget([a, b, copyOther, copySame], sameId)).toEqual({ trip: copySame, match: 'copy' });
    expect(importTarget([{ ...a, name: '京都' }], parseTrip(link({ ...phoneTrip(), id: 't_new', days: [{ id: 'd_x', items: [] }], spots: [] })))).toBeNull();
  });

  it('keeps the local id for links from before ids were shared', () => {
    const d = JSON.parse(exportJson(phoneTrip()));
    delete d.id;
    const local = { ...phoneTrip(), id: 't_local001' };
    expect(mergeImported(local, parseTrip(JSON.stringify(d))).id).toBe('t_local001');
  });
});

describe('mergeImported', () => {
  it('keeps web searches and locations found here, unless the import has a better location', () => {
    const local = phoneTrip();
    local.spots = local.spots.map((s) =>
      s.id === 's_hotel' ? { ...s, lat: 31.25, lng: 121.42, geo: 'manual' as const } : s.id === 's_bund' ? { ...s, geo: 'manual' as const } : s,
    );
    const remote = phoneTrip();
    remote.spots = remote.spots.map((s) =>
      s.id === 's_hotel' ? { ...s, lat: 31.3, lng: 121.4, geo: 'auto' as const } : s.id === 's_yuyu' ? { ...s, lat: 31.227, lng: 121.492 } : s,
    );
    const local2 = { ...local, spots: [...local.spots] };
    local2.spots[1] = { ...local2.spots[1], lat: 31.1, lng: 121.1, geo: 'auto' };
    const byId = Object.fromEntries(mergeImported(local2, parseTrip(link(remote))).spots.map((s) => [s.id, s]));
    expect(byId.s_yuyu.search?.summary).toBe('明代園林');
    // Picked by hand here beats found automatically there.
    expect(byId.s_hotel).toMatchObject({ lat: 31.25, lng: 121.42, geo: 'manual' });
    // Coordinates that came with the import beat ones found automatically here.
    expect(byId.s_yuyu).toMatchObject({ lat: 31.227, lng: 121.492 });
    expect(byId.s_yuyu.geo).toBeUndefined();

    const pickedThere = phoneTrip();
    pickedThere.spots = pickedThere.spots.map((s) => (s.id === 's_hotel' ? { ...s, lat: 31.26, lng: 121.43, geo: 'manual' as const } : s));
    const fromThere = Object.fromEntries(mergeImported(local, parseTrip(link(pickedThere))).spots.map((s) => [s.id, s]));
    expect(fromThere.s_hotel).toMatchObject({ lat: 31.26, lng: 121.43, geo: 'manual' });
  });

  it('drops what belonged to a place that was renamed on the other device', () => {
    const local = phoneTrip();
    local.spots[2] = { ...local.spots[2], lat: 31.25, lng: 121.42, geo: 'auto' };
    const remote = phoneTrip();
    remote.spots = remote.spots.map((s) => (s.id === 's_yuyu' ? { ...s, name: '城隍廟' } : s.id === 's_hotel' ? { ...s, name: '和平飯店' } : s));
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
    expect(mergeImported(local, parseTrip(link({ ...remote, destination: '杭州' }))).center).toBeUndefined();
  });
});

describe('the review cases', () => {
  /** An AI turn on a device: the plan changes, with an undo point to the plan before it. */
  function aiTurn(t: Trip, at: number): Trip {
    const before = { name: t.name, destination: t.destination, startDate: t.startDate, days: t.days, spots: t.spots };
    const spots = [...t.spots, { id: 's_xtd', name: '新天地', category: 'sight' as const }];
    const days = t.days.map((d, i) => (i === 1 ? { ...d, items: [...d.items, { id: 'i_xtd', spotId: 's_xtd' }] } : d));
    return { ...t, spots, days, updatedAt: at, chat: [...t.chat, { id: `m_${at}`, role: 'assistant', text: '加了新天地', undo: before, at }] };
  }
  const undo = (t: Trip): Trip => ({ ...t, ...t.chat[t.chat.length - 1].undo!, chat: t.chat.map((m, i, all) => (i === all.length - 1 ? { ...m, undone: true } : m)) });

  it('an AI undo after sharing is not taken back by the other device', () => {
    const s1 = share(phoneTrip());
    const s2 = share(aiTurn(s1.after, 2000));
    const laptop = mergeImported(importedAsNew(parseTrip(s1.url)), parseTrip(s2.url));
    const phone = undo(s2.after);
    // The laptop, unaware, edits on top of the version with the AI's place.
    const fromLaptop = share(edit(laptop, 3000, '筆電的修改'));
    expect(relation(phone, fromLaptop.url)).toBe('diverged');
    // The phone's own link from before the undo is older.
    expect(relation(phone, s2.url)).toBe('older');
    // The other way round: the laptop goes back and shares that; the phone, still on it, follows.
    const laptopBack = share({ ...laptop, ...s1.after, synced: laptop.synced, id: laptop.id, chat: [] });
    expect(relation(s2.after, laptopBack.url)).toBe('newer');
  });

  it('an import that changes the plan retires undo points from before it', () => {
    const s1 = share(aiTurn(phoneTrip(), 2000));
    const fromLaptop = share(edit(importedAsNew(parseTrip(s1.url)), 3000));
    const phone = mergeImported(s1.after, parseTrip(fromLaptop.url));
    expect(phone.chat).toHaveLength(2);
    expect(phone.chat.every((m) => !m.undo)).toBe(true);
    // Nothing changed: the undo point stays.
    expect(mergeImported(s1.after, parseTrip(s1.url)).chat[1].undo).toBeDefined();
  });

  it('keeps a location the AI gave, and the address picked with a location', () => {
    const local = phoneTrip();
    local.spots = local.spots.map((s) =>
      s.id === 's_yuyu' ? { ...s, lat: 31.227, lng: 121.492 } : s.id === 's_hotel' ? { ...s, lat: 31.25, lng: 121.42, geo: 'manual' as const, address: '普陀区武宁路501号鸿运大厦' } : s,
    );
    const remote = phoneTrip();
    remote.spots = remote.spots.map((s) => (s.id === 's_yuyu' ? { ...s, lat: 30.1, lng: 120.1, geo: 'auto' as const } : s));
    // Locating by hand changed the address too, but the plan is the same version.
    expect(relation(local, link(remote))).toBe('same');
    const byId = Object.fromEntries(mergeImported(local, parseTrip(link(remote))).spots.map((s) => [s.id, s]));
    expect(byId.s_yuyu).toMatchObject({ lat: 31.227, lng: 121.492 });
    expect(byId.s_hotel).toMatchObject({ lat: 31.25, geo: 'manual', address: '普陀区武宁路501号鸿运大厦' });
    // No location in the import: the AI's one here stays.
    const bare = phoneTrip();
    bare.spots = bare.spots.map(({ lat: _a, lng: _b, geo: _g, ...s }) => s);
    expect(mergeImported(local, parseTrip(link(bare))).spots[1]).toMatchObject({ lat: 31.227, lng: 121.492 });
  });

  it('after keeping both, the next link from the same device goes to the copy that was kept', () => {
    const s1 = share(phoneTrip());
    const laptop = importedAsNew(parseTrip(s1.url));
    const fromLaptop = share(edit(laptop, 2000, '筆電'));
    const phone = share(edit(s1.after, 2100, '手機')).after;
    expect(relation(phone, fromLaptop.url)).toBe('diverged');
    // Keep both: the store gives the added copy a fresh id.
    const kept = { ...importedAsNew(parseTrip(fromLaptop.url)), id: 't_kept0001' };
    const next = share(edit(fromLaptop.after, 3000, '筆電又改'));
    const target = importTarget([phone, kept], parseTrip(next.url))!;
    expect(target).toEqual({ trip: kept, match: 'copy' });
    expect(compareImport(kept, parseTrip(next.url))).toBe('newer');
  });

  it('an untouched copy is not called changed when the sender\'s history was cut', () => {
    const s1 = share(phoneTrip());
    const partner = importedAsNew(parseTrip(s1.url));
    let a = s1.after;
    let b = importedAsNew(parseTrip(s1.url));
    for (let round = 1; round <= 25; round++) {
      const s = share(edit(a, round * 10, `A${round}`));
      a = s.after;
      b = mergeImported(b, parseTrip(s.url));
      const back = share(edit(b, round * 10 + 5, `B${round}`));
      b = back.after;
      a = mergeImported(a, parseTrip(back.url));
    }
    const latest = parseTrip(share(a).url);
    expect(latest.seen!.length).toBe(40);
    expect(latest.seen).not.toContain(planFingerprint(partner));
    expect(compareImport(partner, latest)).toBe('unknown');
    expect(updateByDefault({ trip: partner, match: 'id' }, 'unknown', latest)).toBe(true);
  });

  it('a first share carries no history, so it cannot prove both sides changed', () => {
    const copy = share({ ...phoneTrip(), id: 't_copy0001' }).after; // an old copy that was exported once
    const first = parseTrip(link(edit(phoneTrip(), 2000)));
    expect(first.seen).toEqual([]);
    expect(compareImport(copy, first)).toBe('unknown');
  });

  it('a trip that only shares the name is never shown as the same trip changed on both sides', () => {
    const lastYear = share({ ...phoneTrip(), id: 't_2025', days: [{ id: 'd_zzzzzz', items: [] }], spots: [] }).after;
    const friend = parseTrip(share(share({ ...phoneTrip(), id: 't_friend' }).after).url);
    const target = importTarget([lastYear], friend)!;
    expect(target.match).toBe('name');
    expect(compareImport(lastYear, friend)).toBe('diverged');
    expect(importRelation(target, friend)).toBe('unknown');
    expect(updateByDefault(target, 'unknown', friend)).toBe(false);
  });

  it('an old link without an id adds a new trip by default, as it always did', () => {
    const d = JSON.parse(exportJson(phoneTrip()));
    delete d.id;
    delete d.seen;
    const old = parseTrip(JSON.stringify(d));
    const copy = { ...edit(phoneTrip(), 5000, '之後改過'), id: 't_copy0001' };
    const target = importTarget([copy], old)!;
    expect(target.match).toBe('copy');
    expect(updateByDefault(target, compareImport(copy, old), old)).toBe(false);
  });
});

describe('formatStamp', () => {
  it('shows the year only when it is not this year', () => {
    const now = new Date(2026, 9, 17);
    expect(formatStamp(new Date(2026, 9, 17, 15, 5).getTime(), now)).toBe('10/17 15:05');
    expect(formatStamp(new Date(2025, 0, 2, 9, 0).getTime(), now)).toBe('2025/1/2 09:00');
  });
});
