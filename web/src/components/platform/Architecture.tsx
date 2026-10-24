import { useEffect, useRef, useState } from 'react';
import { PaperPlaneTiltIcon } from '@phosphor-icons/react';
import { int } from '../../lib/format';

export interface Health {
  status: string; crashes: number; processed_at: string; data_source: string; data_load_ms: number | null; instance_age_s: number;
  runtime: { platform: string; region: string | null; function: string | null; memory_mb: number | null; python: string };
}

type NodeId = 'cris' | 'pipeline' | 's3' | 'client' | 'url' | 'lambda' | 'iam' | 'logs' | 'cfn';
interface Node { id: NodeId; x: number; y: number; title: string; sub: string; what: string; why: string; facts: string[] }

const W = 168, H = 62;
// Facts here restate infra/template.yaml and scripts/deploy.sh; live values come from /api/health.
const NODES: Node[] = [
  { id: 'cris', x: 24, y: 40, title: 'CRIS export', sub: 'district_crashes.csv',
    what: 'The TxDOT CRIS query export: one row per person involved in a crash, 94 columns, a text header above the table.',
    why: 'Kept out of git and out of AWS: it is the lab\'s file and holds person-level records.',
    facts: ['Read locally by the pipeline only'] },
  { id: 'pipeline', x: 274, y: 40, title: 'Pipeline', sub: 'python -m roadalyx',
    what: 'pandas reads the export, collapses it to one record per Crash ID, cleans each field and checks the result against the export\'s declared counts.',
    why: 'Cleaning runs once, offline, and is tested; the API never touches the raw file.',
    facts: ['Unit tests, plus a check on the real export', 'Writes one gzipped JSON file'] },
  { id: 's3', x: 790, y: 180, title: 'Amazon S3', sub: 'crashes.json.gz',
    what: 'A private bucket holding the processed dataset and the Lambda code packages.',
    why: 'Data and code ship separately: re-running the pipeline updates the data without a code release.',
    facts: ['Block Public Access on, SSE-S3 encryption', 'Bucket policy refuses non-TLS requests', 'Old code packages expire after 30 days'] },
  { id: 'client', x: 24, y: 180, title: 'Browser, analyst', sub: 'portal or scripts',
    what: 'This portal, or any HTTP client. Every page and chart calls the same public API.',
    why: 'One origin serves the portal and the API, so the browser needs no CORS and no second host.',
    facts: ['React, three.js, MapLibre', 'pandas.read_csv works on the CSV endpoint'] },
  { id: 'url', x: 274, y: 180, title: 'Function URL', sub: 'HTTPS, read-only',
    what: 'The HTTPS endpoint built into Lambda. Requests go straight to the function.',
    why: 'No API Gateway is needed for a public read-only API, so there is one service less to pay for and configure.',
    facts: ['Auth type NONE: the data is public', 'The API only defines GET routes', 'Throttled by the account\'s Lambda concurrency'] },
  { id: 'lambda', x: 532, y: 180, title: 'AWS Lambda', sub: 'FastAPI + Mangum',
    what: 'One Python function runs the FastAPI app through Mangum. It loads the dataset from S3 once per cold start and answers from memory.',
    why: 'Serverless fits a dataset this size: 24,000 records filter in milliseconds, and an idle function costs nothing.',
    facts: ['python3.13 on arm64 (Graviton)', '10 s timeout', 'Gzip responses, 5-minute browser cache'] },
  { id: 'iam', x: 532, y: 320, title: 'IAM role', sub: 'least privilege',
    what: 'The function\'s execution role. Lambda hands the function short-lived credentials for it.',
    why: 'No AWS key exists in the code or the repository; the role can do two things only.',
    facts: ['s3:GetObject on the one dataset key', 'logs:CreateLogStream, logs:PutLogEvents on its log group'] },
  { id: 'logs', x: 790, y: 320, title: 'CloudWatch Logs', sub: '14-day retention',
    what: 'One JSON line per request: method, path, status, duration.',
    why: 'Enough to answer "what is slow, what fails" with Logs Insights, at no cost at this volume.',
    facts: ['Log group /aws/lambda/roadalyx-api'] },
  { id: 'cfn', x: 274, y: 320, title: 'CloudFormation', sub: 'infra/template.yaml',
    what: 'The whole stack (role, function, URL, permissions, log group) as one template, deployed by scripts/deploy.sh.',
    why: 'Repeatable and reviewable: the deployment is code, and redeploying changes only what changed.',
    facts: ['Deploy uses the AWS CLI session, no stored keys', 'Tests run before every deploy'] },
];
const at = (id: NodeId) => NODES.find((n) => n.id === id)!;
const cx = (n: Node) => n.x + W / 2, cy = (n: Node) => n.y + H / 2;
const right = (id: NodeId) => [at(id).x + W, cy(at(id))] as const;
const left = (id: NodeId) => [at(id).x, cy(at(id))] as const;

