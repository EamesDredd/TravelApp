import { useState } from 'react';
import { FriendlyError, listModels } from '../lib/ai';
import { useStore } from '../store';
import type { Settings } from '../types';
import { useUI } from '../ui';
import { Modal } from './Modal';

const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5（預設，最聰明）' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5（較快、較便宜）' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5（最快、最便宜）' },
];

export function SettingsModal() {
  const open = useUI((s) => s.settingsOpen);
  if (!open) return null;
  return <SettingsInner />;
}

function SettingsInner() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const [draft, setDraft] = useState<Settings>(settings);
  const [models, setModels] = useState<string[] | null>(null);
  const [test, setTest] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => useUI.getState().openSettings(false);
  const set = (patch: Partial<Settings>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setTest(null);
  };

  const check = async () => {
    setBusy(true);
    setTest(null);
    try {
      const ids = await listModels(draft);
      setModels(ids);
      const model = draft.provider === 'claude' ? draft.claudeModel : draft.openaiModel;
      setTest({
        ok: true,
        msg: ids.includes(model) ? `連線成功，可使用 ${model}` : `連線成功，但清單中沒有 ${model}，請從下方選擇`,
      });
    } catch (err) {
      setTest({ ok: false, msg: err instanceof FriendlyError ? err.message : (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="設定"
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
              setSettings(draft);
              close();
              useUI.getState().showToast('設定已儲存');
            }}
          >
            儲存
          </button>
        </>
      }
    >
      <div className="section" style={{ marginTop: 0 }}>
        <h3>連接 AI</h3>
        <div className="seg" style={{ marginBottom: 12 }}>
          <button className={draft.provider === 'relay' ? 'on' : ''} onClick={() => set({ provider: 'relay' })}>
            用 AI App
          </button>
          <button className={draft.provider === 'claude' ? 'on' : ''} onClick={() => set({ provider: 'claude' })}>
            Claude API
          </button>
          <button className={draft.provider === 'openai' ? 'on' : ''} onClick={() => set({ provider: 'openai' })}>
            ChatGPT API
          </button>
        </div>

        {draft.provider === 'relay' ? (
          <div className="notice" style={{ marginBottom: 12 }}>
            <b>免 API 金鑰，用你手機上的 Claude 或 ChatGPT App（訂閱即可）。</b>
            <ol className="steps">
              <li>在 AI 討論輸入需求，按「傳送」，選 Claude 或 ChatGPT App。</li>
              <li>在 AI App 送出，等它回覆。</li>
              <li>複製整則回覆，回到這裡按「📋 貼上回覆」，行程自動更新。</li>
            </ol>
            <span className="muted small">填了 API 金鑰的話，AI 可以直接在這個 App 裡修改，不需要複製貼上（API 另外計費）。</span>
          </div>
        ) : draft.provider === 'claude' ? (
          <>
            <label className="field">
              <span>Claude API 金鑰</span>
              <input
                className="input"
                type="password"
                autoComplete="off"
                placeholder="sk-ant-…"
                value={draft.claudeKey}
                onChange={(e) => set({ claudeKey: e.target.value })}
              />
              <p className="hint">
                到{' '}
                <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noreferrer">
                  Claude Console
                </a>{' '}
                建立 API 金鑰（API 用量另計，與 Claude.ai 訂閱分開）。
              </p>
            </label>
            <label className="field">
              <span>模型</span>
              <input
                className="input"
                list="claude-models"
                value={draft.claudeModel}
                onChange={(e) => set({ claudeModel: e.target.value })}
              />
              <datalist id="claude-models">
                {(models ?? CLAUDE_MODELS.map((m) => m.id)).map((id) => (
                  <option key={id} value={id}>
                    {CLAUDE_MODELS.find((m) => m.id === id)?.label}
                  </option>
                ))}
              </datalist>
              <div className="row-wrap" style={{ marginTop: 6 }}>
                {CLAUDE_MODELS.map((m) => (
                  <button
                    key={m.id}
                    className={`chip${draft.claudeModel === m.id ? ' chip-accent' : ''}`}
                    onClick={() => set({ claudeModel: m.id })}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </label>
          </>
        ) : (
          <>
            <label className="field">
              <span>API 金鑰</span>
              <input
                className="input"
                type="password"
                autoComplete="off"
                placeholder="sk-…"
                value={draft.openaiKey}
                onChange={(e) => set({ openaiKey: e.target.value })}
              />
              <p className="hint">
                到{' '}
                <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">
                  OpenAI Platform
                </a>{' '}
                建立 API 金鑰（API 用量另計，與 ChatGPT Plus 訂閱分開）。
              </p>
            </label>
            <label className="field">
              <span>模型</span>
              <input
                className="input"
                list="openai-models"
                value={draft.openaiModel}
                onChange={(e) => set({ openaiModel: e.target.value })}
              />
              <datalist id="openai-models">
                {(models ?? []).map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
              <p className="hint">按「測試連線」可載入你的帳號能用的模型清單。</p>
            </label>
            <label className="field">
              <span>API Base URL</span>
              <input
                className="input"
                value={draft.openaiBaseUrl}
                onChange={(e) => set({ openaiBaseUrl: e.target.value })}
              />
              <p className="hint">
                預設為 OpenAI。也可填其他 OpenAI 相容服務（例如 DeepSeek、通義千問、OpenRouter），在中國大陸較容易連線。
              </p>
            </label>
          </>
        )}

        {draft.provider !== 'relay' && (
        <div className="row" style={{ marginBottom: 10 }}>
          <button className="btn btn-sm" onClick={check} disabled={busy}>
            {busy ? '測試中…' : '測試連線'}
          </button>
          {test && (
            <span className="small" style={{ color: test.ok ? 'var(--accent)' : 'var(--danger)' }}>
              {test.msg}
            </span>
          )}
        </div>
        )}
        {models && draft.provider === 'claude' && (
          <div className="row-wrap" style={{ marginBottom: 10 }}>
            {models.map((id) => (
              <button key={id} className={`chip${draft.claudeModel === id ? ' chip-accent' : ''}`} onClick={() => set({ claudeModel: id })}>
                {id}
              </button>
            ))}
          </div>
        )}
        {models && draft.provider === 'openai' && models.length > 0 && (
          <select className="select" style={{ marginBottom: 10 }} value="" onChange={(e) => e.target.value && set({ openaiModel: e.target.value })}>
            <option value="">從清單選擇模型…</option>
            {models.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        )}

        {draft.provider !== 'relay' && (
          <>
            <label className="row small" style={{ marginBottom: 6 }}>
              <input type="checkbox" checked={draft.chatWebSearch} onChange={(e) => set({ chatWebSearch: e.target.checked })} />
              討論時允許 AI 搜尋網路（Claude；會增加一些費用）
            </label>
            <p className="hint">
              金鑰只存在這台裝置的瀏覽器裡，App 直接連到 AI 服務，不經過其他伺服器。請不要在共用電腦上儲存金鑰。
            </p>
          </>
        )}
      </div>

      <details className="more section">
        <summary>地圖 API 金鑰（選填）</summary>
        <p className="hint" style={{ marginBottom: 10 }}>
          不填也能使用：Google 地圖與高德地圖的連結、導航都可直接開啟。填了之後 App 內的地圖會更完整。
        </p>
        <label className="field">
          <span>Google Maps Embed API 金鑰</span>
          <input
            className="input"
            autoComplete="off"
            value={draft.googleMapsKey}
            onChange={(e) => set({ googleMapsKey: e.target.value })}
          />
          <p className="hint">用於 App 內嵌的 Google 地圖與路線（Embed API 免費）。</p>
        </label>
        <label className="field">
          <span>高德 Web 端（JS API）Key</span>
          <input className="input" autoComplete="off" value={draft.amapKey} onChange={(e) => set({ amapKey: e.target.value })} />
        </label>
        <label className="field">
          <span>高德安全密鑰（securityJsCode）</span>
          <input
            className="input"
            autoComplete="off"
            value={draft.amapSecurityCode}
            onChange={(e) => set({ amapSecurityCode: e.target.value })}
          />
          <p className="hint">
            到{' '}
            <a href="https://console.amap.com/dev/key/app" target="_blank" rel="noreferrer">
              高德開放平台
            </a>{' '}
            建立「Web 端 (JS API)」Key。用於中國大陸地點搜尋、App 內實際路線規劃與即時路況。
          </p>
        </label>
      </details>
    </Modal>
  );
}
