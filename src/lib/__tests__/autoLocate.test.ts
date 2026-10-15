import { beforeEach, describe, expect, it } from 'vitest';
import { planRelayApply, tripFingerprint } from '../ai/relay';
import {
  contextFor,
  createLocator,
  findPlace,
  locateKey,
  useLocateStatus,
  type FindContext,
  type LocatorDeps,
  type MissMemory,
} from '../autoLocate';
import type { PlaceResult } from '../geocode';
import { isGenericName, nameScore, normName, pickPlace, queryVariants } from '../placeMatch';
import { toSimplified } from '../t2s';
import { keepLocations } from '../tripOps';
import type { LatLng, Spot, Trip, TripSnapshot } from '../../types';

const SHANGHAI = { lat: 31.2304, lng: 121.4737 };
const place = (name: string, lat: number, lng: number, extra: Partial<PlaceResult> = {}): PlaceResult => ({
  name,
  address: '',
  lat,
  lng,
  source: 'osm',
  ...extra,
});

describe('Traditional → Simplified', () => {
  it('converts place names character by character', () => {
    expect(toSimplified('磁浮列車 龍陽路站')).toBe('磁浮列车 龙阳路站');
    expect(toSimplified('浦東國際機場')).toBe('浦东国际机场');
    expect(toSimplified('東方明珠廣播電視塔')).toBe('东方明珠广播电视塔');
    expect(toSimplified('Kyoto 清水寺')).toBe('Kyoto 清水寺');
  });
  it('handles Taiwan variants', () => {
    expect(toSimplified('為')).toBe('为');
    expect(toSimplified('裡')).toBe('里');
    expect(toSimplified('臺北')).toBe('台北');
  });
});

describe('place names', () => {
  it('normalises for comparison', () => {
    expect(normName(' 小楊生煎（黃河路店） ')).toBe('小杨生煎黄河路店');
    expect(normName('Fushimi Inari-Taisha')).toBe('fushimiinaritaisha');
  });

  it('recognises names that are not a place', () => {
    for (const n of ['飯店', '回飯店休息', '午餐（附近找）', '自由活動', 'Check-in', '機場', '晚餐', 'Free time', '早餐 自理']) {
      expect(isGenericName(n), n).toBe(true);
    }
    for (const n of ['浦東國際機場', '外灘散步', '晚餐：南翔饅頭店', '豫園', '上海站', 'Louvre', '磁浮列車 龍陽路站', '住吉大社', 'Resto', 'Forest Park', 'Hotel Okura', '入住 錦江飯店']) {
      expect(isGenericName(n), n).toBe(false);
    }
  });

  it('tries the specific part of a name after the full name', () => {
    expect(queryVariants('磁浮列車 龍陽路站')).toEqual(['磁浮列車 龍陽路站', '龍陽路站', '龍陽路']);
    expect(queryVariants('小楊生煎（黃河路店）')).toEqual(['小楊生煎(黃河路店)', '小楊生煎']);
    expect(queryVariants('晚餐：南翔饅頭店')).toEqual(['晚餐:南翔饅頭店', '南翔饅頭店']);
    expect(queryVariants('Fushimi Inari Taisha')).toEqual(['Fushimi Inari Taisha']);
    expect(queryVariants('浦東國際機場')).toEqual(['浦東國際機場']);
    expect(queryVariants('a')).toEqual([]);
  });

  it('scores names across scripts', () => {
    expect(nameScore('浦東國際機場', ['浦东国际机场'])).toBe(1);
    expect(nameScore('浦東國際機場', ['上海浦东国际机场'])).toBe(0.9);
    expect(nameScore('東方明珠廣播電視塔', ['东方明珠'])).toBe(0.9);
    expect(nameScore('龍陽路站', ['龙阳路'])).toBe(1);
    expect(nameScore('上海站', ['上海虹桥站'])).toBeLessThan(1);
    expect(nameScore('伏見稻荷大社', ['伏見稲荷大社'])).toBeGreaterThanOrEqual(0.5);
    expect(nameScore('浦東國際機場', ['虹桥国际机场'])).toBeLessThan(0.5);
    expect(nameScore('龍陽路站', ['龙华路站'])).toBeLessThan(0.5);
    expect(nameScore('小楊生煎', ['锦江饭店'])).toBe(0);
  });
});

