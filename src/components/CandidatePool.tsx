import { useState } from 'react';
import { hasCoords } from '../lib/geo';
import { CATEGORIES, scheduledDays } from '../lib/tripOps';
import { useCurrentTrip } from '../store';
import type { Category } from '../types';
import { CATEGORY_ICON, CATEGORY_LABEL } from '../types';
import { useUI } from '../ui';

export function CandidatePool() {
  const trip = useCurrentTrip()!;
  const ui = useUI();
  const [cat, setCat] = useState<Category | 'all'>('all');
  const [onlyFree, setOnlyFree] = useState(false);
  const [q, setQ] = useState('');

  const count = (c: Category) => trip.spots.filter((s) => s.category === c).length;
  const list = trip.spots
    .filter((s) => cat === 'all' || s.category === cat)
    .filter((s) => !q.trim() || s.name.toLowerCase().includes(q.trim().toLowerCase()))
    .map((s) => ({ s, days: scheduledDays(trip, s.id) }))
    .filter((x) => !onlyFree || x.days.length === 0);

  return (
    <section className="pool">
      <div className="pool-head">
        <h2>候選地點</h2>
        <button className="btn btn-sm btn-primary" onClick={() => ui.openAddSpot({ category: cat === 'all' ? undefined : cat })}>
          ＋ 新增
        </button>
      </div>
      <div className="seg">
        <button className={cat === 'all' ? 'on' : ''} onClick={() => setCat('all')}>
          全部 {trip.spots.length}
        </button>
        {CATEGORIES.map((c) => (
          <button key={c} className={cat === c ? 'on' : ''} onClick={() => setCat(c)}>
            {CATEGORY_ICON[c]} {CATEGORY_LABEL[c]} {count(c)}
          </button>
        ))}
      </div>
      {trip.spots.length > 5 && (
        <div className="row" style={{ marginTop: 10 }}>
          <input className="input grow" placeholder="搜尋名稱" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="row small muted" style={{ whiteSpace: 'nowrap', gap: 4 }}>
            <input type="checkbox" checked={onlyFree} onChange={(e) => setOnlyFree(e.target.checked)} />
            未排入
          </label>
        </div>
      )}
      {trip.spots.length === 0 ? (
        <div className="empty" style={{ borderTop: 'none' }}>
          先把想去的景點、早餐、午晚餐加進來，
          <br />
          再加入每天的行程，或請 AI 依遠近幫你排好。
        </div>
      ) : (
        <ul className="cand-list">
          {list.map(({ s, days }) => (
            <li key={s.id} className={`cand cat-${s.category}`}>
              <button className="cand-main" onClick={() => ui.openSpot(s.id)}>
                <span className="cat-dot">{CATEGORY_ICON[s.category]}</span>
                <span className="item-text">
                  <span className="item-name">{s.name}</span>
                  <span className="item-sub">
                    {s.address || s.note || (hasCoords(s) ? '已定位' : '未定位')}
                  </span>
                  <span className="cand-badges">
                    {days.length ? (
                      days.map((d) => (
                        <span key={d} className="chip chip-accent">
                          D{d + 1}
                        </span>
                      ))
                    ) : (
                      <span className="chip">未排入</span>
                    )}
                    {!hasCoords(s) && <span className="chip">無座標</span>}
                  </span>
                </span>
              </button>
              <button className="btn btn-sm" onClick={() => ui.openPickDay(s.id)}>
                ＋ 加入
              </button>
            </li>
          ))}
          {list.length === 0 && <li className="hint">沒有符合的地點</li>}
        </ul>
      )}
    </section>
  );
}
