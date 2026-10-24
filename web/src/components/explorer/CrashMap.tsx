import { useEffect, useRef, useState } from 'react';
import { Map as MlMap, NavigationControl, setWorkerUrl, type GeoJSONSource, type MapLayerMouseEvent, type StyleSpecification } from 'maplibre-gl';
// MapLibre 6 runs tile parsing in a module worker; let Vite bundle it so the production build ships it.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { FeatureCollection } from 'geojson';
import counties from '../../data/counties.json';
import type { Points } from '../../lib/types';

const DISTRICT: [[number, number], [number, number]] = [[-103.07, 32.52], [-101.04, 34.75]];
const SEV_COLOR = ['match', ['get', 's'], 'K', '#d31246', 'A', '#f27000', 'B', '#e7b63b', '#d0d8e1'];

setWorkerUrl(workerUrl);

let style: Promise<StyleSpecification> | null = null;
/** OpenFreeMap's dark style, quietened so the crash marks carry the colour. */
function baseStyle() {
  style ??= fetch('https://tiles.openfreemap.org/styles/dark')
    .then((r) => { if (!r.ok) throw new Error(`basemap ${r.status}`); return r.json() as Promise<StyleSpecification>; })
    .then((s) => {
      for (const l of s.layers) {
        const paint = (l.paint ?? {}) as Record<string, unknown>;
        if (l.type === 'background') paint['background-color'] = '#0e0f0e';
        if (l.type === 'symbol') paint['text-color'] = '#8f968d';
        if (l.type === 'line' && l.id.startsWith('highway')) {
          paint['line-color'] = l.id.includes('casing') ? '#30362f' : l.id.includes('motorway') ? '#2a2f29' : '#1e221e';
        }
        l.paint = paint as never;
      }
      return s;
    })
    .catch((e) => { style = null; throw e; });
  return style;
}

interface Props {
  points: Points | null;
  selected: number | null;
  onSelect: (id: number | null) => void;
}

/** Crash locations on a basemap: K and A drawn last and largest, click a mark to open its record. */
export default function CrashMap({ points, selected, onSelect }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const select = useRef(onSelect);
  select.current = onSelect;

  useEffect(() => {
    let m: MlMap | null = null;
    let ro: ResizeObserver | null = null;
    let live = true;
    baseStyle().then((s) => {
      if (!live || !el.current) return;
      m = new MlMap({
        container: el.current, style: s, bounds: DISTRICT, fitBoundsOptions: { padding: 24 },
        attributionControl: { compact: true }, cooperativeGestures: false, maxPitch: 0, dragRotate: false,
      });
      m.addControl(new NavigationControl({ showCompass: false }), 'top-right');
      m.on('load', () => {
        m!.addSource('counties', { type: 'geojson', data: counties as FeatureCollection });
        m!.addLayer({ id: 'county-line', type: 'line', source: 'counties', paint: { 'line-color': '#4a524a', 'line-width': 1 } });
        m!.addSource('crashes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m!.addLayer({
          id: 'crash', type: 'circle', source: 'crashes',
          layout: { 'circle-sort-key': ['match', ['get', 's'], 'K', 4, 'A', 3, 'B', 2, 1] },
          paint: {
            'circle-color': SEV_COLOR as never,
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, ['match', ['get', 's'], 'K', 3.4, 'A', 2.6, 1.4], 13, ['match', ['get', 's'], 'K', 8, 'A', 6.5, 'B', 5, 4]] as never,
            'circle-opacity': ['match', ['get', 's'], 'C', 0.55, 'B', 0.75, 0.95] as never,
            'circle-stroke-color': '#0e0f0e',
            'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9, 0, 12, 1] as never,
          },
        });
        m!.addLayer({
          id: 'crash-selected', type: 'circle', source: 'crashes', filter: ['==', ['get', 'id'], -1],
          paint: { 'circle-radius': 11, 'circle-color': 'transparent', 'circle-stroke-color': '#eef0ec', 'circle-stroke-width': 2 },
        });
        m!.on('click', 'crash', (e: MapLayerMouseEvent) => { const id = e.features?.[0]?.properties?.id; if (id != null) select.current(Number(id)); });
        m!.on('mouseenter', 'crash', () => { m!.getCanvas().style.cursor = 'pointer'; });
        m!.on('mouseleave', 'crash', () => { m!.getCanvas().style.cursor = ''; });
        map.current = m;
        setReady(true);
      });
      // The panel can change size after the map is created (layout, sidebar wrap): keep the canvas matched.
      ro = new ResizeObserver(() => m?.resize());
      ro.observe(el.current);
    }).catch(() => live && setFailed(true));
    return () => { live = false; ro?.disconnect(); m?.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    if (!ready || !points || !map.current) return;
    const features = points.id.map((id, i) => ({
      type: 'Feature' as const, properties: { id, s: points.severity[i] },
      geometry: { type: 'Point' as const, coordinates: [points.lon[i], points.lat[i]] },
    }));
    (map.current.getSource('crashes') as GeoJSONSource).setData({ type: 'FeatureCollection', features });
  }, [ready, points]);

  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    m.setFilter('crash-selected', ['==', ['get', 'id'], selected ?? -1]);
    if (selected == null || !points) return;
    const i = points.id.indexOf(selected);
    if (i >= 0) m.easeTo({ center: [points.lon[i], points.lat[i]], zoom: Math.max(m.getZoom(), 12), duration: 600 });
  }, [ready, selected, points]);

  return (
    <div className="map" ref={el} role="region" aria-label="Crash map. Click a crash mark to open its record; the records table below lists the same crashes.">
      {failed && <p className="map-msg">The basemap could not be loaded. The charts and tables below are unaffected.</p>}
      <ul className="map-legend" aria-label="Severity legend">
        <li><i className="sw k" />K fatal</li><li><i className="sw a" />A serious</li><li><i className="sw b" />B minor</li><li><i className="sw c" />C possible</li>
      </ul>
    </div>
  );
}
