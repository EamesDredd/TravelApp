import { useEffect, useMemo, useRef, useState } from 'react';
import { parseAmapShare, roadOf } from '../lib/amapLink';
import { searchAmap, searchOsm, type PlaceResult } from '../lib/geocode';
import { hasCoords, tripRegion } from '../lib/geo';
import { readClipboard } from '../lib/handoff';
import { amapSearchLink } from '../lib/maps';
import { forgetLocate, rememberLocate } from '../lib/pendingLocate';
import { isGenericName } from '../lib/placeMatch';
import { CATEGORIES } from '../lib/tripOps';
import { formatDayDate } from '../lib/util';
import { useCurrentTrip, useStore } from '../store';
import type { Category, LatLng, Spot, Trip } from '../types';
import { CATEGORY_ICON, CATEGORY_LABEL } from '../types';
import { useUI } from '../ui';
import type { MapPoint } from './LeafletMap';
import { MapAppLink } from './MapAppLink';
import { Modal } from './Modal';
import { PasteModal } from './PasteModal';
import { PickMap, type MapFocus } from './PickMap';
import { CAT_COLOR } from './SpotMap';

export function AddSpotModal() {
  const opts = useUI((s) => s.addSpot);
  const trip = useCurrentTrip();
  if (!opts || !trip) return null;
  return <AddSpotInner key={JSON.stringify(opts)} />;
}

/** The chosen position and where it came from. */
interface Picked extends LatLng {
  via: 'search' | 'amap' | 'map';
  address?: string;
}

const VIA_LABEL: Record<Picked['via'], string> = { search: '搜尋結果', amap: '高德連結', map: '在地圖上點選' };

const SHORT_LINK_HINT =
  '這是高德的短網址，App 讀不到裡面的位置（瀏覽器的安全限制）。已填好名稱和地址，地圖會移到那條路附近，請在地圖上點一下這個地點；也可以在瀏覽器打開短網址，把跳轉後的長網址貼過來。';

/** Places still without a position, in itinerary order, after `current` (wrapping around). */
function nextToLocate(trip: Trip, current: Spot): { spot: Spot; count: number } | null {
  const byId = new Map(trip.spots.map((s) => [s.id, s]));
  const order: Spot[] = [];
  const seen = new Set<string>();
  for (const d of trip.days) {
    for (const it of d.items) {
      const s = byId.get(it.spotId);
      if (s && !seen.has(s.id)) {
        seen.add(s.id);
        order.push(s);
      }
    }
  }
  for (const s of trip.spots) if (!seen.has(s.id)) order.push(s);
  const todo = order.filter((s) => s.id !== current.id && !hasCoords(s) && !isGenericName(s.name));
  if (!todo.length) return null;
  const at = order.findIndex((s) => s.id === current.id);
  return { spot: todo.find((s) => order.indexOf(s) > at) ?? todo[0], count: todo.length };
}

