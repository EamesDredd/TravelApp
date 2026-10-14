import { useEffect, useRef, useState } from 'react';
import { aiConfigured, chatSupportsWebSearch, FriendlyError, providerLabel, runChatTurn } from '../lib/ai';
import {
  applyRelayOps,
  buildRelayPrompt,
  looksLikeOwnPrompt,
  opsFingerprint,
  parseRelayReply,
  tripFingerprint,
} from '../lib/ai/relay';
import { AI_APP_LINKS, copyText, readClipboard, sendToAiApp } from '../lib/handoff';
import { snapshotOf } from '../lib/tripOps';
import { uid } from '../lib/util';
import { getCurrentTrip, useCurrentTrip, useStore } from '../store';
import type { ChatMessage, SearchSource, TripSnapshot } from '../types';
import { useUI } from '../ui';
import { Markdown } from './Markdown';
import { PasteModal } from './PasteModal';

const SUGGESTIONS = [
  '幫我按景點遠近安排各天行程',
  '幫每天補上順路的早餐和午晚餐',
  '檢查行程會不會太趕，給我建議',
  '推薦幾個必去景點加入候選',
];

interface Live {
  text: string;
  status: string;
}

export function ChatPanel() {
  const open = useStore((s) => s.chatOpen);
  const setOpen = useStore((s) => s.setChatOpen);
  const [running, setRunning] = useState(false);

  return (
    <>
      <ChatBody visible={open} running={running} setRunning={setRunning} onCollapse={() => setOpen(false)} />
      {!open && (
        <button className="chat-tab" onClick={() => setOpen(true)} aria-label="開啟 AI 討論">
          {running && <span className="dot" />}
          <span>💬</span>
          <span>AI</span>
          <span>討</span>
          <span>論</span>
        </button>
      )}
    </>
  );
}

