import { useEffect, useMemo, useRef, useState } from 'react';
import { Map as MlMap, NavigationControl, FullscreenControl, Popup, ScaleControl, setWorkerUrl, type GeoJSONSource, type MapLayerMouseEvent, type StyleSpecification } from 'maplibre-gl';
// MapLibre 6 runs tile parsing in a module worker; let Vite bundle it so the production build ships it.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { FeatureCollection } from 'geojson';
import { ArrowClockwiseIcon, ArrowCounterClockwiseIcon, CaretDownIcon, CaretUpIcon, CarProfileIcon, CompassIcon, CubeIcon, FireIcon, ListNumbersIcon } from '@phosphor-icons/react';
import counties from '../../data/counties.json';
import CanvasMap from '../maps/CanvasMap';
import { Seg } from '../ui';
import { supportsWebGL2 } from '../../lib/map2d';
import type { Group, Points } from '../../lib/types';
import { slug } from '../../lib/filters';
import { county, int, pct, road } from '../../lib/format';
import { useTheme, type Theme } from '../../lib/theme';

const DISTRICT: [[number, number], [number, number]] = [[-103.07, 32.52], [-101.04, 34.75]];
const SEV_NAME: Record<string, string> = { K: 'Fatal', A: 'Suspected serious injury', B: 'Suspected minor injury', C: 'Possible injury' };
type Mode = 'crashes' | 'hotspots';
// Crash points per mode: in Density they come in only when zoomed in past the density surface.
const POINT_OPACITY = {
  crashes: ['match', ['get', 's'], 'C', 0.75, 'B', 0.85, 0.95],
  hotspots: ['interpolate', ['linear'], ['zoom'], 10.5, 0, 12, ['match', ['get', 's'], 'C', 0.75, 'B', 0.85, 0.95]],
};

/**
 * One basemap per theme. Dark: OpenFreeMap's dark style as a road map at night, cool greys under the warm
 * severity colours. Light: its Positron style as a paper road map, white roads with grey casings.
 * Severity colours match --sev-* in tokens.css; density is one cool hue so it never reads as a severity.
 */
const PALETTE = {
  dark: {
    style: 'dark', bg: '#101010', place: '#c9c9c9', label: '#9c9c9c', county: '#4d4d4d', building3d: '#262626', outline: '#2e2e2e',
    stroke: '#101010', ring: '#f2f2f2', routeText: '#d4d4d4', routeHalo: '#0b0b0b',
    route: ['#6d82b0', '#55678f', '#46546f'], casing: ['#0c0f17', '#0c0f17', '#0e1118'],
    sev: ['#e8284a', '#cc7d08', '#9c6cf0', '#0f9ec4'],
    density: ['rgba(30, 70, 80, 0)', 'rgba(34, 96, 108, 0.45)', 'rgba(47, 138, 148, 0.8)', '#6cc4c2', '#e2f7f1'],
    sky: { 'sky-color': '#13181b', 'horizon-color': '#262b2c', 'fog-color': '#101010' },
    roads: {
      highway_minor: '#2c2f2f', highway_path: '#1f2121',
      highway_major_casing: '#4c5254', highway_major_inner: '#363b3c', highway_major_subtle: '#3c4143',
      highway_motorway_casing: '#74808a', highway_motorway_inner: '#4f585e', highway_motorway_subtle: '#5a6369',
    } as Record<string, string>,
    areas: {
      water: '#14202a', landuse_residential: '#151616', landuse_park: '#141c17', landcover_wood: '#141a16',
      building: '#1d1f1f', 'aeroway-area': '#181a1a',
    } as Record<string, string>,
  },
  light: {
    style: 'positron', bg: '#f3f0e8', place: '#202124', label: '#6b6b6b', county: '#a5a29b', building3d: '#dcd7ce', outline: '#d3cec4',
    stroke: '#ffffff', ring: '#151515', routeText: '#262626', routeHalo: '#f7f5f1',
    route: ['#b4c2e3', '#c3cfea', '#ffffff'], casing: ['#8597c6', '#9babd2', '#b7bec9'],
    sev: ['#c41634', '#c97400', '#6c48c4', '#0a84a8'],
    density: ['rgba(30, 100, 110, 0)', 'rgba(30, 100, 110, 0.3)', 'rgba(26, 96, 106, 0.65)', '#17525b', '#0a2c31'],
    sky: { 'sky-color': '#dde4e8', 'horizon-color': '#eef0ef', 'fog-color': '#f1efea' },
    roads: {
      highway_minor: '#ffffff', highway_path: '#e9e6e0',
      highway_major_casing: '#cfc9bf', highway_major_inner: '#ffffff', highway_major_subtle: '#e2ded6',
      highway_motorway_casing: '#b3ab9e', highway_motorway_inner: '#fdfcf9', highway_motorway_subtle: '#d6d1c8',
    } as Record<string, string>,
    areas: {
      water: '#c6d4de', landuse_residential: '#eae7e1', landuse_park: '#dfe7d8', landcover_wood: '#dce4d3',
      building: '#e2ded6', 'aeroway-area': '#e8e5df',
    } as Record<string, string>,
  },
};
type Palette = (typeof PALETTE)['dark'];