function AddSpotInner() {
  const opts = useUI((s) => s.addSpot)!;
  const ui = useUI();
  const trip = useCurrentTrip()!;
  const settings = useStore((s) => s.settings);
  const { addSpot, addToDay, updateSpot } = useStore.getState();
  const locating = opts.locateId ? trip.spots.find((s) => s.id === opts.locateId) : undefined;

  const [name, setName] = useState(locating?.name ?? opts.name ?? '');
  const [category, setCategory] = useState<Category>(locating?.category ?? opts.category ?? 'sight');
  const [address, setAddress] = useState(locating?.address ?? '');
  const [note, setNote] = useState('');
  const [query, setQuery] = useState(locating ? `${locating.name} ${trip.destination}`.trim() : (opts.name ?? ''));
  const [results, setResults] = useState<PlaceResult[] | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState(opts.restored ? '回到「定位」了。在高德按「分享」→「复制链接」後，按「貼上高德連結」。' : '');
  const [pasting, setPasting] = useState(false);
  /** Back from the Amap app: the paste button is what comes next. */
  const [returned, setReturned] = useState(!!opts.restored);
  const awaiting = useRef(!!opts.restored);

  const region = tripRegion(trip);
  const cn = region === 'cn';
  const hasAmap = !!settings.amapKey.trim();
  const [source, setSource] = useState<'osm' | 'amap'>(cn && hasAmap ? 'amap' : 'osm');
  const [showMap, setShowMap] = useState(!!locating);

  // The places around, to find one's way on the map: the same day's, else the whole trip's.
  const points = useMemo<MapPoint[]>(() => {
    const byId = new Map(trip.spots.map((s) => [s.id, s]));
    const day = locating ? trip.days.find((d) => d.items.some((it) => it.spotId === locating.id)) : trip.days[opts.day ?? -1];
    const located = (list: (Spot | undefined)[]) => list.filter((s): s is Spot & LatLng => !!s && s.id !== locating?.id && hasCoords(s));
    let near = located(day ? day.items.map((it) => byId.get(it.spotId)) : []);
    if (!near.length) near = located(trip.spots);
    const pts: MapPoint[] = near.slice(0, 40).map((s) => ({ lat: s.lat, lng: s.lng, label: CATEGORY_ICON[s.category], title: s.name, color: CAT_COLOR[s.category] }));
    if (locating && hasCoords(locating)) pts.push({ lat: locating.lat, lng: locating.lng, label: '?', title: `${locating.name}（目前的位置）`, color: '#6b7280' });
    return pts;
  }, [trip, locating, opts.day]);

  const [focus, setFocus] = useState<MapFocus | null>(() => {
    if (locating && hasCoords(locating)) return { at: { lat: locating.lat, lng: locating.lng }, zoom: 16 };
    if (!points.length && trip.center) return { at: trip.center, zoom: 12 };
    return null;
  });

  // Moves the map to the road in an address, when the exact place is not known.
  const looking = useRef(0);
  const lookAround = async (addr: string | undefined) => {
    const road = addr && roadOf(addr);
    if (!road) return;
    const n = ++looking.current;
    try {
      const r = trip.center
        ? await searchOsm(road, { near: trip.center, bounded: true, limit: 1 })
        : await searchOsm(`${road} ${trip.destination}`.trim(), { limit: 1 });
      if (n === looking.current && r[0]) setFocus({ at: { lat: r[0].lat, lng: r[0].lng }, zoom: 16 });
    } catch {
      /* the map stays where it is */
    }
  };

  // Once, when the dialog opens.
  useEffect(() => {
    if (locating && !hasCoords(locating)) void lookAround(locating.address);
  }, []);

  // Coming back from the Amap app.
  useEffect(() => {
    const onShow = () => {
      if (document.visibilityState === 'visible' && awaiting.current) setReturned(true);
    };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, []);

  const close = () => {
    forgetLocate();
    ui.openAddSpot(null);
  };

  const search = async () => {
    const q = (query || name).trim();
    if (!q) return;
    setBusy(true);
    setError('');
    try {
      const r =
        source === 'amap'
          ? await searchAmap(q, trip.destination, settings.amapKey.trim(), settings.amapSecurityCode.trim())
          : await searchOsm(q, trip.center);
      setResults(r);
      setChosen(null);
    } catch (err) {
      setError((err as Error).message || '搜尋失敗');
      setResults(null);
    } finally {
      setBusy(false);
    }
  };

  const pick = (r: PlaceResult, i: number) => {
    setChosen(i);
    setPicked({ lat: r.lat, lng: r.lng, via: 'search', address: r.address });
    if (!locating && !name.trim()) setName(r.name);
    setAddress(r.address);
  };

  /** A link or the text copied from the Amap app. */
  const applyAmap = (text: string) => {
    const s = parseAmapShare(text);
    setError('');
    if (!s) {
      setError('這不是高德的分享連結。請在高德 App 的地點頁按「分享」→「复制链接」，再回來貼上。');
      return;
    }
    setReturned(false);
    awaiting.current = false;
    if (!locating && s.name && !name.trim()) setName(s.name);
    if (s.address) setAddress(s.address);
    setChosen(null);
    setShowMap(true);
    if (s.at) {
      setPicked({ ...s.at, via: 'amap', address: s.address });
      setInfo(`已讀到高德的位置${s.name ? `：${s.name}` : ''}。看一下地圖，沒問題就按「${locating ? '使用這個位置' : '新增'}」。`);
      return;
    }
    setInfo(s.shortUrl ? SHORT_LINK_HINT : '這個高德連結沒有位置資訊，請在地圖上點一下這個地點。');
    void lookAround(s.address ?? address);
  };

  const pasteAmap = async () => {
    const text = await readClipboard();
    if (text && parseAmapShare(text)) applyAmap(text);
    else setPasting(true);
  };

  const save = (next?: Spot) => {
    forgetLocate();
    if (locating) {
      if (picked) updateSpot(locating.id, { lat: picked.lat, lng: picked.lng, geo: 'manual', address: address.trim() || picked.address });
      ui.showToast('已更新位置');
      ui.openAddSpot(next ? { locateId: next.id } : null);
      return;
    }
    const n = name.trim();
    if (!n) return;
    const id = addSpot({
      name: n,
      category,
      address: address.trim() || undefined,
      note: note.trim() || undefined,
      ...(picked ? { lat: picked.lat, lng: picked.lng, geo: 'manual' as const } : {}),
    });
    if (opts.day !== undefined) addToDay(opts.day, id);
    ui.showToast(opts.day !== undefined ? `已加入第 ${opts.day + 1} 天` : '已加入候選');
    ui.openAddSpot(null);
  };

  const next = locating ? nextToLocate(trip, locating) : null;
  const lookupName = (locating?.name ?? name).trim();

  const title = locating
    ? `定位「${locating.name}」`
    : opts.day !== undefined
      ? `新增地點到第 ${opts.day + 1} 天 ${formatDayDate(trip.startDate, opts.day)}`
      : '新增候選地點';

  return (
    <>
      <Modal
        title={title}
        onClose={close}
        footer={
          <>
            <button className="btn" onClick={close}>
              取消
            </button>
            <span className="grow" />
            {locating && next && (
              <button className="btn" disabled={!picked} onClick={() => save(next.spot)} title={`下一個：${next.spot.name}`}>
                使用，下一個（{next.count}）
              </button>
            )}
            <button className="btn btn-primary" disabled={locating ? !picked : !name.trim()} onClick={() => save()}>
              {locating ? '使用這個位置' : picked ? '新增（已定位）' : '新增'}
            </button>
          </>
        }
      >
        {!locating && (
          <>
            <div className="seg" style={{ marginBottom: 12 }}>
              {CATEGORIES.map((c) => (
                <button key={c} className={category === c ? 'on' : ''} onClick={() => setCategory(c)}>
                  {CATEGORY_ICON[c]} {CATEGORY_LABEL[c]}
                </button>
              ))}
            </div>
            <label className="field">
              <span>名稱</span>
              <input
                className="input"
                value={name}
                autoFocus={!opts.name}
                placeholder="例如：清水寺、一蘭拉麵 祇園店"
                onChange={(e) => {
                  setName(e.target.value);
                  if (!query || query === name) setQuery(e.target.value);
                }}
              />
            </label>
          </>
        )}

        {cn && (
          <div className="amap-tools">
            <div className="row-wrap">
              {lookupName ? (
                <MapAppLink
                  className="btn btn-sm"
                  link={amapSearchLink({ id: locating?.id ?? '', name: lookupName, category }, trip.destination)}
                  onClick={() => {
                    rememberLocate(trip.id, locating ? { locateId: locating.id } : { ...opts, name: name.trim() || undefined });
                    awaiting.current = true;
                  }}
                >
                  🔎 在高德 App 找
                </MapAppLink>
              ) : (
                <button className="btn btn-sm" disabled title="先輸入名稱">
                  🔎 在高德 App 找
                </button>
              )}
              <button className={`btn btn-sm${returned ? ' btn-primary' : ''}`} onClick={pasteAmap}>
                📋 貼上高德連結
              </button>
            </div>
            <p className="hint">
              {returned
                ? '從高德回來了？按「貼上高德連結」。'
                : `在高德找到後按「分享」→「复制链接」，回來按「貼上高德連結」，就會填好位置${locating ? '和地址' : '、名稱和地址'}。`}
            </p>
          </div>
        )}
        {info && <div className="notice small" style={{ margin: '8px 0' }}>{info}</div>}
        {error && <div className="bubble error">{error}</div>}

        {picked && (
          <p className="small picked-line">
            📍 已選位置（{VIA_LABEL[picked.via]}）{address.trim() ? `：${address.trim()}` : ''}
          </p>
        )}
        {showMap ? (
          <>
            <PickMap
              region={region}
              value={picked}
              focus={focus}
              points={points}
              onPick={(at) => {
                setPicked({ ...at, via: 'map' });
                setChosen(null);
              }}
            />
            <p className="hint">
              在地圖上點一下就能選位置{cn ? '；高德底圖放大後可以看到店名和大樓' : ''}。
            </p>
          </>
        ) : (
          <button className="btn btn-sm" style={{ marginTop: 4 }} onClick={() => setShowMap(true)}>
            🗺 在地圖上選位置
          </button>
        )}

        <label className="field" style={{ marginTop: 12 }}>
          <span>搜尋位置{locating ? '' : '（選填，定位後可估算距離、排路線）'}</span>
          <div className="row">
            <input
              className="input grow"
              value={query}
              placeholder={`${name || '地點名稱'} ${trip.destination}`.trim()}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && search()}
            />
            <button className="btn" onClick={search} disabled={busy}>
              {busy ? '…' : '搜尋'}
            </button>
          </div>
        </label>
        {hasAmap && (
          <div className="seg" style={{ marginBottom: 8 }}>
            <button className={source === 'osm' ? 'on' : ''} onClick={() => setSource('osm')}>
              OpenStreetMap
            </button>
            <button className={source === 'amap' ? 'on' : ''} onClick={() => setSource('amap')}>
              高德（中國大陸）
            </button>
          </div>
        )}
        {results && (
          <ul className="results">
            {results.length === 0 && (
              <li className="hint">
                找不到結果，試試加上城市名稱或使用當地語言{cn && !hasAmap ? '；中國大陸的店家和飯店可以改用上面的「在高德 App 找」' : ''}。
              </li>
            )}
            {results.map((r, i) => (
              <li key={`${r.lat},${r.lng},${i}`}>
                <button className={chosen === i ? 'on' : ''} onClick={() => pick(r, i)}>
                  <b>{r.name}</b>
                  <div className="small muted">{r.address}</div>
                </button>
              </li>
            ))}
          </ul>
        )}

        {!locating && (
          <details className="more" style={{ marginTop: 8 }} open={!!address && !picked}>
            <summary>地址與備註</summary>
            <label className="field">
              <span>地址 / 區域</span>
              <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} />
            </label>
            <label className="field">
              <span>備註</span>
              <textarea className="textarea" value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
          </details>
        )}
      </Modal>
      {pasting && (
        <PasteModal
          title="貼上高德連結"
          hint="在高德 App 的地點頁按「分享」→「复制链接」，再長按下面的框框貼上。"
          submitLabel="讀取"
          onSubmit={applyAmap}
          onClose={() => setPasting(false)}
        />
      )}
    </>
  );
}
