import { useEffect, useMemo, useRef, useState } from 'react';
import { Map as MlMap, NavigationControl, FullscreenControl, Popup, setWorkerUrl, type GeoJSONSource, type MapLayerMouseEvent, type StyleSpecification } from 'maplibre-gl';
// MapLibre 6 runs tile parsing in a module worker; let Vite bundle it so the production build ships it.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { FeatureCollection } from 'geojson';
import { ArrowClockwiseIcon, ArrowCounterClockwiseIcon, CaretDownIcon, CaretUpIcon, CompassIcon } from '@phosphor-icons/react';
import counties from '../../data/counties.json';
import CanvasMap from '../maps/CanvasMap';
import { supportsWebGL2 } from '../../lib/map2d';
import type { Points } from '../../lib/types';
import { int, pct, road } from '../../lib/format';

const DISTRICT: [[number, number], [number, number]] = [[-103.07, 32.52], [-101.04, 34.75]];
const SEV_COLOR = ['match', ['get', 's'], 'K', '#d31246', 'A', '#f27000', 'B', '#e7b63b', '#d0d8e1'];
const SEV_NAME: Record<string, string> = { K: 'Fatal', A: 'Suspected serious injury', B: 'Suspected minor injury', C: 'Possible injury' };
// Crash density: one cool hue from dark to light, so it never reads as a severity colour.
const DENSITY = ['interpolate', ['linear'], ['heatmap-density'],
  0, 'rgba(30, 70, 80, 0)', 0.2, 'rgba(34, 96, 108, 0.45)', 0.5, 'rgba(47, 138, 148, 0.8)', 0.8, '#6cc4c2', 1, '#e2f7f1'];
type Mode = 'crashes' | 'hotspots';
// Crash points per mode: in Hotspots they come in only when zoomed in past the density surface.
const POINT_OPACITY = {
  crashes: ['match', ['get', 's'], 'C', 0.75, 'B', 0.85, 0.95],
  hotspots: ['interpolate', ['linear'], ['zoom'], 10.5, 0, 12, ['match', ['get', 's'], 'C', 0.75, 'B', 0.85, 0.95]],
};

