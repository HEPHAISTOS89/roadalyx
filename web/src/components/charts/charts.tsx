import { scaleBand, scaleLinear } from 'd3-scale';
import { useTip } from '../Tooltip';
import { useWidth } from '../../lib/hooks';
import { int, pct, title } from '../../lib/format';
import { SEVS, type Bucket, type FactorRow, type HeatmapRes, type SeverityRes, type Sev } from '../../lib/types';

const SEV_VAR: Record<Sev, string> = { K: 'var(--sev-k)', A: 'var(--sev-a)', B: 'var(--sev-b)', C: 'var(--sev-c)' };
const SEV_NAME: Record<Sev, string> = { K: 'Fatal', A: 'Serious injury', B: 'Minor injury', C: 'Possible injury' };

function niceMax(v: number) {
  return scaleLinear().domain([0, Math.max(v, 1)]).nice(4).domain()[1];
}

/** KABCO counts as one horizontal bar each; the share sits beside the count, in ink, not in the bar colour. */
export function SeverityBars({ data, active, onPick }: { data: SeverityRes; active: Sev[]; onPick: (s: Sev) => void }) {
  const max = Math.max(...data.severity.map((s) => s.crashes), 1);
  return (
    <ul className="hbars" aria-label="Crashes by severity">
      {data.severity.map((s) => (
        <li key={s.code}>
          <button type="button" className={active.includes(s.code) ? 'on' : ''} aria-pressed={active.includes(s.code)}
            onClick={() => onPick(s.code)} aria-label={`${SEV_NAME[s.code]}: ${int(s.crashes)} crashes. Filter by ${s.code}.`}>
            <span className="hbar-label"><b>{s.code}</b> {SEV_NAME[s.code]}</span>
            <span className="hbar-track"><i style={{ width: `${(s.crashes / max) * 100}%`, background: SEV_VAR[s.code] }} /></span>
            <span className="hbar-val num">{int(s.crashes)}<small>{pct(s.share)}</small></span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Factors ranked by crash count. The K+A share is a second, separate scale: a dot on a 0–40 % strip. */
export function FactorBars({ rows, total, onPick, active }: { rows: FactorRow[]; total: number; onPick: (f: string) => void; active: string | null }) {
  const max = Math.max(...rows.map((r) => r.crashes), 1);
  const kaMax = Math.max(0.4, ...rows.map((r) => r.ka_share));
  const { show, hide } = useTip();
  return (
    <div className="factors">
      <div className="factors-head" aria-hidden="true">
        <span>Contributing factor</span><span>Crashes citing it</span><span>Share K + A</span>
      </div>
      {rows.length === 0 && <p className="empty-note">No coded factor in this selection.</p>}
      <ol>
        {rows.map((r) => {
          const slugged = r.factor.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
          return (
            <li key={r.factor}>
              <button type="button" className={active === slugged ? 'on' : ''} onClick={() => onPick(slugged)}
                onPointerMove={(e) => show(e, <>
                  <b>{title(r.factor)}</b>
                  <span>{int(r.crashes)} crashes, {pct(r.share)} of {int(total)}</span>
                  <span>{int(r.ka_crashes)} fatal or serious ({pct(r.ka_share)})</span>
                </>)} onPointerLeave={hide}
                aria-label={`${title(r.factor)}: ${int(r.crashes)} crashes, ${pct(r.ka_share)} fatal or serious. Filter by this factor.`}>
                <span className="f-name">{title(r.factor)}</span>
                <span className="f-bar"><i style={{ width: `${(r.crashes / max) * 100}%` }} /><em className="num">{int(r.crashes)}</em></span>
                <span className="f-ka" aria-hidden="true"><i style={{ '--p': r.ka_share / kaMax } as React.CSSProperties} /><em className="num">{pct(r.ka_share, 0)}</em></span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Stacked columns by severity over one time axis. Partial periods are drawn hollow and labelled. */
export function TrendChart({ buckets, by, onPickYear }: { buckets: Bucket[]; by: string; onPickYear?: (year: number) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { show, hide } = useTip();
  const h = 240, m = { t: 12, r: 8, b: 26, l: 44 };
  const x = scaleBand<string>().domain(buckets.map((b) => String(b.key))).range([m.l, Math.max(width - m.r, m.l + 1)]).paddingInner(buckets.length > 40 ? 0.15 : 0.28);
  const top = niceMax(Math.max(...buckets.map((b) => b.crashes)));
  const y = scaleLinear().domain([0, top]).range([h - m.b, m.t]);
  const every = Math.ceil(buckets.length / Math.max(1, Math.floor(width / 64)));
  const tickLabel = (b: Bucket) => (by === 'month' ? (String(b.key).endsWith('-01') ? String(b.key).slice(0, 4) : '') : by === 'weekday' ? b.label.slice(0, 3) : b.label);

  return (
    <div ref={ref} className="chart">
      {width > 0 && (
        <svg width={width} height={h} role="img" aria-label={`Crashes per ${by}, stacked by severity`}>
          {y.ticks(4).map((t) => (
            <g key={t}>
              <line x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} className="grid" />
              <text x={m.l - 8} y={y(t)} dy="0.32em" textAnchor="end" className="tick">{int(t)}</text>
            </g>
          ))}
          {buckets.map((b, i) => {
            let y0 = h - m.b;
            const bx = x(String(b.key))!;
            const bw = x.bandwidth();
            return (
              <g key={b.key} className={by === 'year' && onPickYear ? 'pickable' : undefined}
                onClick={by === 'year' && onPickYear ? () => { hide(); onPickYear(b.key as number); } : undefined}
                onPointerMove={(e) => show(e, <>
                <b>{b.label}{b.complete ? '' : ' (partial)'}</b>
                <span>{int(b.crashes)} crashes</span>
                {SEVS.map((s) => <span key={s}><i className={`sw ${s.toLowerCase()}`} />{s} {int(b[s])}</span>)}
                {by === 'year' && onPickYear && <span className="muted">Click to keep only {b.label}</span>}
              </>)} onPointerLeave={hide}>
                <rect x={bx - 2} y={m.t} width={bw + 4} height={h - m.b - m.t} fill="transparent" />
                {SEVS.map((s) => {
                  const hgt = y(0) - y(b[s]);
                  y0 -= hgt;
                  if (hgt <= 0) return null;
                  return <rect key={s} x={bx} y={y0} width={bw} height={Math.max(hgt - (s === 'C' ? 0 : 1), 0.5)}
                    fill={b.complete ? SEV_VAR[s] : 'none'} stroke={b.complete ? 'none' : SEV_VAR[s]} strokeWidth={1} rx={s === 'C' && bw > 6 ? 2 : 0} />;
                })}
                {!b.complete && bw > 14 && <text x={bx + bw / 2} y={y(b.crashes) - 6} textAnchor="middle" className="tick">partial</text>}
                {i % every === 0 && tickLabel(b) && (
                  <text x={bx + bw / 2} y={h - m.b + 16} textAnchor={by === 'month' ? 'start' : 'middle'} className="tick">{tickLabel(b)}</text>
                )}
              </g>
            );
          })}
          <line x1={m.l} x2={width - m.r} y1={y(0)} y2={y(0)} className="axis" />
        </svg>
      )}
    </div>
  );
}

/** Day-of-week by hour grid. One hue, light to dark; empty cells stay ground-coloured. */
export function Heatmap({ data, metric }: { data: HeatmapRes; metric: 'crashes' | 'ka_crashes' }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { show, hide } = useTip();
  const grid = data[metric];
  const max = Math.max(...grid.flat(), 1);
  const m = { l: 40, t: 4, b: 22 };
  const cw = Math.max((width - m.l) / 24, 6);
  const ch = Math.min(Math.max(cw * 0.78, 16), 30);
  const h = m.t + ch * 7 + m.b;
  const shade = scaleLinear<string>().domain([0, max]).range(metric === 'crashes' ? ['#1b1f1b', '#cfe0ca'] : ['#1d1617', '#f0566f']);
  return (
    <div ref={ref} className="chart">
      {width > 0 && (
        <svg width={width} height={h} role="img" aria-label={`${metric === 'crashes' ? 'Crashes' : 'Fatal and serious crashes'} by day of week and hour`}>
          {grid.map((row, d) => (
            <g key={d}>
              <text x={m.l - 8} y={m.t + d * ch + ch / 2} dy="0.32em" textAnchor="end" className="tick">{data.rows[d].slice(0, 3)}</text>
              {row.map((v, hr) => (
                <rect key={hr} x={m.l + hr * cw + 1} y={m.t + d * ch + 1} width={cw - 2} height={ch - 2} rx={2}
                  fill={v ? shade(v) : 'var(--ground-2)'}
                  onPointerMove={(e) => show(e, <>
                    <b>{data.rows[d]}, {String(hr).padStart(2, '0')}:00–{String(hr).padStart(2, '0')}:59</b>
                    <span>{int(data.crashes[d][hr])} crashes, {int(data.ka_crashes[d][hr])} fatal or serious</span>
                  </>)} onPointerLeave={hide} />
              ))}
            </g>
          ))}
          {[0, 3, 6, 9, 12, 15, 18, 21].map((hr) => (
            <text key={hr} x={m.l + hr * cw + cw / 2} y={h - 6} textAnchor="middle" className="tick">{String(hr).padStart(2, '0')}</text>
          ))}
        </svg>
      )}
      <div className="ramp" aria-hidden="true">
        <span>0</span><i style={{ background: `linear-gradient(90deg, ${shade(0)}, ${shade(max)})` }} /><span className="num">{int(max)}</span>
      </div>
    </div>
  );
}
