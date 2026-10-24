import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import FilterBar from '../components/explorer/FilterBar';
import CrashMap from '../components/explorer/CrashMap';
import { Breakdown, CrashCard, Records } from '../components/explorer/Tables';
import { FactorBars, Heatmap, SeverityBars, TrendChart } from '../components/charts/charts';
import { TooltipLayer } from '../components/Tooltip';
import { useApi } from '../lib/api';
import { api, useFilters } from '../lib/filters';
import { county, int, pct, title } from '../lib/format';
import type { FactorsRes, HeatmapRes, Meta, Points, SeverityRes, TrendRes } from '../lib/types';
import '../styles/explorer.css';

const AXES = [
  { by: 'year', label: 'Year' }, { by: 'month', label: 'Month' },
  { by: 'hour', label: 'Hour of day' }, { by: 'weekday', label: 'Day of week' },
] as const;

/** One sentence stating the selection every number on the page is computed on. */
function Scope({ meta, total, located }: { meta: Meta; total: number | null; located: number | null }) {
  const { filters: f } = useFilters();
  const label = (list: { value: string; label: string }[], v: string) => list.find((c) => c.value === v)?.label ?? v;
  const parts = [
    f.county.length ? f.county.map((c) => county(label(meta.filters.county, c))).join(', ') + (f.county.length > 1 ? ' counties' : ' County') : 'all 17 counties',
    ((from, to) => (from === to ? String(from) : `${from}–${to}`))(f.yearFrom ?? meta.filters.year[0], f.yearTo ?? meta.filters.year.at(-1)),
    f.severity.length ? `severity ${f.severity.join(', ')}` : null,
    f.roadClass.length ? f.roadClass.map((r) => title(label(meta.filters.road_class, r))).join(', ') : null,
    f.factor ? `citing “${title(label(meta.filters.factor, f.factor)).toLowerCase()}”` : null,
    f.vru.length ? `involving a ${f.vru.join(' or ')}` : null,
  ].filter(Boolean);
  return (
    <p className="scope" aria-live="polite">
      <b className="num">{total == null ? '…' : int(total)}</b> injury crashes · {parts.join(' · ')}
      {located != null && total != null && total > located ? <span className="muted"> · {int(total - located)} have no coordinates (not mapped)</span> : null}
      {total === 0 && <span className="scope-empty"> · No crashes match.</span>}
    </p>
  );
}