/** Stays mounted while collapsed so a running request keeps streaming in the background. */
function ChatBody(props: { visible: boolean; running: boolean; setRunning(v: boolean): void; onCollapse(): void }) {
  const trip = useCurrentTrip()!;
  const settings = useStore((s) => s.settings);
  const { appendChat, updateChat, replaceSnapshot, clearChat } = useStore.getState();
  const [input, setInput] = useState('');
  const [live, setLive] = useState<Live | null>(null);
  const [full, setFull] = useState(false);
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const ctrl = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  /** API key set: the app talks to the AI itself. Otherwise relay through the user's AI app. */
  const direct = aiConfigured(settings);
  const toast = useUI.getState().showToast;

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [trip.chat.length, live?.text, live?.status, props.visible]);

  const resetInput = () => {
    setInput('');
    if (textarea.current) textarea.current.style.height = 'auto';
  };

  // ---------------------------------------------------------------- direct (API key)

  const sendDirect = async (text: string) => {
    const t = getCurrentTrip();
    if (!t || props.running) return;
    const before = snapshotOf(t);
    const history = t.chat;
    const tripId = t.id;
    resetInput();
    appendChat({ id: uid('m'), role: 'user', text, at: Date.now() });
    props.setRunning(true);
    setLive({ text: '', status: '思考中…' });
    const controller = new AbortController();
    ctrl.current = controller;
    const actions: string[] = [];
    let streamed = '';

    const finish = (msg: Partial<ChatMessage>) => {
      // The user may have switched trips mid-request; only write to the trip we started on.
      if (getCurrentTrip()?.id !== tripId) return;
      appendChat({
        id: uid('m'),
        role: 'assistant',
        text: '',
        at: Date.now(),
        ...(actions.length ? { actions: [...actions], undo: before } : {}),
        ...msg,
      });
    };

    try {
      const res = await runChatTurn({
        settings: useStore.getState().settings,
        trip: before,
        chat: history,
        userText: text,
        signal: controller.signal,
        cb: {
          onText: (s) => {
            streamed = s;
            setLive((l) => ({ text: s, status: l?.status ?? '' }));
          },
          onStatus: (status) => setLive((l) => ({ text: l?.text ?? '', status })),
          onApply: (snap, summary) => {
            if (getCurrentTrip()?.id !== tripId) return;
            actions.push(...summary);
            replaceSnapshot(snap);
          },
        },
      });
      finish({
        text: res.text || (res.actions.length ? '已更新行程。' : '（沒有回覆內容）'),
        ...(res.sources.length ? { sources: res.sources } : {}),
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === 'AbortError' || controller.signal.aborted) {
        finish({ text: `${streamed}${streamed ? '\n\n' : ''}（已停止）` });
      } else {
        if (streamed || actions.length) finish({ text: streamed || '（回覆中斷）' });
        appendChat({
          id: uid('m'),
          role: 'error',
          text: e instanceof FriendlyError ? e.message : `發生錯誤：${e.message}`,
          at: Date.now(),
        });
      }
    } finally {
      ctrl.current = null;
      props.setRunning(false);
      setLive(null);
    }
  };

  // ---------------------------------------------------------------- relay (no key)

  /** Called straight from the tap so the share sheet is allowed to open. */
  const sendRelay = async (text: string) => {
    const t = getCurrentTrip();
    if (!t) return;
    const snapshot = snapshotOf(t);
    const base = tripFingerprint(snapshot);
    const prompt = buildRelayPrompt(snapshot, text, base);
    setLastPrompt(prompt);
    const result = await sendToAiApp(prompt);
    if (result === 'cancelled') return;
    resetInput();
    appendChat({ id: uid('m'), role: 'user', text, relay: { base, snapshot }, at: Date.now() });
    if (result === 'copied') toast('已複製，請貼到 Claude 或 ChatGPT 送出');
    if (result === 'failed') toast('無法自動傳送，請按下方「複製內容」');
  };

  const applyReply = (raw: string) => {
    const t = getCurrentTrip();
    if (!t) return;
    if (looksLikeOwnPrompt(raw)) {
      toast('剪貼簿裡是要傳給 AI 的內容，請先在 AI App 複製它的回覆');
      return;
    }
    const parsed = parseRelayReply(raw);
    if (!parsed.message && !parsed.ops) {
      toast('沒有讀到內容');
      return;
    }
    const current = snapshotOf(t);
    const currentFp = tripFingerprint(current);
    const opsFp = parsed.ops?.length ? opsFingerprint(parsed.ops) : undefined;
    if (opsFp && t.chat.some((m) => m.relayOps === opsFp && m.relayResult === currentFp && !m.undone)) {
      toast('這則回覆已經套用過了');
      return;
    }
    let start: TripSnapshot = current;
    const notes: string[] = parsed.problems.map((p) => `⚠️ ${p}`);

    if (parsed.ops?.length && parsed.base) {
      const sent = [...t.chat].reverse().find((m) => m.relay?.base === parsed.base);
      if (sent?.relay) {
        // The AI's operations are relative to the version it was sent; apply them there.
        const lastApplied = [...t.chat].reverse().find((m) => m.relayBase === parsed.base && m.relayResult);
        const untouched = currentFp === parsed.base || currentFp === lastApplied?.relayResult;
        if (
          !untouched &&
          !confirm('傳給 AI 之後，行程有其他變動。要以 AI 這次回覆的版本為準嗎？那些變動會被取代（之後可按「復原」）。')
        ) {
          return;
        }
        start = sent.relay.snapshot;
      } else {
        notes.push('⚠️ 找不到這次回覆對應的傳送紀錄，已直接套用到目前的行程');
      }
    }

    let result = current;
    const actions: string[] = [];
    if (parsed.ops?.length) {
      const r = applyRelayOps(start, parsed.ops);
      result = r.trip;
      actions.push(...r.summary, ...r.errors.map((e) => `⚠️ ${e}`));
    }
    actions.push(...notes);
    const resultFp = tripFingerprint(result);
    const changed = resultFp !== currentFp;
    if (changed) replaceSnapshot(result);
    appendChat({
      id: uid('m'),
      role: 'assistant',
      text: parsed.message || (changed ? '已套用 AI 的修改。' : '（AI 的回覆）'),
      at: Date.now(),
      ...(actions.length ? { actions } : {}),
      ...(changed ? { undo: current, relayResult: resultFp, relayOps: opsFp } : {}),
      ...(parsed.base ? { relayBase: parsed.base } : {}),
    });
    toast(changed ? '已套用 AI 的修改' : parsed.ops ? '這次回覆沒有要變更的內容' : '已加入對話紀錄');
  };

  const pasteReply = async () => {
    const text = await readClipboard();
    if (text) applyReply(text);
    else setPasteOpen(true);
  };

  // ---------------------------------------------------------------- shared

  const send = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    if (direct) void sendDirect(text);
    else void sendRelay(text);
  };

  const undo = (m: ChatMessage) => {
    if (!m.undo) return;
    if (!confirm('復原這次 AI 的修改？之後手動做的變更也會一起還原。')) return;
    replaceSnapshot(m.undo);
    updateChat(m.id, { undo: undefined, undone: true });
    toast('已復原');
  };

  return (
    <aside className={`chat${full ? ' full' : ''}`} hidden={!props.visible} aria-label="AI 討論">
      <div className="chat-head">
        <div className="chat-title">
          <b>AI 旅遊助理</b>
          <small>
            {providerLabel(settings)}
            {direct && settings.chatWebSearch && chatSupportsWebSearch(settings) ? ' · 可搜尋網路' : ''}
          </small>
        </div>
        {trip.chat.length > 0 && (
          <button
            className="icon-btn"
            title="清除對話"
            aria-label="清除對話"
            disabled={props.running}
            onClick={() => confirm('清除這個旅程的所有對話？') && clearChat()}
          >
            🗑
          </button>
        )}
        <button className="icon-btn chat-full-btn" aria-label={full ? '縮小' : '放大'} onClick={() => setFull((f) => !f)}>
          {full ? '⌄' : '⌃'}
        </button>
        <button className="icon-btn" aria-label="收合到旁邊" title="收合到旁邊" onClick={props.onCollapse}>
          ⇥
        </button>
      </div>

      <div className="chat-log" ref={log}>
        {!direct && trip.chat.length === 0 && (
          <div className="notice">
            <b>用你自己的 Claude 或 ChatGPT（訂閱就能用，不需要 API 金鑰）</b>
            <ol className="steps">
              <li>在下面輸入需求，按「傳送」，選擇 Claude 或 ChatGPT App。</li>
              <li>在 AI App 裡按送出，等它回覆。</li>
              <li>複製 AI 的整則回覆，回到這裡按「📋 貼上回覆」，行程就會自動更新（可一鍵復原）。</li>
            </ol>
            <span className="muted small">
              想讓 AI 直接在這裡修改、不用複製貼上，也可以到{' '}
              <button className="linklike" onClick={() => useUI.getState().openSettings(true)}>
                設定
              </button>{' '}
              填入 API 金鑰。
            </span>
          </div>
        )}
        {direct && trip.chat.length === 0 && !live && (
          <div className="notice">
            可以直接說你想怎麼安排，例如「幫我按景點遠近安排各天行程」。AI 修改後，訊息下方會列出改了什麼，也可以一鍵復原。
          </div>
        )}
        {trip.chat.map((m) => (
          <Bubble key={m.id} m={m} onUndo={() => undo(m)} />
        ))}
        {live && (
          <div className="bubble assistant">
            {live.text && <Markdown text={live.text} />}
            {(live.status || !live.text) && (
              <div className="status-line" style={{ marginTop: live.text ? 6 : 0 }}>
                <span className="spinner" /> {live.status || '回覆中…'}
              </div>
            )}
          </div>
        )}
      </div>

      {!props.running && trip.chat.length === 0 && (
        <div className="suggestions" style={{ padding: '0 10px 6px' }}>
          {SUGGESTIONS.map((s) => (
            <button key={s} className="chip" onClick={() => send(s)}>
              {s}
            </button>
          ))}
        </div>
      )}

      {!direct && (
        <div className="relay-bar">
          <button className="btn btn-sm btn-primary" onClick={pasteReply}>
            📋 貼上回覆
          </button>
          {lastPrompt && (
            <button
              className="btn btn-sm"
              onClick={async () => toast((await copyText(lastPrompt)) ? '已複製，請貼到 AI App' : '複製失敗')}
            >
              ⧉ 複製內容
            </button>
          )}
          <span className="grow" />
          {AI_APP_LINKS.map((l) => (
            <a key={l.label} className="btn btn-sm" href={l.url} target="_blank" rel="noreferrer">
              {l.label} ↗
            </a>
          ))}
        </div>
      )}

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <textarea
          ref={textarea}
          rows={1}
          value={input}
          placeholder={direct ? '和 AI 討論行程…' : '想請 AI 怎麼安排？'}
          onChange={(e) => {
            setInput(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
          }}
          onKeyDown={(e) => {
            // Enter sends on desktop; never while an IME (注音/拼音) is composing.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(min-width: 900px)').matches) {
              e.preventDefault();
              send(input);
            }
          }}
        />
        {props.running ? (
          <button type="button" className="btn" onClick={() => ctrl.current?.abort()}>
            停止
          </button>
        ) : (
          <button type="submit" className="btn btn-primary" disabled={!input.trim()}>
            {direct ? '送出' : '傳送'}
          </button>
        )}
      </form>

      {pasteOpen && (
        <PasteModal
          title="貼上 AI 的回覆"
          hint="在 Claude 或 ChatGPT App 裡複製 AI 的整則回覆，貼到下面。"
          submitLabel="套用"
          onSubmit={applyReply}
          onClose={() => setPasteOpen(false)}
        />
      )}
    </aside>
  );
}

