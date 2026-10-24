import { useCallback, useEffect, useState } from 'react';
import { ArrowSquareOutIcon, CircleIcon, TreeStructureIcon } from '@phosphor-icons/react';
import Architecture, { type Health } from '../components/platform/Architecture';
import ApiConsole from '../components/platform/ApiConsole';
import { REPO } from '../components/Shell';
import { useApi } from '../lib/api';
import { dateLong, int } from '../lib/format';
import type { Meta } from '../lib/types';
import '../styles/platform.css';

/** GET /api/health without cache, timed from this browser. */
async function ping(): Promise<{ health: Health | null; ms: number }> {
  const t0 = performance.now();
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    return { health: r.ok ? await r.json() : null, ms: performance.now() - t0 };
  } catch {
    return { health: null, ms: performance.now() - t0 };
  }
}

export default function Platform() {
  const meta = useApi<Meta>('/api/v1/meta');
  const [health, setHealth] = useState<Health | null>(null);
  const [down, setDown] = useState(false);
  const [rtt, setRtt] = useState<number | null>(null);

  // Three sequential pings; the median is the round trip shown (the first may include a cold start).
  useEffect(() => {
    let live = true;
    (async () => {
      const times: number[] = [];
      for (let i = 0; i < 3 && live; i++) {
        const { health: h, ms } = await ping();
        if (!live) return;
        times.push(ms);
        setHealth(h);
        setDown(!h);
      }
      if (live) setRtt(times.sort((a, b) => a - b)[1]);
    })();
    return () => { live = false; };
  }, []);

  const trace = useCallback(async () => {
    const { health: h, ms } = await ping();
    setHealth(h); setDown(!h); setRtt(ms);
    return h;
  }, []);

  const d = meta.data?.dataset;
  const aws = health?.runtime.platform === 'aws-lambda';
  return (
    <div className="platform">
      <header className="pf-head">
        <span className="pf-badge" aria-hidden="true"><TreeStructureIcon weight="duotone" /></span>
        <h1>Platform</h1>
        <p className={`pf-health ${down ? 'down' : health ? 'up' : ''}`} role="status">
          <CircleIcon weight="fill" aria-hidden="true" />
          {down ? 'API unreachable' : health ? `Healthy · ${aws ? health.runtime.region : 'local'}` : 'Checking…'}
        </p>
      </header>

      <dl className="pf-stats">
        <div><dt>Round trip</dt><dd><b className="num">{rtt != null ? int(Math.round(rtt)) : '–'}</b> ms</dd></div>
        <div><dt>Instance</dt><dd>{health ? (aws ? <><b className="num">{health.instance_age_s < 90 ? health.instance_age_s : Math.round(health.instance_age_s / 60)}</b> {health.instance_age_s < 90 ? 's' : 'min'} warm</> : <b>local</b>) : '–'}</dd></div>
        <div><dt>Cold-start load</dt><dd><b className="num">{health?.data_load_ms != null ? int(Math.round(health.data_load_ms)) : '–'}</b> ms</dd></div>
        <div><dt>Records in memory</dt><dd><b className="num">{health ? int(health.crashes) : '–'}</b></dd></div>
        <div><dt>Data processed</dt><dd><b>{d ? dateLong(d.processed_at.slice(0, 10)) : '–'}</b></dd></div>
      </dl>

      <section className="pf-sec" aria-labelledby="arch-h">
        <h2 id="arch-h">Architecture</h2>
        <Architecture meta={meta.data} health={health} rtt={rtt} ping={trace} />
      </section>

      <section className="pf-sec" aria-labelledby="val-h">
        <div className="pf-sec-head">
          <h2 id="val-h">Validation</h2>
          <a className="btn small" href={`${REPO}/blob/main/notebooks/eda.ipynb`}><ArrowSquareOutIcon aria-hidden="true" />EDA notebook</a>
        </div>
        {d ? (
          <table className="ledger">
            <thead><tr><th scope="col">Check</th><th scope="col" className="num-col">Found</th><th scope="col">Expected or handling</th></tr></thead>
            <tbody>
              <tr><th scope="row">Person rows</th><td className="num-col">{int(d.person_rows)}</td><td>{int(d.declared.persons)} declared in the export header</td></tr>
              <tr><th scope="row">Crashes, one per Crash ID</th><td className="num-col">{int(d.crashes)}</td><td>{int(d.declared.crashes)} declared</td></tr>
              <tr><th scope="row">Crashes with conflicting crash fields</th><td className="num-col">{int(d.conflicting_crashes)}</td><td>0, or nothing is written</td></tr>
              <tr><th scope="row">No coordinates</th><td className="num-col">{int(d.missing_coordinates)}</td><td>counted, not mapped</td></tr>
              <tr><th scope="row">Speed limit −1</th><td className="num-col">{int(d.unknown_speed_limit)}</td><td>stored as unknown</td></tr>
            </tbody>
          </table>
        ) : meta.error ? <p className="error-box">{meta.error}</p> : <div className="ph" />}
      </section>

      <section className="pf-sec" aria-labelledby="api-h">
        <div className="pf-sec-head">
          <h2 id="api-h">API</h2>
          <a className="btn small" href="/api/docs"><ArrowSquareOutIcon aria-hidden="true" />OpenAPI reference</a>
        </div>
        {meta.data ? <ApiConsole meta={meta.data} /> : <div className="ph" />}
      </section>

      <section className="pf-sec" aria-labelledby="lim-h">
        <h2 id="lim-h">Limits</h2>
        <ul className="pf-limits">
          <li><b>Injury crashes only.</b> No property-damage-only (O) crashes in the export.</li>
          <li><b>Counts, not rates.</b> No traffic volume (AADT, VMT) to normalise by.</li>
          <li><b>2026 is partial.</b> Data ends {meta.data ? dateLong(meta.data.coverage.end) : '…'}; late reports still arrive.</li>
          <li><b>No throttling.</b> Only the account's Lambda concurrency caps a burst of requests.</li>
        </ul>
      </section>
    </div>
  );
}
