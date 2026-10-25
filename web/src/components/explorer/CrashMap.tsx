import { useEffect, useRef, useState } from 'react';
import { Map as MlMap, NavigationControl, FullscreenControl, setWorkerUrl, type GeoJSONSource, type MapLayerMouseEvent, type StyleSpecification } from 'maplibre-gl';
// MapLibre 6 runs tile parsing in a module worker; let Vite bundle it so the production build ships it.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { FeatureCollection } from 'geojson';
import counties from '../../data/counties.json';
import CanvasMap from '../maps/CanvasMap';
import { supportsWebGL2 } from '../../lib/map2d';
import type { Points } from '../../lib/types';

const DISTRICT: [[number, number], [number, number]] = [[-103.07, 32.52], [-101.04, 34.75]];
const SEV_COLOR = ['match', ['get', 's'], 'K', '#d31246', 'A', '#f27000', 'B', '#e7b63b', '#d0d8e1'];

const ROAD_COLOR: Record<string, string> = {
  highway_minor: '#262c29', highway_path: '#1d2220',
  highway_major_casing: '#3d4645', highway_major_inner: '#2c3332', highway_major_subtle: '#333b3a',
  highway_motorway_casing: '#5c686a', highway_motorway_inner: '#3f494b', highway_motorway_subtle: '#465052',
};

const AREA_COLOR: Record<string, string> = {
  water: '#15222e', landuse_residential: '#141716', landuse_park: '#142019', landcover_wood: '#141d17',
  building: '#1c201f', 'aeroway-area': '#171b1a',
};

