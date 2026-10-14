import { useEffect, useState } from 'react';
import { aiConfigured, FriendlyError, providerLabel, searchSpot, spotSearchIsLive } from '../lib/ai';
import { hasCoords, spotRegion } from '../lib/geo';
import { placeQuery, quickSearchLinks } from '../lib/maps';
import { CATEGORIES, scheduledDays } from '../lib/tripOps';
import { formatDayDate } from '../lib/util';
import { wikiSearch, wikiSummary, type WikiHit, type WikiSummary } from '../lib/wiki';
import { useCurrentTrip, useStore } from '../store';
import type { Category, Spot, Trip } from '../types';
import { CATEGORY_ICON, CATEGORY_LABEL } from '../types';
import { useUI } from '../ui';
import { Markdown } from './Markdown';
import { Modal } from './Modal';
import { SpotMap } from './SpotMap';

export function SpotDetail() {
  const spotId = useUI((s) => s.spotId);
  const trip = useCurrentTrip();
  const spot = trip?.spots.find((s) => s.id === spotId);
  const close = () => useUI.getState().openSpot(null);
  if (!trip || !spot) return null;
  return <SpotDetailInner key={spot.id} trip={trip} spot={spot} onClose={close} />;
}

function SpotDetailInner({ trip, spot, onClose }: { trip: Trip; spot: Spot; onClose(): void }) {
  const updateSpot = useStore((s) => s.updateSpot);
  const removeSpot = useStore((s) => s.removeSpot);
  const ui = useUI();
  const region = spotRegion(spot, trip);
  const days = scheduledDays(trip, spot.id);

  return (
    <Modal
      title={
        <span className="row">
          <span className={`cat-dot cat-${spot.category}`}>{CATEGORY_ICON[spot.category]}</span>
          <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {spot.name}
          </span>
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <button
            className="btn btn-danger"
            onClick={() => {
              if (confirm(`刪除「${spot.name}」？也會從每日行程中移除。`)) {
                removeSpot(spot.id);
                onClose();
              }
            }}
          >
            刪除
          </button>
          <span className="grow" />
          <button className="btn btn-primary" onClick={() => ui.openPickDay(spot.id)}>
            ＋ 加入行程
          </button>
        </>
      }
    >
      <div className="row-wrap" style={{ marginBottom: 10 }}>
        {days.length ? (
          days.map((d) => (
            <span key={d} className="chip chip-accent">
              已排入第 {d + 1} 天 {formatDayDate(trip.startDate, d)}
            </span>
          ))
        ) : (
          <span className="chip">尚未排入行程</span>
        )}
        <span className="chip">{region === 'cn' ? '高德地圖' : 'Google 地圖'}</span>
      </div>

      <SpotMap spot={spot} region={region} destination={trip.destination} />

      <div className="section">
        <h3>基本資料</h3>
        <label className="field">
          <span>名稱</span>
          <input
            className="input"
            defaultValue={spot.name}
            onBlur={(e) => e.target.value.trim() && updateSpot(spot.id, { name: e.target.value.trim() })}
          />
        </label>
        <div className="row" style={{ marginBottom: 12 }}>
          <div className="seg grow">
            {CATEGORIES.map((c: Category) => (
              <button key={c} className={spot.category === c ? 'on' : ''} onClick={() => updateSpot(spot.id, { category: c })}>
                {CATEGORY_ICON[c]} {CATEGORY_LABEL[c]}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span>地址 / 區域</span>
          <input
            className="input"
            defaultValue={spot.address ?? ''}
            placeholder="例如：京都市東山區清水 1-294"
            onBlur={(e) => updateSpot(spot.id, { address: e.target.value.trim() || undefined })}
          />
        </label>
        <div className="row" style={{ marginBottom: 12 }}>
          <span className="small muted grow">
            {hasCoords(spot) ? `座標 ${spot.lat.toFixed(5)}, ${spot.lng.toFixed(5)}` : '尚未定位（距離與路線估算需要座標）'}
          </span>
          <button className="btn btn-sm" onClick={() => ui.openAddSpot({ locateId: spot.id })}>
            📍 {hasCoords(spot) ? '修正位置' : '定位'}
          </button>
        </div>
        <div className="row" style={{ marginBottom: 12 }}>
          <label className="field grow" style={{ margin: 0 }}>
            <span>建議停留（分鐘）</span>
            <input
              className="input"
              type="number"
              inputMode="numeric"
              min={0}
              step={15}
              defaultValue={spot.durationMin ?? ''}
              onBlur={(e) => {
                const n = Number(e.target.value);
                updateSpot(spot.id, { durationMin: n > 0 ? Math.round(n) : undefined });
              }}
            />
          </label>
        </div>
        <label className="field">
          <span>備註</span>
          <textarea
            className="textarea"
            defaultValue={spot.note ?? ''}
            placeholder="營業時間、必點、預約提醒…"
            onBlur={(e) => updateSpot(spot.id, { note: e.target.value.trim() || undefined })}
          />
        </label>
      </div>

      <WebSearch spot={spot} trip={trip} region={region} />
    </Modal>
  );
}

function WebSearch({ spot, trip, region }: { spot: Spot; trip: Trip; region: 'cn' | 'intl' }) {
  const settings = useStore((s) => s.settings);
  const updateSpot = useStore((s) => s.updateSpot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready = aiConfigured(settings);

  const runAi = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await searchSpot(settings, spot, trip.destination);
      updateSpot(spot.id, { search: result });
    } catch (err) {
      setError(err instanceof FriendlyError ? err.message : `搜尋失敗：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="section">
      <h3>網路搜尋</h3>
      <div className="card">
        <div className="row" style={{ marginBottom: spot.search || busy || error ? 8 : 0 }}>
          <div className="grow small">
            <b>AI 搜尋整理</b>
            <div className="muted">
              {ready
                ? `${providerLabel(settings)}${spotSearchIsLive(settings) ? ' · 即時網路搜尋' : ' · 未連網'}`
                : '到「設定」連接 Claude 或 ChatGPT 後可使用'}
            </div>
          </div>
          <button
            className={`btn btn-sm ${spot.search ? '' : 'btn-primary'}`}
            disabled={busy || !ready}
            onClick={runAi}
          >
            {busy ? '搜尋中…' : spot.search ? '重新搜尋' : '🔎 搜尋'}
          </button>
        </div>
        {busy && (
          <div className="status-line">
            <span className="spinner" /> 正在搜尋「{placeQuery(spot, trip.destination)}」…
          </div>
        )}
        {error && <div className="bubble error">{error}</div>}
        {spot.search && !busy && (
          <>
            <Markdown text={spot.search.summary || '（沒有找到資料）'} />
            {spot.search.sources.length > 0 && (
              <ul className="sources">
                {spot.search.sources.slice(0, 8).map((s) => (
                  <li key={s.url}>
                    <a href={s.url} target="_blank" rel="noreferrer">
                      🔗 {s.title}
                    </a>
                  </li>
                ))}
              </ul>
            )}
            <p className="hint">
              {spot.search.provider} · {new Date(spot.search.at).toLocaleString('zh-TW')}
            </p>
          </>
        )}
      </div>

      <WikiResults spot={spot} destination={trip.destination} />

      <div className="row-wrap" style={{ marginTop: 10 }}>
        {quickSearchLinks(spot, trip.destination, region).map((l) => (
          <a key={l.label} className="chip" href={l.url} target="_blank" rel="noreferrer">
            {l.label} ↗
          </a>
        ))}
      </div>
    </div>
  );
}

function WikiResults({ spot, destination }: { spot: Spot; destination: string }) {
  const [enabled, setEnabled] = useState(spot.category === 'sight');
  const [hits, setHits] = useState<WikiHit[] | null>(null);
  const [summary, setSummary] = useState<WikiSummary | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setHits(null);
    setError('');
    wikiSearch(spot.name)
      .then(async (h) => {
        if (!alive) return;
        setHits(h);
        // Only show a summary card when the top hit is clearly this place.
        if (h[0] && (h[0].title.includes(spot.name) || spot.name.includes(h[0].title))) {
          const s = await wikiSummary(h[0].title);
          if (alive) setSummary(s);
        }
      })
      .catch(() => alive && setError('無法連線到維基百科'));
    return () => {
      alive = false;
    };
  }, [enabled, spot.name, destination]);

  return (
    <div className="card" style={{ marginTop: 10 }}>
      <div className="row">
        <b className="small grow">維基百科</b>
        {!enabled && (
          <button className="btn btn-sm" onClick={() => setEnabled(true)}>
            搜尋
          </button>
        )}
      </div>
      {enabled && !hits && !error && (
        <div className="status-line" style={{ marginTop: 6 }}>
          <span className="spinner" /> 載入中…
        </div>
      )}
      {error && <p className="hint">{error}</p>}
      {summary && (
        <div className="wiki-summary" style={{ marginTop: 8 }}>
          {summary.thumbnail && <img src={summary.thumbnail} alt="" loading="lazy" />}
          <div className="small">
            <a href={summary.url} target="_blank" rel="noreferrer">
              <b>{summary.title}</b>
            </a>
            <div>{summary.extract.length > 220 ? `${summary.extract.slice(0, 220)}…` : summary.extract}</div>
          </div>
        </div>
      )}
      {hits && !summary && (
        <div style={{ marginTop: 4 }}>
          {hits.length === 0 && <p className="hint">沒有相關條目</p>}
          {hits.map((h) => (
            <div key={h.url} className="wiki-hit small">
              <a href={h.url} target="_blank" rel="noreferrer">
                {h.title}
              </a>
              <div className="muted">{h.snippet}…</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
