/* Loader and small helpers for the Amap (高德) JS API v2. Only used when the
 * user configures their own key; everything else works without it. */

// The AMap global is untyped; keep the surface we touch narrow.
export type AMapNS = any;

declare global {
  interface Window {
    AMap?: AMapNS;
    _AMapSecurityConfig?: { securityJsCode: string };
  }
}

let loading: Promise<AMapNS> | null = null;
let loadedKey = '';

const PLUGINS = [
  'AMap.Driving',
  'AMap.Transfer',
  'AMap.Walking',
  'AMap.PlaceSearch',
  'AMap.Geocoder',
  'AMap.Scale',
  'AMap.ToolBar',
].join(',');

export function loadAmap(key: string, securityCode: string): Promise<AMapNS> {
  if (window.AMap && loadedKey === key) return Promise.resolve(window.AMap);
  if (loading && loadedKey === key) return loading;
  loadedKey = key;
  if (securityCode) window._AMapSecurityConfig = { securityJsCode: securityCode };
  loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}&plugin=${PLUGINS}`;
    s.async = true;
    s.onload = () => (window.AMap ? resolve(window.AMap) : reject(new Error('高德地圖 API 載入失敗')));
    s.onerror = () => {
      loading = null;
      reject(new Error('無法連線到高德地圖 API'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export interface AmapPoi {
  name: string;
  address: string;
  /** GCJ-02 */
  lng: number;
  lat: number;
}

export function amapPlaceSearch(AMap: AMapNS, keyword: string, city?: string): Promise<AmapPoi[]> {
  return new Promise((resolve, reject) => {
    const ps = new AMap.PlaceSearch({ pageSize: 8, pageIndex: 1, city: city || '全国', citylimit: false });
    ps.search(keyword, (status: string, result: AMapNS) => {
      if (status === 'no_data') return resolve([]);
      if (status !== 'complete') return reject(new Error(typeof result === 'string' ? result : '高德搜尋失敗'));
      const pois = (result?.poiList?.pois ?? []) as AMapNS[];
      resolve(
        pois
          .filter((p) => p.location)
          .map((p) => ({
            name: String(p.name ?? ''),
            address: [p.cityname, p.adname, typeof p.address === 'string' ? p.address : '']
              .filter(Boolean)
              .join(' '),
            lng: Number(p.location.lng),
            lat: Number(p.location.lat),
          })),
      );
    });
  });
}

/** City code for transit routing (AMap.Transfer needs the city). */
export function amapCityCode(AMap: AMapNS, lng: number, lat: number): Promise<string | null> {
  return new Promise((resolve) => {
    const geocoder = new AMap.Geocoder();
    geocoder.getAddress(new AMap.LngLat(lng, lat), (status: string, result: AMapNS) => {
      if (status !== 'complete') return resolve(null);
      const c = result?.regeocode?.addressComponent;
      resolve((c?.citycode as string) || (c?.city as string) || (c?.province as string) || null);
    });
  });
}