describe('pickPlace', () => {
  it('prefers the branch the name asks for', () => {
    const other = place('小杨生煎(吴江路店)', 31.23, 121.46);
    const asked = place('小杨生煎(黄河路店)', 31.24, 121.47);
    expect(pickPlace([other, asked], '小楊生煎（黃河路店）', '小楊生煎', [SHANGHAI])).toBe(asked);
    expect(pickPlace([other], '小楊生煎（黃河路店）', '小楊生煎', [SHANGHAI])).toBe(other);
  });

  it('needs a matching name', () => {
    const r = [place('锦江饭店', 31.2, 121.47), place('小杨生煎(吴江路店)', 31.23, 121.46)];
    expect(pickPlace(r, '小楊生煎', '小楊生煎', [SHANGHAI])?.name).toBe('小杨生煎(吴江路店)');
    expect(pickPlace([place('锦江饭店', 31.2, 121.47)], '小楊生煎', '小楊生煎', [SHANGHAI])).toBeNull();
  });

  it('rejects matches far from the rest of the trip', () => {
    const far = place('东方明珠', 39.9, 116.4); // Beijing
    expect(pickPlace([far], '東方明珠', '東方明珠', [SHANGHAI])).toBeNull();
    expect(pickPlace([far], '東方明珠', '東方明珠', [])).toBe(far);
  });

  it('prefers the station when the name is a station', () => {
    const road = place('龙阳路', 31.2, 121.55, { kind: 'highway:primary' });
    const station = place('龙阳路', 31.203, 121.557, { kind: 'railway:station' });
    expect(pickPlace([road, station], '磁浮列車 龍陽路站', '龍陽路', [SHANGHAI])).toBe(station);
  });

  it('matches through alternative names', () => {
    const r = place('Shanghai Pudong International Airport', 31.15, 121.8, { names: ['上海浦东国际机场'] });
    expect(pickPlace([r], '浦東國際機場', '浦東國際機場', [SHANGHAI])).toBe(r);
  });
});

describe('findPlace', () => {
  const ctx: FindContext = { region: 'cn', destination: '上海', anchors: [SHANGHAI], center: SHANGHAI };

  it('tries the query variants, inside the trip area first', async () => {
    const calls: string[] = [];
    const osm = async (q: string, o: { bounded?: boolean } | LatLng = {}) => {
      calls.push(`${q}|${'bounded' in o && o.bounded ? 'box' : 'any'}`);
      return q === '龍陽路站' ? [place('龙阳路站', 31.203, 121.557, { kind: 'railway:station' })] : [];
    };
    const r = await findPlace('磁浮列車 龍陽路站', ctx, { osm, amap: async () => [] });
    expect(r?.name).toBe('龙阳路站');
    expect(calls).toEqual(['磁浮列車 龍陽路站|box', '龍陽路站|box']);
  });

  it('uses Amap first when a key is set, and OpenStreetMap when Amap fails', async () => {
    const osmCalls: string[] = [];
    const amap = async () => {
      throw new Error('INVALID_USER_KEY');
    };
    const osm = async (q: string) => {
      osmCalls.push(q);
      return [place('上海浦东国际机场', 31.15, 121.8)];
    };
    const r = await findPlace('浦東國際機場', { ...ctx, amap: { key: 'k', securityCode: '' } }, { osm, amap });
    expect(r?.lat).toBe(31.15);
    expect(osmCalls).toEqual(['浦東國際機場']);
    const fromAmap = await findPlace(
      '浦東國際機場',
      { ...ctx, amap: { key: 'k', securityCode: '' } },
      { osm: async () => [], amap: async () => [{ ...place('上海浦东国际机场', 31.14, 121.81), source: 'amap' }] },
    );
    expect(fromAmap?.source).toBe('amap');
  });

  it('returns null when nothing matches, and throws when the service fails', async () => {
    expect(await findPlace('不存在的地方', ctx, { osm: async () => [], amap: async () => [] })).toBeNull();
    await expect(
      findPlace('豫園', ctx, {
        osm: async () => {
          throw new Error('OpenStreetMap 搜尋失敗（429）');
        },
        amap: async () => [],
      }),
    ).rejects.toThrow('429');
  });
});

// ------------------------------------------------------------------ the queue

