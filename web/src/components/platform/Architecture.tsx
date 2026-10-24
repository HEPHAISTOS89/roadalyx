import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  BrowsersIcon, ChartLineIcon, DatabaseIcon, FileCsvIcon, GlobeSimpleIcon, LightningIcon, PaperPlaneTiltIcon,
  ShieldCheckIcon, StackIcon, TerminalWindowIcon,
} from '@phosphor-icons/react';
import { int } from '../../lib/format';
import type { Meta } from '../../lib/types';

export interface Health {
  status: string; crashes: number; processed_at: string; data_source: string; data_load_ms: number | null; instance_age_s: number;
  runtime: { platform: string; region: string | null; function: string | null; memory_mb: number | null; python: string };
}

type Flow = 'data' | 'request' | 'logs' | 'deploy';
type Id = 'csv' | 'pipeline' | 's3' | 'lambda' | 'url' | 'client' | 'cfn' | 'iam' | 'logs';
interface Spec { id: Id; icon: ReactNode; title: string; service: string; col: string; row: string; does: string; why: string; config: string[] }

// Listed in data-flow order (the reading order on narrow screens). Facts restate infra/template.yaml and scripts/deploy.sh; each node's status line comes from the live API.
const NODES: Spec[] = [
  { id: 'csv', icon: <FileCsvIcon />, title: 'CRIS export', service: 'district_crashes.csv', col: '1', row: '2',
    does: 'One row per person involved, under an 11-line header.', why: 'Stays on the laptop: it holds person-level records.',
    config: ['not committed', 'not uploaded'] },
  { id: 'pipeline', icon: <TerminalWindowIcon />, title: 'Pipeline', service: 'python -m roadalyx', col: '2', row: '2',
    does: 'One record per Crash ID, cleaned fields, counts checked against the export header.', why: 'Cleaning runs once, offline, under tests; a failed check writes nothing.',
    config: ['pandas', 'pytest', 'crashes.json.gz'] },
  { id: 's3', icon: <DatabaseIcon />, title: 'S3', service: 'private bucket', col: '3', row: '2',
    does: 'Holds the processed dataset and the code packages.', why: 'Data and code are published separately.',
    config: ['Block Public Access', 'SSE-S3', 'TLS only', 'last 2 releases kept'] },
  { id: 'lambda', icon: <LightningIcon />, title: 'Lambda', service: 'FastAPI + Mangum', col: '4', row: '2',
    does: 'Loads the dataset once per cold start, filters it in memory, serves the API and this portal.', why: 'The records filter in memory in milliseconds; no database to run.',
    config: ['python3.13', 'arm64', '1024 MB', '10 s timeout'] },
  { id: 'url', icon: <GlobeSimpleIcon />, title: 'Function URL', service: 'public HTTPS', col: '5', row: '2',
    does: 'Sends HTTPS requests straight to the function.', why: 'A read-only public API needs no API Gateway.',
    config: ['auth NONE', 'GET only', 'CSP + HSTS'] },
  { id: 'client', icon: <BrowsersIcon />, title: 'Clients', service: 'portal · curl · pandas', col: '6', row: '2',
    does: 'This portal and any script call the same endpoints.', why: 'One origin, so the portal needs no CORS.',
    config: ['/api/v1/*', '/api/docs'] },
  { id: 'iam', icon: <ShieldCheckIcon />, title: 'IAM role', service: 'Lambda execution role', col: '3 / 6', row: '1',
    does: 'Lambda hands the function short-lived credentials for this role.', why: 'No access key in the code, the repository or the bundle.',
    config: ['s3:GetObject on data/crashes.json.gz', 'logs:CreateLogStream', 'logs:PutLogEvents'] },
  { id: 'cfn', icon: <StackIcon />, title: 'CloudFormation', service: 'stack roadalyx', col: '3', row: '3',
    does: 'Creates the role, function, URL, permissions and log group.', why: 'The deployment is code; tests run before every deploy.',
    config: ['infra/template.yaml', 'scripts/deploy.sh'] },
  { id: 'logs', icon: <ChartLineIcon />, title: 'CloudWatch Logs', service: 'one line per request', col: '4 / 6', row: '3',
    does: 'Records method, path, status and duration of each request.', why: 'Queryable with CloudWatch Logs Insights to find slow or failing calls.',
    config: ['/aws/lambda/roadalyx-api', '14-day retention'] },
];
const EDGES: { from: Id; to: Id; flow: Flow }[] = [
  { from: 'csv', to: 'pipeline', flow: 'data' },
  { from: 'pipeline', to: 's3', flow: 'data' },
  { from: 's3', to: 'lambda', flow: 'data' },
  { from: 'client', to: 'url', flow: 'request' },
  { from: 'url', to: 'lambda', flow: 'request' },
  { from: 'lambda', to: 'logs', flow: 'logs' },
  { from: 'cfn', to: 'lambda', flow: 'deploy' },
  { from: 'iam', to: 'lambda', flow: 'deploy' },
];
const LEGEND: [Flow, string][] = [['data', 'Data'], ['request', 'Requests'], ['logs', 'Logs'], ['deploy', 'Grants, deploys']];