/**
 * Route shields drawn once on a canvas at 2x: the Interstate's blue shield with its red crown, the white
 * US-highway shield, and the plain rectangle Texas uses for state highways. The middle stretches to fit the number.
 */
function SHIELDS() {
  const W = 48, H = 44, R = 2;
  const make = (draw: (c: CanvasRenderingContext2D) => void, stretch: [number, number][], content: [number, number, number, number]) => {
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d')!;
    draw(c);
    return { data: c.getImageData(0, 0, W, H), opts: { pixelRatio: R, stretchX: stretch, stretchY: [[16, 26]] as [number, number][], content } };
  };
  const shield = (c: CanvasRenderingContext2D) => {
    c.beginPath();
    c.moveTo(4, 7); c.quadraticCurveTo(24, 1, 44, 7);
    c.lineTo(44, 24); c.quadraticCurveTo(43, 37, 24, 42); c.quadraticCurveTo(5, 37, 4, 24);
    c.closePath();
  };
  return {
    'shield-i': make((c) => {
      shield(c); c.fillStyle = '#1d4f9c'; c.fill();
      c.save(); c.clip(); c.fillStyle = '#c8102e'; c.fillRect(0, 0, W, 14); c.restore();
      shield(c); c.lineWidth = 2.5; c.strokeStyle = '#ffffff'; c.stroke();
    }, [[20, 28]], [8, 13, 40, 36]),
    'shield-us': make((c) => {
      shield(c); c.fillStyle = '#ffffff'; c.fill(); c.lineWidth = 2.5; c.strokeStyle = '#151515'; c.stroke();
    }, [[20, 28]], [8, 9, 40, 36]),
    'shield-sh': make((c) => {
      c.beginPath(); c.roundRect(3, 7, 42, 30, 15); c.fillStyle = '#ffffff'; c.fill(); c.lineWidth = 2.5; c.strokeStyle = '#151515'; c.stroke();
    }, [[18, 30]], [9, 9, 39, 35]),
  };
}
const sevColor = (P: Palette) => ['match', ['get', 's'], 'K', P.sev[0], 'A', P.sev[1], 'B', P.sev[2], P.sev[3]];

setWorkerUrl(workerUrl);
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const styles: Partial<Record<Theme, Promise<StyleSpecification>>> = {};
/** The theme's OpenFreeMap style, quietened so the crash marks carry the colour. */
function baseStyle(theme: Theme) {
  const P = PALETTE[theme];
  return styles[theme] ??= fetch(`https://tiles.openfreemap.org/styles/${P.style}`)
    .then((r) => { if (!r.ok) throw new Error(`basemap ${r.status}`); return r.json() as Promise<StyleSpecification>; })
    .then((s) => {
      s.layers = s.layers.filter((l) => !(l.type === 'symbol' && l.layout?.['icon-image'] && !l.layout?.['text-field']));
      for (const l of s.layers) {
        if (l.type === 'symbol' && l.layout) delete l.layout['icon-image'];
        const paint = (l.paint ?? {}) as Record<string, unknown>;
        // Decorative sprite textures are unnecessary on this data-focused basemap.
        for (const key of ['fill-pattern', 'line-pattern', 'background-pattern']) delete paint[key];
        if (l.type === 'background') paint['background-color'] = P.bg;
        // Towns stay readable for orientation; street names recede.
        if (l.type === 'symbol') paint['text-color'] = l.id.startsWith('place') ? P.place : P.label;
        // A full road hierarchy with casings on major roads, streets visible once zoomed in,
        // all below the severity colours of the crashes.
        const road = P.roads[l.id];
        if (road) paint['line-color'] = road;
        // Water, parks, built-up areas and building footprints, so a town reads as on a road map.
        const area = P.areas[l.id];
        if (area) { paint['fill-color'] = area; paint['fill-opacity'] = 1; }
        if (l.id === 'building') paint['fill-outline-color'] = P.outline;
        if (l.id === 'highway_minor') paint['line-opacity'] = 1;
        l.paint = paint as never;
      }
      return s;
    })
    .catch((e) => { delete styles[theme]; throw e; });
}

