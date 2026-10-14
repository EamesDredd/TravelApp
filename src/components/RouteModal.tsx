import { useEffect, useMemo, useRef, useState } from 'react';
import { amapCityCode, loadAmap, type AMapNS } from '../lib/amap';
import { distanceKm, estimateMinutes, formatKm, formatMinutes, hasCoords, stopsRegion, wgsToGcj } from '../lib/geo';
import {
  amapNavigationUrl,
  chunkStops,
  googleDirectionsUrl,
  googleEmbedDirectionsUrl,
  tripToKml,
} from '../lib/maps';
import { downloadFile, formatDayDate, safeFilename } from '../lib/util';
import { useCurrentTrip, useStore } from '../store';
import type { Spot, TravelMode } from '../types';
import { CATEGORY_ICON } from '../types';
import { useUI } from '../ui';
import { LeafletMap, type MapPoint } from './LeafletMap';
import { Modal } from './Modal';

const MODES: { id: TravelMode; label: string }[] = [
  { id: 'driving', label: '🚗 開車' },
  { id: 'transit', label: '🚇 大眾運輸' },
  { id: 'walking', label: '🚶 步行' },
];

const MODE_KEY = 'travel-planner-route-mode';

function loadMode(): TravelMode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    if (m === 'driving' || m === 'transit' || m === 'walking') return m;
  } catch {
    /* storage unavailable */
  }
  return 'transit';
}

export function RouteModal() {
  const dayIdx = useUI((s) => s.routeDay);
  const trip = useCurrentTrip();
  if (dayIdx === null || !trip || !trip.days[dayIdx]) return null;
  return <RouteInner key={dayIdx} dayIdx={dayIdx} />;
}

