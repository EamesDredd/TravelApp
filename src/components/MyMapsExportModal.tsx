import { useState } from 'react';
import { inProgress, locateKey, useLocateStatus } from '../lib/autoLocate';
import { hasCoords, isMainlandChina } from '../lib/geo';
import { spotsToKml } from '../lib/maps';
import { useOnline } from '../lib/online';
import { CATEGORIES, filterLabel, filterSpots, type SpotFilter } from '../lib/tripOps';
import { downloadFile, formatDayDate, safeFilename } from '../lib/util';
import { useCurrentTrip } from '../store';
import { CATEGORY_ICON, CATEGORY_LABEL } from '../types';
import { useUI } from '../ui';
import { Modal } from './Modal';

const KML_TYPE = 'application/vnd.google-earth.kml+xml';
/** Places without coordinates shown as buttons; the locate dialog's 「下一個」 goes on through the rest. */
const SHOW_MISSING = 12;

export function MyMapsExportModal() {
  const filter = useUI((s) => s.myMapsExport);
  const trip = useCurrentTrip();
  if (!filter || !trip) return null;
  return <MyMapsExportInner key={trip.id} filter={filter} />;
}

function MyMapsExportInner({ filter }: { filter: SpotFilter }) {
  const trip = useCurrentTrip()!;
  const ui = useUI();
  const online = useOnline();
  const statuses = useLocateStatus((s) => s.byKey);
  const paused = useLocateStatus((s) => s.paused);
  const label = filterLabel(filter);
  const [scope, setScope] = useState<'list' | 'all'>(label ? 'list' : 'all');
  const [canShare] = useState(() => {
    try {
      return !!navigator.canShare?.({ files: [new File([''], 'x.kml', { type: KML_TYPE })] });
    } catch {
      return false;
    }
  });

  const listed = filterSpots(trip, filter);
  const spots = scope === 'list' ? listed : trip.spots;
  const located = spots.filter(hasCoords);
  const unlocated = spots.filter((s) => !hasCoords(s));
  const waiting = unlocated.filter((s) => ['queued', 'locating'].includes(statuses[locateKey(trip.id, s)] ?? ''));
  const locating = unlocated.filter((s) => inProgress(statuses[locateKey(trip.id, s)], online, paused));
  const missing = unlocated.filter((s) => !locating.includes(s));
  const counts = CATEGORIES.map((c) => ({ c, n: located.filter((s) => s.category === c).length })).filter((x) => x.n);
  const title = `${trip.name} 候選地點${scope === 'list' && label ? `（${label}）` : ''}`;

  const close = () => ui.openMyMapsExport(null);
  const file = () =>
    new File(
      [spotsToKml(trip, spots, title, (i) => `第${i + 1}天 ${formatDayDate(trip.startDate, i)}`.trim())],
      `${safeFilename(title)}.kml`,
      { type: KML_TYPE },
    );
  const share = async () => {
    try {
      await navigator.share({ files: [file()], title });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') ui.showToast('無法分享，請改用「下載」');
    }
  };
  const download = () => {
    const f = file();
    downloadFile(f.name, f, KML_TYPE);
  };

  return (
    <Modal
      title="匯出到 Google 我的地圖"
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            關閉
          </button>
          <span className="grow" />
          {canShare && (
            <button className="btn" onClick={share} disabled={!located.length}>
              📤 分享
            </button>
          )}
          <button className="btn btn-primary" onClick={download} disabled={!located.length}>
            ⬇ 下載 KML
          </button>
        </>
      }
    >
      {label && (
        <label className="field">
          <span>範圍</span>
          <select className="select" value={scope} onChange={(e) => setScope(e.target.value as 'list' | 'all')}>
            <option value="list">
              目前列表：{label}（{listed.length} 個）
            </option>
            <option value="all">全部候選地點（{trip.spots.length} 個）</option>
          </select>
        </label>
      )}
      <p style={{ margin: '4px 0' }}>
        {!spots.length
          ? '目前列表沒有地點。'
          : located.length
            ? `會匯出 ${located.length} 個地點（${counts.map((x) => `${CATEGORY_ICON[x.c]} ${CATEGORY_LABEL[x.c]} ${x.n}`).join('、')}）。`
            : '這些地點都還沒有座標，沒有可以匯出的地點。'}
      </p>
      {locating.length > 0 && (
        <p className="hint">
          <span className="spinner" /> 正在自動定位 {locating.length} 個地點，完成後再匯出會更完整。
        </p>
      )}
      {missing.length > 0 && (
        <div className="hint">
          ⚠️ {missing.length} 個地點沒有座標，不會出現在地圖上，點地名可以定位
          {waiting.length > locating.length && (online ? '（暫時連不上地圖搜尋服務，稍後會再試）' : '（沒有網路，連線後會自動定位）')}：
          <div className="row-wrap" style={{ marginTop: 6 }}>
            {missing.slice(0, SHOW_MISSING).map((s) => (
              <button key={s.id} className="chip" onClick={() => ui.openAddSpot({ locateId: s.id })}>
                📍 {s.name}
              </button>
            ))}
            {missing.length > SHOW_MISSING && <span>…還有 {missing.length - SHOW_MISSING} 個</span>}
          </div>
        </div>
      )}
      {located.some((s) => isMainlandChina(s)) && (
        <p className="hint">中國大陸的地點會換成 Google 地圖用的座標，標記才會對準街道地圖（切到衛星圖時會偏移幾百公尺）。</p>
      )}

      <div className="notice" style={{ marginTop: 12 }}>
        <ol className="steps">
          <li>在電腦打開 Google 我的地圖，按「建立新地圖」→「匯入」，選這個 KML 檔。</li>
          <li>手機的 Google 地圖 App 點「已儲存」→「地圖」就能看到。</li>
        </ol>
        <div className="small muted">
          在 iPhone 上可以用「分享」把檔案 AirDrop 到電腦；也可以先用「🔗 分享連結」把行程傳到電腦，再從電腦匯出。
        </div>
        <div className="row-wrap" style={{ marginTop: 8 }}>
          <a className="btn btn-sm" href="https://www.google.com/maps/d/" target="_blank" rel="noreferrer">
            開啟 Google 我的地圖 ↗
          </a>
        </div>
      </div>
    </Modal>
  );
}
