import { useState } from 'react';
import { searchAmap, searchOsm, type PlaceResult } from '../lib/geocode';
import { tripRegion } from '../lib/geo';
import { CATEGORIES } from '../lib/tripOps';
import { formatDayDate } from '../lib/util';
import { useCurrentTrip, useStore } from '../store';
import type { Category } from '../types';
import { CATEGORY_ICON, CATEGORY_LABEL } from '../types';
import { useUI } from '../ui';
import { Modal } from './Modal';

export function AddSpotModal() {
  const opts = useUI((s) => s.addSpot);
  const trip = useCurrentTrip();
  if (!opts || !trip) return null;
  return <AddSpotInner key={JSON.stringify(opts)} />;
}

function AddSpotInner() {
  const opts = useUI((s) => s.addSpot)!;
  const ui = useUI();
  const trip = useCurrentTrip()!;
  const settings = useStore((s) => s.settings);
  const { addSpot, addToDay, updateSpot } = useStore.getState();
  const locating = opts.locateId ? trip.spots.find((s) => s.id === opts.locateId) : undefined;

  const [name, setName] = useState(locating?.name ?? '');
  const [category, setCategory] = useState<Category>(locating?.category ?? opts.category ?? 'sight');
  const [address, setAddress] = useState(locating?.address ?? '');
  const [note, setNote] = useState('');
  const [query, setQuery] = useState(locating ? `${locating.name} ${trip.destination}`.trim() : '');
  const [results, setResults] = useState<PlaceResult[] | null>(null);
  const [picked, setPicked] = useState<PlaceResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const region = tripRegion(trip);
  const hasAmap = !!settings.amapKey.trim();
  const [source, setSource] = useState<'osm' | 'amap'>(region === 'cn' && hasAmap ? 'amap' : 'osm');

  const close = () => ui.openAddSpot(null);

  const search = async () => {
    const q = (query || name).trim();
    if (!q) return;
    setBusy(true);
    setError('');
    setPicked(null);
    try {
      const r =
        source === 'amap'
          ? await searchAmap(q, trip.destination, settings.amapKey.trim(), settings.amapSecurityCode.trim())
          : await searchOsm(q, trip.center);
      setResults(r);
    } catch (err) {
      setError((err as Error).message || '搜尋失敗');
      setResults(null);
    } finally {
      setBusy(false);
    }
  };

  const pick = (r: PlaceResult) => {
    setPicked(r);
    if (!locating && !name.trim()) setName(r.name);
    setAddress(r.address);
  };

  const save = () => {
    if (locating) {
      if (picked) {
        updateSpot(locating.id, { lat: picked.lat, lng: picked.lng, geo: 'manual', address: address.trim() || picked.address });
      }
      close();
      ui.showToast('已更新位置');
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
    close();
  };

  const title = locating
    ? `定位「${locating.name}」`
    : opts.day !== undefined
      ? `新增地點到第 ${opts.day + 1} 天 ${formatDayDate(trip.startDate, opts.day)}`
      : '新增候選地點';

  return (
    <Modal
      title={title}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            取消
          </button>
          <span className="grow" />
          <button className="btn btn-primary" disabled={locating ? !picked : !name.trim()} onClick={save}>
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
              autoFocus
              placeholder="例如：清水寺、一蘭拉麵 祇園店"
              onChange={(e) => {
                setName(e.target.value);
                if (!query || query === name) setQuery(e.target.value);
              }}
            />
          </label>
        </>
      )}

      <label className="field">
        <span>搜尋位置（選填，定位後可估算距離、排路線）</span>
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
      {error && <div className="bubble error">{error}</div>}
      {results && (
        <ul className="results">
          {results.length === 0 && <li className="hint">找不到結果，試試加上城市名稱或使用當地語言。</li>}
          {results.map((r, i) => (
            <li key={`${r.lat},${r.lng},${i}`}>
              <button className={picked === r ? 'on' : ''} onClick={() => pick(r)}>
                <b>{r.name}</b>
                <div className="small muted">{r.address}</div>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!hasAmap && region === 'cn' && (
        <p className="hint">中國大陸的地點建議在設定填入高德 Key，搜尋會更準確。</p>
      )}

      {!locating && (
        <details className="more" style={{ marginTop: 8 }}>
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
  );
}
