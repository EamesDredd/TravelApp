import { useEffect } from 'react';
import { AddSpotModal } from './components/AddSpotModal';
import { CandidatePool } from './components/CandidatePool';
import { ChatPanel } from './components/ChatPanel';
import { DayPlan } from './components/DayPlan';
import { ExportPdfModal } from './components/ExportPdfModal';
import { ImportTripModal } from './components/ImportTripModal';
import { DayPickerModal, SpotPickerModal } from './components/Pickers';
import { RouteModal } from './components/RouteModal';
import { SettingsModal } from './components/SettingsModal';
import { SpotDetail } from './components/SpotDetail';
import { TripForm, TripsModal } from './components/TripsModal';
import { hasCoords } from './lib/geo';
import { parseTrip, sharedTripInHash } from './lib/share';
import { formatDayDate } from './lib/util';
import { locator } from './locator';
import { getCurrentTrip, useCurrentTrip, useStore } from './store';
import { useUI } from './ui';

export default function App() {
  const trip = useCurrentTrip();
  const view = useStore((s) => s.view);
  const chatOpen = useStore((s) => s.chatOpen);
  const toast = useUI((s) => s.toast);
  useAutoLocate();

  // Import a trip opened from a share link (#trip=...), also one pasted into an open tab.
  useEffect(() => {
    const check = () => {
      const hash = sharedTripInHash();
      if (!hash) return;
      history.replaceState(null, '', location.pathname + location.search);
      try {
        useUI.getState().openImport(parseTrip(hash));
      } catch (err) {
        alert(`無法讀取分享連結：${(err as Error).message}`);
      }
    };
    check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
  }, []);

  return (
    <>
      {trip ? (
        <div className="app" data-view={view} data-chat={chatOpen ? 'open' : 'closed'}>
          <main className="main">
            <TopBar />
            <DayStrip />
            <ViewTabs />
            <div className="panes">
              <div className="pane-plan">
                <DayPlan />
              </div>
              <div className="pane-spots">
                <CandidatePool />
              </div>
            </div>
          </main>
          <ChatPanel />
        </div>
      ) : (
        <Welcome />
      )}
      {/* The route map opens place details and the locate dialog on top of itself. */}
      <RouteModal />
      <SpotDetail />
      <AddSpotModal />
      <DayPickerModal />
      <SpotPickerModal />
      <TripsModal />
      <ExportPdfModal />
      <ImportTripModal />
      <SettingsModal />
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

/** Finds coordinates in the background for places of the open trip that have none. */
function useAutoLocate() {
  const trip = useCurrentTrip();
  const unlocated = trip
    ? trip.spots
        .filter((s) => !hasCoords(s))
        .map((s) => `${s.id}:${s.name}`)
        .join('|')
    : '';
  useEffect(() => {
    const t = getCurrentTrip();
    if (t && unlocated) locator.schedule(t);
  }, [trip?.id, unlocated, trip?.destination, !!trip?.center]);
  useEffect(() => {
    const resume = () => locator.resume();
    window.addEventListener('online', resume);
    return () => window.removeEventListener('online', resume);
  }, []);
}

function Welcome() {
  const ui = useUI();
  return (
    <div className="welcome">
      <img className="logo" src="./icon.svg" alt="" />
      <h1>旅遊行程規劃</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        收集候選景點與餐廳、依天排行程、看路線地圖，還能和你的 Claude 或 ChatGPT 一起討論與調整。
      </p>
      <div className="card" style={{ marginTop: 20 }}>
        <TripForm submitLabel="開始規劃" />
      </div>
      <div className="row" style={{ marginTop: 12, justifyContent: 'center' }}>
        <button className="btn btn-sm" onClick={() => ui.openTrips(true)}>
          匯入行程
        </button>
        <button className="btn btn-sm" onClick={() => ui.openSettings(true)}>
          ⚙ 設定 AI
        </button>
      </div>
    </div>
  );
}

function TopBar() {
  const trip = useCurrentTrip()!;
  const ui = useUI();
  const sub = [
    trip.destination,
    trip.startDate && `${formatDayDate(trip.startDate, 0)} 起`,
    `${trip.days.length} 天`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <header className="topbar">
      <button className="trip-btn" onClick={() => ui.openTrips(true)}>
        <span className="trip-name">{trip.name} ▾</span>
        <span className="trip-sub">{sub}</span>
      </button>
      <button className="icon-btn" aria-label="匯出 PDF" title="匯出 PDF 行程表" onClick={() => ui.openPdfExport({})}>
        📄
      </button>
      <button className="icon-btn" aria-label="設定" onClick={() => ui.openSettings(true)}>
        ⚙
      </button>
    </header>
  );
}

function DayStrip() {
  const trip = useCurrentTrip()!;
  const selected = useStore((s) => s.selectedDay);
  const { selectDay, addDay, setView } = useStore.getState();
  const pick = (i: number) => {
    selectDay(i);
    setView('plan');
  };
  return (
    <nav className="daystrip" aria-label="選擇天數">
      <button className={`daychip${selected < 0 ? ' on' : ''}`} onClick={() => pick(-1)}>
        <b>全部</b>
        <small>{trip.days.length} 天</small>
      </button>
      {trip.days.map((d, i) => (
        <button key={d.id} className={`daychip${selected === i ? ' on' : ''}`} onClick={() => pick(i)}>
          <b>第{i + 1}天</b>
          <small>{formatDayDate(trip.startDate, i) || `${d.items.length} 個行程`}</small>
        </button>
      ))}
      <button
        className="daychip"
        aria-label="新增一天"
        onClick={() => {
          addDay();
          pick(trip.days.length);
        }}
      >
        <b>＋</b>
        <small>加一天</small>
      </button>
    </nav>
  );
}

function ViewTabs() {
  const trip = useCurrentTrip()!;
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const scheduled = new Set(trip.days.flatMap((d) => d.items.map((i) => i.spotId)));
  const free = trip.spots.filter((s) => !scheduled.has(s.id)).length;
  return (
    <div className="viewtabs">
      <div className="seg">
        <button className={view === 'plan' ? 'on' : ''} onClick={() => setView('plan')}>
          📅 每日行程
        </button>
        <button className={view === 'spots' ? 'on' : ''} onClick={() => setView('spots')}>
          ⭐ 候選地點 {trip.spots.length > 0 && <span className="muted small">（{free} 未排）</span>}
        </button>
      </div>
    </div>
  );
}
