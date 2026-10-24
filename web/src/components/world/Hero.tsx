import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowCounterClockwiseIcon, PauseIcon, PlayIcon } from '@phosphor-icons/react';
import { useApi } from '../../lib/api';
import { county, int, pct } from '../../lib/format';
import type { BreakdownRes, Points } from '../../lib/types';
import { createWorld, type World } from './district';
import '../../styles/hero.css';

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const webgl = () => {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
};

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

export default function Hero() {
  const pts = useApi<Points>('/api/v1/points');
  const byCounty = useApi<BreakdownRes>('/api/v1/breakdown?by=county');
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const world = useRef<World | null>(null);
  const [still] = useState(reduced);
  const [gl] = useState(webgl);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [day, setDay] = useState<number | null>(null);
  const [view, setView] = useState<'district' | 'lubbock'>('district');
  const [tip, setTip] = useState<{ name: string; x: number; y: number } | null>(null);

  const days = useMemo(() => {
    if (!pts.data) return null;
    const all: number[] = [], K: number[] = [], A: number[] = [];
    pts.data.day.forEach((d, i) => {
      all.push(d);
      const s = pts.data!.severity[i];
      if (s === 'K') K.push(d);
      if (s === 'A') A.push(d);
    });
    for (const a of [all, K, A]) a.sort((x, y) => x - y);
    return { all, K, A, last: all[all.length - 1] ?? 0, start: new Date(`${pts.data.start}T12:00:00`) };
  }, [pts.data]);

  useEffect(() => {
    if (!pts.data || !gl || !host.current || !labels.current) return;
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
      });
    } catch {
      setFailed(true);
      return;
    }
    world.current = w;
    if (!still) { w.play(); setPlaying(true); }
    let inView = true;
    const sync = () => w.setActive(inView && !document.hidden);
    const io = new IntersectionObserver(([e]) => { inView = e.isIntersecting; sync(); });
    if (section.current) io.observe(section.current);
    document.addEventListener('visibilitychange', sync);
    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', sync);
      w.dispose();
      world.current = null;
    };
  }, [pts.data, gl, still]);

  // Keep the play button honest when playback reaches the last crash on its own.
  useEffect(() => {
    if (playing && days && day != null && day >= days.last) setPlaying(false);
  }, [day, days, playing]);

  const shownDay = day ?? days?.last ?? 0;
  const atEnd = !!days && shownDay >= days.last;
  const date = days ? new Date(days.start.getTime() + shownDay * 864e5) : null;
  const toggle = () => {
    const w = world.current;
    if (!w) return;
    if (playing) { w.pause(); setPlaying(false); } else { w.play(); setPlaying(true); }
  };
  const scrub = (d: number) => {
    world.current?.pause();
    setPlaying(false);
    world.current?.setDay(d);
    setDay(d);
  };
  const go = (v: 'district' | 'lubbock') => { setView(v); world.current?.view(v); };
  const stat = tip && byCounty.data?.groups.find((g) => g.value === tip.name);
  const broken = !gl || failed || !!pts.error;

  return (
    <section ref={section} className="hero" aria-labelledby="hero-h">
      <div ref={host} className="hero-stage" data-state={broken ? 'broken' : pts.data ? 'ready' : 'loading'}
        role="img" aria-label={pts.data
          ? `Map of the 17 counties of the TxDOT Lubbock District with ${int(pts.data.located)} injury crashes drawn at their reported locations. Fatal and serious-injury crashes stand as red and orange posts. Drag to turn the view.`
          : 'Map of the Lubbock District, loading'}>
        <div ref={labels} className="hero-labels" aria-hidden="true" />
        {tip && (
          <div className="hero-tip" style={{ transform: `translate(${tip.x + 14}px, ${tip.y + 14}px)` }} aria-hidden="true">
            <b>{county(tip.name)} County</b>
            {stat ? <span>{int(stat.crashes)} injury crashes · {pct(stat.ka_share)} fatal or serious</span> : null}
          </div>
        )}
        {broken && (
          <p className="hero-fallback">
            {pts.error ? 'The crash data could not be loaded. Reload the page to try again.'
              : 'This browser cannot draw the 3D map (WebGL 2 is off or unavailable). Every number is still in the Explorer.'}
          </p>
        )}
      </div>

      <div className="hero-copy">
        <h1 id="hero-h">Every injury crash in the Lubbock District since 2020, where it happened.</h1>
        <p className="lede">
          {pts.data ? int(pts.data.total) : 'All'} crashes from TxDOT CRIS across 17 counties of the South Plains, cleaned to
          one record per crash and served by a public API. Fatal and serious crashes rise as posts.
        </p>
        <div className="actions">
          <Link className="btn primary" to="/explorer">Open the Explorer</Link>
          <Link className="btn" to="/platform">How it is built</Link>
        </div>
      </div>

      <div className="hero-views" role="group" aria-label="Map view">
        <button type="button" aria-pressed={view === 'district'} onClick={() => go('district')} disabled={broken}>District</button>
        <button type="button" aria-pressed={view === 'lubbock'} onClick={() => go('lubbock')} disabled={broken}>Lubbock</button>
      </div>

      <div className="hero-hud">
        <button type="button" className="icon-btn" onClick={toggle} disabled={broken || !days}
          aria-label={playing ? 'Pause the timeline' : atEnd ? 'Replay from January 2020' : 'Play the timeline'}>
          {playing ? <PauseIcon weight="fill" /> : atEnd ? <ArrowCounterClockwiseIcon weight="bold" /> : <PlayIcon weight="fill" />}
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
        <p className="hud-date num">{date ? date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : ' '}</p>
        <dl className="hud-counts">
          <div title={pts.data ? `${int(pts.data.total - pts.data.located)} crashes have no coordinates in CRIS: they count everywhere except on this map.` : undefined}>
            <dt>Located crashes</dt><dd className="num">{days ? int(upTo(days.all, shownDay)) : '–'}</dd>
          </div>
          <div><dt><i className="sw k" />Fatal (K)</dt><dd className="num">{days ? int(upTo(days.K, shownDay)) : '–'}</dd></div>
          <div><dt><i className="sw a" />Serious (A)</dt><dd className="num">{days ? int(upTo(days.A, shownDay)) : '–'}</dd></div>
        </dl>
      </div>
    </section>
  );
}
