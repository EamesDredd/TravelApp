import { useMemo } from 'react';
import { hasCoords, type ResolvedRegion } from '../lib/geo';
import { amapPlaceUrl, googleEmbedPlaceUrl, googleSearchUrl } from '../lib/maps';
import { useStore } from '../store';
import type { Spot } from '../types';
import { CATEGORY_ICON } from '../types';
import { LeafletMap } from './LeafletMap';

const CAT_COLOR = { sight: '#0f766e', breakfast: '#b45309', meal: '#be185d' } as const;

/** Small map for one place: Google Maps outside mainland China, Amap tiles inside. */
export function SpotMap({ spot, region, destination }: { spot: Spot; region: ResolvedRegion; destination: string }) {
  const googleKey = useStore((s) => s.settings.googleMapsKey.trim());
  const points = useMemo(
    () =>
      hasCoords(spot)
        ? [{ lat: spot.lat, lng: spot.lng, label: CATEGORY_ICON[spot.category], title: spot.name, color: CAT_COLOR[spot.category] }]
        : [],
    [spot],
  );

  return (
    <div>
      {region === 'cn' ? (
        points.length ? (
          <LeafletMap points={points} region="cn" />
        ) : (
          <div className="map-placeholder">
            這個地點還沒有座標。
            <br />
            按下方「定位」搜尋位置，或直接在高德地圖查看。
          </div>
        )
      ) : (
        <iframe
          key={`${spot.id}-${spot.address}-${spot.lat}`}
          className="minimap"
          title={`${spot.name} 地圖`}
          src={googleEmbedPlaceUrl(spot, destination, googleKey || undefined)}
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          allowFullScreen
        />
      )}
      <div className="row-wrap" style={{ marginTop: 8 }}>
        {region === 'cn' ? (
          <a className="btn btn-sm" href={amapPlaceUrl(spot, destination)} target="_blank" rel="noreferrer">
            在高德地圖開啟
          </a>
        ) : null}
        <a className="btn btn-sm" href={googleSearchUrl(spot, destination)} target="_blank" rel="noreferrer">
          在 Google 地圖開啟
        </a>
      </div>
    </div>
  );
}
