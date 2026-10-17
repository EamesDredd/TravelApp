import { useState } from 'react';
import { checkImport, importedAsNew, importTarget, mergeImported, updateByDefault, type IncomingTrip } from '../lib/share';
import { tripSummary } from '../lib/tripOps';
import { formatStamp } from '../lib/util';
import { useStore } from '../store';
import { useUI } from '../ui';
import { Modal } from './Modal';

/** Imports a shared or exported trip: updates the same trip on this device, or adds it as a new one. */
export function ImportTripModal() {
  const incoming = useUI((s) => s.importing);
  if (!incoming) return null;
  return <ImportInner key={`${incoming.trip.id}-${incoming.changedAt ?? ''}`} incoming={incoming} />;
}

function ImportInner({ incoming }: { incoming: IncomingTrip }) {
  const trips = useStore((s) => s.trips);
  const ui = useUI();
  const target = importTarget(trips, incoming);
  const [choice, setChoice] = useState<'update' | 'new'>(() => (target && updateByDefault(target) ? 'update' : 'new'));
  const update = !!target && choice === 'update';
  const check = target ? checkImport(target.trip, incoming) : null;
  const t = incoming.trip;
  const close = () => ui.openImport(null);

  const submit = () => {
    const st = useStore.getState();
    // Merge with the latest copy: the background locator may have saved places meanwhile.
    const local = target && update ? st.trips.find((x) => x.id === target.trip.id) : undefined;
    if (local) {
      st.replaceTrip(local.id, mergeImported(local, incoming));
      ui.showToast(`已更新「${t.name}」`);
    } else {
      st.importTrip(importedAsNew(incoming));
      ui.showToast(`已匯入「${t.name}」`);
    }
    close();
  };

  return (
    <Modal
      title="匯入行程"
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            取消
          </button>
          <span className="grow" />
          <button className="btn btn-primary" onClick={submit}>
            {update ? '更新行程' : '匯入'}
          </button>
        </>
      }
    >
      <div className="notice">
        <b>{t.name}</b>
        <div className="small muted">{tripSummary(t)}</div>
        {incoming.changedAt && <div className="small muted">{formatStamp(incoming.changedAt)} 的版本</div>}
      </div>

      {target && check ? (
        <div role="radiogroup" aria-label="匯入方式">
          <label className="choice">
            <input type="radio" name="import-mode" checked={choice === 'update'} onChange={() => setChoice('update')} />
            <div>
              <b>{target.byName ? '更新這台裝置上同名的行程' : '更新這台裝置上的這個行程'}</b>
              <div className="small muted">
                「{target.trip.name}」 · {tripSummary(target.trip)}
              </div>
              {target.byName && target.trip.synced && <div className="small muted">名稱相同，但可能是另一個行程，請先確認。</div>}
              {check.olderThan && (
                <div className="small warn">⚠️ 匯入的是比較舊的版本，這台裝置上次同步的是 {formatStamp(check.olderThan)} 的版本。</div>
              )}
              {check.same ? (
                <div className="small muted">內容和這台裝置上的一樣。</div>
              ) : check.editedHere ? (
                <div className="small warn">⚠️ 這台裝置上的行程在上次分享或匯入後有修改，更新會取代這些修改。</div>
              ) : check.editedHere === false ? (
                <div className="small muted">這台裝置上沒有新的修改，可以放心更新。</div>
              ) : (
                <div className="small muted">更新後會換成匯入的內容。</div>
              )}
            </div>
          </label>
          <label className="choice">
            <input type="radio" name="import-mode" checked={choice === 'new'} onChange={() => setChoice('new')} />
            <div>
              <b>另存成新的行程</b>
              <div className="small muted">兩份都保留。</div>
            </div>
          </label>
        </div>
      ) : (
        <p className="hint">這台裝置上還沒有這個行程，會新增一份。</p>
      )}

      <p className="hint" style={{ marginTop: 12 }}>
        AI 對話紀錄和設定（例如 API 金鑰）不會跟著匯入，每台裝置各自保存。
      </p>
    </Modal>
  );
}
