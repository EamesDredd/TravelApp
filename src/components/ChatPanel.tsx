import { useEffect, useRef, useState } from 'react';
import { aiConfigured, chatSupportsWebSearch, FriendlyError, providerLabel, runChatTurn } from '../lib/ai';
import { snapshotOf } from '../lib/tripOps';
import { uid } from '../lib/util';
import { getCurrentTrip, useCurrentTrip, useStore } from '../store';
import type { ChatMessage, SearchSource } from '../types';
import { useUI } from '../ui';
import { Markdown } from './Markdown';

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
  const ctrl = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const ready = aiConfigured(settings);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [trip.chat.length, live?.text, live?.status, props.visible]);

  const send = async (raw: string) => {
    const text = raw.trim();
    const t = getCurrentTrip();
    if (!text || !t || props.running) return;
    const before = snapshotOf(t);
    const history = t.chat;
    const tripId = t.id;
    setInput('');
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

  const undo = (m: ChatMessage) => {
    if (!m.undo) return;
    if (!confirm('復原這次 AI 的修改？之後手動做的變更也會一起還原。')) return;
    replaceSnapshot(m.undo);
    updateChat(m.id, { undo: undefined, undone: true });
    useUI.getState().showToast('已復原');
  };

  return (
    <aside className={`chat${full ? ' full' : ''}`} hidden={!props.visible} aria-label="AI 討論">
      <div className="chat-head">
        <div className="chat-title">
          <b>AI 旅遊助理</b>
          <small>
            {ready ? providerLabel(settings) : '尚未連接 AI'}
            {ready && settings.chatWebSearch && chatSupportsWebSearch(settings) ? ' · 可搜尋網路' : ''}
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
        {!ready && (
          <div className="notice">
            連接你自己的 Claude 或 ChatGPT（API 金鑰）後，就能在這裡討論行程，AI 也能直接幫你新增候選、排每天的行程。
            <div style={{ marginTop: 8 }}>
              <button className="btn btn-primary btn-sm" onClick={() => useUI.getState().openSettings(true)}>
                前往設定
              </button>
            </div>
          </div>
        )}
        {ready && trip.chat.length === 0 && !live && (
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

      {ready && !props.running && trip.chat.length === 0 && (
        <div className="suggestions" style={{ padding: '0 10px 6px' }}>
          {SUGGESTIONS.map((s) => (
            <button key={s} className="chip" onClick={() => send(s)}>
              {s}
            </button>
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
          rows={1}
          value={input}
          placeholder={ready ? '和 AI 討論行程…' : '請先到設定連接 AI'}
          disabled={!ready}
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
          <button type="submit" className="btn btn-primary" disabled={!ready || !input.trim()}>
            送出
          </button>
        )}
      </form>
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
  if (m.role === 'user') return <div className="bubble user">{m.text}</div>;
  if (m.role === 'error') return <div className="bubble error">{m.text}</div>;
  return (
    <div className="bubble assistant">
      <Markdown text={m.text} />
      {m.sources && m.sources.length > 0 && <Sources sources={m.sources} />}
      {m.actions && m.actions.length > 0 && (
        <div className="actions-box">
          <ul>
            {m.actions.map((a, i) => (
              <li key={i}>✓ {a}</li>
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
