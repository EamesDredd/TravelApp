import { useMemo, useState } from 'react';
import { formatKm } from '../lib/geo';
import { applyKmlImport, dayChanges, planKmlImport, type ImportChoice, type KmlContent } from '../lib/kml';
import { CATEGORIES, scheduledDays } from '../lib/tripOps';
import { formatDayDate } from '../lib/util';
import { useCurrentTrip, useStore } from '../store';
import type { Category } from '../types';
import { CATEGORY_ICON, CATEGORY_LABEL } from '../types';
import { useUI } from '../ui';
import { Modal } from './Modal';

function toggled<T>(set: ReadonlySet<T>, key: T): ReadonlySet<T> {
  const next = new Set(set);
  if (!next.delete(key)) next.add(key);
  return next;
}

/** The changes a My Maps file would make to the open trip, to choose from before applying them. */
export function KmlImportModal({
  file,
  content,
  onClose,
  onDone,
}: {
  file: string;
  content: KmlContent;
  onClose(): void;
  onDone(): void;
}) {
  const trip = useCurrentTrip()!;
  const ui = useUI();
  const plan = useMemo(() => planKmlImport(trip, content), [trip, content]);
  // Additions, moves and days are applied unless unticked; deletions and days past the trip's last only when ticked.
  const [skip, setSkip] = useState<ReadonlySet<string>>(new Set());
  const [remove, setRemove] = useState<ReadonlySet<string>>(new Set());
  const [categories, setCategories] = useState<Record<string, Category>>({});
  const [skipDays, setSkipDays] = useState<ReadonlySet<number>>(
    () => new Set(plan.days.filter((d) => d.day >= trip.days.length).map((d) => d.day)),
  );
  const choice: ImportChoice = { skip, remove, categories, skipDays };
  const days = useMemo(() => dayChanges(trip, plan, { skip, remove, categories, skipDays }), [trip, plan, skip, remove, categories, skipDays]);

  const counts = {
    add: plan.add.filter((a) => !skip.has(a.key)).length,
    move: plan.move.filter((m) => !skip.has(m.spot.id)).length,
    remove: plan.absent.filter((s) => remove.has(s.id)).length,
    days: days.filter((d) => !skipDays.has(d.day)).length,
  };
  const changes = counts.add + counts.move + counts.remove + counts.days;
  const nothing = !plan.add.length && !plan.move.length && !plan.absent.length && !days.length;

  const apply = () => {
    useStore.getState().replaceSnapshot(applyKmlImport(trip, plan, choice));
    const done = [
      counts.add && `新增 ${counts.add}`,
      counts.move && `更新 ${counts.move}`,
      counts.remove && `刪除 ${counts.remove}`,
      counts.days && `調整 ${counts.days} 天的行程`,
    ];
    ui.showToast(`已從我的地圖匯入：${done.filter(Boolean).join('、')}`);
    onDone();
  };

  const scheduled = (id: string) => {
    const d = scheduledDays(trip, id);
    return d.length ? `已排入 ${d.map((i) => `第${i + 1}天`).join('、')}` : '未排入';
  };

  return (
    <Modal
      title="從我的地圖匯回"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {nothing ? '關閉' : '取消'}
          </button>
          <span className="grow" />
          {!nothing && (
            <button className="btn btn-primary" onClick={apply} disabled={!changes}>
              套用（{changes} 項）
            </button>
          )}
        </>
      }
    >
      <p className="small muted" style={{ margin: '0 0 8px' }}>
        「{file}」裡有 {content.places.length} 個地點{content.skipped ? `，另有 ${content.skipped} 個路線或形狀不會匯入` : ''}。
        {plan.same > 0 && ` ${plan.same} 個地點和行程裡一樣。`}
      </p>
      {nothing && <p>和這個行程一樣，沒有要更新的地點。</p>}

      {plan.add.length > 0 && (
        <>
          <h3>新增 {plan.add.length} 個候選地點</h3>
          <ul className="results">
            {plan.add.map((a) => {
              const on = !skip.has(a.key);
              return (
                <li key={a.key} className="pick-row">
                  <button className={on ? 'on' : ''} onClick={() => setSkip((s) => toggled(s, a.key))}>
                    <span className="row">
                      <span>{on ? '☑' : '☐'}</span>
                      <span className="grow">
                        <b>{a.name}</b>
                        {a.note && <div className="small muted">{a.note}</div>}
                      </span>
                    </span>
                  </button>
                  <select
                    className="select"
                    aria-label={`「${a.name}」的類別`}
                    value={categories[a.key] ?? a.category}
                    onChange={(e) => setCategories((c) => ({ ...c, [a.key]: e.target.value as Category }))}
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {CATEGORY_ICON[c]} {CATEGORY_LABEL[c]}
                      </option>
                    ))}
                  </select>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {plan.move.length > 0 && (
        <>
          <h3>更新 {plan.move.length} 個地點的位置</h3>
          <ul className="results">
            {plan.move.map((m) => {
              const on = !skip.has(m.spot.id);
              return (
                <li key={m.spot.id}>
                  <button className={on ? 'on' : ''} onClick={() => setSkip((s) => toggled(s, m.spot.id))}>
                    <span className="row">
                      <span>{on ? '☑' : '☐'}</span>
                      <span className={`cat-dot cat-${m.spot.category}`}>{CATEGORY_ICON[m.spot.category]}</span>
                      <span className="grow">
                        <b>{m.spot.name}</b>
                        <div className="small muted">{m.km === undefined ? '原本沒有座標' : `移動了約 ${formatKm(m.km)}`}</div>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {days.length > 0 && (
        <>
          <h3>調整 {days.length} 天的行程</h3>
          <p className="hint" style={{ marginBottom: 6 }}>
            依「第1天」「Day 1」這類名稱的圖層，把地點照圖層裡的順序排進那一天。
          </p>
          <ul className="results">
            {days.map((d) => {
              const on = !skipDays.has(d.day);
              return (
                <li key={d.day}>
                  <button className={on ? 'on' : ''} onClick={() => setSkipDays((s) => toggled(s, d.day))}>
                    <span className="row" style={{ alignItems: 'flex-start' }}>
                      <span>{on ? '☑' : '☐'}</span>
                      <span className="grow">
                        <b>
                          第{d.day + 1}天 {formatDayDate(trip.startDate, d.day)}
                        </b>
                        {d.extra && <div className="small muted">行程目前只有 {trip.days.length} 天，勾選會增加天數</div>}
                        <div className="small">
                          {d.stops.map((s, i) => (
                            <span key={i}>
                              {i > 0 && ' → '}
                              {s.added ? <b style={{ color: 'var(--accent)' }}>＋{s.name}</b> : s.name}
                            </span>
                          ))}
                          {!d.stops.length && '（沒有地點）'}
                        </div>
                        {d.removed.length > 0 && <div className="small muted">移出這天：{d.removed.join('、')}</div>}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {plan.absent.length > 0 && (
        <>
          <h3>我的地圖裡沒有的 {plan.absent.length} 個</h3>
          <p className="hint" style={{ marginBottom: 6 }}>
            在我的地圖刪掉的才勾選，勾選的會從行程刪除（包含每天的安排）；沒勾的會保留。
          </p>
          <ul className="results">
            {plan.absent.map((s) => {
              const on = remove.has(s.id);
              return (
                <li key={s.id}>
                  <button className={on ? 'on' : ''} onClick={() => setRemove((r) => toggled(r, s.id))}>
                    <span className="row">
                      <span>{on ? '☑' : '☐'}</span>
                      <span className={`cat-dot cat-${s.category}`}>{CATEGORY_ICON[s.category]}</span>
                      <span className="grow">
                        <b>{s.name}</b>
                        <div className="small muted">
                          {on ? '會刪除 · ' : ''}
                          {scheduled(s.id)}
                        </div>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Modal>
  );
}