function RouteInner({ dayIdx }: { dayIdx: number }) {
  const trip = useCurrentTrip()!;
  const settings = useStore((s) => s.settings);
  const [mode, setModeState] = useState<TravelMode>(loadMode);
  const [leg, setLeg] = useState(0);
  const day = trip.days[dayIdx];

  const setMode = (m: TravelMode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* ignore */
    }
  };

  // Stops in visiting order; drop consecutive duplicates (e.g. back to the same hotel).
  const stops = useMemo(() => {
    const byId = new Map(trip.spots.map((s) => [s.id, s]));
    const out: Spot[] = [];
    for (const it of day.items) {
      const s = byId.get(it.spotId);
      if (s && out[out.length - 1]?.id !== s.id) out.push(s);
    }
    return out;
  }, [trip.spots, day.items]);

  const region = stopsRegion(stops, trip);
  const legs = stops.slice(1).map((b, i) => ({ a: stops[i], b, i }));
  const curLeg = Math.min(leg, Math.max(0, legs.length - 1));
  // Neither Google nor Amap routes transit through intermediate stops, and Amap
  // walking takes no waypoints either, so those are shown one leg at a time.
  const perLeg = legs.length > 0 && (mode === 'transit' || (mode === 'walking' && region === 'cn'));
  const missing = stops.filter((s) => !hasCoords(s));
  const amapReady = region === 'cn' && !!settings.amapKey.trim();
  const close = () => useUI.getState().openRoute(null);
  const date = formatDayDate(trip.startDate, dayIdx);

  const exportKml = () => {
    const kml = tripToKml(trip, [dayIdx], (i) => `第${i + 1}天 ${formatDayDate(trip.startDate, i)}`.trim());
    downloadFile(`${safeFilename(trip.name)}-第${dayIdx + 1}天.kml`, kml, 'application/vnd.google-earth.kml+xml');
  };

  const mapStops = perLeg ? [legs[curLeg].a, legs[curLeg].b] : stops;

  return (
    <Modal wide title={`第 ${dayIdx + 1} 天路線 ${date}`} onClose={close}>
      <div className="seg" style={{ marginBottom: 10 }}>
        {MODES.map((m) => (
          <button key={m.id} className={mode === m.id ? 'on' : ''} onClick={() => setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>

      {stops.length === 0 ? (
        <div className="map-placeholder">這天還沒有行程</div>
      ) : region === 'intl' ? (
        <iframe
          key={`${mode}-${curLeg}-${mapStops.map((s) => s.id).join()}`}
          className="route-map"
          title="路線地圖"
          src={googleEmbedDirectionsUrl(mapStops, mode, trip.destination, settings.googleMapsKey.trim() || undefined)}
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          allowFullScreen
        />
      ) : amapReady ? (
        <AmapRoute stops={mapStops} mode={mode} amapKey={settings.amapKey.trim()} securityCode={settings.amapSecurityCode.trim()} />
      ) : (
        <CnPreview stops={stops} highlight={perLeg ? [legs[curLeg].a.id, legs[curLeg].b.id] : undefined} />
      )}

      {region === 'cn' && !amapReady && (
        <p className="hint">
          地圖上是直線連線。要在 App 內看實際路線與即時路況，請在設定填入高德 Key；或用下方按鈕直接開啟高德地圖導航。
        </p>
      )}
      {missing.length > 0 && (
        <p className="hint">⚠️ 尚未定位：{missing.map((s) => s.name).join('、')}（到地點詳情按「定位」）。</p>
      )}

      <div className="section">
        <h3>
          {perLeg ? '分段路線（點選切換地圖）' : '各段距離'}
          <span className="chip">直線粗估</span>
        </h3>
        <ol className="legs">
          {legs.map(({ a, b, i }) => {
            const km = hasCoords(a) && hasCoords(b) ? distanceKm(a, b) : null;
            const nav =
              region === 'cn' ? amapNavigationUrl(a, b, mode) : googleDirectionsUrl([a, b], mode, trip.destination);
            return (
              <li
                key={`${a.id}-${b.id}-${i}`}
                className={`leg-row${perLeg && i === curLeg ? ' on' : ''}`}
                onClick={() => setLeg(i)}
              >
                <span className="leg-no">{i + 1}</span>
                <span className="grow small">
                  <b>
                    {CATEGORY_ICON[a.category]} {a.name} → {CATEGORY_ICON[b.category]} {b.name}
                  </b>
                  <div className="muted">
                    {km !== null ? `${formatKm(km)} · 約 ${formatMinutes(estimateMinutes(km, mode))}` : '缺少座標'}
                  </div>
                </span>
                {nav ? (
                  <a
                    className="btn btn-sm"
                    href={nav}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    導航
                  </a>
                ) : null}
              </li>
            );
          })}
          {legs.length === 0 && <li className="hint">只有一個地點，沒有路線。</li>}
        </ol>
      </div>

      <div className="section">
        <h3>開啟整天路線</h3>
        <div className="row-wrap">
          {region === 'intl' ? (
            mode === 'transit' ? (
              <span className="hint">Google 地圖的大眾運輸不支援多個中途點，請用上方各段的「導航」。</span>
            ) : (
              chunkStops(stops).map((chunk, i, all) => (
                <a
                  key={i}
                  className="btn btn-primary"
                  href={googleDirectionsUrl(chunk, mode, trip.destination)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Google 地圖{all.length > 1 ? ` (${i + 1}/${all.length})` : ''}：{chunk[0].name} → {chunk[chunk.length - 1].name}
                </a>
              ))
            )
          ) : mode === 'driving' && stops.length >= 2 && stops.length <= 3 ? (
            <AmapLink stops={stops} />
          ) : (
            <span className="hint">高德連結一次只能規劃一段（開車可含 1 個途經點），請用上方各段的「導航」。</span>
          )}
        </div>
      </div>

      <div className="section">
        <h3>Google 我的地圖</h3>
        <div className="notice">
          下載 KML 後，到 Google 我的地圖「建立新地圖 → 匯入」選擇檔案，就會產生這天的標記與路線圖層，可以在手機的 Google 地圖「已儲存 → 地圖」中查看。
          <div className="row-wrap" style={{ marginTop: 8 }}>
            <button className="btn btn-sm" onClick={exportKml} disabled={stops.every((s) => !hasCoords(s))}>
              ⬇ 下載 KML
            </button>
            <a className="btn btn-sm" href="https://www.google.com/maps/d/" target="_blank" rel="noreferrer">
              開啟 Google 我的地圖 ↗
            </a>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function AmapLink({ stops }: { stops: Spot[] }) {
  const url = amapNavigationUrl(stops[0], stops[stops.length - 1], 'driving', stops.length === 3 ? stops[1] : undefined);
  if (!url) return <span className="hint">需要先定位所有地點。</span>;
  return (
    <a className="btn btn-primary" href={url} target="_blank" rel="noreferrer">
      在高德地圖開啟整天路線
    </a>
  );
}

const PIN_COLORS = { sight: '#0f766e', breakfast: '#b45309', meal: '#be185d' } as const;

function CnPreview({ stops, highlight }: { stops: Spot[]; highlight?: string[] }) {
  const points = useMemo<MapPoint[]>(
    () =>
      stops
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => hasCoords(s))
        .map(({ s, i }) => ({
          lat: s.lat!,
          lng: s.lng!,
          label: String(i + 1),
          title: s.name,
          color: highlight && !highlight.includes(s.id) ? '#9ca3af' : PIN_COLORS[s.category],
        })),
    [stops, highlight],
  );
  return <LeafletMap points={points} region="cn" line className="route-map" />;
}

/** In-app Amap route with live traffic (driving) or step-by-step transit / walking directions. */
function AmapRoute(props: { stops: Spot[]; mode: TravelMode; amapKey: string; securityCode: string }) {
  const mapEl = useRef<HTMLDivElement>(null);
  const panelEl = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('載入高德地圖…');
  const located = props.stops.filter(hasCoords);
  const sig = located.map((s) => `${s.id}:${s.lat},${s.lng}`).join('|');

  useEffect(() => {
    let alive = true;
    let map: AMapNS | null = null;
    let router: AMapNS | null = null;
    const panel = panelEl.current;
    setStatus('載入高德地圖…');

    (async () => {
      try {
        const AMap = await loadAmap(props.amapKey, props.securityCode);
        if (!alive || !mapEl.current) return;
        if (located.length < 2) {
          setStatus('至少需要兩個已定位的地點');
          return;
        }
        const pts = located.map((s) => {
          const g = wgsToGcj(s);
          return new AMap.LngLat(g.lng, g.lat);
        });
        map = new AMap.Map(mapEl.current, { zoom: 12, center: pts[0], resizeEnable: true });
        map.addControl(new AMap.Scale());
        map.addControl(new AMap.ToolBar({ position: 'RB' }));
        const done = (st: string, result: unknown) => {
          if (!alive) return;
          setStatus(st === 'complete' ? '' : `查無路線（${typeof result === 'string' ? result : st}）`);
        };
        setStatus('規劃路線中…');
        if (props.mode === 'driving') {
          map.add(new AMap.TileLayer.Traffic({ autoRefresh: true, interval: 180 }));
          router = new AMap.Driving({ map, panel, policy: AMap.DrivingPolicy.LEAST_TIME });
          router.search(pts[0], pts[pts.length - 1], { waypoints: pts.slice(1, -1).slice(0, 16) }, done);
        } else if (props.mode === 'walking') {
          router = new AMap.Walking({ map, panel });
          router.search(pts[0], pts[1], done);
        } else {
          const [city, cityd] = await Promise.all([
            amapCityCode(AMap, pts[0].lng, pts[0].lat),
            amapCityCode(AMap, pts[1].lng, pts[1].lat),
          ]);
          if (!alive) return;
          router = new AMap.Transfer({
            map,
            panel,
            city: city ?? '',
            cityd: cityd ?? city ?? '',
            policy: AMap.TransferPolicy.LEAST_TIME,
            nightflag: true,
          });
          router.search(pts[0], pts[1], done);
        }
      } catch (err) {
        if (alive) setStatus((err as Error).message);
      }
    })();

    return () => {
      alive = false;
      try {
        router?.clear?.();
        map?.destroy();
      } catch {
        /* map already gone */
      }
      if (panel) panel.innerHTML = '';
    };
    // `sig` captures the located stops; re-plan when they, the mode or the keys change.
  }, [sig, props.mode, props.amapKey, props.securityCode]);

  return (
    <>
      <div ref={mapEl} className="route-map" />
      {status && (
        <div className="status-line" style={{ marginTop: 6 }}>
          {status.endsWith('…') && <span className="spinner" />} {status}
        </div>
      )}
      <div ref={panelEl} className="amap-panel" />
    </>
  );
}
