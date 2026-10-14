import { useState } from 'react';
import { CATEGORIES, scheduledDays } from '../lib/tripOps';
import { formatDayDate } from '../lib/util';
import { useCurrentTrip, useStore } from '../store';
import type { Category } from '../types';
import { CATEGORY_ICON, CATEGORY_LABEL } from '../types';
import { useUI } from '../ui';
import { Modal } from './Modal';

/** Choose which day (and optionally what time) a candidate goes on. */
export function DayPickerModal() {
  const spotId = useUI((s) => s.pickDayFor);
  const trip = useCurrentTrip();
  const selectedDay = useStore((s) => s.selectedDay);
  const [day, setDay] = useState<number | null>(null);
  const [time, setTime] = useState('');
  const spot = trip?.spots.find((s) => s.id === spotId);
  if (!trip || !spot) return null;

  const current = day ?? Math.max(0, Math.min(selectedDay, trip.days.length - 1));
  const close = () => {
    setDay(null);
    setTime('');
    useUI.getState().openPickDay(null);
  };
  const already = scheduledDays(trip, spot.id);

  return (
    <Modal
      title={`把「${spot.name}」加入行程`}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            取消
          </button>
          <span className="grow" />
          <button
            className="btn btn-primary"
            onClick={() => {
              useStore.getState().addToDay(current, spot.id, time || undefined);
              useUI.getState().showToast(`已加入第 ${current + 1} 天`);
              close();
            }}
          >
            加入第 {current + 1} 天
          </button>
        </>
      }
    >
      <div className="row-wrap" style={{ marginBottom: 14 }}>
        {trip.days.map((d, i) => (
          <button key={d.id} className={`daychip${i === current ? ' on' : ''}`} onClick={() => setDay(i)}>
            <b>第{i + 1}天</b>
            <small>{formatDayDate(trip.startDate, i) || `${d.items.length} 個行程`}</small>
            {already.includes(i) && <span className="count">已排入</span>}
          </button>
        ))}
      </div>
      <label className="field">
        <span>時間（選填）</span>
        <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
      </label>
    </Modal>
  );
}

/** Pick one or more candidates to append to a day. */
export function SpotPickerModal() {
  const day = useUI((s) => s.pickSpotsForDay);
  const trip = useCurrentTrip();
  const [cat, setCat] = useState<Category | 'all'>('all');
  const [chosen, setChosen] = useState<string[]>([]);
  if (!trip || day === null || !trip.days[day]) return null;

  const close = () => {
    setChosen([]);
    useUI.getState().openPickSpots(null);
  };
  const list = trip.spots
    .filter((s) => cat === 'all' || s.category === cat)
    .map((s) => ({ s, days: scheduledDays(trip, s.id) }))
    .sort((a, b) => a.days.length - b.days.length);

  return (
    <Modal
      title={`從候選加入第 ${day + 1} 天`}
      onClose={close}
      footer={
        <>
          <button
            className="btn"
            onClick={() => {
              close();
              useUI.getState().openAddSpot({ day });
            }}
          >
            ＋ 新地點
          </button>
          <span className="grow" />
          <button
            className="btn btn-primary"
            disabled={!chosen.length}
            onClick={() => {
              const add = useStore.getState().addToDay;
              chosen.forEach((id) => add(day, id));
              useUI.getState().showToast(`已加入 ${chosen.length} 個地點`);
              close();
            }}
          >
            加入 {chosen.length || ''} 個
          </button>
        </>
      }
    >
      <div className="seg" style={{ marginBottom: 10 }}>
        <button className={cat === 'all' ? 'on' : ''} onClick={() => setCat('all')}>
          全部
        </button>
        {CATEGORIES.map((c) => (
          <button key={c} className={cat === c ? 'on' : ''} onClick={() => setCat(c)}>
            {CATEGORY_ICON[c]} {CATEGORY_LABEL[c]}
          </button>
        ))}
      </div>
      {list.length === 0 && <p className="muted">還沒有這類候選地點。</p>}
      <ul className="results">
        {list.map(({ s, days }) => {
          const on = chosen.includes(s.id);
          return (
            <li key={s.id}>
              <button
                className={on ? 'on' : ''}
                onClick={() => setChosen((c) => (on ? c.filter((x) => x !== s.id) : [...c, s.id]))}
              >
                <span className="row">
                  <span>{on ? '☑' : '☐'}</span>
                  <span className={`cat-dot cat-${s.category}`}>{CATEGORY_ICON[s.category]}</span>
                  <span className="grow">
                    <b>{s.name}</b>
                    <div className="small muted">
                      {days.length ? `已排入 ${days.map((d) => `第${d + 1}天`).join('、')}` : '未排入'}
                      {s.address ? ` · ${s.address}` : ''}
                    </div>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
