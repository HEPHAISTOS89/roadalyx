import Architecture from '../components/platform/Architecture';
import ApiConsole from '../components/platform/ApiConsole';
import { REPO } from '../components/Shell';
import { useApi } from '../lib/api';
import { dateLong, int } from '../lib/format';
import type { Meta } from '../lib/types';
import '../styles/platform.css';

function Ledger({ meta }: { meta: Meta }) {
  const d = meta.dataset;
  const match = d.declared.crashes === d.crashes;
  const rows: [string, string, string][] = [
    ['Person rows in the export', int(d.person_rows), `declared ${int(d.declared.persons)}`],
    ['Crashes, one record per Crash ID', int(d.crashes), match ? `matches the declared ${int(d.declared.crashes)}` : `declared ${int(d.declared.crashes)}`],
    ['Crashes whose person rows disagree on a crash field', int(d.conflicting_crashes), 'checked on every kept crash column'],
    ['Crashes without coordinates', int(d.missing_coordinates), 'counted, not mapped'],
    ['Crashes with an unknown speed limit (−1)', int(d.unknown_speed_limit), 'stored as missing'],
  ];
  return (
    <table className="ledger">
      <tbody>
        {rows.map(([k, v, note]) => <tr key={k}><th scope="row">{k}</th><td className="num">{v}</td><td className="muted">{note}</td></tr>)}
      </tbody>
    </table>
  );
}

export default function Platform() {
  const meta = useApi<Meta>('/api/v1/meta');
  return (
    <div className="platform">
      <header className="platform-head">
        <h1>How Roadalyx is built</h1>
        <p className="lede">A tested Python pipeline publishes one clean file to S3; a single Lambda function serves it as a REST API
          and serves this portal. Lambda, S3, IAM and CloudWatch Logs, all inside the free tier, deployed from one CloudFormation template.</p>
      </header>

      <section aria-labelledby="arch-h" className="platform-sec">
        <h2 id="arch-h">Architecture</h2>
        <Architecture />
      </section>

      <section aria-labelledby="data-h" className="platform-sec split">
        <div>
          <h2 id="data-h">From the export to the dataset</h2>
          <p className="muted">
            Processed {meta.data ? dateLong(meta.data.dataset.processed_at.slice(0, 10)) : '…'} from <span className="mono">{meta.data?.dataset.source_file ?? '…'}</span>.
            Every cleaning decision and its reason is in the <a href={`${REPO}/blob/main/notebooks/eda.ipynb`}>EDA notebook</a>.
          </p>
        </div>
        {meta.data ? <Ledger meta={meta.data} /> : meta.error ? <p className="error-box">{meta.error}</p> : <div className="ph" />}
      </section>

      <section aria-labelledby="api-h" className="platform-sec">
        <div className="sec-head">
          <h2 id="api-h">Try the API</h2>
          <a className="btn small" href="/api/docs">Full reference (OpenAPI)</a>
        </div>
        {meta.data ? <ApiConsole meta={meta.data} /> : <div className="ph" />}
      </section>

      <section aria-labelledby="sec-h" className="platform-sec split">
        <div>
          <h2 id="sec-h">Security</h2>
          <ul className="plain">
            <li>No AWS credentials anywhere in the code: the function uses its IAM role, the deploy script uses your CLI session.</li>
            <li>The role can read one S3 object and write its own logs, nothing else.</li>
            <li>The bucket is private, encrypted and refuses non-TLS access.</li>
            <li>Read-only API: GET routes only, every parameter validated, page size capped at 1,000.</li>
            <li>Strict Content-Security-Policy, HSTS, no framing; CSV cells cannot run as spreadsheet formulas.</li>
          </ul>
        </div>
        <div>
          <h2 id="lim-h">Known limits</h2>
          <ul className="plain">
            <li>Injury crashes only: the export has no property-damage-only (O) crashes.</li>
            <li>Counts, not rates: there is no traffic volume (AADT, VMT) to normalise by.</li>
            <li>2026 ends on {meta.data ? dateLong(meta.data.coverage.end) : '…'}; recent months may still grow as reports arrive.</li>
            <li>No rate limiting beyond Lambda concurrency; a paid API Gateway or CloudFront would add it.</li>
          </ul>
        </div>
      </section>
    </div>
  );
}