setWorkerUrl(workerUrl);
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let style: Promise<StyleSpecification> | null = null;
/** OpenFreeMap's dark style, quietened so the crash marks carry the colour. */
function baseStyle() {
  style ??= fetch('https://tiles.openfreemap.org/styles/dark')
    .then((r) => { if (!r.ok) throw new Error(`basemap ${r.status}`); return r.json() as Promise<StyleSpecification>; })
    .then((s) => {
      s.layers = s.layers.filter((l) => !(l.type === 'symbol' && l.layout?.['icon-image'] && !l.layout?.['text-field']));
      for (const l of s.layers) {
        if (l.type === 'symbol' && l.layout) delete l.layout['icon-image'];
        const paint = (l.paint ?? {}) as Record<string, unknown>;
        // Decorative sprite textures are unnecessary on this data-focused basemap.
        for (const key of ['fill-pattern', 'line-pattern', 'background-pattern']) delete paint[key];
        if (l.type === 'background') paint['background-color'] = '#0e0f0e';
        // Towns stay readable for orientation; street names recede.
        if (l.type === 'symbol') paint['text-color'] = l.id.startsWith('place') ? '#b4bbb1' : '#8f968d';
        // A full road hierarchy in cool greys, read like a road map at night: casings on major roads,
        // streets visible once zoomed in, all below the warm severity colours of the crashes.
        const road = ROAD_COLOR[l.id];
        if (road) paint['line-color'] = road;
        // Water, parks, built-up areas and building footprints, so a town reads as on a road map.
        const area = AREA_COLOR[l.id];
        if (area) { paint['fill-color'] = area; paint['fill-opacity'] = 1; }
        if (l.id === 'building') paint['fill-outline-color'] = '#2c3330';
        if (l.id === 'highway_minor') paint['line-opacity'] = 1;
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
  const [failed, setFailed] = useState(() => !supportsWebGL2());
  const select = useRef(onSelect);
  select.current = onSelect;

  useEffect(() => {
    if (failed) return;
    let m: MlMap | null = null;
    let ro: ResizeObserver | null = null;
    let live = true;
    let loaded = false;
    const fail = () => { if (live) setFailed(true); };
    // A stalled basemap must not leave an empty panel indefinitely.
    const deadline = window.setTimeout(() => { if (!loaded) fail(); }, 15000);
    const lost = (event: Event) => { event.preventDefault(); fail(); };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
        el.current?.querySelector<HTMLButtonElement>('.maplibregl-ctrl-shrink')?.click();
      }
    };
    document.addEventListener('keydown', escape);
    baseStyle().then((s) => {
      if (!live || !el.current) return;
      m = new MlMap({
        container: el.current, style: s, bounds: DISTRICT, fitBoundsOptions: { padding: 24 },
        attributionControl: { compact: true }, cooperativeGestures: false, maxPitch: 0, dragRotate: false,
      });
      m.getCanvas().addEventListener('webglcontextlost', lost);
      m.on('error', () => { if (!loaded) fail(); });
      m.addControl(new NavigationControl({ showCompass: false }), 'top-right');
      // Expand inside the portal, including browsers that block native fullscreen.
      m.addControl(new FullscreenControl({ pseudo: true }), 'top-right');
      m.on('load', () => {
        if (!live) return;
        try {
        m!.addSource('counties', { type: 'geojson', data: counties as FeatureCollection });
        m!.addLayer({ id: 'county-line', type: 'line', source: 'counties', paint: { 'line-color': '#4a524a', 'line-width': 1 } });
        // The state highway network under the crashes, so a cluster can be read as "on US 84" or "on I-27".
        m!.addLayer({
          id: 'route-line', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation',
          filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], true, false],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': ['match', ['get', 'class'], 'motorway', '#a4b2b8', 'trunk', '#7d8a8f', '#5f6a6e'] as never,
            'line-width': ['interpolate', ['linear'], ['zoom'],
              6, ['match', ['get', 'class'], 'motorway', 1.4, 'trunk', 1, 0.6],
              12, ['match', ['get', 'class'], 'motorway', 3.2, 'trunk', 2.4, 1.6]] as never,
          },
        });
        m!.addSource('crashes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m!.addLayer({
          id: 'crash', type: 'circle', source: 'crashes',
          layout: { 'circle-sort-key': ['match', ['get', 's'], 'K', 4, 'A', 3, 'B', 2, 1] },
          paint: {
            'circle-color': SEV_COLOR as never,
            // Close sizes at district scale: K and A are drawn on top, but B and C (91% of crashes) stay visible.
            'circle-radius': ['interpolate', ['linear'], ['zoom'],
              7, ['match', ['get', 's'], 'K', 2, 'A', 1.7, 'B', 1.4, 1.3],
              10, ['match', ['get', 's'], 'K', 3.2, 'A', 2.8, 'B', 2.4, 2.2],
              13, ['match', ['get', 's'], 'K', 7, 'A', 6, 'B', 5, 4.5]] as never,
            'circle-opacity': ['match', ['get', 's'], 'C', 0.75, 'B', 0.85, 0.95] as never,
            'circle-stroke-color': '#0e0f0e',
            'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9, 0, 12, 1] as never,
          },
        });
        // Route numbers (I 27, US 84, SH 114…) above the points, so they stay readable over a dense corridor.
        m!.addLayer({
          id: 'route-label', type: 'symbol', source: 'openmaptiles', 'source-layer': 'transportation_name', minzoom: 6.5,
          filter: ['all', ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], true, false], ['has', 'ref']],
          layout: {
            'symbol-placement': 'line', 'symbol-spacing': 420,
            // OpenMapTiles keeps the route system in `network`: show I-27, US 84, SH 114 as a Texas map does.
            'text-field': ['concat', ['match', ['get', 'network'], 'us-interstate', 'I-', 'us-highway', 'US ', 'us-state', 'SH ', ''], ['get', 'ref']] as never,
            'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 7, 10, 12, 12] as never,
            'text-letter-spacing': 0.04, 'text-rotation-alignment': 'viewport', 'text-max-angle': 30,
          },
          paint: { 'text-color': '#c9d1c5', 'text-halo-color': '#0b0c0b', 'text-halo-width': 1.6 },
        });
        m!.addLayer({
          id: 'crash-selected', type: 'circle', source: 'crashes', filter: ['==', ['get', 'id'], -1],
          paint: { 'circle-radius': 11, 'circle-color': 'transparent', 'circle-stroke-color': '#eef0ec', 'circle-stroke-width': 2 },
        });
        m!.on('click', 'crash', (e: MapLayerMouseEvent) => { const id = e.features?.[0]?.properties?.id; if (id != null) select.current(Number(id)); });
        m!.on('mouseenter', 'crash', () => { m!.getCanvas().style.cursor = 'pointer'; });
        m!.on('mouseleave', 'crash', () => { m!.getCanvas().style.cursor = ''; });
        map.current = m;
        loaded = true;
        window.clearTimeout(deadline);
        setReady(true);
        } catch { fail(); }
      });
      // The panel can change size after the map is created (layout, sidebar wrap): keep the canvas matched.
      ro = new ResizeObserver(() => m?.resize());
      ro.observe(el.current);
    }).catch(() => live && setFailed(true));
    return () => {
      live = false;
      window.clearTimeout(deadline);
      m?.getCanvas().removeEventListener('webglcontextlost', lost);
      document.removeEventListener('keydown', escape);
      ro?.disconnect(); m?.remove(); map.current = null;
    };
  }, [failed]);

  useEffect(() => {
    if (!ready || !map.current) return;
    if (!points) {
      (map.current.getSource('crashes') as GeoJSONSource).setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    const features = points.id.map((id, i) => ({
      type: 'Feature' as const, properties: { id, s: points.severity[i] },
      geometry: { type: 'Point' as const, coordinates: [points.lon[i], points.lat[i]] },
    }));
    (map.current.getSource('crashes') as GeoJSONSource).setData({ type: 'FeatureCollection', features });
    // Frame the selection so a filtered set is never off screen; an empty one keeps the district view.
    if (points.lon.length) {
      const bounds: [[number, number], [number, number]] = [
        [Math.min(...points.lon), Math.min(...points.lat)], [Math.max(...points.lon), Math.max(...points.lat)]];
      map.current.fitBounds(bounds, { padding: 40, maxZoom: 12, duration: reduced() ? 0 : 600 });
    }
  }, [ready, points]);

  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    m.setFilter('crash-selected', ['==', ['get', 'id'], selected ?? -1]);
    if (selected == null || !points) return;
    const i = points.id.indexOf(selected);
    if (i >= 0) m.easeTo({ center: [points.lon[i], points.lat[i]], zoom: Math.max(m.getZoom(), 12), duration: reduced() ? 0 : 600 });
  }, [ready, selected, points]);

  if (failed) return <CanvasMap points={points} selected={selected} onSelect={onSelect} />;

  return (
    <div className="map" ref={el} role="region" aria-label="Crash map. Click a crash mark to open its record; the records table below lists the same crashes.">
      <ul className="map-legend" aria-label="Map legend">
        <li><i className="sw k" />K fatal</li><li><i className="sw a" />A suspected serious</li><li><i className="sw b" />B suspected minor</li><li><i className="sw c" />C possible</li>
        <li><i className="sw-route" aria-hidden="true" />Interstate, US and state highways</li>
      </ul>
    </div>
  );
}