function spot(id: string, name: string, at?: LatLng): Spot {
  return { id, name, category: 'sight', ...(at ?? {}) };
}

function mkTrip(spots: Spot[], extra: Partial<Trip> = {}): Trip {
  return {
    id: 't1',
    name: '上海',
    destination: '上海',
    days: [{ id: 'd1', items: spots.map((s, i) => ({ id: `i${i}`, spotId: s.id })) }],
    spots,
    mapRegion: 'auto',
    chat: [],
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  };
}

function harness(trip: Trip, find: LocatorDeps['find'], opts: Partial<LocatorDeps> = {}) {
  let current = trip;
  const missed = new Set<string>();
  const misses: MissMemory = { has: (k) => missed.has(k), add: (k) => void missed.add(k), delete: (k) => void missed.delete(k) };
  const locator = createLocator({
    getTrip: (id) => (id === current.id ? current : undefined),
    getSettings: () => ({ amapKey: '', amapSecurityCode: '' }),
    find,
    save: (tripId, spotId, name, at) => {
      const s = current.spots.find((x) => x.id === spotId);
      if (tripId !== current.id || !s || s.lat !== undefined || s.name !== name) return false;
      current = { ...current, spots: current.spots.map((x) => (x.id === spotId ? { ...x, ...at, geo: 'auto' as const } : x)) };
      return true;
    },
    findCenter: async () => SHANGHAI,
    setCenter: (_id, center) => {
      current = { ...current, center };
    },
    misses,
    online: () => true,
    retryDelayMs: 5,
    ...opts,
  });
  return {
    locator,
    missed,
    get trip() {
      return current;
    },
    set trip(t: Trip) {
      current = t;
    },
    status: (id: string) => {
      const s = current.spots.find((x) => x.id === id)!;
      return useLocateStatus.getState().byKey[locateKey(current.id, s)];
    },
  };
}

describe('background locator', () => {
  beforeEach(() => useLocateStatus.setState({ byKey: {} }));

  it('locates places without coordinates and leaves the others alone', async () => {
    const seen: string[] = [];
    const h = harness(
      mkTrip([spot('a', '外灘', SHANGHAI), spot('b', '浦東國際機場'), spot('c', '午餐（附近找）'), spot('d', '不存在的店')]),
      async (name) => {
        seen.push(name);
        return name === '浦東國際機場' ? place('上海浦东国际机场', 31.15, 121.8) : null;
      },
    );
    h.locator.schedule(h.trip);
    await h.locator.idle();
    expect(seen).toEqual(['浦東國際機場', '不存在的店']);
    expect(h.trip.spots.find((s) => s.id === 'b')).toMatchObject({ lat: 31.15, lng: 121.8, geo: 'auto' });
    expect(h.status('b')).toBe('found');
    expect(h.status('c')).toBe('skipped');
    expect(h.status('d')).toBe('not-found');
    // Nothing found is remembered; scheduling again does not search again.
    h.locator.schedule(h.trip);
    await h.locator.idle();
    expect(seen).toHaveLength(2);
  });

  it('a renamed place is searched again under its new name', async () => {
    const seen: string[] = [];
    const h = harness(mkTrip([spot('a', '不存在的店')]), async (name) => {
      seen.push(name);
      return name === '豫園' ? place('豫园', 31.227, 121.492) : null;
    });
    h.locator.schedule(h.trip);
    await h.locator.idle();
    h.trip = { ...h.trip, spots: [spot('a', '豫園')] };
    h.locator.schedule(h.trip);
    await h.locator.idle();
    expect(seen).toEqual(['不存在的店', '豫園']);
    expect(h.trip.spots[0].lat).toBe(31.227);
  });

  it('does not overwrite a place renamed or located by hand during the search', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness(mkTrip([spot('a', '豫園')]), async () => {
      await gate;
      return place('豫园', 31.227, 121.492);
    });
    h.locator.schedule(h.trip);
    await Promise.resolve();
    h.trip = { ...h.trip, spots: [{ ...spot('a', '豫園', { lat: 1, lng: 2 }), geo: 'manual' }] };
    release();
    await h.locator.idle();
    expect(h.trip.spots[0]).toMatchObject({ lat: 1, lng: 2, geo: 'manual' });
  });

  it('pauses when the service fails and tries again later', async () => {
    let fail = true;
    let calls = 0;
    const h = harness(mkTrip([spot('a', '豫園')]), async () => {
      calls++;
      if (fail) throw new Error('offline');
      return place('豫园', 31.227, 121.492);
    });
    h.locator.schedule(h.trip);
    await h.locator.idle();
    expect(h.status('a')).toBe('queued');
    fail = false;
    await new Promise((r) => setTimeout(r, 30));
    await h.locator.idle();
    expect(calls).toBe(2);
    expect(h.status('a')).toBe('found');
  });

  it('retry searches a place that found nothing before', async () => {
    let found = false;
    const h = harness(mkTrip([spot('a', '新開的店')]), async () => (found ? place('新开的店', 31.2, 121.4) : null));
    h.locator.schedule(h.trip);
    await h.locator.idle();
    expect(h.status('a')).toBe('not-found');
    found = true;
    h.locator.retry(h.trip, ['a']);
    await h.locator.idle();
    expect(h.status('a')).toBe('found');
    expect(h.missed.size).toBe(0);
  });

  it('finds the destination first when the trip has no located place', async () => {
    let ctxSeen: FindContext | undefined;
    const h = harness(mkTrip([spot('a', '豫園')]), async (_n, ctx) => {
      ctxSeen = ctx;
      return null;
    });
    h.locator.schedule(h.trip);
    await h.locator.idle();
    expect(h.trip.center).toEqual(SHANGHAI);
    expect(ctxSeen?.center).toEqual(SHANGHAI);
    expect(ctxSeen?.anchors).toEqual([SHANGHAI]);
  });

  it('builds the search context from the trip', () => {
    const t = mkTrip([spot('a', '外灘', { lat: 31.24, lng: 121.49 }), spot('b', '豫園')], { mapRegion: 'cn' });
    const ctx = contextFor(t, { amapKey: ' key ', amapSecurityCode: 'sec' });
    expect(ctx).toMatchObject({ region: 'cn', destination: '上海', center: { lat: 31.24, lng: 121.49 }, amap: { key: 'key', securityCode: 'sec' } });
    expect(contextFor(t, { amapKey: '', amapSecurityCode: '' }).amap).toBeUndefined();
  });
});

