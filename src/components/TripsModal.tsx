import { useRef, useState } from 'react';
import { geocodeDestination } from '../lib/geocode';
import { tripRegion } from '../lib/geo';
import { tripToKml } from '../lib/maps';
import { readClipboard } from '../lib/handoff';
import { exportJson, looksLikeTrip, parseTrip, shareUrl } from '../lib/share';
import { tripSummary } from '../lib/tripOps';
import { downloadFile, formatDayDate, safeFilename, toIsoDate } from '../lib/util';
import { useCurrentTrip, useStore } from '../store';
import type { MapRegion } from '../types';
import { useUI } from '../ui';
import { Modal } from './Modal';
import { PasteModal } from './PasteModal';

/** Look up the destination's centre in the background (used to pick Google vs Amap). */
export function locateDestination(tripId: string, destination: string) {
  geocodeDestination(destination).then((center) => {
    const st = useStore.getState();
    if (center && st.currentTripId === tripId) st.updateTrip({ center });
  });
}

export function TripForm(props: { submitLabel: string; onDone?(): void }) {
  const createTrip = useStore((s) => s.createTrip);
  const [name, setName] = useState('');
  const [destination, setDestination] = useState('');
  const [startDate, setStartDate] = useState(toIsoDate(new Date(Date.now() + 14 * 864e5)));
  const [days, setDays] = useState(3);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!destination.trim() && !name.trim()) return;
        const id = createTrip({ name, destination, startDate, dayCount: days });
        locateDestination(id, destination);
        props.onDone?.();
      }}
    >
      <label className="field">
        <span>目的地</span>
        <input
          className="input"
          value={destination}
          placeholder="例如：京都、上海、首爾"
          onChange={(e) => setDestination(e.target.value)}
          required
        />
      </label>
      <label className="field">
        <span>旅程名稱（選填）</span>
        <input className="input" value={name} placeholder={destination ? `${destination}之旅` : '我的旅程'} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="row">
        <label className="field grow">
          <span>出發日期</span>
          <input className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </label>
        <label className="field" style={{ width: 110 }}>
          <span>天數</span>
          <input
            className="input"
            type="number"
            inputMode="numeric"
            min={1}
            max={60}
            value={days}
            onChange={(e) => setDays(Math.max(1, Math.min(60, Number(e.target.value) || 1)))}
          />
        </label>
      </div>
      <button className="btn btn-primary btn-block" type="submit">
        {props.submitLabel}
      </button>
    </form>
  );
}

export function TripsModal() {
  const open = useUI((s) => s.tripsOpen);
  if (!open) return null;
  return <TripsInner />;
}