const EDGES: { id: string; d: string; kind: 'data' | 'request' | 'ops'; label?: string; lx?: number; ly?: number }[] = [
  { id: 'e-cris', d: `M${right('cris')} L${left('pipeline')}`, kind: 'data' },
  { id: 'e-up', d: `M${right('pipeline')} C 640 ${cy(at('pipeline'))}, ${cx(at('s3'))} 90, ${cx(at('s3'))} ${at('s3').y}`, kind: 'data', label: 'upload', lx: 650, ly: 62 },
  { id: 'e-req1', d: `M${right('client')} L${left('url')}`, kind: 'request' },
  { id: 'e-req2', d: `M${right('url')} L${left('lambda')}`, kind: 'request' },
  { id: 'e-read', d: `M${right('lambda')} L${left('s3')}`, kind: 'request', label: 'read at cold start', lx: 745, ly: 202 },
  { id: 'e-logs', d: `M${cx(at('lambda')) + 50} ${at('lambda').y + H} C ${cx(at('lambda')) + 50} 300, ${at('logs').x - 60} ${cy(at('logs'))}, ${left('logs')}`, kind: 'ops', label: 'logs', lx: 740, ly: 300 },
  { id: 'e-role', d: `M${cx(at('iam'))} ${at('iam').y} L${cx(at('lambda'))} ${at('lambda').y + H}`, kind: 'ops' },
  { id: 'e-cfn', d: `M${right('cfn')} L${left('iam')}`, kind: 'ops', label: 'creates', lx: 487, ly: 342 },
];

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Moves the packet along the request path (and to S3 on a cold start), then back. */
function animatePacket(svg: SVGSVGElement, dot: SVGCircleElement, cold: boolean, done: () => void) {
  const ids = ['e-req1', 'e-req2', ...(cold ? ['e-read'] : [])];
  const paths = ids.map((id) => svg.querySelector<SVGPathElement>(`#${id}`)!);
  const legs = [...paths.map((p) => ({ p, back: false })), ...[...paths].reverse().map((p) => ({ p, back: true }))];
  const LEG_MS = 420;
  const start = performance.now();
  let raf = 0;
  const step = (now: number) => {
    const t = (now - start) / LEG_MS;
    const i = Math.floor(t);
    if (i >= legs.length) { dot.style.opacity = '0'; done(); return; }
    const { p, back } = legs[i];
    const f = t - i;
    const e = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
    const pt = p.getPointAtLength(p.getTotalLength() * (back ? 1 - e : e));
    dot.setAttribute('cx', String(pt.x));
    dot.setAttribute('cy', String(pt.y));
    dot.style.opacity = '1';
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}

export default function Architecture() {
  const [sel, setSel] = useState<NodeId>('lambda');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ms: number; status: number; health: Health | null; error?: string } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const dot = useRef<SVGCircleElement>(null);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const send = async () => {
    setBusy(true);
    const t0 = performance.now();
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      const health = r.ok ? (await r.json() as Health) : null;
      const ms = Math.round(performance.now() - t0);
      const cold = !!health && health.instance_age_s < 5;
      const finish = () => { setResult({ ms, status: r.status, health }); setBusy(false); };
      if (reduced() || !svg.current || !dot.current) finish();
      else stop.current = animatePacket(svg.current, dot.current, cold, finish);
    } catch (e) {
      setResult({ ms: 0, status: 0, health: null, error: (e as Error).message });
      setBusy(false);
    }
  };

  const node = at(sel);
  const h = result?.health;
  return (
    <div className="arch">
      <div className="arch-figure">
        <svg ref={svg} viewBox="0 0 982 402" role="group" aria-label="Architecture: select a component to read what it does and why it was chosen">
          <text x="24" y="24" className="lane">Publish the data</text>
          <text x="24" y="164" className="lane">Serve requests</text>
          <text x="24" y="304" className="lane">Operate</text>
          {EDGES.map((e) => (
            <g key={e.id}>
              <path id={e.id} d={e.d} className={`edge ${e.kind}`} />
              {e.label && <text x={e.lx} y={e.ly} className="edge-label" textAnchor="middle">{e.label}</text>}
            </g>
          ))}
          {NODES.map((n) => (
            <g key={n.id} className={`node${sel === n.id ? ' on' : ''}${n.id === 'lambda' || n.id === 'url' ? ' aws-run' : ''}`}
              transform={`translate(${n.x} ${n.y})`} role="button" tabIndex={0} aria-pressed={sel === n.id}
              aria-label={`${n.title}: ${n.sub}`} onClick={() => setSel(n.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSel(n.id); } }}>
              <rect width={W} height={H} rx={10} />
              <text x={14} y={26} className="node-title">{n.title}</text>
              <text x={14} y={45} className="node-sub">{n.sub}</text>
            </g>
          ))}
          <circle ref={dot} r={6} className="packet" style={{ opacity: 0 }} />
        </svg>
        <div className="arch-run">
          <button type="button" className="btn primary" onClick={send} disabled={busy}>
            <PaperPlaneTiltIcon aria-hidden="true" />{busy ? 'Sending…' : 'Send a request'}
          </button>
          <p role="status" className="arch-result">
            {result?.error ? <>Request failed: {result.error}</>
              : result && h ? <>
                <b className="num">{result.status} in {int(result.ms)} ms</b>
                {h.runtime.platform === 'aws-lambda'
                  ? <> · {h.instance_age_s < 5 ? `cold start, dataset loaded from S3 in ${int(h.data_load_ms)} ms` : `warm instance, up ${Math.round(h.instance_age_s / 60)} min`} · {h.runtime.function} in {h.runtime.region}, {h.runtime.memory_mb} MB, {h.runtime.python.replace('AWS_Lambda_', '')}</>
                  : <> · running locally ({h.runtime.python}), dataset from a {h.data_source}</>}
              </>
                : result ? <>The API answered {result.status}.</>
                  : 'GET /api/health from this browser, timed, with what the function reports about itself.'}
          </p>
        </div>
      </div>
      <aside className="arch-detail" aria-live="polite">
        <h3>{node.title}</h3>
        <p>{node.what}</p>
        <p className="why"><b>Why:</b> {node.why}</p>
        <ul>{node.facts.map((f) => <li key={f}>{f}</li>)}</ul>
        {node.id === 'lambda' && h?.runtime.platform === 'aws-lambda' && (
          <p className="live">Live: {h.runtime.memory_mb} MB, {h.runtime.region}, {int(h.crashes)} crashes in memory</p>
        )}
      </aside>
    </div>
  );
}
