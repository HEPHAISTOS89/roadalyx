// The SVG charts of the Analysis page, drawn with d3-scale and React (no chart library):
// severity bars, contributing factors, the trend over time and the day-by-hour heat map.
// Each one is keyboard navigable and has a data table for screen readers.
import { useState, type KeyboardEvent } from 'react';
import { tickIndices } from '../../lib/chartTicks';
import { scaleBand, scaleLinear } from 'd3-scale';
import { useTip } from '../Tooltip';
import { useWidth } from '../../lib/hooks';
import { int, pct, title } from '../../lib/format';
import { SEVS, type Bucket, type FactorRow, type HeatmapRes, type SeverityRes, type Sev } from '../../lib/types';

const SEV_VAR: Record<Sev, string> = { K: 'var(--sev-k)', A: 'var(--sev-a)', B: 'var(--sev-b)', C: 'var(--sev-c)' };
// CRIS KABCO terms
const SEV_NAME: Record<Sev, string> = { K: 'Fatal', A: 'Suspected serious', B: 'Suspected minor', C: 'Possible injury' };

// A round axis maximum (e.g. 1,000 rather than 943).
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
        <span>Contributing factor</span><span>Crashes</span><span>K + A share</span>
      </div>
      {rows.length === 0 && <p className="empty-note">No coded factor in this selection.</p>}
      <ol>
        {rows.map((r) => {
          // same slug rule as lib/filters, so the factor matches the URL filter
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
  const ticks = tickIndices(buckets, by, width);
  // Roving tabindex: one bar is in the tab order, arrow keys move between bars, Enter on a year filters it.
  const [active, setActive] = useState(0);
  const focused = Math.min(active, buckets.length - 1);
  const readout = buckets[focused];
  const move = (e: KeyboardEvent<SVGGElement>, i: number) => {
    const next = e.key === 'ArrowRight' ? Math.min(i + 1, buckets.length - 1) : e.key === 'ArrowLeft' ? Math.max(i - 1, 0) : e.key === 'Home' ? 0 : e.key === 'End' ? buckets.length - 1 : null;
    if (next != null) {
      e.preventDefault();
      e.currentTarget.parentElement?.querySelector<SVGGElement>(`[data-bucket="${next}"]`)?.focus();
    } else if (by === 'year' && onPickYear && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault(); hide(); onPickYear(Number(buckets[i].key));
    } else if (e.key === 'Escape') hide();
  };
  const tickLabel = (b: Bucket) => (by === 'month' ? String(b.key).slice(0, 4) : by === 'weekday' ? b.label.slice(0, 3) : b.label);

  return (
    <div ref={ref} className="chart">
      {width > 0 && (
        <svg width={width} height={h} role="group" aria-label={`Crashes per ${by}, stacked by severity. Use left and right arrows to inspect values.`}>
          {/* gridlines and y-axis labels */}
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
            const top = [...SEVS].reverse().find((code) => b[code] > 0); // the last segment drawn gets the rounded end
            return (
              <g key={b.key} data-bucket={i} tabIndex={i === focused ? 0 : -1} style={{ '--i': i } as React.CSSProperties}
                role={by === 'year' && onPickYear ? 'button' : 'img'}
                aria-label={`${b.label}${b.complete ? '' : ', partial period'}: ${int(b.crashes)} crashes. ${SEVS.map((code) => `${code} ${int(b[code])}`).join(', ')}.${by === 'year' ? ' Activate to filter this year.' : ''}`}
                onFocus={() => setActive(i)} onKeyDown={(e) => move(e, i)}
                className={by === 'year' && onPickYear ? 'pickable' : undefined}
                onClick={(e) => { setActive(i); e.currentTarget.focus(); if (by === 'year' && onPickYear) { hide(); onPickYear(Number(b.key)); } }}
                onPointerMove={(e) => { setActive(i); show(e, <>
                <b>{b.label}{b.complete ? '' : ' (partial)'}</b>
                <span>{int(b.crashes)} crashes</span>
                {SEVS.map((s) => <span key={s}><i className={`sw ${s.toLowerCase()}`} />{s} {int(b[s])}</span>)}
                {by === 'year' && onPickYear && <span className="muted">Activate to keep only {b.label}</span>}
              </>); }} onPointerLeave={hide}>
                {/* a full-height transparent hit area, so short bars are as easy to point at as tall ones */}
                <rect x={bx - 2} y={m.t} width={bw + 4} height={h - m.b - m.t} fill="transparent" />
                <g className="bar-in">
                  {SEVS.map((s) => {
                    const hgt = y(0) - y(b[s]);
                    y0 -= hgt;
                    if (hgt <= 0) return null;
                    const r = s === top && bw > 6 ? Math.min(4, bw / 3, hgt) : 0;
                    const h2 = Math.max(hgt - (s === 'K' ? 0 : 2), 0.5);
                    // square at the baseline and between segments, rounded only at the top end
                    const d = `M${bx},${y0 + h2}V${y0 + r}${r ? `Q${bx},${y0} ${bx + r},${y0}` : ''}H${bx + bw - r}${r ? `Q${bx + bw},${y0} ${bx + bw},${y0 + r}` : ''}V${y0 + h2}Z`;
                    return <path key={s} d={d} fill={b.complete ? SEV_VAR[s] : 'none'} stroke={b.complete ? 'none' : SEV_VAR[s]} strokeWidth={1} />;
                  })}
                </g>
                {!b.complete && bw > 14 && <text x={bx + bw / 2} y={y(b.crashes) - 6} textAnchor="middle" className="tick">partial</text>}
                {ticks.has(i) && tickLabel(b) && (
                  <text x={bx + bw / 2} y={h - m.b + 16} textAnchor={by === 'month' ? 'start' : 'middle'} className="tick">{tickLabel(b)}</text>
                )}
              </g>
            );
          })}
          <line x1={m.l} x2={width - m.r} y1={y(0)} y2={y(0)} className="axis" />
        </svg>
      )}
      {readout && <p className="chart-readout"><b>{readout.label}{readout.complete ? '' : ' · partial'}</b><span>{int(readout.crashes)} crashes</span>{SEVS.map((code) => <span key={code}>{code} {int(readout[code])}</span>)}</p>}
      {/* The same numbers as a table, for screen readers and for reading exact values. */}
      <details className="chart-data">
        <summary>View time data</summary>
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Time data">
          <table className="data"><caption className="sr-only">Crashes by {by}; partial periods identified</caption>
            <thead><tr><th scope="col">Period</th><th scope="col">Crashes</th>{SEVS.map((code) => <th scope="col" key={code}>{code}</th>)}</tr></thead>
            <tbody>{buckets.map((b) => <tr key={b.key}><th scope="row">{b.label}{b.complete ? '' : ' (partial)'}</th><td>{int(b.crashes)}</td>{SEVS.map((code) => <td key={code}>{int(b[code])}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/** Day-of-week by hour grid. One hue, light to dark; empty cells stay ground-coloured. */
export function Heatmap({ data, metric }: { data: HeatmapRes; metric: 'crashes' | 'ka_crashes' }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { show, hide } = useTip();
  const grid = data[metric];
  const [active, setActive] = useState(0);
  const d = Math.floor(active / 24), hour = active % 24;
  const move = (e: KeyboardEvent<SVGRectElement>, index: number) => {
    const row = Math.floor(index / 24), col = index % 24;
    const next = e.key === 'ArrowRight' ? row * 24 + Math.min(col + 1, 23) : e.key === 'ArrowLeft' ? row * 24 + Math.max(col - 1, 0) : e.key === 'ArrowDown' ? Math.min(row + 1, 6) * 24 + col : e.key === 'ArrowUp' ? Math.max(row - 1, 0) * 24 + col : e.key === 'Home' ? row * 24 : e.key === 'End' ? row * 24 + 23 : null;
    if (next != null) {
      e.preventDefault();
      e.currentTarget.closest('svg')?.querySelector<SVGRectElement>(`[data-cell="${next}"]`)?.focus();
    } else if (e.key === 'Escape') hide();
  };
  // Cells of 24 columns; their height follows the width within 16 to 30 px.
  const max = Math.max(...grid.flat(), 1);
  const m = { l: 40, t: 4, b: 22 };
  const cw = Math.max((width - m.l) / 24, 6);
  const ch = Math.min(Math.max(cw * 0.78, 16), 30);
  const h = m.t + ch * 7 + m.b;
  // One hue light to dark, mixed in CSS from the theme's ramp so a theme switch recolours without a re-render.
  const [lo, hi] = metric === 'crashes' ? ['var(--heat-lo)', 'var(--heat-hi)'] : ['var(--heat-ka-lo)', 'var(--heat-ka-hi)'];
  // Square-root scale: a few very busy hours do not wash every other cell out.
  const shade = (v: number) => `color-mix(in oklab, ${hi} ${Math.round(8 + 92 * Math.sqrt(v / max))}%, ${lo})`;
  return (
    <div ref={ref} className="chart">
      {width > 0 && (
        <svg width={width} height={h} role="group" aria-label={`${metric === 'crashes' ? 'Crashes' : 'Fatal and serious crashes'} by day of week and hour. Use arrow keys to inspect cells.`}>
          {grid.map((row, d) => (
            <g key={d}>
              <text x={m.l - 8} y={m.t + d * ch + ch / 2} dy="0.32em" textAnchor="end" className="tick">{data.rows[d].slice(0, 3)}</text>
              {row.map((v, hr) => (
                <rect key={hr} data-cell={d * 24 + hr} role="img" tabIndex={active === d * 24 + hr ? 0 : -1}
                  aria-label={`${data.rows[d]}, ${hr}:00: ${int(data.crashes[d][hr])} crashes, ${int(data.ka_crashes[d][hr])} fatal or serious`}
                  onFocus={() => setActive(d * 24 + hr)} onClick={(e) => { setActive(d * 24 + hr); e.currentTarget.focus(); }}
                  onKeyDown={(e) => move(e, d * 24 + hr)} x={m.l + hr * cw + 1.5} y={m.t + d * ch + 1.5} width={cw - 3} height={ch - 3} rx={Math.min(4, cw / 5)}
                  className="heat-cell" style={{ fill: v ? shade(v) : lo }}
                  onPointerMove={(e) => { setActive(d * 24 + hr); show(e, <>
                    <b>{data.rows[d]}, {String(hr).padStart(2, '0')}:00–{String(hr).padStart(2, '0')}:59</b>
                    <span>{int(data.crashes[d][hr])} crashes, {int(data.ka_crashes[d][hr])} fatal or serious</span>
                  </>); }} onPointerLeave={hide} />
              ))}
            </g>
          ))}
          {[0, 3, 6, 9, 12, 15, 18, 21].map((hr) => (
            <text key={hr} x={m.l + hr * cw + cw / 2} y={h - 6} textAnchor="middle" className="tick">{String(hr).padStart(2, '0')}</text>
          ))}
        </svg>
      )}
      <p className="chart-readout"><b>{data.rows[d]} · {String(hour).padStart(2, '0')}:00</b><span>{int(data.crashes[d][hour])} crashes</span><span>{int(data.ka_crashes[d][hour])} K + A</span></p>
      <details className="chart-data">
        <summary>View day and hour data</summary>
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Day and hour data">
          <table className="data"><caption className="sr-only">{metric === 'crashes' ? 'All crashes' : 'Fatal and serious crashes'} by hour and weekday</caption>
            <thead><tr><th scope="col">Day</th>{Array.from({ length: 24 }, (_, hr) => <th scope="col" key={hr}>{String(hr).padStart(2, '0')}:00</th>)}</tr></thead>
            <tbody>{grid.map((row, day) => <tr key={day}><th scope="row">{data.rows[day]}</th>{row.map((v, hr) => <td key={hr}>{int(v)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </details>
      <div className="heat-key" aria-hidden="true">
        <span>0</span>{[0, 0.25, 0.5, 0.75, 1].map((f) => <i key={f} style={{ background: f ? shade(f * f * max) : lo }} />)}<span className="num">{int(max)}</span>
      </div>
    </div>
  );
}