function Sources({ sources }: { sources: SearchSource[] }) {
  return (
    <ul className="sources">
      {sources.slice(0, 6).map((s) => (
        <li key={s.url}>
          <a href={s.url} target="_blank" rel="noreferrer">
            🔗 {s.title}
          </a>
        </li>
      ))}
    </ul>
  );
}

function Bubble({ m, onUndo }: { m: ChatMessage; onUndo(): void }) {
  if (m.role === 'user') {
    return (
      <div className="bubble user">
        {m.text}
        {m.relay && <div className="relay-tag">已傳給 AI App</div>}
      </div>
    );
  }
  if (m.role === 'error') return <div className="bubble error">{m.text}</div>;
  return (
    <div className="bubble assistant">
      <Markdown text={m.text} />
      {m.sources && m.sources.length > 0 && <Sources sources={m.sources} />}
      {m.actions && m.actions.length > 0 && (
        <div className="actions-box">
          <ul>
            {m.actions.map((a, i) => (
              <li key={i}>{a.startsWith('⚠️') ? a : `✓ ${a}`}</li>
            ))}
          </ul>
          {m.undo ? (
            <button className="btn btn-sm" onClick={onUndo}>
              ↶ 復原這次修改
            </button>
          ) : m.undone ? (
            <span className="muted">已復原</span>
          ) : null}
        </div>
      )}
    </div>
  );
}
