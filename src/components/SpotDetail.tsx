import { useEffect, useState } from 'react';
import { aiConfigured, FriendlyError, providerLabel, searchSpot, spotSearchIsLive, spotSearchPrompt } from '../lib/ai';
import { buildRelaySearchPrompt, extractSources, looksLikeOwnPrompt, parseRelayReply } from '../lib/ai/relay';
import { inProgress, locateKey, useLocateStatus } from '../lib/autoLocate';
import { useOnline } from '../lib/online';
import { copyText, preview, readClipboard, sendToAiApp } from '../lib/handoff';
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
import { PasteModal } from './PasteModal';
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
  const locateStatus = useLocateStatus((s) => s.byKey[locateKey(trip.id, spot)]);
  const online = useOnline();
  const paused = useLocateStatus((s) => s.paused);

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
            {hasCoords(spot)
              ? `座標 ${spot.lat.toFixed(5)}, ${spot.lng.toFixed(5)}${spot.geo === 'auto' ? '（自動定位，可能不準）' : ''}`
              : inProgress(locateStatus, online, paused)
                ? '自動定位中…'
                : locateStatus === 'queued' || locateStatus === 'locating'
                  ? online
                    ? '暫時連不上地圖搜尋服務，稍後會再試（也可以按「定位」）'
                    : '沒有網路，連線後會自動定位'
                : locateStatus === 'not-found'
                  ? '自動定位找不到這個地點，請按「定位」搜尋'
                  : locateStatus === 'no-area'
                    ? '尚未定位：請先設定旅程目的地，或手動定位一個地點'
                    : '尚未定位（距離與路線估算需要座標）'}
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
  const [pasteOpen, setPasteOpen] = useState(false);
  const [copyFallback, setCopyFallback] = useState<string | null>(null);
  const ready = aiConfigured(settings);
  const toast = useUI.getState().showToast;

  // Without an API key: ask the user's own Claude / ChatGPT app, then paste its answer back.
  const relayAsk = async () => {
    const prompt = buildRelaySearchPrompt(spotSearchPrompt(spot, trip.destination, true));
    const r = await sendToAiApp(prompt);
    setCopyFallback(r === 'failed' ? prompt : null);
    if (r === 'copied') toast('已複製，請貼到 Claude 或 ChatGPT 送出');
    if (r === 'failed') toast('無法自動傳送，請按「複製查詢內容」');
  };
  const saveReply = (text: string) => {
    if (looksLikeOwnPrompt(text)) {
      toast('剪貼簿裡是要傳給 AI 的內容，請先複製 AI 的回覆');
      return;
    }
    const summary = text.replace(/\r\n?/g, '\n').trim();
    if (!summary) return;
    const asPlan = parseRelayReply(summary);
    if (asPlan.ops || asPlan.problems.length) {
      toast('這是行程修改的回覆，請到 AI 討論按「📋 貼上回覆」');
      return;
    }
    const notes = [
      spot.search ? '會取代原本的查詢結果。' : '',
      summary.includes(spot.name) ? '' : `內容裡沒有提到「${spot.name}」，確定是這個地點的結果嗎？`,
    ].filter(Boolean);
    if (!confirm(`把這段內容存成「${spot.name}」的查詢結果嗎？${notes.length ? `\n${notes.join('\n')}` : ''}\n\n${preview(summary)}`)) {
      return;
    }
    updateSpot(spot.id, {
      search: { summary, sources: extractSources(summary), provider: 'Claude / ChatGPT App', at: Date.now() },
    });
    toast('已存到這個地點');
  };
  const relayPaste = async () => {
    const text = await readClipboard();
    if (text) saveReply(text);
    else setPasteOpen(true);
  };

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
                : '用你的 Claude / ChatGPT App 查，再把回覆貼回來存檔'}
            </div>
          </div>
          {ready && (
            <button className={`btn btn-sm ${spot.search ? '' : 'btn-primary'}`} disabled={busy} onClick={runAi}>
              {busy ? '搜尋中…' : spot.search ? '重新搜尋' : '🔎 搜尋'}
            </button>
          )}
        </div>
        {!ready && (
          <div className="row-wrap" style={{ marginBottom: spot.search ? 8 : 0 }}>
            <button className="btn btn-sm btn-primary" onClick={relayAsk}>
              🔎 傳給 AI 查詢
            </button>
            <button className="btn btn-sm" onClick={relayPaste}>
              📋 貼上回覆存檔
            </button>
            {copyFallback && (
              <button
                className="btn btn-sm"
                onClick={async () => toast((await copyText(copyFallback)) ? '已複製，請貼到 Claude 或 ChatGPT 送出' : '複製失敗')}
              >
                ⧉ 複製查詢內容
              </button>
            )}
          </div>
        )}
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

      {pasteOpen && (
        <PasteModal
          title={`貼上「${spot.name}」的查詢結果`}
          hint="在 Claude 或 ChatGPT App 裡複製 AI 的回覆，貼到下面存檔。"
          submitLabel="存檔"
          onSubmit={saveReply}
          onClose={() => setPasteOpen(false)}
        />
      )}

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
