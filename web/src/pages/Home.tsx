import { Link } from 'react-router-dom';
import { ArrowRightIcon } from '@phosphor-icons/react';
import Hero from '../components/world/Hero';
import { useApi } from '../lib/api';
import { county, int, pct, title } from '../lib/format';
import type { BreakdownRes, FactorsRes, Meta, SeverityRes, TrendRes } from '../lib/types';
import '../styles/home.css';

const ka = (g: { K: number; A: number; crashes: number }) => (g.crashes ? (g.K + g.A) / g.crashes : 0);

/** K+A shares as two short bars; the highlighted one is the finding. */
function Bars({ rows }: { rows: { label: string; v: number; hot?: boolean }[] }) {
  const max = Math.max(...rows.map((r) => r.v), 0.01);
  return (
    <div className="mini-bars">
      {rows.map((r) => (
        <div key={r.label} className={r.hot ? 'hot' : ''}>
          <span>{r.label}</span><i style={{ width: `${(r.v / max) * 100}%` }} /><b className="num">{pct(r.v, 0)}</b>
        </div>
      ))}
    </div>
  );
}

/** K+A share for each hour of the day, night hours highlighted. */
function Hours({ values }: { values: number[] }) {
  const max = Math.max(...values, 0.01);
  return (
    <div className="mini-hours">
      {values.map((v, h) => <i key={h} className={h >= 21 || h <= 6 ? 'hot' : ''} style={{ height: `${Math.max(6, (v / max) * 100)}%` }} />)}
      <span>00</span><span>12</span><span>23</span>
    </div>
  );
}

/** One county's share of all crashes. */
function Share({ part, total }: { part: number; total: number }) {
  return <div className="mini-share"><i style={{ width: `${(part / total) * 100}%` }} /></div>;
}

/** Findings are computed from the live API each time; the sentences only frame the numbers. */
function Findings() {
  const sev = useApi<SeverityRes>('/api/v1/severity');
  const rural = useApi<BreakdownRes>('/api/v1/breakdown?by=rural');
  const hours = useApi<TrendRes>('/api/v1/trends?by=hour');
  const factors = useApi<FactorsRes>('/api/v1/factors?limit=10');
  const counties = useApi<BreakdownRes>('/api/v1/breakdown?by=county');
  const error = [sev, rural, hours, factors, counties].find((r) => r.error)?.error;
  if (error) return <p className="error-box">The findings could not be loaded ({error}).</p>;
  if (!sev.data || !rural.data || !hours.data || !factors.data || !counties.data) {
    return <div className="findings" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="finding skeleton" />)}</div>;
  }

  const r = rural.data.groups.find((g) => g.value === true)!;
  const u = rural.data.groups.find((g) => g.value === false)!;
  const night = hours.data.buckets.filter((b) => (b.key as number) >= 21 || (b.key as number) <= 6);
  const day = hours.data.buckets.filter((b) => (b.key as number) > 6 && (b.key as number) < 21);
  const sum = (bs: typeof night) => bs.reduce((a, b) => ({ K: a.K + b.K, A: a.A + b.A, crashes: a.crashes + b.crashes }), { K: 0, A: 0, crashes: 0 });
  const n = sum(night), d = sum(day);
  const top = factors.data.factors[0];
  const deadliest = [...factors.data.factors].sort((a, b) => b.ka_share - a.ka_share)[0];
  const lbk = counties.data.groups[0];
  const rest = counties.data.groups.slice(1).filter((g) => g.crashes >= 100).sort((a, b) => ka(b) - ka(a))[0];
  const k = sev.data.severity[0];

  return (
    <div className="findings">
      <Finding figure={`${(ka(r) / ka(u)).toFixed(1)}×`} label="as likely to be fatal or serious when rural"
        to="/explorer?severity=K,A" cta="Map the K and A crashes"
        chart={<Bars rows={[{ label: 'Urban', v: ka(u) }, { label: 'Rural', v: ka(r), hot: true }]} />}>
        {pct(ka(r))} of rural crashes are K or A, against {pct(ka(u))} in urban areas. Rural roads carry
        {' '}{pct(r.crashes / (r.crashes + u.crashes), 0)} of the crashes and {pct((r.K + r.A) / (r.K + r.A + u.K + u.A), 0)} of the fatal and serious ones.
      </Finding>
      <Finding figure={pct(ka(n), 0)} label="of night crashes are K or A (21:00–06:59)"
        to="/explorer?severity=K,A#when" cta="See the hour-by-day grid"
        chart={<Hours values={hours.data.buckets.map((b) => ka(b))} />}>
        Night brings {pct(n.crashes / (n.crashes + d.crashes), 0)} of the crashes but they are worse: {pct(ka(n), 0)} fatal or
        serious, against {pct(ka(d), 0)} between 07:00 and 20:59.
      </Finding>
      <Finding figure={pct(top.share, 0)} label={`of crashes cite “${title(top.factor).toLowerCase()}”`}
        to={`/explorer?factor=${encodeURIComponent(deadliest.factor.toLowerCase())}`} cta={`Explore “${title(deadliest.factor).toLowerCase()}”`}
        chart={<Bars rows={[{ label: 'Most cited', v: top.ka_share }, { label: 'Most severe', v: deadliest.ka_share, hot: true }]} />}>
        The most cited contributing factor is not the most severe. Among the ten most cited, “{title(deadliest.factor).toLowerCase()}”
        has the highest share of K and A crashes: {pct(deadliest.ka_share, 0)}, against {pct(top.ka_share, 0)}.
      </Finding>
      <Finding figure={pct(lbk.crashes / counties.data.total, 0)} label={`of crashes are in ${county(String(lbk.value))} County`}
        to={`/explorer?county=${rest ? String(rest.value).toLowerCase() : ''}`} cta={rest ? `Open ${county(String(rest.value))} County` : 'Open the Explorer'}
        chart={<Share part={lbk.crashes} total={counties.data.total} />}>
        Volume and severity point to different counties. {county(String(lbk.value))} has {pct(ka(lbk))} K or A crashes;
        {rest ? <> {county(String(rest.value))} has {pct(ka(rest))}, the highest of the counties with at least 100 crashes.</> : null}
        {' '}In all, {int(k.crashes)} crashes killed {int(sev.data.deaths)} people.
      </Finding>
    </div>
  );
}