// ------------------------------------------------------------------ keeping locations

function snap(spots: Spot[]): TripSnapshot {
  return { name: 'x', destination: '上海', days: [{ id: 'd1', items: spots.map((s, i) => ({ id: `i${i}`, spotId: s.id })) }], spots };
}

describe('keepLocations', () => {
  it('fills in coordinates found since the snapshot', () => {
    const old = snap([spot('a', '豫園'), spot('b', '外灘', { lat: 1, lng: 1 })]);
    const now = snap([{ ...spot('a', '豫園', { lat: 31.2, lng: 121.4 }), geo: 'auto' }, spot('b', '外灘', { lat: 2, lng: 2 })]);
    const kept = keepLocations(old, now);
    expect(kept.spots[0]).toMatchObject({ lat: 31.2, lng: 121.4, geo: 'auto' });
    // Coordinates the snapshot has stay as they are (an AI change being undone, for example).
    expect(kept.spots[1]).toMatchObject({ lat: 1, lng: 1 });
  });

  it('a hand-picked location wins only when restoring an older version', () => {
    const old = snap([spot('a', '豫園', { lat: 1, lng: 1 })]);
    const now = snap([{ ...spot('a', '豫園', { lat: 31.2, lng: 121.4 }), geo: 'manual' }]);
    expect(keepLocations(old, now, true).spots[0]).toMatchObject({ lat: 31.2, geo: 'manual' });
    expect(keepLocations(old, now, false).spots[0]).toMatchObject({ lat: 1 });
  });

  it('matches re-created places by name, and never a renamed one', () => {
    const now = snap([{ ...spot('a', '豫園', { lat: 31.2, lng: 121.4 }), geo: 'auto' }]);
    expect(keepLocations(snap([spot('z', '豫 園')]), now).spots[0]).toMatchObject({ lat: 31.2 });
    expect(keepLocations(snap([spot('a', '城隍廟')]), now).spots[0].lat).toBeUndefined();
  });

  it('returns the same object when nothing changes', () => {
    const s = snap([spot('a', '豫園', { lat: 1, lng: 1 })]);
    expect(keepLocations(s, s)).toBe(s);
  });
});

