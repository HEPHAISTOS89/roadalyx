// The Analysis page: filter bar, key figures, map, charts, breakdown and the crash records, all
// computed by the API on the same filters, which live in the URL so any view can be shared as a link.
import { useCallback, useState } from 'react';
import { UsersIcon } from '@phosphor-icons/react';
import { useSearchParams } from 'react-router-dom';
import FilterBar from '../components/explorer/FilterBar';
import CrashMap from '../components/explorer/CrashMap';
import { Breakdown, CrashCard, Records } from '../components/explorer/Tables';
import { FactorBars, Heatmap, SeverityBars, TrendChart } from '../components/charts/charts';
import { TooltipLayer } from '../components/Tooltip';
import { Rolling, Seg } from '../components/ui';
import { useApi } from '../lib/api';
import { api, LOCATIONS, toQuery, useFilters, type Location } from '../lib/filters';
import { county, int, pct, streetName, title } from '../lib/format';
import type { BreakdownRes, FactorsRes, HeatmapRes, Meta, Points, SeverityRes, TrendRes } from '../lib/types';
import '../styles/explorer.css';

// Time axes of the trend chart.
const AXES = [
  { by: 'year', label: 'Year' }, { by: 'month', label: 'Month' },
  { by: 'hour', label: 'Hour of day' }, { by: 'weekday', label: 'Day of week' },
] as const;
// Crash location (HSM: intersection vs segment), worded for the scope line, the buttons and their tooltips.
const PLACE: Record<Location, string> = { intersection: 'at intersections', segment: 'on segments', driveway: 'at driveways' };
const PLACE_LABEL: Record<Location, string> = { intersection: 'Intersection', segment: 'Segment', driveway: 'Driveway' };
const PLACE_HELP: Record<Location, string> = {
  intersection: 'At or near a junction (CRIS "Intersection Related")', segment: 'Between junctions', driveway: 'At a private access',
};
// CRIS "Intersection Related" values behind each location (same grouping as roadalyx.query.LOCATIONS).
const PLACE_VALUES: Record<Location, string[]> = {
  intersection: ['INTERSECTION', 'INTERSECTION RELATED'], segment: ['NON INTERSECTION'], driveway: ['DRIVEWAY ACCESS'],
};

/** One sentence stating the selection every number on the page is computed on. */
function Scope({ meta, total, located }: { meta: Meta; total: number | null; located: number | null }) {
  const { filters: f, set } = useFilters();
  const label = (list: { value: string; label: string }[], v: string) => list.find((c) => c.value === v)?.label ?? v;
  const parts = [
    f.county.length ? f.county.map((c) => county(label(meta.filters.county, c))).join(', ') + (f.county.length > 1 ? ' counties' : ' County') : 'all 17 counties',
    ((from, to) => (from === to ? String(from) : `${from}–${to}`))(f.yearFrom ?? meta.filters.year[0], f.yearTo ?? meta.filters.year.at(-1)),
    f.severity.length ? `severity ${f.severity.join(', ')}` : null,
    f.roadClass.length ? f.roadClass.map((r) => title(label(meta.filters.road_class, r))).join(', ') : null,
    f.factor ? `citing “${title(label(meta.filters.factor, f.factor)).toLowerCase()}”` : null,
    f.vru.length ? `involving a ${f.vru.join(' or ')}` : null,
    f.location ? PLACE[f.location] : null,
  ].filter(Boolean);
  return (
    <p className="scope" aria-live="polite">
      <b className="num">{total == null ? '…' : int(total)}</b> injury crashes · {parts.join(' · ')}
      {f.street.map((st) => (
        <button key={st} type="button" className="scope-chip" onClick={() => set({ street: f.street.filter((x) => x !== st) })}
          aria-label={`Remove the ${streetName(st)} filter`}>on {streetName(st)}<span aria-hidden="true">×</span></button>
      ))}
      {/* Crashes without coordinates are still in every count; they just cannot be drawn on the map. */}
      {located != null && total != null && total > located
        ? <span title="Counted in every figure; without coordinates, they cannot be drawn."> · {int(total - located)} not on the map (no location)</span> : null}
      {total === 0 && <span className="scope-empty"> · No crashes match.</span>}
    </p>
  );
}

