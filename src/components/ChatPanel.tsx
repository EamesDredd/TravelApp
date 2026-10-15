import { useEffect, useRef, useState } from 'react';
import { aiConfigured, chatSupportsWebSearch, FriendlyError, providerLabel, runChatTurn } from '../lib/ai';
import { buildFixPrompt, buildRelayPrompt, contentFingerprint, newRelayTag, planRelayApply, tripFingerprint } from '../lib/ai/relay';
import { AI_APP_LINKS, copyText, preview, readClipboard, sendToAiApp } from '../lib/handoff';
import { snapshotOf } from '../lib/tripOps';
import { uid } from '../lib/util';
import { getCurrentTrip, useCurrentTrip, useStore } from '../store';
import type { ChatMessage, SearchSource } from '../types';
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
  /** The last relay message prepared in this trip; recorded in the chat once it leaves the app. */
  const [pending, setPending] = useState<PendingSend | null>(null);
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

  // A prepared message belongs to the trip it was made from.
  useEffect(() => setPending(null), [trip.id]);

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

  const recordSend = (p: PendingSend) => {
    if (p.recorded || getCurrentTrip()?.id !== p.tripId) return;
    appendChat({ id: uid('m'), role: 'user', text: p.text, relay: { tag: p.tag, fp: p.fp }, at: Date.now() });
    resetInput();
    setPending({ ...p, recorded: true });
  };

  /**
   * Builds the message for the user's AI app from the trip as it is now, then shares it
   * (or copies it). Called straight from the tap so the share sheet / clipboard is allowed.
   */
  const sendRelay = async (text: string, via: 'share' | 'copy' = 'share') => {
    const t = getCurrentTrip();
    if (!t) return;
    const snapshot = snapshotOf(t);
    const tag = newRelayTag();
    const p: PendingSend = {
      tripId: t.id,
      text,
      tag,
      fp: tripFingerprint(snapshot),
      prompt: buildRelayPrompt(snapshot, text, tag),
      recorded: false,
    };
    setPending(p);
    const result = via === 'copy' ? ((await copyText(p.prompt)) ? 'copied' : 'failed') : await sendToAiApp(p.prompt);
    if (result === 'shared' || result === 'copied') recordSend(p);
    if (result === 'copied') toast('已複製，請貼到 Claude 或 ChatGPT 送出');
    if (result === 'failed') toast('無法自動傳送，請按下方「⧉ 複製」');
  };

  /** "Copy" sends what is typed now; with an empty box it copies a message whose share did not go through. */
  const copySend = async () => {
    const text = input.trim();
    if (text) return sendRelay(text, 'copy');
    if (!pending || pending.recorded) return;
    if (await copyText(pending.prompt)) {
      recordSend(pending);
      toast('已複製，請貼到 Claude 或 ChatGPT 送出');
    } else {
      toast('複製失敗');
    }
  };

  const applyReply = (raw: string) => {
    const st = useStore.getState();
    const t = getCurrentTrip();
    if (!t) return;
    const d = planRelayApply(raw, t, st.trips.filter((x) => x.id !== t.id));
    const addReply = (msg: Partial<ChatMessage>) =>
      appendChat({ id: uid('m'), role: 'assistant', text: '', at: Date.now(), ...msg });

    switch (d.kind) {
      case 'own-prompt':
        toast('剪貼簿裡是要傳給 AI 的內容，請先在 AI App 複製它的回覆');
        return;
      case 'empty':
        toast('沒有讀到內容');
        return;
      case 'other-trip':
        alert(`這則回覆是「${d.tripName}」的，請切換到那個旅程再貼上。`);
        return;
      case 'duplicate':
        toast('這則回覆已經套用過了');
        return;
      case 'message-only': {
        const { parsed } = d;
        if (parsed.problems.length) {
          addReply({
            text: parsed.message || '（AI 的回覆）',
            actions: ['⚠️ 沒有套用任何修改', ...parsed.problems.map((p) => `⚠️ ${p}`)],
            relayFix: buildFixPrompt(parsed.base, parsed.problems),
          });
          toast('修改區塊有問題，沒有套用');
          return;
        }
        if (parsed.ops) {
          // An empty block: the AI says there is nothing to change.
          addReply({
            text: parsed.message || '（AI 的回覆）',
            actions: d.cannotRevert
              ? [
                  'ℹ️ AI 這次沒有附任何修改',
                  'ℹ️ 這個請求先前套用的修改還在（之後行程有其他變動，無法自動還原）；要取消的話，請按先前那則回覆的「↶ 復原這次修改」',
                ]
              : ['ℹ️ AI 表示這次不需要修改行程'],
          });
          toast(d.cannotRevert ? '先前的修改還在，可用該則回覆的「復原」取消' : '這則回覆沒有要修改行程');
          return;
        }
        const ok = confirm(
          `這段內容沒有行程修改區塊。\n（如果 AI 說它改了行程，請在 AI App 複製「整則」回覆，包含最後的程式碼區塊。）\n\n要把它加入對話紀錄嗎？\n\n${preview(parsed.message)}`,
        );
        if (!ok) return;
        addReply({ text: parsed.message });
        toast('已加入對話紀錄');
        return;
      }
      case 'apply': {
        const questions = {
          'unknown-send': `找不到這則回覆對應的傳送紀錄（可能來自其他裝置，或對話已清除）。\n要套用到目前的旅程「${t.name}」嗎？`,
          'edited-since-send': '傳給 AI 之後，行程有其他變動。AI 的修改可能會覆蓋那幾天的安排，要繼續嗎？（之後可按「復原」）',
          'edited-after-reply':
            '這個請求先前的回覆已經套用，之後行程又有變動。要把這則回覆直接套用在目前的行程上嗎？（之後可按「復原」）',
          'older-version': `這是較早的版本（第 ${d.parsed.rev} 版），目前套用的是第 ${d.replacesRev} 版。要改用這個版本嗎？`,
        } as const;
        const notes = d.parsed.notes.map((n) => `ℹ️ ${n}`);
        if (d.revertsRequest) {
          // An empty block in a follow-up: the AI takes back everything this request changed.
          const older = d.confirm === 'older-version' ? `這是較早的版本（第 ${d.parsed.rev} 版）。\n` : '';
          if (!confirm(`${older}AI 這次沒有附任何修改，套用會把這個請求先前的修改全部還原，要還原嗎？（之後可按「復原」）`)) {
            addReply({ text: d.parsed.message || '（AI 的回覆）', actions: ['ℹ️ 保留了這個請求先前套用的修改', ...notes] });
            return;
          }
        } else if (d.confirm && !confirm(questions[d.confirm])) return;

        // A broken version never replaces one that applied cleanly; ask the AI to fix it instead.
        if (d.replaces && d.issues.length && !d.replacesBroken) {
          addReply({
            text: d.parsed.message || '（AI 的回覆）',
            actions: ['⚠️ 這一版有問題，先保留目前套用的版本', ...d.issues.map((i) => `⚠️ ${i}`), ...notes],
            relayFix: buildFixPrompt(d.parsed.base, d.issues),
            ...(d.parsed.base ? { relayBase: d.parsed.base } : {}),
          });
          toast('這一版有問題，先保留目前的版本');
          return;
        }

        let apply = d.result;
        let issues = d.issues;
        let replaced = !!d.replaces;
        if (d.dropped.length && d.onCurrent) {
          const swap = confirm(
            `這一版沒有包含先前套用的部分修改：\n${d.dropped.map((x) => `・${x}`).join('\n')}\n\n按「確定」照這一版取代；按「取消」可以改成套用在目前的行程上（保留先前的修改）。`,
          );
          if (!swap) {
            if (!confirm('要把這一版套用在目前的行程上，保留先前的修改嗎？')) return;
            apply = d.onCurrent;
            issues = d.onCurrentIssues ?? d.issues;
          }
        }
        const onTop = apply !== d.result;

        let result = apply.trip;
        if (issues.length) {
          const list = issues.slice(0, 5).map((i) => `・${i}`).join('\n');
          const partial =
            apply.summary.length > 0 &&
            confirm(`AI 的修改有 ${issues.length} 個問題：\n${list}\n\n要先套用沒問題的部分嗎？（也可以把問題傳回給 AI 修正）`);
          if (!partial) result = d.before;
        }
        const resultFp = tripFingerprint(result);
        const changed = contentFingerprint(result) !== contentFingerprint(d.before);
        if (!changed) replaced = false;
        if (changed) {
          replaceSnapshot(result);
          // The new reply carries the request's starting point from here on.
          if (d.replaces) updateChat(d.replaces, { superseded: true, relayStart: undefined });
        }
        const actions: string[] = !changed
          ? issues.length
            ? ['⚠️ 沒有套用任何修改']
            : ['AI 的修改和目前行程相同，沒有變更']
          : d.revertsRequest
            ? ['已還原這個請求先前套用的修改']
            : apply.summary.length
              ? [...apply.summary]
              : ['已更新行程'];
        if (replaced && !d.revertsRequest) {
          actions.push(onTop ? '套用在目前的行程上（保留先前的修改）' : '取代了這個請求先前套用的版本');
        }
        if (replaced && !onTop && d.dropped.length) actions.push(...d.dropped);
        actions.push(...issues.map((i) => `⚠️ ${i}`), ...notes);
        addReply({
          text: d.parsed.message || (changed ? '已套用 AI 的修改。' : '（AI 的回覆）'),
          actions,
          ...(d.parsed.base ? { relayBase: d.parsed.base } : {}),
          ...(d.parsed.rev ? { relayRev: d.parsed.rev } : {}),
          ...(changed ? { undo: d.before, relayResult: resultFp, relayOps: d.opsFp, relayStart: d.requestBase } : {}),
          ...(issues.length ? { relayFix: buildFixPrompt(d.parsed.base, issues) } : {}),
        });
        toast(
          changed
            ? d.revertsRequest
              ? '已還原這個請求的修改'
              : issues.length
                ? '已套用部分修改'
                : '已套用 AI 的修改'
            : issues.length
              ? '沒有套用，可以把問題傳回給 AI 修正'
              : '和目前行程相同，沒有變更',
        );
        return;
      }
    }
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

  /** Restoring an older snapshot also reverts every later change, so later undo points are retired too. */
  const undo = (m: ChatMessage) => {
    const t = getCurrentTrip();
    if (!m.undo || !t) return;
    const idx = t.chat.findIndex((x) => x.id === m.id);
    const later = t.chat.slice(idx + 1).filter((x) => x.undo);
    const question = later.length
      ? `復原到這則回覆之前的狀態？之後的 ${later.length} 次 AI 修改和手動變更也會一起還原。`
      : '復原這次 AI 的修改？之後手動做的變更也會一起還原。';
    if (!confirm(question)) return;
    const restored = m.undo;
    // Replies that replace each other share one starting point; only the one in effect holds it.
    const start = t.chat.slice(idx).find((x) => x.relayBase === m.relayBase && x.relayStart && !x.undone)?.relayStart;
    replaceSnapshot(restored, { restore: true });
    for (const x of [m, ...later]) updateChat(x.id, { undo: undefined, relayStart: undefined, undone: true });
    // A reply this one had replaced is in effect again, and takes back the request's starting point.
    if (m.relayBase) {
      const fp = tripFingerprint(restored);
      const back = t.chat
        .slice(0, idx)
        .reverse()
        .find((x) => x.relayBase === m.relayBase && x.superseded && !x.undone && x.relayResult === fp);
      if (back) updateChat(back.id, { superseded: false, relayStart: back.relayStart ?? start });
    }
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
          {(input.trim() || (pending && !pending.recorded)) && (
            <button className="btn btn-sm" onClick={copySend} title="不用分享選單，改用複製再貼到 AI App">
              ⧉ 複製
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

interface PendingSend {
  tripId: string;
  text: string;
  tag: string;
  fp: string;
  prompt: string;
  /** Already logged in the chat as sent. */
  recorded: boolean;
}

function Bubble({ m, onUndo }: { m: ChatMessage; onUndo(): void }) {
  if (m.role === 'user') {
    return (
      <div className="bubble user">
        {m.text}
        {m.relay && <div className="relay-tag">已傳給 AI App · 回覆後複製整則，按「📋 貼上回覆」</div>}
      </div>
    );
  }
  if (m.role === 'error') return <div className="bubble error">{m.text}</div>;
  return (
    <div className="bubble assistant">
      <Markdown text={m.text} />
      {m.sources && m.sources.length > 0 && <Sources sources={m.sources} />}
      {m.superseded && !m.undone && <div className="muted small">（已由這個請求較新的回覆取代）</div>}
      {(!!m.actions?.length || !!m.undo || !!m.undone || !!m.relayFix) && (
        <div className="actions-box">
          {m.actions && m.actions.length > 0 && (
            <ul>
              {m.actions.map((a, i) => (
                <li key={i}>{a.startsWith('⚠️') || a.startsWith('ℹ️') ? a : `✓ ${a}`}</li>
              ))}
            </ul>
          )}
          <div className="row-wrap">
            {m.undo ? (
              <button className="btn btn-sm" onClick={onUndo}>
                ↶ 復原這次修改
              </button>
            ) : m.undone ? (
              <span className="muted">已復原</span>
            ) : null}
            {m.relayFix && (
              <button
                className="btn btn-sm"
                onClick={async () =>
                  useUI.getState().showToast((await copyText(m.relayFix!)) ? '已複製，貼回 AI 的同一個對話請它修正' : '複製失敗')
                }
              >
                ⧉ 複製修正請求給 AI
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