const ROAD_COLOR: Record<string, string> = {
  highway_minor: '#2d3431', highway_path: '#1f2422',
  highway_major_casing: '#4c5754', highway_major_inner: '#363f3c', highway_major_subtle: '#3c4643',
  highway_motorway_casing: '#74838a', highway_motorway_inner: '#4f5c61', highway_motorway_subtle: '#5a676d',
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
        if (l.type === 'symbol') paint['text-color'] = l.id.startsWith('place') ? '#c3c9bf' : '#9ba398';
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
  const [mode, setMode] = useState<Mode>('crashes');
  const [tilted, setTilted] = useState(false);
  // Corridor under the pointer in the list, and the one clicked (kept until clicked again).
  const [hoverRoad, setHoverRoad] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const [showRoads, setShowRoads] = useState(() => window.innerWidth > 700);
  const corridor = hoverRoad ?? pinned;
  const modeRef = useRef(mode);
  modeRef.current = mode;
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
        attributionControl: { compact: true }, cooperativeGestures: false, maxPitch: 80,
      });
      m.getCanvas().addEventListener('webglcontextlost', lost);
      m.on('error', () => { if (!loaded) fail(); });
      // Right-drag (or ctrl-drag) tilts and turns the map; the compass resets north and pitch.
      m.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');
      // Expand inside the portal, including browsers that block native fullscreen.
      m.addControl(new FullscreenControl({ pseudo: true }), 'top-right');
      m.on('load', () => {
        if (!live) return;
        try {
        // A night sky and a soft horizon haze, seen when the 3D view is tilted towards the horizon.
        m!.setSky({ 'sky-color': '#121a1e', 'horizon-color': '#26302f', 'fog-color': '#0e0f0e',
          'sky-horizon-blend': 0.7, 'horizon-fog-blend': 0.8, 'fog-ground-blend': 0.6, 'atmosphere-blend': 0 });
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
        // Building footprints rise in 3D from street level (OpenMapTiles render_height).
        m!.addLayer({
          id: 'building-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 14,
          paint: {
            'fill-extrusion-color': '#252b29',
            'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, ['coalesce', ['get', 'render_height'], 5]] as never,
            'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0] as never,
            'fill-extrusion-opacity': 0.85,
          },
        });
        m!.addSource('crashes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m!.addLayer({
          id: 'density', type: 'heatmap', source: 'crashes', maxzoom: 13, layout: { visibility: 'none' },
          paint: {
            'heatmap-color': DENSITY as never,
            'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 6, 4, 9, 9, 12, 18] as never,
            'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 6, 0.35, 12, 1.1] as never,
            'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.85, 13, 0] as never,
          },
        });
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
            'circle-opacity': POINT_OPACITY.crashes as never,
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
        // In Hotspots the points under the density surface are invisible: they must not answer the pointer.
        const hidden = () => modeRef.current === 'hotspots' && m!.getZoom() < 11.5;
        m!.on('click', 'crash', (e: MapLayerMouseEvent) => { if (hidden()) return; const id = e.features?.[0]?.properties?.id; if (id != null) select.current(Number(id)); });
        // Hover card: what an analyst checks before opening the record.
        const card = new Popup({ closeButton: false, closeOnClick: false, offset: 10, className: 'crash-hover' });
        m!.on('mousemove', 'crash', (e: MapLayerMouseEvent) => {
          const f = e.features?.[0];
          if (!f || hidden()) return;
          m!.getCanvas().style.cursor = 'pointer';
          const { s: sev, d } = f.properties as { s: string; d: number };
          const date = new Date(new Date(`${start.current}T12:00:00`).getTime() + d * 864e5)
            .toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
          const el = document.createElement('div');
          const head = document.createElement('b');
          head.className = `sev-${sev.toLowerCase()}`;
          head.textContent = `${sev} · ${SEV_NAME[sev]}`;
          const sub = document.createElement('span');
          sub.textContent = `${date} · click to open the record`;
          el.append(head, sub);
          card.setLngLat(e.lngLat).setDOMContent(el).addTo(m!);
        });
        m!.on('mouseleave', 'crash', () => { m!.getCanvas().style.cursor = ''; card.remove(); });
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

  const start = useRef('2020-01-01');
  // The streets with the most located crashes in the current selection, and their K+A share.
  const corridors = useMemo(() => {
    if (!points?.streets) return [];
    const crashes = new Map<number, { n: number; ka: number }>();
    points.street.forEach((st, i) => {
      if (st < 0) return;
      const c = crashes.get(st) ?? { n: 0, ka: 0 };
      c.n++;
      if (points.severity[i] === 'K' || points.severity[i] === 'A') c.ka++;
      crashes.set(st, c);
    });
    return [...crashes].sort((a, b) => b[1].n - a[1].n).slice(0, 8)
      .map(([st, c]) => ({ st, name: road(points.streets[st]), crashes: c.n, ka: c.ka / c.n }));
  }, [points]);
  useEffect(() => { setPinned(null); setHoverRoad(null); }, [points]);
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    m.setLayoutProperty('density', 'visibility', mode === 'hotspots' ? 'visible' : 'none');
    const on = ['==', ['get', 'st'], corridor ?? -2];
    // A chosen corridor keeps its crashes and fades the rest, in both views.
    m.setPaintProperty('crash', 'circle-opacity', (corridor == null ? POINT_OPACITY[mode]
      : ['case', on, mode === 'hotspots' ? 0.95 : POINT_OPACITY.crashes, 0.07]) as never);
    m.setFilter('density', corridor == null ? null : on as never);
  }, [ready, mode, corridor]);
  // Camera pad: hold a button to keep turning or tilting; a click (or Enter) moves one step.
  const spin = useRef(0);
  const orbit = (bearing: number, pitch: number) => {
    const m = map.current;
    if (!m) return;
    m.jumpTo({ bearing: m.getBearing() + bearing, pitch: Math.min(80, Math.max(0, m.getPitch() + pitch)) });
  };
  const hold = (bearing: number, pitch: number) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      const step = () => { orbit(bearing, pitch); spin.current = requestAnimationFrame(step); };
      cancelAnimationFrame(spin.current);
      step();
    },
    onPointerUp: () => cancelAnimationFrame(spin.current),
    onPointerCancel: () => cancelAnimationFrame(spin.current),
    onClick: (e: React.MouseEvent) => {
      if (e.detail) return; // pointer presses already moved the camera
      map.current?.easeTo({ bearing: map.current.getBearing() + bearing * 15, pitch: Math.min(80, Math.max(0, map.current.getPitch() + pitch * 15)), duration: 300 });
    },
  });
  useEffect(() => () => cancelAnimationFrame(spin.current), []);
  const pin = (st: number) => {
    const next = pinned === st ? null : st;
    setPinned(next);
    const m = map.current;
    if (next == null || !m || !points) return;
    const lon: number[] = [], lat: number[] = [];
    points.street.forEach((s, i) => { if (s === next) { lon.push(points.lon[i]); lat.push(points.lat[i]); } });
    m.fitBounds([[Math.min(...lon), Math.min(...lat)], [Math.max(...lon), Math.max(...lat)]],
      { padding: { top: 60, bottom: 60, left: showRoads ? 280 : 60, right: 60 }, maxZoom: 14, duration: reduced() ? 0 : 800 });
  };
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    m.easeTo({ pitch: tilted ? 55 : 0, bearing: tilted ? -17 : 0, duration: reduced() ? 0 : 900 });
  }, [ready, tilted]);

  useEffect(() => {
    if (!ready || !map.current) return;
    if (!points) {
      (map.current.getSource('crashes') as GeoJSONSource).setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    start.current = points.start;
    const features = points.id.map((id, i) => ({
      type: 'Feature' as const, properties: { id, s: points.severity[i], d: points.day[i], st: points.street?.[i] ?? -1 },
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
        {mode === 'hotspots'
          ? <li className="density-key">Crash density<span>fewer</span><i aria-hidden="true" /><span>more</span><span className="muted">· zoom in for single crashes</span></li>
          : <><li><i className="sw k" />K fatal</li><li><i className="sw a" />A suspected serious</li><li><i className="sw b" />B suspected minor</li><li><i className="sw c" />C possible</li></>}
        <li><i className="sw-route" aria-hidden="true" />Interstate, US and state highways</li>
      </ul>
      {showRoads && corridors.length > 0 && (
        <section className="corridors" aria-labelledby="corr-h">
          <h3 id="corr-h">Top corridors<span>located crashes · K+A share</span></h3>
          <ol onMouseLeave={() => setHoverRoad(null)}>
            {corridors.map((c, i) => (
              <li key={c.st}>
                <button type="button" aria-pressed={pinned === c.st} onMouseEnter={() => setHoverRoad(c.st)}
                  onFocus={() => setHoverRoad(c.st)} onBlur={() => setHoverRoad(null)} onClick={() => pin(c.st)}
                  aria-label={`${c.name}: ${int(c.crashes)} located crashes, ${pct(c.ka)} fatal or serious. ${pinned === c.st ? 'Show all crashes' : 'Show only this corridor'}.`}>
                  <span className="num rank">{i + 1}</span>
                  <span className="name">{c.name}</span>
                  <span className="num">{int(c.crashes)}</span>
                  <span className="ka"><i style={{ width: `${Math.min(c.ka / 0.3, 1) * 100}%` }} /></span>
                  <span className="num ka-v">{pct(c.ka, 0)}</span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}
      {tilted && (
        <div className="orbit" role="group" aria-label="Camera: hold to turn or tilt; drag the map to move, right-drag to orbit">
          <button type="button" aria-label="Tilt up" title="Tilt up" {...hold(0, 0.6)}><CaretUpIcon weight="bold" /></button>
          <button type="button" aria-label="Turn left" title="Turn left" {...hold(-0.8, 0)}><ArrowCounterClockwiseIcon weight="bold" /></button>
          <button type="button" aria-label="Top-down view, north up" title="Top-down view, north up" className="orbit-reset"
            onClick={() => map.current?.easeTo({ bearing: 0, pitch: 0, duration: reduced() ? 0 : 600 })}><CompassIcon weight="bold" /></button>
          <button type="button" aria-label="Turn right" title="Turn right" {...hold(0.8, 0)}><ArrowClockwiseIcon weight="bold" /></button>
          <button type="button" aria-label="Tilt down" title="Tilt down" {...hold(0, -0.6)}><CaretDownIcon weight="bold" /></button>
        </div>
      )}
      <div className="map-modes">
        <div role="group" aria-label="Map view">
          <button type="button" aria-pressed={mode === 'crashes'} onClick={() => setMode('crashes')}>Crashes</button>
          <button type="button" aria-pressed={mode === 'hotspots'} onClick={() => setMode('hotspots')}
            title="Crash density of the current selection; individual crashes appear as you zoom in">Hotspots</button>
        </div>
        <button type="button" aria-pressed={tilted} onClick={() => setTilted(!tilted)}
          title="Tilt the map to see buildings in 3D; right-drag also tilts and turns it">3D</button>
        <button type="button" aria-pressed={showRoads} onClick={() => setShowRoads(!showRoads)}>Corridors</button>
      </div>
    </div>
  );
}
