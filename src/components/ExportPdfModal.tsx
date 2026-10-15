import { useEffect, useMemo, useRef, useState } from 'react';
import { locateKey, useLocateStatus } from '../lib/autoLocate';
import { hasCoords } from '../lib/geo';
import { useOnline } from '../lib/online';
import { buildItinerary } from '../lib/pdf/itinerary';
import { downloadFile, formatDayDate, safeFilename } from '../lib/util';
import { useCurrentTrip } from '../store';
import { useUI } from '../ui';
import { Modal } from './Modal';

export function ExportPdfModal() {
  const opts = useUI((s) => s.pdfExport);
  const trip = useCurrentTrip();
  if (!opts || !trip) return null;
  return <ExportPdfInner key={`${trip.id}-${opts.day ?? 'all'}`} initialDay={opts.day} />;
}

interface Result {
  file: File;
  url: string;
  pages: number;
  /** What the file shows, to tell when the trip has changed since. */
  key: string;
}

/** A blob: link cannot be opened from the home-screen app (it opens outside the app). */
const standalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

function ExportPdfInner({ initialDay }: { initialDay?: number }) {
  const trip = useCurrentTrip()!;
  const ui = useUI();
  const online = useOnline();
  const [range, setRange] = useState<number>(initialDay ?? -1);
  const [maps, setMaps] = useState(true);
  const [perDay, setPerDay] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<{ message: string; reload?: boolean } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const statuses = useLocateStatus((s) => s.byKey);

  // The chosen day may disappear while the dialog is open (the AI shortened the trip).
  const day = range >= 0 && range < trip.days.length ? range : -1;
  const days = useMemo(() => (day < 0 ? trip.days.map((_, i) => i) : [day]), [day, trip.days]);
  const byId = new Map(trip.spots.map((s) => [s.id, s]));
  const stops = [...new Set(days.flatMap((i) => trip.days[i].items.map((it) => it.spotId)))]
    .map((id) => byId.get(id))
    .filter((s) => !!s);
  const unlocated = stops.filter((s) => !hasCoords(s));
  const waiting = unlocated.filter((s) => ['queued', 'locating'].includes(statuses[locateKey(trip.id, s)] ?? ''));
  const locating = online ? waiting : [];
  const missing = unlocated.filter((s) => !locating.includes(s));
  const empty = stops.length === 0;

  // What the PDF would show now (fixed date, so only the trip and the options matter).
  const key = useMemo(
    () => JSON.stringify(buildItinerary(trip, { days, maps, newPagePerDay: perDay }, new Date(0))),
    [trip, days, maps, perDay],
  );

  // A different choice makes the file not the one asked for. A change to the trip only marks
  // it out of date (the background locator may keep saving places for a while).
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [day, maps, perDay]);
  useEffect(() => () => ctrl.current?.abort(), []);
  useEffect(() => {
    if (!result) return;
    return () => URL.revokeObjectURL(result.url);
  }, [result]);

  const close = () => ui.openPdfExport(null);

  const generate = async () => {
    ctrl.current?.abort();
    const controller = new AbortController();
    ctrl.current = controller;
    const filename = `${safeFilename(trip.name)}-${day < 0 ? '行程' : `第${day + 1}天`}.pdf`;
    const startedKey = key;
    setError(null);
    setResult(null);
    setBusy('準備中…');
    try {
      // Loaded on demand: most visits never export.
      let renderPdf: typeof import('../lib/pdf/render').renderPdf;
      try {
        ({ renderPdf } = await import('../lib/pdf/render'));
      } catch {
        // After an update the old file is gone from the server and the offline cache.
        setError({ message: 'App 已更新，請重新整理頁面後再匯出。', reload: true });
        return;
      }
      const doc = buildItinerary(trip, { days, maps, newPagePerDay: perDay });
      const { blob, pages } = await renderPdf(doc, { newPagePerDay: perDay }, setBusy, controller.signal);
      if (controller.signal.aborted) return;
      const file = new File([blob], filename, { type: 'application/pdf' });
      setResult({ file, url: URL.createObjectURL(file), pages, key: startedKey });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError({ message: `無法產生 PDF：${(err as Error).message}` });
    } finally {
      if (ctrl.current === controller) {
        ctrl.current = null;
        setBusy('');
      }
    }
  };

  const canShare = (() => {
    try {
      return !!result && !!navigator.canShare?.({ files: [result.file] });
    } catch {
      return false;
    }
  })();

  const share = async () => {
    if (!result) return;
    try {
      await navigator.share({ files: [result.file], title: trip.name });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') ui.showToast('無法分享，請改用「下載」');
    }
  };

  const size = result ? `${(result.file.size / 1024 / 1024).toFixed(result.file.size < 1024 * 1024 ? 2 : 1)} MB` : '';

  return (
    <Modal
      title="匯出 PDF 行程表"
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            關閉
          </button>
          <span className="grow" />
          <button className="btn btn-primary" onClick={generate} disabled={!!busy || empty}>
            {busy ? '產生中…' : result ? '重新產生' : '產生 PDF'}
          </button>
        </>
      }
    >
      <label className="field">
        <span>範圍</span>
        <select className="select" value={day} disabled={!!busy} onChange={(e) => setRange(Number(e.target.value))}>
          <option value={-1}>全部 {trip.days.length} 天</option>
          {trip.days.map((d, i) => (
            <option key={d.id} value={i}>
              第 {i + 1} 天 {formatDayDate(trip.startDate, i)}
              {d.title ? ` ${d.title}` : ''}
              {d.items.length ? '' : '（沒有行程）'}
            </option>
          ))}
        </select>
      </label>
      <label className="row small" style={{ marginBottom: 6 }}>
        <input type="checkbox" checked={maps} disabled={!!busy} onChange={(e) => setMaps(e.target.checked)} />
        包含每天的路線地圖
      </label>
      {day < 0 && trip.days.length > 1 && (
        <label className="row small" style={{ marginBottom: 6 }}>
          <input type="checkbox" checked={perDay} disabled={!!busy} onChange={(e) => setPerDay(e.target.checked)} />
          每天從新的一頁開始
        </label>
      )}

      {empty && <p className="hint">這個範圍還沒有排入任何地點。</p>}
      {maps && locating.length > 0 && (
        <p className="hint">
          <span className="spinner" /> 正在自動定位 {locating.length} 個地點，完成後地圖會更完整。
        </p>
      )}
      {maps && missing.length > 0 && (
        <p className="hint">
          ⚠️ {missing.length} 個地點沒有座標，不會出現在地圖上：{missing.map((s) => s.name).join('、')}
          {!online && waiting.length > 0 && '（沒有網路，連線後會自動定位）'}
        </p>
      )}

      {busy && (
        <div className="status-line" style={{ marginTop: 8 }}>
          <span className="spinner" /> {busy}
        </div>
      )}
      {error && (
        <div className="bubble error">
          {error.message}
          {error.reload && (
            <div style={{ marginTop: 8 }}>
              <button className="btn btn-sm" onClick={() => location.reload()}>
                重新整理
              </button>
            </div>
          )}
        </div>
      )}

      {result && (
        <div className="notice" style={{ marginTop: 8 }}>
          ✓ 已產生 {result.pages} 頁 · {size}
          {result.key !== key && <div className="small muted">行程在產生後有更新（例如自動定位到新的地點），可按「重新產生」取得最新版。</div>}
          <div className="row-wrap" style={{ marginTop: 8 }}>
            {canShare && (
              <button className="btn btn-sm btn-primary" onClick={share}>
                📤 分享／儲存到檔案
              </button>
            )}
            <button className="btn btn-sm" onClick={() => downloadFile(result.file.name, result.file, 'application/pdf')}>
              ⬇ 下載
            </button>
            {!standalone() && (
              <a className="btn btn-sm" href={result.url} target="_blank" rel="noreferrer">
                👁 預覽
              </a>
            )}
          </div>
        </div>
      )}

      <p className="hint" style={{ marginTop: 12 }}>
        PDF 用這台裝置的字型產生；地名和交通資訊可以點，會開啟 Google 地圖或高德地圖。路線地圖的底圖需要網路，沒有網路時只畫出地點的相對位置。
      </p>
    </Modal>
  );
}