function TripsInner() {
  const trips = useStore((s) => s.trips);
  const currentId = useStore((s) => s.currentTripId);
  const trip = useCurrentTrip();
  const { selectTrip, deleteTrip, updateTrip, setDayCount, markSynced } = useStore.getState();
  const ui = useUI();
  const [creating, setCreating] = useState(trips.length === 0);
  const [pasting, setPasting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const close = () => ui.openTrips(false);

  const share = async () => {
    if (!trip) return;
    const url = shareUrl(trip);
    try {
      if (navigator.share) {
        await navigator.share({ title: trip.name, url });
        markSynced(trip.id);
        return;
      }
    } catch {
      /* cancelled; fall back to copying */
    }
    try {
      await navigator.clipboard.writeText(url);
      ui.showToast('已複製分享連結，在另一台裝置打開就能匯入');
    } catch {
      prompt('複製這個連結：', url);
    }
    markSynced(trip.id);
  };

  /** Asks how to import (update the same trip here, or add it) in its own dialog. */
  const importText = (text: string) => {
    try {
      ui.openImport(parseTrip(text));
      close();
    } catch (err) {
      alert(`匯入失敗：${(err as Error).message}`);
    }
  };

  const pasteLink = async () => {
    const text = await readClipboard();
    if (text && looksLikeTrip(text)) importText(text);
    else setPasting(true);
  };

  return (
    <>
      <Modal title="我的旅程" onClose={close}>
        <ul className="trip-list">
          {trips.map((t) => (
            <li key={t.id} className={`trip-row${t.id === currentId ? ' on' : ''}`}>
              <button
                className="grow"
                style={{ border: 'none', background: 'transparent', textAlign: 'left', padding: 0 }}
                onClick={() => {
                  selectTrip(t.id);
                  close();
                }}
              >
                <b>{t.name}</b>
                <div className="small muted">{tripSummary(t)}</div>
              </button>
              <button
                className="icon-btn"
                aria-label="刪除旅程"
                onClick={() => confirm(`刪除「${t.name}」？此動作無法復原。`) && deleteTrip(t.id)}
              >
                🗑
              </button>
            </li>
          ))}
        </ul>

        {creating ? (
          <div className="card">
            <TripForm submitLabel="建立旅程" onDone={close} />
          </div>
        ) : (
          <button className="btn btn-block" onClick={() => setCreating(true)}>
            ＋ 新旅程
          </button>
        )}
        <button className="btn btn-block" style={{ marginTop: 8 }} onClick={() => fileRef.current?.click()}>
          ⬆ 匯入行程檔（JSON）
        </button>
        <button className="btn btn-block" style={{ marginTop: 8 }} onClick={pasteLink}>
          📋 貼上分享連結
        </button>
        <p className="hint">iPhone 從主畫面開的 App 打不開分享連結時，先複製連結，再按「貼上分享連結」。</p>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) f.text().then(importText, () => alert('匯入失敗：無法讀取檔案'));
            e.target.value = '';
          }}
        />

        {trip && (
          <div className="section">
            <h3>目前旅程設定</h3>
            <label className="field">
              <span>名稱</span>
              <input
                key={`n-${trip.id}`}
                className="input"
                defaultValue={trip.name}
                onBlur={(e) => e.target.value.trim() && updateTrip({ name: e.target.value.trim() })}
              />
            </label>
            <label className="field">
              <span>目的地</span>
              <input
                key={`d-${trip.id}`}
                className="input"
                defaultValue={trip.destination}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v === trip.destination) return;
                  updateTrip({ destination: v, center: undefined });
                  locateDestination(trip.id, v);
                }}
              />
            </label>
            <div className="row">
              <label className="field grow">
                <span>出發日期</span>
                <input
                  className="input"
                  type="date"
                  value={trip.startDate ?? ''}
                  onChange={(e) => updateTrip({ startDate: e.target.value || undefined })}
                />
              </label>
              <label className="field" style={{ width: 110 }}>
                <span>天數</span>
                <input
                  key={`c-${trip.id}-${trip.days.length}`}
                  className="input"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={60}
                  defaultValue={trip.days.length}
                  onBlur={(e) => {
                    const n = Math.max(1, Math.min(60, Number(e.target.value) || 1));
                    if (n === trip.days.length) return;
                    if (n < trip.days.length && !confirm(`減少為 ${n} 天會移除第 ${n + 1} 天之後的行程，確定嗎？`)) {
                      e.target.value = String(trip.days.length);
                      return;
                    }
                    setDayCount(n);
                  }}
                />
              </label>
            </div>
            <label className="field">
              <span>地圖服務</span>
              <select
                className="select"
                value={trip.mapRegion}
                onChange={(e) => updateTrip({ mapRegion: e.target.value as MapRegion })}
              >
                <option value="auto">
                  自動判斷（目前：{tripRegion({ ...trip, mapRegion: 'auto' }) === 'cn' ? '高德地圖' : 'Google 地圖'}）
                </option>
                <option value="cn">中國大陸：高德地圖</option>
                <option value="intl">其他地區：Google 地圖</option>
              </select>
            </label>

            <h3 style={{ marginTop: 16 }}>分享與備份</h3>
            <div className="row-wrap">
              <button
                className="btn btn-sm"
                onClick={() => {
                  close();
                  ui.openPdfExport({});
                }}
              >
                📄 匯出 PDF 行程表
              </button>
              <button className="btn btn-sm" onClick={share}>
                🔗 分享連結（傳到其他裝置）
              </button>
              <button
                className="btn btn-sm"
                onClick={() => {
                  downloadFile(`${safeFilename(trip.name)}.json`, exportJson(trip), 'application/json');
                  markSynced(trip.id);
                }}
              >
                ⬇ 匯出 JSON
              </button>
              <button
                className="btn btn-sm"
                onClick={() =>
                  downloadFile(
                    `${safeFilename(trip.name)}.kml`,
                    tripToKml(trip, undefined, (i) => `第${i + 1}天 ${formatDayDate(trip.startDate, i)}`.trim()),
                    'application/vnd.google-earth.kml+xml',
                  )
                }
              >
                ⬇ 全部天數 KML（Google 我的地圖）
              </button>
            </div>
            <p className="hint">
              資料存在這台裝置的瀏覽器中。要在另一台裝置（手機或電腦）使用，用「分享連結」或匯出 JSON 再到那台匯入；同一個行程再次匯入時，會更新那台裝置上原本的行程。
            </p>
          </div>
        )}
      </Modal>
      {pasting && (
        <PasteModal
          title="貼上分享連結"
          hint="在另一台裝置按「🔗 分享連結」，把連結傳過來後複製，貼在下面。"
          submitLabel="匯入"
          onSubmit={importText}
          onClose={() => setPasting(false)}
        />
      )}
    </>
  );
}
