import { Link } from 'react-router-dom';
import { ArrowRightIcon } from '@phosphor-icons/react';
import Hero from '../components/world/Hero';
import { useApi } from '../lib/api';
import { county, pct, title } from '../lib/format';
import type { BreakdownRes, FactorsRes, Meta, TrendRes } from '../lib/types';
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


/** Findings are computed from the live API each time; the sentences only frame the numbers. */
function Findings() {
  const rural = useApi<BreakdownRes>('/api/v1/breakdown?by=rural');
  const hours = useApi<TrendRes>('/api/v1/trends?by=hour');
  const factors = useApi<FactorsRes>('/api/v1/factors?limit=10');
  const counties = useApi<BreakdownRes>('/api/v1/breakdown?by=county');
  const error = [rural, hours, factors, counties].find((r) => r.error)?.error;
  if (error) return <p className="error-box">The findings could not be loaded ({error}).</p>;
  if (!rural.data || !hours.data || !factors.data || !counties.data) {
    return <div className="findings" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="finding skeleton" />)}</div>;
  }

  const r = rural.data.groups.find((g) => g.value === true)!;
  const u = rural.data.groups.find((g) => g.value === false)!;
  const night = hours.data.buckets.filter((b) => (b.key as number) >= 21 || (b.key as number) <= 6);
  const day = hours.data.buckets.filter((b) => (b.key as number) > 6 && (b.key as number) < 21);
  const sum = (bs: typeof night) => bs.reduce((a, b) => ({ K: a.K + b.K, A: a.A + b.A, crashes: a.crashes + b.crashes }), { K: 0, A: 0, crashes: 0 });
  const n = sum(night), d = sum(day);
  const top = factors.data.factors[0];
  const severest = [...factors.data.factors].sort((a, b) => b.ka_share - a.ka_share)[0];
  // County shares below 100 crashes swing too much to rank.
  const ranked = counties.data.groups.filter((g) => g.crashes >= 100).sort((a, b) => ka(b) - ka(a));
  const worst = ranked[0];
  const lbk = counties.data.groups[0];
  const name = (f: string) => `“${title(f).toLowerCase()}”`;

  return (
    <div className="findings">
      <Finding figure={`${(ka(r) / ka(u)).toFixed(1)}×`} label="higher K + A share on rural roads"
        to="/explorer?severity=K,A" cta="K and A crashes on the map"
        chart={<Bars rows={[{ label: 'Urban', v: ka(u) }, { label: 'Rural', v: ka(r), hot: true }]} />}>
        Rural: {pct(r.crashes / (r.crashes + u.crashes), 0)} of crashes, {pct((r.K + r.A) / (r.K + r.A + u.K + u.A), 0)} of K and A crashes.
      </Finding>
      <Finding figure={pct(ka(n), 0)} label="K + A share at night, 21:00–06:59"
        to="/explorer?severity=K,A#when" cta="Hour-by-day grid"
        chart={<Hours values={hours.data.buckets.map((b) => ka(b))} />}>
        Night: {pct(n.crashes / (n.crashes + d.crashes), 0)} of crashes. Daytime K + A share: {pct(ka(d), 0)}.
      </Finding>
      <Finding figure={pct(severest.ka_share, 0)} label={`K + A share of crashes citing ${name(severest.factor)}`}
        to={`/explorer?factor=${encodeURIComponent(severest.factor.toLowerCase())}`} cta={`Crashes citing ${name(severest.factor)}`}
        chart={<Bars rows={[{ label: 'Most cited', v: top.ka_share }, { label: 'Most severe', v: severest.ka_share, hot: true }]} />}>
        Highest among the ten most cited factors. {title(top.factor)}, cited most ({pct(top.share, 0)} of crashes), has {pct(top.ka_share, 0)}.
      </Finding>
      {worst && (
        <Finding figure={pct(ka(worst), 0)} label={`K + A share in ${county(String(worst.value))} County, the district's highest`}
          to={`/explorer?county=${String(worst.value).toLowerCase()}`} cta={`${county(String(worst.value))} County`}
          chart={<Bars rows={[...ranked.slice(0, 3).map((g, i) => ({ label: county(String(g.value)), v: ka(g), hot: i === 0 })),
            { label: county(String(lbk.value)), v: ka(lbk) }]} />}>
          {county(String(lbk.value))} County has {pct(lbk.crashes / counties.data.total, 0)} of the crashes and a {pct(ka(lbk))} K + A share.
          Counties with fewer than 100 crashes are not ranked.
        </Finding>
      )}
    </div>
  );
}

function Finding({ figure, label, children, to, cta, chart }: { figure: string; label: string; children: React.ReactNode; to: string; cta: string; chart: React.ReactNode }) {
  return (
    <article className="finding">
      <h3><b className="num">{figure}</b> {label}</h3>
      <p className="finding-body">{children}</p>
      <div className="finding-chart" aria-hidden="true">{chart}</div>
      <Link className="finding-cta" to={to}>{cta}<ArrowRightIcon aria-hidden="true" /></Link>
    </article>
  );
}

export default function Home() {
  const meta = useApi<Meta>('/api/v1/meta');
  return (
    <>
      <Hero meta={meta.data} />
      <section className="section" aria-labelledby="find-h">
        <h2 id="find-h" className="find-title">Findings</h2>
        <Findings />
      </section>
    </>
  );
}
