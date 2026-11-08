import { useMemo, useState } from 'react';
import { formatKm } from '../lib/geo';
import { planKmlImport, type KmlContent } from '../lib/kml';
import { CATEGORIES, scheduledDays } from '../lib/tripOps';
import { useCurrentTrip, useStore } from '../store';
import type { Category } from '../types';
import { CATEGORY_ICON, CATEGORY_LABEL } from '../types';
import { useUI } from '../ui';
import { Modal } from './Modal';

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
  // Additions and moves are applied unless unticked; places missing from the file are kept unless ticked.
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [categories, setCategories] = useState<Record<string, Category>>({});
  const toggle = (set: (f: (s: ReadonlySet<string>) => ReadonlySet<string>) => void, key: string) =>
    set((s) => {
      const next = new Set(s);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const adds = plan.add.filter((a) => !skipped.has(a.key));
  const moves = plan.move.filter((m) => !skipped.has(m.spot.id));
  const removes = plan.absent.filter((s) => removed.has(s.id));
  const changes = adds.length + moves.length + removes.length;
  const nothing = !plan.add.length && !plan.move.length && !plan.absent.length;

  const apply = () => {
    const st = useStore.getState();
    for (const a of adds) {
      st.addSpot({
        name: a.name,
        category: categories[a.key] ?? a.category,
        lat: a.at.lat,
        lng: a.at.lng,
        geo: 'manual',
        ...(a.note ? { note: a.note } : {}),
      });
    }
    for (const m of moves) st.updateSpot(m.spot.id, { lat: m.at.lat, lng: m.at.lng, geo: 'manual' });
    for (const s of removes) st.removeSpot(s.id);
    const done = [adds.length && `新增 ${adds.length}`, moves.length && `更新 ${moves.length}`, removes.length && `刪除 ${removes.length}`];
    ui.showToast(`已從我的地圖匯入：${done.filter(Boolean).join('、')}`);
    onDone();
  };

  const days = (id: string) => {
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
              const on = !skipped.has(a.key);
              return (
                <li key={a.key} className="pick-row">
                  <button className={on ? 'on' : ''} onClick={() => toggle(setSkipped, a.key)}>
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
              const on = !skipped.has(m.spot.id);
              return (
                <li key={m.spot.id}>
                  <button className={on ? 'on' : ''} onClick={() => toggle(setSkipped, m.spot.id)}>
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

      {plan.absent.length > 0 && (
        <>
          <h3>我的地圖裡沒有的 {plan.absent.length} 個</h3>
          <p className="hint" style={{ marginBottom: 6 }}>
            在我的地圖刪掉的才勾選，勾選的會從行程刪除（包含每天的安排）；沒勾的會保留。
          </p>
          <ul className="results">
            {plan.absent.map((s) => {
              const on = removed.has(s.id);
              return (
                <li key={s.id}>
                  <button className={on ? 'on' : ''} onClick={() => toggle(setRemoved, s.id)}>
                    <span className="row">
                      <span>{on ? '☑' : '☐'}</span>
                      <span className={`cat-dot cat-${s.category}`}>{CATEGORY_ICON[s.category]}</span>
                      <span className="grow">
                        <b>{s.name}</b>
                        <div className="small muted">
                          {on ? '會刪除 · ' : ''}
                          {days(s.id)}
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