function Finding({ figure, label, children, to, cta, chart }: { figure: string; label: string; children: React.ReactNode; to: string; cta: string; chart: React.ReactNode }) {
  return (
    <article className="finding">
      <p className="finding-fig num">{figure}</p>
      <h3>{label}</h3>
      <div className="finding-chart" aria-hidden="true">{chart}</div>
      <p className="finding-body">{children}</p>
      <Link className="finding-cta" to={to}>{cta}<ArrowRightIcon aria-hidden="true" /></Link>
    </article>
  );
}

export default function Home() {
  const meta = useApi<Meta>('/api/v1/meta');
  return (
    <>
      <Hero />
      <section className="section" aria-labelledby="find-h">
        <div className="section-head">
          <h2 id="find-h">What the district's crashes say</h2>
        </div>
        <Findings />
      </section>
      <section className="section" aria-labelledby="flow-h">
        <div className="home-flow">
          <div className="section-head">
            <h2 id="flow-h">From a CRIS export to an API anyone can query</h2>
            <p className="lede">
              A tested Python pipeline turns the export's {meta.data ? int(meta.data.dataset.person_rows) : ''} person rows into one
              record per crash and publishes it to S3. One Lambda function serves the API and this portal.
            </p>
          </div>
          <ol className="flow-steps">
            <li><b>CRIS export</b><span>one row per person</span></li>
            <li><b>Pipeline</b><span>Python, pandas, tests</span></li>
            <li><b>Amazon S3</b><span>crashes.json.gz</span></li>
            <li><b>AWS Lambda</b><span>FastAPI, function URL</span></li>
            <li><b>You</b><span>portal, curl, pandas</span></li>
          </ol>
          <div className="actions">
            <Link className="btn" to="/platform">See the architecture</Link>
            <a className="btn" href="/api/docs">Read the API reference</a>
          </div>
        </div>
      </section>
    </>
  );
}
