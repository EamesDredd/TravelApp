import { useState } from 'react';
import { distanceKm, estimateMinutes, formatKm, formatMinutes, hasCoords } from '../lib/geo';
import { formatDayDate } from '../lib/util';
import { useCurrentTrip, useStore } from '../store';
import type { PlanItem, Spot, Trip } from '../types';
import { CATEGORY_ICON } from '../types';
import { useUI } from '../ui';
import { TimeField } from './TimeField';

export function DayPlan() {
  const trip = useCurrentTrip()!;
  const selectedDay = useStore((s) => s.selectedDay);
  const indexes = selectedDay < 0 ? trip.days.map((_, i) => i) : [Math.min(selectedDay, trip.days.length - 1)];
  return (
    <div>
      {indexes.map((i) => (
        <DayCard key={trip.days[i].id} trip={trip} index={i} />
      ))}
      {selectedDay < 0 && (
        <button className="btn btn-block" onClick={() => useStore.getState().addDay()}>
          ＋ 新增一天
        </button>
      )}
    </div>
  );
}

/** Straight-line hint between two stops; real routes live in the route map. */
function LegHint({ a, b }: { a?: Spot; b?: Spot }) {
  if (!a || !b || !hasCoords(a) || !hasCoords(b) || a.id === b.id) return <div className="leg" />;
  const km = distanceKm(a, b);
  const walk = km <= 1.5;
  const min = estimateMinutes(km, walk ? 'walking' : 'transit');
  return (
    <div className="leg" title="以直線距離粗估，實際路線請看路線地圖">
      {walk ? '🚶' : '🚇'} {formatKm(km)} · 約 {formatMinutes(min)}
    </div>
  );
}

function DayCard({ trip, index }: { trip: Trip; index: number }) {
  const day = trip.days[index];
  const { updateDay, removeDay, sortDayByTime } = useStore.getState();
  const ui = useUI();
  const [menu, setMenu] = useState(false);
  const byId = new Map(trip.spots.map((s) => [s.id, s]));
  const date = formatDayDate(trip.startDate, index);

  return (
    <section className="daycard">
      <div className="daycard-head">
        <span className="daycard-no">第 {index + 1} 天</span>
        {date && <span className="daycard-date">{date}</span>}
        <button
          className="btn btn-sm btn-primary route-btn"
          onClick={() => ui.openRoute(index)}
          disabled={day.items.length === 0}
          title="在地圖上查看當天路線"
        >
          🗺 路線地圖
        </button>
        <button className="icon-btn" aria-label="更多" onClick={() => setMenu((m) => !m)}>
          ⋯
        </button>
      </div>
      {menu && (
        <div className="row-wrap" style={{ padding: '0 14px 10px' }}>
          <button
            className="btn btn-sm"
            onClick={() => {
              sortDayByTime(index);
              setMenu(false);
            }}
          >
            依時間排序
          </button>
          <button
            className="btn btn-sm"
            onClick={() => {
              useStore.getState().addDay(index + 1);
              setMenu(false);
            }}
          >
            在後面插入一天
          </button>
          <button
            className="btn btn-sm"
            disabled={day.items.length === 0}
            onClick={() => {
              ui.openPdfExport({ day: index });
              setMenu(false);
            }}
          >
            📄 匯出這天 PDF
          </button>
          <button
            className="btn btn-sm btn-danger"
            disabled={trip.days.length <= 1}
            onClick={() => {
              if (confirm(`刪除第 ${index + 1} 天？當天的行程會移除（候選地點保留）。`)) removeDay(index);
              setMenu(false);
            }}
          >
            刪除這一天
          </button>
        </div>
      )}
      <input
        key={`${day.id}-${day.title ?? ''}`}
        className="title-input"
        defaultValue={day.title ?? ''}
        placeholder="當天主題，例如：東山・祇園散策"
        onBlur={(e) => updateDay(index, { title: e.target.value.trim() || undefined })}
      />
      {day.items.length === 0 ? (
        <div className="empty">
          還沒有行程。從候選加入，或請 AI 幫你安排。
        </div>
      ) : (
        <ul className="items">
          {day.items.map((it, n) => (
            <li key={it.id}>
              {n > 0 && <LegHint a={byId.get(day.items[n - 1].spotId)} b={byId.get(it.spotId)} />}
              <ItemRow
                trip={trip}
                dayIndex={index}
                item={it}
                spot={byId.get(it.spotId)}
                first={n === 0}
                last={n === day.items.length - 1}
              />
            </li>
          ))}
        </ul>
      )}
      <div className="daycard-foot">
        <button className="btn btn-sm grow" onClick={() => ui.openPickSpots(index)}>
          ＋ 從候選加入
        </button>
        <button className="btn btn-sm grow" onClick={() => ui.openAddSpot({ day: index })}>
          ＋ 新地點
        </button>
      </div>
    </section>
  );
}

function ItemRow(props: { trip: Trip; dayIndex: number; item: PlanItem; spot?: Spot; first: boolean; last: boolean }) {
  const { trip, dayIndex, item, spot } = props;
  const { updateItem, moveItem, removeItem, moveItemToDay } = useStore.getState();
  const [open, setOpen] = useState(false);
  const ui = useUI();

  return (
    <>
      <div className={`item cat-${spot?.category ?? 'sight'}`}>
        <TimeField value={item.time} onChange={(time) => updateItem(dayIndex, item.id, { time })} />
        <button className="item-main" onClick={() => spot && ui.openSpot(spot.id)}>
          <span className="cat-dot">{spot ? CATEGORY_ICON[spot.category] : '❔'}</span>
          <span className="item-text">
            <span className="item-name">{spot?.name ?? '（已刪除的地點）'}</span>
            {(item.note || spot?.note || spot?.address) && (
              <span className="item-sub">{item.note || spot?.note || spot?.address}</span>
            )}
          </span>
        </button>
        <span className="item-actions">
          <button className="icon-btn" aria-label="上移" disabled={props.first} onClick={() => moveItem(dayIndex, item.id, -1)}>
            ▲
          </button>
          <button className="icon-btn" aria-label="下移" disabled={props.last} onClick={() => moveItem(dayIndex, item.id, 1)}>
            ▼
          </button>
          <button className="icon-btn" aria-label="更多" onClick={() => setOpen((o) => !o)}>
            ⋯
          </button>
        </span>
      </div>
      {open && (
        <div className="item-more">
          <input
            className="input"
            defaultValue={item.note ?? ''}
            placeholder="這一站的備註（例如：搭 206 號公車）"
            onBlur={(e) => updateItem(dayIndex, item.id, { note: e.target.value.trim() || undefined })}
          />
          <div className="row-wrap">
            <select
              className="select"
              style={{ width: 'auto', flex: 1 }}
              value=""
              onChange={(e) => {
                const to = Number(e.target.value);
                if (!Number.isNaN(to)) {
                  moveItemToDay(dayIndex, item.id, to);
                  ui.showToast(`已移到第 ${to + 1} 天`);
                }
              }}
            >
              <option value="">移到其他天…</option>
              {trip.days.map((_, i) =>
                i === dayIndex ? null : (
                  <option key={i} value={i}>
                    第 {i + 1} 天 {formatDayDate(trip.startDate, i)}
                  </option>
                ),
              )}
            </select>
            {item.time && (
              <button className="btn btn-sm" onClick={() => updateItem(dayIndex, item.id, { time: undefined })}>
                清除時間
              </button>
            )}
            <button className="btn btn-sm btn-danger" onClick={() => removeItem(dayIndex, item.id)}>
              從這天移除
            </button>
          </div>
        </div>
      )}
    </>
  );
}