export default function Explorer() {
  const { filters, set, query } = useFilters();
  const [params, setParams] = useSearchParams();
  const [axis, setAxis] = useState<(typeof AXES)[number]['by']>('year');
  const [metric, setMetric] = useState<'crashes' | 'ka_crashes'>('crashes');
  const meta = useApi<Meta>('/api/v1/meta');
  const sev = useApi<SeverityRes>(api('/severity', query));
  const pts = useApi<Points>(api('/points', query));
  const factors = useApi<FactorsRes>(api('/factors', query, 'limit=10'));
  const trend = useApi<TrendRes>(api('/trends', query, `by=${axis}`));
  const heat = useApi<HeatmapRes>(api('/heatmap', query));

  const selected = params.get('crash') ? Number(params.get('crash')) : null;
  const select = useCallback((id: number | null) => setParams((p) => {
    const q = new URLSearchParams(p);
    if (id == null) q.delete('crash'); else q.set('crash', String(id));
    return q;
  }, { replace: true }), [setParams]);

  if (meta.error) return <section className="page"><p className="error-box">The API could not be reached ({meta.error}). Reload to try again.</p></section>;
  if (!meta.data) return <div className="page-loading" role="status">Loading the dataset…</div>;

  const s = sev.data;
  const k = s?.severity.find((r) => r.code === 'K');
  const a = s?.severity.find((r) => r.code === 'A');

  return (
    <TooltipLayer>
      <div className="explorer">
        <div className="explorer-top">
          <h1 className="sr-only">Crash explorer</h1>
          <FilterBar meta={meta.data} filters={filters} set={set} />
          <Scope meta={meta.data} total={s?.total ?? null} located={pts.data?.located ?? null} />
          <p className="selection-status" role="status">{sev.loading || pts.loading ? 'Updating selection…' : ''}</p>
          {(sev.error || pts.error) && <p className="error-box">{sev.error || pts.error}</p>}
        </div>

        <dl className="kpis" aria-label="Key figures" aria-busy={sev.loading}>
          <div><dt>Injury crashes</dt><dd><b className="num">{int(s?.total)}</b></dd></div>
          <div><dt><i className="sw k" />Fatal (K)</dt><dd><b className="num">{int(k?.crashes)}</b><small>{int(s?.deaths)} people killed</small></dd></div>
          <div><dt><i className="sw a" />Suspected serious (A)</dt><dd><b className="num">{int(a?.crashes)}</b><small>{int(s?.serious_injuries)} people seriously injured</small></dd></div>
          <div><dt>K + A share</dt><dd><b className="num">{pct(s?.ka_share)}</b></dd></div>
        </dl>

        <div className="grid-main">
          <section className="panel map-panel" aria-labelledby="map-h">
            <div className="panel-head"><h2 id="map-h">Map</h2></div>
            <div className="map-wrap" aria-busy={pts.loading}>
              {pts.loading && <p className="map-loading" role="status">Updating map…</p>}
              <CrashMap points={pts.data} selected={selected} onSelect={select} />
            </div>
          </section>
          <div className="side">
            <section className="panel" aria-labelledby="sev-h">
              <div className="panel-head"><h2 id="sev-h">Severity</h2></div>
              {s ? <SeverityBars data={s} active={filters.severity} onPick={(code) => set({ severity: filters.severity.includes(code) ? filters.severity.filter((x) => x !== code) : [...filters.severity, code] })} /> : <div className="ph" />}
            </section>
            <section className="panel" aria-labelledby="fac-h" aria-busy={factors.loading}>
              <div className="panel-head">
                <h2 id="fac-h">Contributing factors</h2>
                {factors.data && <span className="panel-meta num">{int(factors.data.crashes_without_coded_factor)} with no coded factor</span>}
              </div>
              {factors.error && <p className="error-box" role="alert">{factors.error}</p>}
              {factors.data ? <FactorBars rows={factors.data.factors} total={factors.data.total} active={filters.factor}
                onPick={(f) => set({ factor: filters.factor === f ? null : f })} /> : <div className="ph tall" />}
            </section>
          </div>
        </div>

        <div className="grid-when" id="when">
          <section className="panel" aria-labelledby="trend-h" aria-busy={trend.loading}>
            <div className="panel-head">
              <h2 id="trend-h">Over time</h2>
              <div className="tabs" role="tablist" aria-label="Time axis">
                {AXES.map((x) => (
                  <button key={x.by} type="button" role="tab" aria-selected={axis === x.by} onClick={() => setAxis(x.by)}>{x.label}</button>
                ))}
              </div>
            </div>
            {trend.error && <p className="error-box" role="alert">{trend.error}</p>}
            {trend.data ? <TrendChart buckets={trend.data.buckets} by={trend.data.by} onPickYear={(y) => set({ yearFrom: y, yearTo: y })} /> : <div className="ph" />}
          </section>
          <section className="panel" aria-labelledby="heat-h" aria-busy={heat.loading}>
            <div className="panel-head">
              <h2 id="heat-h">Day and hour</h2>
              <div className="tabs" role="tablist" aria-label="Heat map measure">
                <button type="button" role="tab" aria-selected={metric === 'crashes'} onClick={() => setMetric('crashes')}>All crashes</button>
                <button type="button" role="tab" aria-selected={metric === 'ka_crashes'} onClick={() => setMetric('ka_crashes')}>K + A</button>
              </div>
            </div>
            {heat.error && <p className="error-box" role="alert">{heat.error}</p>}
            {heat.data ? <Heatmap data={heat.data} metric={metric} /> : <div className="ph" />}
          </section>
        </div>

        <Breakdown query={query} onFilter={(key, value) => set({ [key]: filters[key].includes(value) ? filters[key] : [...filters[key], value] })} />
        {selected != null && <CrashCard id={selected} onClose={() => select(null)} />}
        <Records query={query} total={s?.total ?? null} onSelect={select} selected={selected} />
      </div>
    </TooltipLayer>
  );
}
