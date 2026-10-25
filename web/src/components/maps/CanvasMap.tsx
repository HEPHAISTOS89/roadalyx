// The 2D map drawn on a Canvas, used where WebGL is missing or the GPU context is lost. It serves both
// the Analysis map (click a crash to open it) and the district page (click a county; timeline via maxDay).
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowsOutIcon, CornersInIcon, MinusIcon, PlusIcon, ArrowCounterClockwiseIcon } from '@phosphor-icons/react';
import { county as countyLabel, int } from '../../lib/format';
import { countyAt, countyShapes, districtBounds, fitMap, lubbockBounds, nearestPoint, pointBounds, project2d, visibleIndices, type XY } from '../../lib/map2d';
import type { Points } from '../../lib/types';
import '../../styles/map-fallback.css';
import { useTheme } from '../../lib/theme';

interface Props {
  points: Points | null;
  selected?: number | null;
  onSelect?: (id: number | null) => void;
  county?: string | null;
  onCounty?: (name: string | null) => void;
  view?: 'district' | 'lubbock' | null;
  maxDay?: number;
}

/** GPU-independent fallback. Bundled county boundaries and CRIS locations, not an external tile service. */
export default function CanvasMap({ points, selected, onSelect, county, onCounty, view, maxDay }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; startX: number; startY: number; moved: boolean } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [camera, setCamera] = useState({ x: 0, y: 0, scale: 1 });
  const [full, setFull] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const theme = useTheme();
  const indices = useMemo(() => visibleIndices(points, maxDay), [points, maxDay]);
  const coordinates = useMemo(() => points?.lon.map((lon, i) => project2d(lon, points.lat[i])) ?? [], [points]);
  // What to frame: the picked county, a fixed camera view, or the crashes in the selection.
  const bounds = useMemo(() => county ? (countyShapes.find((c) => c.name === county)?.bounds ?? districtBounds)
    : view === 'lubbock' ? lubbockBounds : view === 'district' ? districtBounds : pointBounds(points), [points, county, view]);
  const fit = () => setCamera(fitMap(bounds, size.width, size.height, onCounty ? 100 : 48));
  useEffect(() => {
    if (!root.current) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(fit, [bounds, size.width, size.height, onCounty]); // A new filter set is framed, never left off-screen.
  useEffect(() => {
    if (selected == null || !points) return;
    const i = points.id.indexOf(selected);
    if (i >= 0) setCamera((c) => ({ x: coordinates[i][0], y: coordinates[i][1], scale: Math.max(c.scale, 1800) }));
  }, [selected, points, coordinates]);
  const zoom = (factor: number) => setCamera((c) => ({ ...c, scale: Math.max(25, Math.min(40000, c.scale * factor)) }));
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    // Attached by hand: React wheel listeners are passive, and the page must not scroll while zooming.
    const wheel = (e: WheelEvent) => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2); };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  useEffect(() => {
    if (!full) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setFull(false); };
    document.addEventListener('keydown', escape);
    return () => { document.body.style.overflow = previous; document.removeEventListener('keydown', escape); };
  }, [full]);

  useEffect(() => {
    const el = canvas.current;
    if (!el || !size.width || !size.height) return;
    // The whole map is redrawn on every change: county fills and outlines, then the crashes, then labels.
    const ctx = el.getContext('2d');
    if (!ctx) { setUnavailable(true); return; }
    const { width, height } = size;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    el.width = Math.round(width * ratio); el.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    // Colours from the theme tokens, read at draw time so a theme switch repaints in the other palette.
    const css = getComputedStyle(el);
    const v = (name: string) => css.getPropertyValue(name).trim();
    const colors: Record<string, string> = { K: v('--sev-k'), A: v('--sev-a'), B: v('--sev-b'), C: v('--sev-c') };
    ctx.fillStyle = v('--panel-2'); ctx.fillRect(0, 0, width, height);
    const screen = ([x, y]: XY): XY => [(x - camera.x) * camera.scale + width / 2, (y - camera.y) * camera.scale + height / 2];
    for (const c of countyShapes) {
      ctx.beginPath();
      c.ring.forEach((p, i) => { const [x, y] = screen(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.closePath(); ctx.fillStyle = county === c.name ? v('--raise') : v('--panel'); ctx.fill();
      ctx.strokeStyle = v('--ink-4'); ctx.lineWidth = 1; ctx.stroke();
    }
    for (const i of indices) {
      const [x, y] = screen(coordinates[i]);
      if (x < -8 || y < -8 || x > width + 8 || y > height + 8) continue;
      const s = points!.severity[i];
      ctx.beginPath(); ctx.arc(x, y, (s === 'K' ? 2.5 : s === 'A' ? 2 : 1.4) * Math.min(2, Math.max(1, camera.scale / 700)), 0, Math.PI * 2);
      ctx.fillStyle = colors[s]; ctx.globalAlpha = s === 'C' ? 0.75 : 1; ctx.fill();
      if (points!.id[i] === selected) {
        ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.strokeStyle = v('--ink'); ctx.lineWidth = 2; ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    if (!onCounty) {
      ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = v('--ink-3');
      for (const c of countyShapes) { const [x, y] = screen(c.center); ctx.fillText(c.name, x, y - 10); }
    }
  }, [size, camera, coordinates, points, indices, selected, county, onCounty, theme]);

  const label = `${int(indices.length)} located crashes on a 2D county map. Drag to pan, use plus or minus to zoom. Arrow keys pan; Home resets the view.`;
  return <div ref={root} className={`canvas-map${full ? ' canvas-map-full' : ''}`} role="region" aria-label="2D crash map">
    <canvas ref={canvas} tabIndex={0} role="img" aria-label={label}
      onKeyDown={(e) => {
        if (e.key === '+' || e.key === '=') zoom(1.4);
        else if (e.key === '-') zoom(1 / 1.4);
        else if (e.key === 'Home') fit();
        else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
          setCamera((c) => ({ ...c, x: c.x + (e.key === 'ArrowLeft' ? -60 : e.key === 'ArrowRight' ? 60 : 0) / c.scale,
            y: c.y + (e.key === 'ArrowUp' ? -60 : e.key === 'ArrowDown' ? 60 : 0) / c.scale }));
        } else return;
        e.preventDefault();
      }}
      // Drag pans; a press that moves less than 4 px is a click, which picks a crash or a county.
      onPointerDown={(e) => {
        if (e.button !== 0 || drag.current) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 4) d.moved = true;
        d.x = e.clientX; d.y = e.clientY;
        setCamera((c) => ({ ...c, x: c.x - dx / c.scale, y: c.y - dy / c.scale }));
      }}
      onPointerCancel={() => { drag.current = null; }}
      onPointerUp={(e) => {
        const d = drag.current; drag.current = null;
        if (!d || d.moved) return;
        const r = e.currentTarget.getBoundingClientRect();
        const target: XY = [(e.clientX - r.left - size.width / 2) / camera.scale + camera.x,
          (e.clientY - r.top - size.height / 2) / camera.scale + camera.y];
        if (onSelect && points) onSelect(nearestPoint(points, indices, target, 9 / camera.scale));
        else onCounty?.(countyAt(target));
      }} />
    {/* On the district page, each county is also a real button, for keyboard and screen-reader users. */}
    {onCounty && countyShapes.map((c) => <button key={c.name} type="button" className="canvas-county"
      aria-label={`${countyLabel(c.name)} County`} aria-pressed={county === c.name}
      style={{ left: (c.center[0] - camera.x) * camera.scale + size.width / 2, top: (c.center[1] - camera.y) * camera.scale + size.height / 2,
        visibility: Math.abs((c.center[0] - camera.x) * camera.scale) > size.width / 2 - 24 || Math.abs((c.center[1] - camera.y) * camera.scale) > size.height / 2 - 16 ? 'hidden' : 'visible' }}
      onClick={() => onCounty(county === c.name ? null : c.name)}>{countyLabel(c.name)}</button>)}
    {!onCounty && <ul className="canvas-legend" aria-label="Map legend">
      <li><i className="sw k" />K fatal</li><li><i className="sw a" />A suspected serious</li>
      <li><i className="sw b" />B suspected minor</li><li><i className="sw c" />C possible</li>
    </ul>}
    <div className="canvas-controls" role="group" aria-label="Map controls">
      <button type="button" className="icon-btn small" aria-label="Zoom in" onClick={() => zoom(1.5)}><PlusIcon /></button>
      <button type="button" className="icon-btn small" aria-label="Zoom out" onClick={() => zoom(1 / 1.5)}><MinusIcon /></button>
      <button type="button" className="icon-btn small" aria-label="Reset map view" onClick={fit}><ArrowCounterClockwiseIcon /></button>
      {!onCounty && <button type="button" className="icon-btn small" aria-label={full ? 'Exit full screen map' : 'Full screen map'} aria-pressed={full} onClick={() => setFull(!full)}>
        {full ? <CornersInIcon /> : <ArrowsOutIcon />}</button>}
    </div>
    <p className="canvas-note" role="status">{unavailable ? 'The map cannot be drawn. The charts and records remain available.'
      : points && !indices.length ? 'No located crashes in this selection.' : '2D map · county boundaries and crash locations'}</p>
    <span className="canvas-source">County boundaries: US Census Bureau</span>
  </div>;
}
