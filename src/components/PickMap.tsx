import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';
import { gcjToWgs, wgsToGcj, type ResolvedRegion } from '../lib/geo';
import type { LatLng } from '../types';
import { pinIcon, TILES, type MapPoint } from './LeafletMap';

/**
 * Moves made by the app jump instead of animating: the dialog may close (or move on to the next
 * place) right after one, and Leaflet fails when its map is removed mid-animation.
 */
const JUMP = { animate: false };

/** Where to look on the map, when nothing is picked yet. */
export interface MapFocus {
  at: LatLng;
  zoom: number;
}

/**
 * Map for picking a place's position by tapping it. Positions in and out are WGS-84; on Amap's
 * tiles (drawn in GCJ-02) they are converted both ways.
 */
export function PickMap(props: {
  region: ResolvedRegion;
  /** The picked position. */
  value: LatLng | null;
  focus?: MapFocus | null;
  /** Other places, for orientation. */
  points: MapPoint[];
  onPick(at: LatLng): void;
}) {
  const { region, value, focus, points } = props;
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const marker = useRef<L.Marker | null>(null);
  /** The view was set on purpose (a picked position or a focus), so the points no longer move it. */
  const placed = useRef(false);
  const onPick = useRef(props.onPick);
  onPick.current = props.onPick;

  useEffect(() => {
    if (!el.current) return;
    const t = TILES[region];
    const m = L.map(el.current, { zoomControl: true, attributionControl: true });
    m.attributionControl.setPrefix('Leaflet');
    L.tileLayer(t.url, { attribution: t.attribution, subdomains: t.subdomains ?? 'abc', maxZoom: 18 }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => {
      const p = { lat: e.latlng.lat, lng: e.latlng.lng };
      onPick.current(region === 'cn' ? gcjToWgs(p) : p);
    });
    m.setView([25, 121], 3);
    map.current = m;
    placed.current = false;
    const id = setTimeout(() => m.invalidateSize(), 250);
    return () => {
      clearTimeout(id);
      m.remove();
      map.current = null;
      marker.current = null;
    };
  }, [region]);

  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const lls = points.map((p) => {
      const c = region === 'cn' ? wgsToGcj(p) : p;
      const ll = L.latLng(c.lat, c.lng);
      const tip = document.createElement('span');
      tip.textContent = p.title;
      L.marker(ll, { icon: pinIcon(p.label, p.color, 22), title: p.title, interactive: true }).bindTooltip(tip).addTo(g);
      return ll;
    });
    if (placed.current || !lls.length) return;
    if (lls.length === 1) m.setView(lls[0], 14, JUMP);
    else m.fitBounds(L.latLngBounds(lls), { padding: [24, 24], maxZoom: 15, ...JUMP });
  }, [points, region]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!value) {
      marker.current?.remove();
      marker.current = null;
      return;
    }
    const c = region === 'cn' ? wgsToGcj(value) : value;
    const ll = L.latLng(c.lat, c.lng);
    if (marker.current) marker.current.setLatLng(ll);
    else marker.current = L.marker(ll, { icon: pinIcon('✓', '#dc2626', 30, 'pin pin-pick'), zIndexOffset: 1000, interactive: false }).addTo(m);
    // Follow a position chosen elsewhere (a search result, a pasted link); a tap is already in view.
    if (!placed.current || !m.getBounds().pad(-0.15).contains(ll)) m.setView(ll, Math.max(m.getZoom(), 16), JUMP);
    placed.current = true;
  }, [value, region]);

  useEffect(() => {
    const m = map.current;
    if (!m || !focus || value) return;
    const c = region === 'cn' ? wgsToGcj(focus.at) : focus.at;
    m.setView([c.lat, c.lng], focus.zoom, JUMP);
    placed.current = true;
    // Not on `value`: picking must not send the map back to the focus.
  }, [focus, region]);

  return <div ref={el} className="minimap pickmap" />;
}
