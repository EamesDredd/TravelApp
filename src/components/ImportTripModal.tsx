import { useState } from 'react';
import { compareImport, importedAsNew, importTarget, mergeImported, updateByDefault, type ImportRelation, type IncomingTrip } from '../lib/share';
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
  const relation = target ? compareImport(target.trip, incoming) : null;
  const safe = !!target && !!relation && updateByDefault(target, relation);
  const [choice, setChoice] = useState<'update' | 'new'>(() => (safe ? 'update' : 'new'));
  const update = !!target && choice === 'update';
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
            {update ? (safe ? '更新行程' : '仍要更新') : '匯入'}
          </button>
        </>
      }
    >
      <div className="notice">
        <b>{t.name}</b>
        <div className="small muted">{tripSummary(t)}</div>
        {incoming.changedAt && <div className="small muted">{formatStamp(incoming.changedAt)} 的版本</div>}
      </div>

      {target && relation ? (
        <div role="radiogroup" aria-label="匯入方式">
          <label className="choice">
            <input type="radio" name="import-mode" checked={choice === 'update'} onChange={() => setChoice('update')} />
            <div>
              <b>{target.match === 'name' ? '更新這台裝置上同名的行程' : '更新這台裝置上的這個行程'}</b>
              <div className="small muted">
                「{target.trip.name}」 · {tripSummary(target.trip)}
              </div>
              {target.match === 'name' && relation === 'unknown' && (
                <div className="small warn">名稱相同，但可能是另一個行程，請先確認。</div>
              )}
              <RelationNote relation={relation} />
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

const NOTES: Record<ImportRelation, { text: string; warn?: boolean }> = {
  same: { text: '內容和這台裝置上的一樣。' },
  newer: { text: '這個版本是接著這台裝置上的行程修改的，可以放心更新。' },
  older: { text: '⚠️ 這是比較舊的版本：這台裝置上的行程已經有之後的修改，更新會換回舊版。', warn: true },
  diverged: {
    text: '⚠️ 兩邊各自改過：這台裝置上有些修改不在匯入的版本裡，更新會失去這些修改。想兩份都留，請選「另存成新的行程」。',
    warn: true,
  },
  unknown: { text: '更新後會換成匯入的內容。' },
};

function RelationNote({ relation }: { relation: ImportRelation }) {
  const note = NOTES[relation];
  return <div className={`small ${note.warn ? 'warn' : 'muted'}`}>{note.text}</div>;
}
