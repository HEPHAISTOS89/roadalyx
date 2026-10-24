import { useMemo, useState } from 'react';
import { CopyIcon, PlayIcon } from '@phosphor-icons/react';
import { county, int } from '../../lib/format';
import type { Meta } from '../../lib/types';

interface Endpoint { path: string; summary: string; params?: { name: string; options: string[] }[]; filters: boolean }
const ENDPOINTS: Endpoint[] = [
  { path: '/api/v1/severity', summary: 'Crash counts by KABCO severity', filters: true },
  { path: '/api/v1/factors', summary: 'Most cited contributing factors', filters: true, params: [{ name: 'limit', options: ['5', '10', '20'] }] },
  { path: '/api/v1/trends', summary: 'Counts over time, split by severity', filters: true, params: [{ name: 'by', options: ['year', 'month', 'hour', 'weekday'] }] },
  { path: '/api/v1/heatmap', summary: 'Day of week by hour grid', filters: true },
  { path: '/api/v1/breakdown', summary: 'Counts and severity mix per attribute', filters: true,
    params: [{ name: 'by', options: ['county', 'road_class', 'rural', 'weather', 'collision', 'first_event', 'intersection', 'speed_limit'] }] },
  { path: '/api/v1/crashes', summary: 'Crash records, paginated (JSON) or all (CSV)', filters: true,
    params: [{ name: 'limit', options: ['5', '25', '100'] }, { name: 'sort', options: ['newest', 'oldest', 'severity'] }, { name: 'format', options: ['json', 'csv'] }] },
  { path: '/api/v1/points', summary: 'Located crashes as compact arrays for maps', filters: true },
  { path: '/api/v1/meta', summary: 'Provenance, coverage and valid filter values', filters: false },
  { path: '/api/health', summary: 'Liveness and where the instance runs', filters: false },
];
const MAX_LINES = 80;
const ALL_LINES = 2000; // beyond this, the CSV belongs in a download, not a <pre>

/** Build a request, see the exact URL, run it against this deployment, copy it as curl or pandas. */
export default function ApiConsole({ meta }: { meta: Meta }) {
  const [ep, setEp] = useState(ENDPOINTS[0]);
  const [params, setParams] = useState<Record<string, string>>({});
  const [cty, setCty] = useState('');
  const [sev, setSev] = useState('');
  const [from, setFrom] = useState('');
  const [out, setOut] = useState<{ status: number; ms: number; bytes: number; body: string; type: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const [copied, setCopied] = useState('');

  const url = useMemo(() => {
    const q = new URLSearchParams();
    if (ep.filters) {
      if (cty) q.set('county', cty);
      if (sev) q.set('severity', sev);
      if (from) q.set('year_from', from);
    }
    for (const p of ep.params ?? []) q.set(p.name, params[p.name] ?? p.options[0]);
    const s = q.toString();
    return `${ep.path}${s ? `?${s}` : ''}`;
  }, [ep, params, cty, sev, from]);
  const full = `${window.location.origin}${url}`;
  const csv = url.includes('format=csv');

  const run = async () => {
    setBusy(true); setAll(false);
    const t0 = performance.now();
    try {
      const r = await fetch(url);
      const text = await r.text();
      const ms = Math.round(performance.now() - t0);
      const type = r.headers.get('content-type') ?? '';
      const body = type.includes('json') ? JSON.stringify(JSON.parse(text), null, 2) : text;
      setOut({ status: r.status, ms, bytes: new Blob([text]).size, body, type });
    } catch (e) {
      setOut({ status: 0, ms: 0, bytes: 0, body: (e as Error).message, type: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const copy = async (label: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(label); setTimeout(() => setCopied(''), 1600); } catch { setCopied(''); }
  };
  const curl = `curl --compressed "${full}"`;
  const py = csv
    ? `import pandas as pd\ncrashes = pd.read_csv("${full}")`
    : `import requests\ndata = requests.get("${full}", timeout=30).json()`;
  const lines = out?.body.split('\n') ?? [];

  return (
    <div className="console">
      <div className="console-form">
        <label className="field">
          <span>Endpoint</span>
          <select value={ep.path} onChange={(e) => { setEp(ENDPOINTS.find((x) => x.path === e.target.value)!); setParams({}); setOut(null); }}>
            {ENDPOINTS.map((x) => <option key={x.path} value={x.path}>{x.path.replace('/api', '')}: {x.summary}</option>)}
          </select>
        </label>
        {ep.params?.map((p) => (
          <label key={p.name} className="field small">
            <span>{p.name}</span>
            <select value={params[p.name] ?? p.options[0]} onChange={(e) => setParams((s) => ({ ...s, [p.name]: e.target.value }))}>
              {p.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
        ))}
        {ep.filters && (
          <>
            <label className="field small">
              <span>county</span>
              <select value={cty} onChange={(e) => setCty(e.target.value)}>
                <option value="">any</option>
                {meta.filters.county.map((c) => <option key={c.value} value={c.value}>{county(c.label)}</option>)}
              </select>
            </label>
            <label className="field small">
              <span>severity</span>
              <select value={sev} onChange={(e) => setSev(e.target.value)}>
                <option value="">any</option>
                <option value="K">K</option><option value="K,A">K,A</option><option value="B,C">B,C</option>
              </select>
            </label>
            <label className="field small">
              <span>year_from</span>
              <select value={from} onChange={(e) => setFrom(e.target.value)}>
                <option value="">any</option>
                {meta.filters.year.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </label>
          </>
        )}
      </div>

      <div className="console-url">
        <code className="mono">GET {url}</code>
        <button type="button" className="btn primary small" onClick={run} disabled={busy}><PlayIcon weight="fill" aria-hidden="true" />{busy ? 'Running…' : 'Run'}</button>
      </div>
      <div className="console-snippets">
        <div>
          <pre className="mono">{curl}</pre>
          <button type="button" className="btn small" onClick={() => copy('curl', curl)}><CopyIcon aria-hidden="true" />{copied === 'curl' ? 'Copied' : 'Copy curl'}</button>
        </div>
        <div>
          <pre className="mono">{py}</pre>
          <button type="button" className="btn small" onClick={() => copy('py', py)}><CopyIcon aria-hidden="true" />{copied === 'py' ? 'Copied' : 'Copy Python'}</button>
        </div>
      </div>

      {out && (
        <div className="console-out" aria-live="polite">
          <p className="console-status">
            <b className={out.status === 200 ? 'ok' : 'bad'}>{out.status || 'Network error'}</b>
            <span className="num">{int(out.ms)} ms · {(out.bytes / 1024).toFixed(1)} KB · {out.type.split(';')[0]}</span>
          </p>
          <pre className="mono">{lines.slice(0, all ? ALL_LINES : MAX_LINES).join('\n')}</pre>
          {lines.length > MAX_LINES && (
            <button type="button" className="btn small" onClick={() => setAll((a) => !a)}>
              {all ? 'Show less' : lines.length > ALL_LINES ? `Show ${int(ALL_LINES)} of ${int(lines.length)} lines` : `Show all ${int(lines.length)} lines`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
