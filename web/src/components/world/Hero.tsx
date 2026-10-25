import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRightIcon, CornersInIcon, CornersOutIcon, PauseIcon, PlayIcon, XIcon } from '@phosphor-icons/react';
import { useApi } from '../../lib/api';
import { county, int, pct } from '../../lib/format';
import { slug } from '../../lib/filters';
import type { BreakdownRes, Points } from '../../lib/types';
import { createWorld, type World } from './district';
import '../../styles/hero.css';
import CanvasMap from '../maps/CanvasMap';
import { supportsWebGL2 } from '../../lib/map2d';

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = window.matchMedia('(pointer: coarse)').matches;

// CRIS injury severity, worst first; the swatches match the lights on the map.
const LEGEND = [['K', 'Fatal'], ['A', 'Serious'], ['B', 'Minor'], ['C', 'Possible']] as const;

/** Number of values in a sorted array that are <= x. */
function upTo(sorted: number[], x: number) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= x) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Positions of 1 January of each year along the timeline, as a fraction of its length. */
function years(start: Date, last: number) {
  const out: { year: number; at: number }[] = [];
  for (let y = start.getFullYear(); ; y++) {
    const d = (new Date(`${y}-01-01T12:00:00`).getTime() - start.getTime()) / 864e5;
    if (d > last) break;
    if (d >= 0) out.push({ year: y, at: d / last });
  }
  return out;
}

/**
 * The district at night: every located crash at its CRIS coordinates, K and A crashes as posts.
 * The timeline loops 2020 to 2026 while the camera orbits; the pause button stops both. Drag turns
 * it, the wheel zooms, a click on a county opens that county's figures and a link to the Analysis page.
 * If WebGL is unavailable, a Canvas 2D map keeps the county selection and timeline usable.
 */