export default function Explorer() {
  const { filters, set, query } = useFilters();
  const [params, setParams] = useSearchParams();
  const [axis, setAxis] = useState<(typeof AXES)[number]['by']>('year');
  const [metric, setMetric] = useState<'crashes' | 'ka_crashes'>('crashes');
  // One request per panel, each with the same filter query; the breakdowns below drop one filter on purpose.
  const meta = useApi<Meta>('/api/v1/meta');
  const sev = useApi<SeverityRes>(api('/severity', query));
  const pts = useApi<Points>(api('/points', query));
  const factors = useApi<FactorsRes>(api('/factors', query, 'limit=10'));
  const trend = useApi<TrendRes>(api('/trends', query, `by=${axis}`));
  const heat = useApi<HeatmapRes>(api('/heatmap', query));
  // Corridors are ranked on the selection without the street filter, so the list stays to choose from.
  const corridors = useApi<BreakdownRes>(api('/breakdown', toQuery({ ...filters, street: [] }), 'by=street&limit=9'));
  // Crashes per county on the selection without the county filter, for the map's county hover.
  const byCounty = useApi<BreakdownRes>(api('/breakdown', toQuery({ ...filters, county: [] }), 'by=county'));
  // Crashes per location on the selection without the location filter, shown on each button.
  const places = useApi<BreakdownRes>(api('/breakdown', toQuery({ ...filters, location: null }), 'by=intersection'));
  const placeCount = (l: Location | null) => places.data?.groups
    .filter((g) => (l ? PLACE_VALUES[l] : Object.values(PLACE_VALUES).flat()).includes(String(g.value)))
    .reduce((n, g) => n + g.crashes, 0);

  // The open crash is in the URL too (?crash=id), so a link can point at one record.
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

        {/* Key figures. K and A sit together: K+A (fatal plus suspected serious injury) is the usual severe-crash measure. */}
        <dl className="kpis rise" style={{ '--i': 1 } as React.CSSProperties} aria-label="Key figures" aria-busy={sev.loading}>
          <div><dt>Injury crashes</dt><dd><b className="num"><Rolling text={int(s?.total)} /></b></dd></div>
          <div>
            <dt><i className="sw k" aria-hidden="true" />Fatal (K)</dt>
            <dd><b className="num"><Rolling text={int(k?.crashes)} /></b>
              <small><UsersIcon size={15} aria-hidden="true" />{int(s?.deaths)} killed</small></dd>
          </div>
          <div>
            <dt><i className="sw a" aria-hidden="true" />Suspected serious (A)</dt>
            <dd><b className="num"><Rolling text={int(a?.crashes)} /></b>
              <small><UsersIcon size={15} aria-hidden="true" />{int(s?.serious_injuries)} seriously injured</small></dd>
          </div>
          <div><dt>K + A share</dt><dd><b className="num"><Rolling text={pct(s?.ka_share)} /></b></dd></div>
        </dl>

        {/* Where: the map with its location toggle, then severity and contributing factors. Clicking a bar filters the page. */}
        <div className="grid-main rise" style={{ '--i': 2 } as React.CSSProperties}>
          <section className="panel map-panel" aria-labelledby="map-h">
            <div className="panel-head">
              <h2 id="map-h">Map</h2>
              <fieldset className="location">
                <legend>Location</legend>
                <Seg>
                  <button type="button" aria-pressed={!filters.location} onClick={() => set({ location: null })}>
                    All<span className="count">{int(placeCount(null))}</span>
                  </button>
                  {LOCATIONS.map((l) => (
                    <button key={l} type="button" aria-pressed={filters.location === l} title={PLACE_HELP[l]}
                      onClick={() => set({ location: filters.location === l ? null : l })}>
                      {PLACE_LABEL[l]}<span className="count">{int(placeCount(l))}</span>
                    </button>
                  ))}
                </Seg>
              </fieldset>
            </div>
            <div className="map-wrap" aria-busy={pts.loading}>
              {pts.loading && <p className="map-loading" role="status">Updating map…</p>}
              <CrashMap points={pts.data} selected={selected} onSelect={select}
                counties={byCounty.data?.groups ?? []} county={filters.county}
                onCounty={(c) => set({ county: filters.county.includes(c) ? filters.county.filter((x) => x !== c) : [c] })}
                corridors={corridors.data?.groups.filter((g) => g.value).slice(0, 8) ?? []} street={filters.street}
                onStreet={(st) => set({ street: st ? [st] : [] })} />
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
                {factors.data && <span className="panel-meta num" title="Crashes with no coded contributing factor">{int(factors.data.crashes_without_coded_factor)} uncoded</span>}
              </div>
              {factors.error && <p className="error-box" role="alert">{factors.error}</p>}
              {factors.data ? <FactorBars rows={factors.data.factors} total={factors.data.total} active={filters.factor}
                onPick={(f) => set({ factor: filters.factor === f ? null : f })} /> : <div className="ph tall" />}
            </section>
          </div>
        </div>

        {/* When: crashes over time and by day and hour. */}
        <div className="grid-when rise" id="when" style={{ '--i': 3 } as React.CSSProperties}>
          <section className="panel" aria-labelledby="trend-h" aria-busy={trend.loading}>
            <div className="panel-head">
              <h2 id="trend-h">Over time</h2>
              <Seg role="tablist" aria-label="Time axis">
                {AXES.map((x) => (
                  <button key={x.by} type="button" role="tab" aria-selected={axis === x.by} onClick={() => setAxis(x.by)}>{x.label}</button>
                ))}
              </Seg>
            </div>
            {trend.error && <p className="error-box" role="alert">{trend.error}</p>}
            {trend.data ? <TrendChart buckets={trend.data.buckets} by={trend.data.by} onPickYear={(y) => set({ yearFrom: y, yearTo: y })} /> : <div className="ph" />}
          </section>
          <section className="panel" aria-labelledby="heat-h" aria-busy={heat.loading}>
            <div className="panel-head">
              <h2 id="heat-h">Day and hour</h2>
              <Seg role="tablist" aria-label="Heat map measure">
                <button type="button" role="tab" aria-selected={metric === 'crashes'} onClick={() => setMetric('crashes')}>All crashes</button>
                <button type="button" role="tab" aria-selected={metric === 'ka_crashes'} onClick={() => setMetric('ka_crashes')}>K + A</button>
              </Seg>
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
