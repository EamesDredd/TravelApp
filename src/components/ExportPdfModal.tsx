import { useEffect, useRef, useState } from 'react';
import { locateKey, useLocateStatus } from '../lib/autoLocate';
import { hasCoords } from '../lib/geo';
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
}

function ExportPdfInner({ initialDay }: { initialDay?: number }) {
  const trip = useCurrentTrip()!;
  const ui = useUI();
  const [range, setRange] = useState<number>(initialDay !== undefined && initialDay < trip.days.length ? initialDay : -1);
  const [maps, setMaps] = useState(true);
  const [perDay, setPerDay] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const statuses = useLocateStatus((s) => s.byKey);

  const days = range < 0 ? trip.days.map((_, i) => i) : [range];
  const byId = new Map(trip.spots.map((s) => [s.id, s]));
  const stops = [...new Set(days.flatMap((i) => trip.days[i].items.map((it) => it.spotId)))]
    .map((id) => byId.get(id))
    .filter((s) => !!s);
  const unlocated = stops.filter((s) => !hasCoords(s));
  const locating = unlocated.filter((s) => ['queued', 'locating'].includes(statuses[locateKey(trip.id, s)] ?? ''));
  const empty = stops.length === 0;

  // A new choice (or a change to the trip) makes the previous file stale.
  const tripVersion = trip.updatedAt;
  useEffect(() => {
    setResult(null);
    setError('');
  }, [range, maps, perDay, tripVersion]);
  useEffect(() => () => ctrl.current?.abort(), []);
  useEffect(() => {
    if (!result) return;
    return () => URL.revokeObjectURL(result.url);
  }, [result]);

  const close = () => ui.openPdfExport(null);

  const filename = `${safeFilename(trip.name)}-${range < 0 ? '行程' : `第${range + 1}天`}.pdf`;

  const generate = async () => {
    ctrl.current?.abort();
    const controller = new AbortController();
    ctrl.current = controller;
    setError('');
    setResult(null);
    setBusy('準備中…');
    try {
      // Loaded on demand: most visits never export.
      const { renderPdf } = await import('../lib/pdf/render');
      const doc = buildItinerary(trip, { days, maps, newPagePerDay: perDay });
      const { blob, pages } = await renderPdf(doc, { newPagePerDay: perDay }, setBusy, controller.signal);
      if (controller.signal.aborted) return;
      const file = new File([blob], filename, { type: 'application/pdf' });
      setResult({ file, url: URL.createObjectURL(file), pages });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError(`無法產生 PDF：${(err as Error).message}`);
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
        <select className="select" value={range} onChange={(e) => setRange(Number(e.target.value))}>
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
        <input type="checkbox" checked={maps} onChange={(e) => setMaps(e.target.checked)} />
        包含每天的路線地圖
      </label>
      {range < 0 && trip.days.length > 1 && (
        <label className="row small" style={{ marginBottom: 6 }}>
          <input type="checkbox" checked={perDay} onChange={(e) => setPerDay(e.target.checked)} />
          每天從新的一頁開始
        </label>
      )}

      {empty && <p className="hint">這個範圍還沒有排入任何地點。</p>}
      {locating.length > 0 && (
        <p className="hint">
          <span className="spinner" /> 正在自動定位 {locating.length} 個地點，完成後地圖會更完整。
        </p>
      )}
      {unlocated.length > locating.length && maps && (
        <p className="hint">
          ⚠️ {unlocated.length - locating.length} 個地點沒有座標，不會出現在地圖上：
          {unlocated
            .filter((s) => !locating.includes(s))
            .map((s) => s.name)
            .join('、')}
        </p>
      )}

      {busy && (
        <div className="status-line" style={{ marginTop: 8 }}>
          <span className="spinner" /> {busy}
        </div>
      )}
      {error && <div className="bubble error">{error}</div>}

      {result && (
        <div className="notice" style={{ marginTop: 8 }}>
          ✓ 已產生 {result.pages} 頁 · {size}
          <div className="row-wrap" style={{ marginTop: 8 }}>
            {canShare && (
              <button className="btn btn-sm btn-primary" onClick={share}>
                📤 分享／儲存到檔案
              </button>
            )}
            <button className="btn btn-sm" onClick={() => downloadFile(result.file.name, result.file, 'application/pdf')}>
              ⬇ 下載
            </button>
            <a className="btn btn-sm" href={result.url} target="_blank" rel="noreferrer">
              👁 預覽
            </a>
          </div>
        </div>
      )}

      <p className="hint" style={{ marginTop: 12 }}>
        PDF 用這台裝置的字型產生；地名和交通資訊可以點，會開啟 Google 地圖或高德地圖。路線地圖的底圖需要網路，沒有網路時只畫出地點的相對位置。
      </p>
    </Modal>
  );
}