export default function Hero() {
  const pts = useApi<Points>('/api/v1/points');
  const byCounty = useApi<BreakdownRes>('/api/v1/breakdown?by=county');
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const countyPanel = useRef<HTMLElement>(null);
  const world = useRef<World | null>(null);
  const [still, setStill] = useState(reduced);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setStill(media.matches);
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  const [gl] = useState(supportsWebGL2);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [day, setDay] = useState<number | null>(null);
  const [view, setView] = useState<'district' | 'lubbock' | null>('district');
  const [tip, setTip] = useState<{ name: string; x: number; y: number } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [full, setFull] = useState(false);

  const pickCounty = useCallback((name: string | null) => { setTouched(true); setPicked(name); }, []);

  const days = useMemo(() => {
    if (!pts.data) return null;
    const all: number[] = [];
    const by: Record<string, number[]> = { K: [], A: [], B: [], C: [] };
    pts.data.day.forEach((d, i) => {
      all.push(d);
      by[pts.data!.severity[i]]?.push(d);
    });
    for (const a of [all, ...Object.values(by)]) a.sort((x, y) => x - y);
    return { all, by, last: all[all.length - 1] ?? 0, start: new Date(`${pts.data.start}T12:00:00`) };
  }, [pts.data]);

  useEffect(() => {
    if (!pts.data || !gl || failed || !host.current || !labels.current) return;
    let w: World;
    let lastPush = 0;
    try {
      w = createWorld({
        host: host.current, labels: labels.current, points: pts.data, still,
        onDay: (d) => {
          const now = performance.now();
          if (now - lastPush > 60) { lastPush = now; setDay(d); }
        },
        onHover: (name, x, y) => setTip(name ? { name, x, y } : null),
        onSelect: (name) => { setTouched(true); setPicked(name); },
      });
    } catch {
      setFailed(true);
      return;
    }
    const glCanvas = host.current.querySelector('canvas');
    const lost = (e: Event) => { e.preventDefault(); setPlaying(false); setFailed(true); };
    glCanvas?.addEventListener('webglcontextlost', lost);
    world.current = w;
    if (!still) w.play();
    setPlaying(!still);
    let inView = true;
    const sync = () => w.setActive(inView && !document.hidden);
    const io = new IntersectionObserver(([e]) => { inView = e.isIntersecting; sync(); });
    if (section.current) io.observe(section.current);
    document.addEventListener('visibilitychange', sync);
    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', sync);
      glCanvas?.removeEventListener('webglcontextlost', lost);
      w.dispose();
      world.current = null;
    };
  }, [pts.data, gl, still, failed]);

  const fallback = !gl || failed;
  // The software map uses the same day cut-off as the HUD, with no camera animation.
  useEffect(() => {
    if (!fallback || !playing || !days) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) setDay((d) => (d ?? days.last) >= days.last ? 0 : Math.min(days.last, (d ?? 0) + 12));
    }, 100);
    return () => window.clearInterval(timer);
  }, [fallback, playing, days, still]);
  useEffect(() => { if (still && fallback) setPlaying(false); }, [still, fallback]);

  // Keep county figures discoverable when the controls sit below the map on mobile.
  useEffect(() => {
    world.current?.focus(picked);
    if (picked) {
      setView(null);
      countyPanel.current?.scrollIntoView({ block: 'nearest' });
      countyPanel.current?.focus({ preventScroll: true });
    }
  }, [picked]);
  useEffect(() => {
    if (!picked) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setPicked(null); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [picked]);

  const shownDay = Math.min(day ?? days?.last ?? 0, days?.last ?? 0);
  const date = days ? new Date(days.start.getTime() + shownDay * 864e5) : null;
  const toggle = () => {
    const w = world.current;
    if (fallback) {
      setTouched(true);
      if (shownDay >= (days?.last ?? 0)) setDay(0);
      setPlaying(!playing);
      return;
    }
    if (!w) return;
    setTouched(true);
    if (playing) { w.pause(); setPlaying(false); } else { w.play(); setPlaying(true); }
  };
  const scrub = (d: number) => {
    world.current?.pause();
    setPlaying(false);
    world.current?.setDay(d);
    setDay(d);
  };
  // Fullscreen on the whole view, controls included; the button is hidden where the API is missing (iPhone).
  useEffect(() => {
    const sync = () => setFull(document.fullscreenElement === section.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const canFull = typeof document !== 'undefined' && document.fullscreenEnabled;
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void section.current?.requestFullscreen().catch(() => {});
  };
  const go = (v: 'district' | 'lubbock') => { setPicked(null); setView(v); world.current?.view(v); };
  const stat = (name: string | null) => (name ? byCounty.data?.groups.find((g) => g.value === name) : undefined);
  const hover = tip ? stat(tip.name) : undefined;
  const sel = stat(picked);
  const broken = !!pts.error;

  return (
    <section ref={section} className="hero" aria-labelledby="hero-h">
      <div ref={host} className="hero-stage" data-state={broken ? 'broken' : pts.data ? 'ready' : 'loading'}
        role="region" aria-label={pts.data
          ? `Map of the 17 counties of the TxDOT Lubbock District with ${int(pts.data.located)} injury crashes drawn at their reported locations. Colours show crash severity.`
          : 'Map of the Lubbock District, loading'}
        onPointerDown={() => setTouched(true)}>
        {fallback && pts.data && <CanvasMap points={pts.data} county={picked} view={view} maxDay={shownDay}
          onCounty={pickCounty} />}
        <div ref={labels} className="hero-labels" aria-hidden="true" />
        {tip && tip.name !== picked && (
          <div className="hero-tip" style={{ transform: `translate(${tip.x + 14}px, ${tip.y + 14}px)` }} aria-hidden="true">
            <b>{county(tip.name)} County</b>
            {hover ? <span>{int(hover.crashes)} crashes · {pct(hover.ka_share)} K or A</span> : null}
          </div>
        )}
        {broken && (
          <p className="hero-fallback">
            The crash data could not be loaded. Reload the page to try again.
          </p>
        )}
        {!broken && pts.data && !touched && <p className="hero-hint" aria-hidden="true">{fallback ? 'Drag to pan · select a county' : coarse ? 'Drag to rotate · tap a county' : 'Drag to rotate · scroll to zoom · click a county'}</p>}
      </div>

      <div className="hero-copy">
        <h1 id="hero-h" className="sr-only">Injury crashes in the TxDOT Lubbock District, 2020 to 2026</h1>
        <p className="hero-context">Lubbock District · TxDOT CRIS · 2020–2026</p>
        <div className="actions">
          <Link className="btn primary" to="/analysis">Explore crashes<ArrowRightIcon aria-hidden="true" /></Link>
        </div>
      </div>

      <div className="hero-side">
        <div className="hero-views" role="group" aria-label="Camera">
          <button type="button" aria-pressed={view === 'district'} onClick={() => go('district')} disabled={broken}>District</button>
          <button type="button" aria-pressed={view === 'lubbock'} onClick={() => go('lubbock')} disabled={broken}>Lubbock</button>
        </div>
        {canFull && (
          <button type="button" className="icon-btn hero-full" onClick={toggleFull} aria-pressed={full}
            aria-label={full ? 'Exit full screen' : 'Full screen'} title={full ? 'Exit full screen' : 'Full screen'}>
            {full ? <CornersInIcon weight="bold" /> : <CornersOutIcon weight="bold" />}
          </button>
        )}
        {picked && (
          <section ref={countyPanel} tabIndex={-1} className="hero-county" aria-labelledby="county-h">
            <div className="hero-county-head">
              <h2 id="county-h">{county(picked)} County</h2>
              <button type="button" className="icon-btn small" onClick={() => setPicked(null)} aria-label="Close county figures"><XIcon /></button>
            </div>
            {sel ? (
              <>
                <p className="panel-meta">Full period · includes unmapped crashes</p>
                <dl>
                <div><dt>Crashes</dt><dd className="num">{int(sel.crashes)}</dd></div>
                <div><dt>K + A share</dt><dd className="num">{pct(sel.ka_share)}</dd></div>
                <div><dt><i className="sw k" />Fatal</dt><dd className="num">{int(sel.K)}</dd></div>
                <div><dt>Deaths</dt><dd className="num">{int(sel.deaths)}</dd></div>
                </dl>
              </>
            ) : <p className="muted">Loading…</p>}
            <Link className="finding-cta" to={`/analysis?county=${slug(picked)}`}>Open in Analysis<ArrowRightIcon aria-hidden="true" /></Link>
          </section>
        )}
      </div>

      <div className="hero-hud">
        <button type="button" className="icon-btn" onClick={toggle} disabled={broken || !days}
          aria-label={playing ? 'Pause the animation' : 'Play the animation'}>
          {playing ? <PauseIcon weight="fill" /> : <PlayIcon weight="fill" />}
        </button>
        <label className="hud-track">
          <span className="sr-only">Show crashes up to this date</span>
          {days && (
            <span className="hud-years" aria-hidden="true">
              {years(days.start, days.last).map((y) => <i key={y.year} style={{ left: `${y.at * 100}%` }}>{y.year}</i>)}
            </span>
          )}
          <input type="range" min={0} max={days?.last ?? 0} step={1} value={Math.round(shownDay)}
            onChange={(e) => scrub(Number(e.target.value))} disabled={broken || !days}
            aria-valuetext={date?.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} />
        </label>
        <div className="hud-when">
          <p className="hud-date num">{date ? date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '\u00a0'}</p>
          <p className="hud-sub" title={pts.data ? `${int(pts.data.total - pts.data.located)} crashes have no coordinates: counted in all figures, not drawn.` : undefined}>
            <span className="num">{days ? int(upTo(days.all, shownDay)) : '–'}</span> mapped through this date
          </p>
        </div>
        <dl className="hud-legend" aria-label="Cumulative mapped crashes through the displayed date by severity">
          {LEGEND.map(([code, label]) => (
            <div key={code} className={`sev-${code.toLowerCase()}`}>
              <dt><i aria-hidden="true" /><b>{code}</b> {label}</dt>
              <dd className="num">{days ? int(upTo(days.by[code], shownDay)) : '–'}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