describe('relay replies and located places', () => {
  const block = (obj: unknown) => '```travelplan\n' + JSON.stringify(obj) + '\n```';
  const newSpot = (rev: number, extra: object[] = []) =>
    `好\n${block({ base: 'tag001', rev, ops: [{ tool: 'set_day_plans', input: { days: [{ day: 1, items: [{ new_spot: { name: '浦東國際機場', category: 'sight' } }, ...extra] }] } }] })}`;

  function sentTrip(): Trip {
    const t = mkTrip([spot('s_bund', '外灘', { lat: 31.24, lng: 121.49 })]);
    return { ...t, chat: [{ id: 'u0', role: 'user', text: 'req', at: 0, relay: { tag: 'tag001', fp: tripFingerprint(t) } }] };
  }
  function commit(t: Trip, raw: string): Trip {
    const d = planRelayApply(raw, t, []);
    if (d.kind !== 'apply') throw new Error(d.kind);
    return {
      ...t,
      ...keepLocations(d.result.trip, t),
      chat: [
        ...t.chat.map((m) => (m.id === d.replaces ? { ...m, superseded: true, relayStart: undefined } : m)),
        {
          id: `a${t.chat.length}`,
          role: 'assistant',
          text: '',
          at: 0,
          relayBase: d.parsed.base,
          relayRev: d.parsed.rev,
          relayResult: tripFingerprint(d.result.trip),
          relayOps: d.opsFp,
          relayStart: d.requestBase,
          undo: d.before,
        },
      ],
    };
  }
  const locate = (t: Trip, name: string, at: LatLng, geo: 'auto' | 'manual' = 'auto'): Trip => ({
    ...t,
    spots: t.spots.map((s) => (s.name === name ? { ...s, ...at, geo } : s)),
  });

  it('locating a place after a reply does not count as an edit', () => {
    let t = commit(sentTrip(), newSpot(1));
    t = locate(t, '浦東國際機場', { lat: 31.15, lng: 121.8 });
    expect(planRelayApply(newSpot(1), t, []).kind).toBe('duplicate');
    const d = planRelayApply(newSpot(2, [{ spot_id: 's_bund' }]), t, []);
    if (d.kind !== 'apply') throw new Error(d.kind);
    expect(d.confirm).toBeNull();
    expect(d.replaces).toBeDefined();
    expect(d.dropped).toEqual([]);
    expect(d.result.trip.spots.find((s) => s.name === '浦東國際機場')).toMatchObject({ lat: 31.15, lng: 121.8, geo: 'auto' });
  });

  it('a newer version with its own (wrong) coordinates does not undo a location picked by hand', () => {
    let t = commit(sentTrip(), newSpot(1));
    t = locate(t, '浦東國際機場', { lat: 31.15, lng: 121.8 }, 'manual');
    const withCoords = `好\n${block({ base: 'tag001', rev: 2, ops: [{ tool: 'set_day_plans', input: { days: [{ day: 1, items: [{ new_spot: { name: '浦東國際機場', category: 'sight', lat: 30, lng: 120 } }] }] } }] })}`;
    const d = planRelayApply(withCoords, t, []);
    if (d.kind !== 'apply') throw new Error(d.kind);
    expect(d.result.trip.spots.find((s) => s.name === '浦東國際機場')).toMatchObject({ lat: 31.15, geo: 'manual' });
  });

  it('a new request that moves a place applies on top, over any earlier location', () => {
    let t = locate(sentTrip(), '外灘', { lat: 31.24, lng: 121.49 }, 'manual');
    t = { ...t, chat: [...t.chat, { id: 'u9', role: 'user', text: 'fix', at: 0, relay: { tag: 'tag002', fp: tripFingerprint(t) } }] };
    const move = `好\n${block({ base: 'tag002', ops: [{ tool: 'update_spots', input: { updates: [{ spot_id: 's_bund', lat: 31.25, lng: 121.5 }] } }] })}`;
    const d = planRelayApply(move, t, []);
    if (d.kind !== 'apply') throw new Error(d.kind);
    expect(d.confirm).toBeNull();
    const bund = d.result.trip.spots.find((s) => s.id === 's_bund')!;
    expect(bund).toMatchObject({ lat: 31.25, lng: 121.5 });
    expect(bund.geo).toBeUndefined();
  });
});
