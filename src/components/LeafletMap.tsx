import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';
import type { ResolvedRegion } from '../lib/geo';
import { wgsToGcj } from '../lib/geo';

export interface MapPoint {
  lat: number;
  lng: number;
  label: string;
  title: string;
  color?: string;
}

const TILES: Record<ResolvedRegion, { url: string; attribution: string; subdomains?: string }> = {
  // Amap tiles are drawn in GCJ-02, so markers are converted before placing.
  cn: {
    url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    attribution: '© 高德地圖',
    subdomains: '1234',
  },
  intl: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap',
  },
};

/** Leaflet map with numbered pins and an optional line joining them in order. */
export function LeafletMap(props: { points: MapPoint[]; region: ResolvedRegion; line?: boolean; className?: string }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!el.current) return;
    const t = TILES[props.region];
    const m = L.map(el.current, { zoomControl: true, attributionControl: true });
    m.attributionControl.setPrefix('Leaflet');
    L.tileLayer(t.url, { attribution: t.attribution, subdomains: t.subdomains ?? 'abc', maxZoom: 18 }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    // The container may still be animating into view; recompute its size.
    const id = setTimeout(() => m.invalidateSize(), 250);
    return () => {
      clearTimeout(id);
      m.remove();
      map.current = null;
    };
  }, [props.region]);

  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const pts = props.points.map((p) => {
      const c = props.region === 'cn' ? wgsToGcj(p) : p;
      return { ...p, ll: L.latLng(c.lat, c.lng) };
    });
    if (props.line && pts.length > 1) {
      L.polyline(
        pts.map((p) => p.ll),
        { color: '#0f766e', weight: 4, opacity: 0.75, dashArray: '6 8' },
      ).addTo(g);
    }
    for (const p of pts) {
      const html = document.createElement('span');
      html.textContent = p.label;
      html.style.background = p.color ?? '#0f766e';
      const icon = L.divIcon({ className: 'pin', html, iconSize: [26, 26], iconAnchor: [13, 13] });
      const tip = document.createElement('span');
      tip.textContent = p.title;
      L.marker(p.ll, { icon, title: p.title }).bindTooltip(tip).addTo(g);
    }
    if (pts.length === 1) m.setView(pts[0].ll, 15);
    else if (pts.length > 1) m.fitBounds(L.latLngBounds(pts.map((p) => p.ll)), { padding: [28, 28], maxZoom: 16 });
    else m.setView([25, 121], 3);
  }, [props.points, props.region, props.line]);

  return <div ref={el} className={props.className ?? 'minimap'} />;
}