interface Props {
  points: Points | null;
  selected: number | null;
  onSelect: (id: number | null) => void;
  /** Streets ranked by crashes in the selection (street filter left out), from /breakdown?by=street. */
  corridors?: Group[];
  street?: string[];
  onStreet?: (slug: string | null) => void;
  /** Crashes per county on the selection (county filter left out): hovering a county shows its line. */
  counties?: Group[];
  county?: string[];
  onCounty?: (slug: string) => void;
}
const RANK: Record<string, number> = { K: 0, A: 1, B: 2, C: 3 };

/** Crash locations on a basemap: K and A drawn last and largest, click a mark to open its record. */
export default function CrashMap({ points, selected, onSelect, corridors: ranked = [], street = [], onStreet, counties: byCounty = [], county: pickedCounties = [], onCounty }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(() => !supportsWebGL2());
  // A theme switch rebuilds the map on the other basemap; mode, tilt and selection survive in state.
  const theme = useTheme();
  const P = PALETTE[theme];
  const [mode, setMode] = useState<Mode>('crashes');
  const [tilted, setTilted] = useState(false);
  // The corridor under the pointer in the list: its crashes stay lit, the rest fade.
  const [hoverRoad, setHoverRoad] = useState<string | null>(null);
  // The ranking opens on demand, so the map is seen whole first.
  const [showRoads, setShowRoads] = useState(false);
  const corridor = hoverRoad && points?.streets ? points.streets.indexOf(hoverRoad) : null;
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const countyRef = useRef({ byCounty, onCounty });
  countyRef.current = { byCounty, onCounty };
  // What the map shows, in one line: located crashes in the selection and the K and A among them.
  const shown = useMemo(() => {
    const n = { all: 0, K: 0, A: 0 };
    for (const x of points?.severity ?? '') { n.all++; if (x === 'K' || x === 'A') n[x]++; }
    return n;
  }, [points]);
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
    baseStyle(theme).then((s) => {
      if (!live || !el.current) return;
      m = new MlMap({
        container: el.current, style: s, bounds: DISTRICT, fitBoundsOptions: { padding: 24 },
        attributionControl: { compact: true }, cooperativeGestures: false, maxPitch: 70,
        // Keep the district in frame: no zooming out to half the continent, no panning away from it.
        minZoom: 5.5, maxBounds: [[-106.5, 30.5], [-97.5, 36.8]],
      });
      m.getCanvas().addEventListener('webglcontextlost', lost);
      m.on('error', () => { if (!loaded) fail(); });
      // Right-drag (or ctrl-drag) tilts and turns the map; the compass resets north and pitch.
      m.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');
      // Expand inside the portal, including browsers that block native fullscreen.
      m.addControl(new FullscreenControl({ pseudo: true }), 'top-right');
      // Distances read in miles, as on a TxDOT plan sheet.
      m.addControl(new ScaleControl({ unit: 'imperial', maxWidth: 100 }), 'top-right');
      m.on('load', () => {
        if (!live) return;
        try {
        // A night sky and a soft horizon haze, seen when the 3D view is tilted towards the horizon.
        m!.setSky({ ...P.sky,
          'sky-horizon-blend': 0.7, 'horizon-fog-blend': 0.8, 'fog-ground-blend': 0.6, 'atmosphere-blend': 0 });
        for (const [name, img] of Object.entries(SHIELDS())) m!.addImage(name, img.data, img.opts);
        m!.addSource('counties', { type: 'geojson', data: counties as FeatureCollection });
        m!.addLayer({ id: 'county-fill', type: 'fill', source: 'counties', paint: { 'fill-color': P.ring, 'fill-opacity': 0 } });
        m!.addLayer({ id: 'county-line', type: 'line', source: 'counties', paint: { 'line-color': P.county, 'line-width': 1 } });
        m!.addLayer({ id: 'county-on', type: 'line', source: 'counties', filter: ['==', ['get', 'name'], ''],
          paint: { 'line-color': P.ring, 'line-width': 2, 'line-opacity': 0.8 } });
        // The state highway network under the crashes, so a cluster can be read as "on US 84" or "on I-27".
        // Highways drawn as on a road map: a dark casing under a lighter road, interstates widest, then US
        // and state highways, every class widening with the zoom. Colour stays reserved for the crashes.
        const width = (k: number) => ['interpolate', ['exponential', 1.5], ['zoom'],
          6, ['match', ['get', 'class'], 'motorway', 1.6 * k, 'trunk', 1.1 * k, 0.7 * k],
          10, ['match', ['get', 'class'], 'motorway', 3.4 * k, 'trunk', 2.6 * k, 1.8 * k],
          14, ['match', ['get', 'class'], 'motorway', 9 * k, 'trunk', 7 * k, 5.5 * k]];
        const highways = ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], true, false];
        m!.addLayer({
          id: 'route-casing', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', filter: highways as never,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': ['match', ['get', 'class'], 'motorway', P.casing[0], 'trunk', P.casing[1], P.casing[2]] as never,
            'line-gap-width': width(1) as never,
            'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 12, 1.4] as never,
          },
        });
        m!.addLayer({
          id: 'route-line', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', filter: highways as never,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': ['match', ['get', 'class'], 'motorway', P.route[0], 'trunk', P.route[1], P.route[2]] as never,
            'line-width': width(1) as never,
          },
        });
        // Building footprints rise in 3D from street level (OpenMapTiles render_height).
        m!.addLayer({
          id: 'building-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 14,
          paint: {
            'fill-extrusion-color': P.building3d,
            'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, ['coalesce', ['get', 'render_height'], 5]] as never,
            'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0] as never,
            'fill-extrusion-opacity': 0.85,
          },
        });
        m!.addSource('crashes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m!.addLayer({
          id: 'density', type: 'heatmap', source: 'crashes', maxzoom: 13, layout: { visibility: 'none' },
          paint: {
            'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], ...P.density.flatMap((c, i) => [[0, 0.2, 0.5, 0.8, 1][i], c])] as never,
            'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 6, 4, 9, 9, 12, 18] as never,
            'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 6, 0.35, 12, 1.1] as never,
            'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.85, 13, 0] as never,
          },
        });
        m!.addLayer({
          id: 'crash', type: 'circle', source: 'crashes',
          layout: { 'circle-sort-key': ['match', ['get', 's'], 'K', 4, 'A', 3, 'B', 2, 1] },
          paint: {
            'circle-color': sevColor(P) as never,
            // Close sizes at district scale: K and A are drawn on top, but B and C (91% of crashes) stay visible.
            // A spot with several crashes grows with their number, so a hot intersection reads as one big mark.
            'circle-radius': ['interpolate', ['linear'], ['zoom'],
              7, ['*', ['match', ['get', 's'], 'K', 2, 'A', 1.7, 'B', 1.4, 1.3], ['+', 1, ['*', 0.35, ['ln', ['get', 'n']]]]],
              10, ['*', ['match', ['get', 's'], 'K', 3.2, 'A', 2.8, 'B', 2.4, 2.2], ['+', 1, ['*', 0.45, ['ln', ['get', 'n']]]]],
              13, ['*', ['match', ['get', 's'], 'K', 7, 'A', 6, 'B', 5, 4.5], ['+', 1, ['*', 0.5, ['ln', ['get', 'n']]]]]] as never,
            'circle-opacity': POINT_OPACITY.crashes as never,
            'circle-stroke-color': P.stroke,
            'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9, 0, 12, 1] as never,
          },
        });
        // Route numbers (I 27, US 84, SH 114…) above the points, so they stay readable over a dense corridor.
        m!.addLayer({
          id: 'crash-count', type: 'symbol', source: 'crashes', minzoom: 12, filter: ['>=', ['get', 'n'], 3],
          layout: { 'text-field': ['to-string', ['get', 'n']], 'text-font': ['Noto Sans Bold'], 'text-size': 10, 'text-allow-overlap': true },
          paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.35)', 'text-halo-width': 1 },
        });
        m!.addLayer({
          id: 'route-label', type: 'symbol', source: 'openmaptiles', 'source-layer': 'transportation_name', minzoom: 6.5,
          filter: ['all', ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], true, false], ['has', 'ref']],
          layout: {
            'symbol-placement': 'line', 'symbol-spacing': 360,
            // Route shields as on a US road map: OpenMapTiles keeps the system in `network`, the number in `ref`.
            'icon-image': ['match', ['get', 'network'], 'us-interstate', 'shield-i', 'us-highway', 'shield-us', 'shield-sh'] as never,
            'icon-text-fit': 'both', 'icon-text-fit-padding': [1, 4, 1, 4], 'icon-rotation-alignment': 'viewport',
            'text-field': ['get', 'ref'] as never, 'text-font': ['Noto Sans Bold'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 7, 9, 12, 10.5] as never,
            'text-rotation-alignment': 'viewport', 'text-max-angle': 30, 'text-padding': 6,
          },
          paint: { 'text-color': ['match', ['get', 'network'], 'us-interstate', '#ffffff', '#151515'] as never },
        });
        m!.addLayer({
          id: 'crash-halo', type: 'circle', source: 'crashes', filter: ['==', ['get', 'id'], -1],
          paint: { 'circle-radius': 11, 'circle-color': 'transparent', 'circle-stroke-color': P.ring, 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0 },
        });
        m!.addLayer({
          id: 'crash-selected', type: 'circle', source: 'crashes', filter: ['==', ['get', 'id'], -1],
          paint: { 'circle-radius': 11, 'circle-color': 'transparent', 'circle-stroke-color': P.ring, 'circle-stroke-width': 2 },
        });
        // In Density the points under the density surface are invisible: they must not answer the pointer.
        const hidden = () => modeRef.current === 'hotspots' && m!.getZoom() < 11.5;
        m!.on('click', 'crash', (e: MapLayerMouseEvent) => { if (hidden()) return; const id = e.features?.[0]?.properties?.id; if (id != null) select.current(Number(id)); });
        // Hover card: what an analyst checks before opening the record.
        const card = new Popup({ closeButton: false, closeOnClick: false, offset: 10, className: 'crash-hover' });
        m!.on('mousemove', 'crash', (e: MapLayerMouseEvent) => {
          const f = e.features?.[0];
          if (!f || hidden()) return;
          m!.getCanvas().style.cursor = 'pointer';
          const { s: sev, d, st, n } = f.properties as { s: string; d: number; st: number; n: number };
          const street = st >= 0 ? pointsRef.current?.streets?.[st] : undefined;
          const date = new Date(new Date(`${start.current}T12:00:00`).getTime() + d * 864e5)
            .toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
          const el = document.createElement('div');
          const head = document.createElement('b');
          head.className = `sev-${sev.toLowerCase()}`;
          head.textContent = n > 1 ? `${n} crashes here · worst ${sev}` : `${sev} · ${SEV_NAME[sev]}`;
          const sub = document.createElement('span');
          sub.textContent = `${n > 1 ? 'latest ' : ''}${date}${street ? ` · ${road(street)}` : ''}`;
          const hint = document.createElement('small');
          hint.textContent = 'Click to open the record';
          el.append(head, sub, hint);
          card.setLngLat(e.lngLat).setDOMContent(el).addTo(m!);
        });
        m!.on('mouseleave', 'crash', () => { m!.getCanvas().style.cursor = ''; card.remove(); });
        // Counties: hover for the county's line, click (off a crash) to filter the page by it.
        const tip = new Popup({ closeButton: false, closeOnClick: false, offset: 12, className: 'crash-hover county-tip' });
        const onCrash = (e: MapLayerMouseEvent) => !hidden() && m!.queryRenderedFeatures(e.point, { layers: ['crash'] }).length > 0;
        m!.on('mousemove', 'county-fill', (e: MapLayerMouseEvent) => {
          const name = e.features?.[0]?.properties?.name as string | undefined;
          if (!name || onCrash(e)) { tip.remove(); m!.setFilter('county-on', ['==', ['get', 'name'], '']); return; }
          m!.setFilter('county-on', ['==', ['get', 'name'], name]);
          const g = countyRef.current.byCounty.find((x) => String(x.value) === name);
          const el = document.createElement('div');
          const head = document.createElement('b');
          head.textContent = `${county(name)} County`;
          const sub = document.createElement('span');
          sub.textContent = g ? `${int(g.crashes)} crashes · ${pct(g.ka_share)} K+A` : 'No crash in the selection';
          const hint = document.createElement('small');
          hint.textContent = 'Click to filter the page';
          el.append(head, sub, hint);
          tip.setLngLat(e.lngLat).setDOMContent(el).addTo(m!);
        });
        m!.on('mouseleave', 'county-fill', () => { tip.remove(); m!.setFilter('county-on', ['==', ['get', 'name'], '']); });
        m!.on('click', 'county-fill', (e: MapLayerMouseEvent) => {
          const name = e.features?.[0]?.properties?.name as string | undefined;
          if (name && !onCrash(e)) { tip.remove(); countyRef.current.onCounty?.(slug(name)); }
        });
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
      setReady(false); // the next map re-runs the data, mode and selection effects once it has loaded
    };
  }, [failed, theme]);

  const start = useRef('2020-01-01');
  const corridors = useMemo(() => ranked.map((g) => ({
    raw: String(g.value), key: slug(String(g.value)), name: road(String(g.value)), crashes: g.crashes, ka: g.ka_share ?? 0,
  })), [ranked]);
  useEffect(() => { setHoverRoad(null); }, [points]);
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    m.setLayoutProperty('density', 'visibility', mode === 'hotspots' ? 'visible' : 'none');
    // A corridor under the pointer keeps its crashes and fades the rest, in both views.
    const on = corridor != null && corridor >= 0 ? ['==', ['get', 'st'], corridor] : null;
    m.setPaintProperty('crash', 'circle-opacity', (!on ? POINT_OPACITY[mode]
      : ['case', on, mode === 'hotspots' ? 0.95 : POINT_OPACITY.crashes, 0.07]) as never);
    m.setFilter('density', on as never);
  }, [ready, mode, corridor]);
  // Camera pad: hold a button to keep turning or tilting; a click (or Enter) moves one step.
  const spin = useRef(0);
  const orbit = (bearing: number, pitch: number) => {
    const m = map.current;
    if (!m) return;
    m.jumpTo({ bearing: m.getBearing() + bearing, pitch: Math.min(70, Math.max(0, m.getPitch() + pitch)) });
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
      map.current?.easeTo({ bearing: map.current.getBearing() + bearing * 15, pitch: Math.min(70, Math.max(0, map.current.getPitch() + pitch * 15)), duration: 300 });
    },
  });
  useEffect(() => () => cancelAnimationFrame(spin.current), []);

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
    // Crashes at the same spot (to about a metre) become one mark: worst severity, latest date, their number.
    const spots = new Map<string, { id: number; s: string; d: number; st: number; n: number; lon: number; lat: number }>();
    points.id.forEach((id, i) => {
      const key = `${points.lon[i].toFixed(5)},${points.lat[i].toFixed(5)}`;
      const sev = points.severity[i], spot = spots.get(key);
      if (!spot) { spots.set(key, { id, s: sev, d: points.day[i], st: points.street?.[i] ?? -1, n: 1, lon: points.lon[i], lat: points.lat[i] }); return; }
      spot.n++;
      spot.d = Math.max(spot.d, points.day[i]);
      if (RANK[sev] < RANK[spot.s]) { spot.s = sev; spot.id = id; }
    });
    const features = [...spots.values()].map(({ lon, lat, ...properties }) => ({
      type: 'Feature' as const, properties, geometry: { type: 'Point' as const, coordinates: [lon, lat] },
    }));
    (map.current.getSource('crashes') as GeoJSONSource).setData({ type: 'FeatureCollection', features });
    // Frame the selection so a filtered set is never off screen; an empty one keeps the district view.
    if (points.lon.length) {
      const bounds: [[number, number], [number, number]] = [
        [Math.min(...points.lon), Math.min(...points.lat)], [Math.max(...points.lon), Math.max(...points.lat)]];
      // leave room for the corridors list on the left
      map.current.fitBounds(bounds, { padding: { top: 60, bottom: 40, right: 50, left: showRoads ? 290 : 40 }, maxZoom: 12, duration: reduced() ? 0 : 600 });
    }
  }, [ready, points]);

  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    m.setFilter('crash-selected', ['==', ['get', 'id'], selected ?? -1]);
    m.setFilter('crash-halo', ['==', ['get', 'id'], selected ?? -1]);
    if (selected == null || !points) return;
    const i = points.id.indexOf(selected);
    if (i >= 0) m.easeTo({ center: [points.lon[i], points.lat[i]], zoom: Math.max(m.getZoom(), 12), duration: reduced() ? 0 : 600 });
    if (reduced()) return;
    // The selected crash sends a ring outwards every 1.6 s, so it is found at a glance.
    let raf = 0;
    const t0 = performance.now();
    const pulse = (now: number) => {
      const t = ((now - t0) % 1600) / 1600;
      m.setPaintProperty('crash-halo', 'circle-radius', 11 + 16 * t);
      m.setPaintProperty('crash-halo', 'circle-stroke-opacity', 0.9 * (1 - t));
      raf = requestAnimationFrame(pulse);
    };
    raf = requestAnimationFrame(pulse);
    return () => { cancelAnimationFrame(raf); if (map.current === m) m.setPaintProperty('crash-halo', 'circle-stroke-opacity', 0); };
  }, [ready, selected, points]);

  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    m.setPaintProperty('county-line', 'line-width', ['case', ['in', ['downcase', ['get', 'name']], ['literal', pickedCounties]], 2, 1]);
  }, [ready, pickedCounties]);

  if (failed) return <CanvasMap points={points} selected={selected} onSelect={onSelect} />;

  return (
    <div className="map" ref={el} role="region" aria-label="Crash map. Click a crash mark to open its record; the records table below lists the same crashes.">
      <ul className="map-legend" aria-label="Map legend">
        <li className="map-sum" aria-live="polite"><b className="num">{int(shown.all)}</b> on the map<span className="num">· {int(shown.K)} K · {int(shown.A)} A</span></li>
        {mode === 'hotspots'
          ? <li className="density-key">Density<span>fewer</span><i aria-hidden="true">{P.density.slice(1).map((c) => <b key={c} style={{ '--c': c } as React.CSSProperties} />)}</i><span>more</span></li>
          : null}
        <li><i className="sw-route" aria-hidden="true" />Highways</li>
      </ul>
      {showRoads && corridors.length > 0 && (
        <section className="corridors" aria-labelledby="corr-h">
          <h3 id="corr-h">Top corridors<span>crashes · K+A</span></h3>
          <ol onMouseLeave={() => setHoverRoad(null)}>
            {corridors.map((c, i) => (
              <li key={c.key}>
                <button type="button" aria-pressed={street.includes(c.key)} onMouseEnter={() => setHoverRoad(c.raw)}
                  onFocus={() => setHoverRoad(c.raw)} onBlur={() => setHoverRoad(null)}
                  onClick={() => { setHoverRoad(null); onStreet?.(street.includes(c.key) ? null : c.key); }}
                  aria-label={`${c.name}: ${int(c.crashes)} crashes, ${pct(c.ka)} fatal or serious. ${street.includes(c.key) ? 'Remove the street filter' : 'Filter the whole page to this street'}.`}>
                  <span className="num rank">{i + 1}</span>
                  <span className="name">{c.name}</span>
                  <span className="num">{int(c.crashes)}</span>
                  <span className="ka"><i style={{ width: `${Math.min(c.ka / 0.3, 1) * 100}%` }} /></span>
                  <span className="num ka-v">{pct(c.ka, 0)}</span>
                </button>
              </li>
            ))}
          </ol>
          <p className="corridors-note">Click to filter the page. Counts, not rates: without AADT, busy roads rank high.</p>
        </section>
      )}
      <div className="map-modes">
        <Seg role="group" aria-label="Map view">
          <button type="button" aria-pressed={mode === 'crashes'} onClick={() => setMode('crashes')}><CarProfileIcon weight="bold" aria-hidden="true" />Crashes</button>
          <button type="button" aria-pressed={mode === 'hotspots'} onClick={() => setMode('hotspots')}
            title="Crash density of the current selection; single crashes appear as you zoom in"><FireIcon weight="bold" aria-hidden="true" />Density</button>
        </Seg>
        <button type="button" aria-pressed={tilted} onClick={() => setTilted(!tilted)}
          title="Tilt the map to see buildings in 3D; right-drag also tilts and turns it"><CubeIcon weight="bold" aria-hidden="true" />3D</button>
        <button type="button" aria-pressed={showRoads} onClick={() => setShowRoads(!showRoads)}><ListNumbersIcon weight="bold" aria-hidden="true" />Corridors</button>
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
      </div>
    </div>
  );
}