interface Box { x: number; y: number; w: number; h: number }

/** Side to side for neighbours in a row, top or bottom otherwise. */
function route(a: Box, b: Box): string {
  const ay = a.y + a.h / 2, by = b.y + b.h / 2;
  if (Math.abs(ay - by) < 4) {
    const [l, r] = a.x < b.x ? [a, b] : [b, a];
    return `M${l.x + l.w} ${ay} L${r.x} ${by}`;
  }
  const down = b.y > a.y;
  const ax = Math.min(Math.max(b.x + b.w / 2, a.x + 24), a.x + a.w - 24);
  const bx = Math.min(Math.max(ax, b.x + 24), b.x + b.w - 24);
  const sy = down ? a.y + a.h : a.y, ey = down ? b.y : b.y + b.h;
  const mid = (sy + ey) / 2;
  return `M${ax} ${sy} C ${ax} ${mid}, ${bx} ${mid}, ${bx} ${ey}`;
}

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function Architecture({ meta, health, rtt, ping }: {
  meta: Meta | null; health: Health | null; rtt: number | null; ping: () => Promise<Health | null>;
}) {
  const canvas = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const dot = useRef<SVGCircleElement>(null);
  const [boxes, setBoxes] = useState<Record<string, Box>>({});
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [sel, setSel] = useState<Id>('lambda');
  const [tracing, setTracing] = useState(false);

  // Nodes are laid out by CSS grid; the edges are drawn from their measured boxes.
  useLayoutEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const measure = () => {
      const out: Record<string, Box> = {};
      c.querySelectorAll<HTMLElement>('[data-node]').forEach((el) => {
        out[el.dataset.node!] = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
      });
      setBoxes(out);
      setSize({ w: c.offsetWidth, h: c.offsetHeight });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(c);
    document.fonts?.ready.then(measure).catch(() => {});
    return () => ro.disconnect();
  }, []);

  /** A real GET /api/health, then a dot retraces its path: client, URL, Lambda (and S3 on a cold start). */
  const trace = useCallback(async () => {
    setTracing(true);
    const h = await ping();
    const s = svg.current, d = dot.current;
    if (!h || reduced() || !s || !d) { setTracing(false); return; }
    const leg = (id: string, reverse: boolean) => ({ p: s.querySelector<SVGPathElement>(`[data-edge="${id}"]`)!, reverse });
    // client->url and url->lambda are drawn left-to-right from lambda's side, so travel them in reverse
    const out = [leg('client-url', true), leg('url-lambda', true), ...(h.instance_age_s < 5 ? [leg('s3-lambda', true)] : [])];
    const legs = [...out, ...[...out].reverse().map((l) => ({ ...l, reverse: !l.reverse }))];
    const t0 = performance.now(), LEG = 340;
    const step = (now: number) => {
      const t = (now - t0) / LEG, i = Math.floor(t);
      if (i >= legs.length) { d.style.opacity = '0'; setTracing(false); return; }
      const f = t - i, e = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
      const { p, reverse } = legs[i];
      const pt = p.getPointAtLength(p.getTotalLength() * (reverse ? 1 - e : e));
      d.setAttribute('cx', String(pt.x)); d.setAttribute('cy', String(pt.y)); d.style.opacity = '1';
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, [ping]);

  const aws = health?.runtime.platform === 'aws-lambda';
  const age = health ? (health.instance_age_s < 90 ? `${health.instance_age_s} s` : `${Math.round(health.instance_age_s / 60)} min`) : '';
  const status: Record<Id, string> = {
    iam: aws ? '2 grants' : 'local run',
    csv: meta ? `${int(meta.dataset.person_rows)} rows` : '…',
    pipeline: meta ? `${int(meta.dataset.crashes)} crashes` : '…',
    s3: meta ? `updated ${new Date(meta.dataset.processed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : '…',
    lambda: health ? (aws ? `up ${age} · ${health.runtime.memory_mb} MB` : 'local uvicorn') : '…',
    url: rtt != null ? `${Math.round(rtt)} ms from you` : '…',
    client: 'this browser',
    cfn: aws ? 'deployed' : 'local run',
    logs: aws ? '14-day retention' : 'stdout',
  };
  const node = NODES.find((n) => n.id === sel)!;

  return (
    <div className="ar">
      <div className="ar-bar">
        <ul className="ar-legend" aria-label="Legend">
          {LEGEND.map(([f, l]) => <li key={f}><i className={`ar-key ${f}`} />{l}</li>)}
        </ul>
        <button type="button" className="btn small" onClick={trace} disabled={tracing}>
          <PaperPlaneTiltIcon aria-hidden="true" />{tracing ? 'Tracing…' : 'Trace a request'}
        </button>
      </div>
      <div className="ar-canvas" ref={canvas}>
        <svg ref={svg} className="ar-edges" width={size.w} height={size.h} aria-hidden="true">
          <defs>
            {LEGEND.map(([f]) => (
              <marker key={f} id={`ar-head-${f}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 1 L9 5 L0 9 z" className={`ar-head ${f}`} />
              </marker>
            ))}
          </defs>
          {EDGES.map((e) => {
            const a = boxes[e.from], b = boxes[e.to];
            if (!a || !b) return null;
            const d = route(a, b);
            // route() draws side-by-side neighbours left to right; flag edges whose flow runs the other way
            const rev = Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) < 4 && a.x > b.x;
            const head = `url(#ar-head-${e.flow})`;
            return (
              <g key={`${e.from}-${e.to}`}>
                <path data-edge={`${e.from}-${e.to}`} d={d} className={`ar-edge ${e.flow}`}
                  markerEnd={rev ? undefined : head} markerStart={rev ? head : undefined} />
                {e.flow !== 'deploy' && <path d={d} className={`ar-flow ${e.flow}${rev ? ' rev' : ''}`} />}
              </g>
            );
          })}
          <circle ref={dot} r={5} className="ar-packet" style={{ opacity: 0 }} />
        </svg>
        <div className="ar-grid">
          {NODES.map((n) => (
            <button key={n.id} type="button" data-node={n.id} className={`ar-node${sel === n.id ? ' on' : ''}`}
              style={{ '--col': n.col, '--row': n.row } as React.CSSProperties} aria-pressed={sel === n.id} onClick={() => setSel(n.id)}>
              <span className="ar-icon" aria-hidden="true">{n.icon}</span>
              <span className="ar-text">
                <b>{n.title}</b>
                <span className="ar-service">{n.service}</span>
                <span className="ar-status"><i aria-hidden="true" />{status[n.id]}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
      <section className="ar-panel" aria-live="polite" aria-label={`${node.title} details`}>
        <span className="ar-icon" aria-hidden="true">{node.icon}</span>
        <div>
          <h3>{node.title} <span className="muted">{node.service}</span></h3>
          <p>{node.does} <span className="muted">{node.why}</span></p>
        </div>
        <ul className="chips">{node.config.map((c) => <li key={c} className="mono">{c}</li>)}</ul>
      </section>
    </div>
  );
}
