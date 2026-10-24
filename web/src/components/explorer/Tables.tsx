import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowSquareOutIcon, DownloadSimpleIcon, XIcon } from '@phosphor-icons/react';
import { useApi } from '../../lib/api';
import { county, dateLong, int, pct, title } from '../../lib/format';
import { api, slug } from '../../lib/filters';
import type { BreakdownRes, Crash, CrashPage, Group } from '../../lib/types';

export const DIMENSIONS = [
  { by: 'county', label: 'County', filter: 'county' as const },
  { by: 'road_class', label: 'Road class', filter: 'roadClass' as const },
  { by: 'rural', label: 'Rural / urban' },
  { by: 'intersection', label: 'Intersection' },
  { by: 'collision', label: 'Manner of collision' },
  { by: 'first_event', label: 'First harmful event' },
  { by: 'weather', label: 'Weather' },
  { by: 'speed_limit', label: 'Speed limit' },
];
type Dim = (typeof DIMENSIONS)[number];
type SortKey = 'crashes' | 'K' | 'A' | 'ka_share' | 'deaths';

function valueLabel(by: string, v: Group['value']) {
  if (v == null) return 'Not recorded';
  if (by === 'county') return county(String(v));
  if (by === 'rural') return v ? 'Rural' : 'Urban';
  if (by === 'speed_limit') return `${v} mph`;
  return title(String(v));
}

/** Crashes and severity mix per value of one attribute. Rows of county and road class filter the page. */
export function Breakdown({ query, onFilter }: { query: string; onFilter: (key: 'county' | 'roadClass', value: string) => void }) {
  const [dim, setDim] = useState<Dim>(DIMENSIONS[0]);
  const [sort, setSort] = useState<SortKey>('crashes');
  const res = useApi<BreakdownRes>(api('/breakdown', query, `by=${dim.by}`));
  const rows = useMemo(() => {
    const g = [...(res.data?.groups ?? [])];
    return g.sort((a, b) => ((b[sort] ?? -1) as number) - ((a[sort] ?? -1) as number));
  }, [res.data, sort]);
  const max = Math.max(...rows.map((r) => r.crashes), 1);
  const head = (key: SortKey, label: string) => (
    <th scope="col" aria-sort={sort === key ? 'descending' : 'none'} className="num-col">
      <button type="button" onClick={() => setSort(key)}>{label}</button>
    </th>
  );
  return (
    <div className="panel">
      <div className="panel-head">
        <h2 id="breakdown-h">Breakdown</h2>
        <label className="inline-select">
          <span className="sr-only">Group crashes by</span>
          <select value={dim.by} onChange={(e) => setDim(DIMENSIONS.find((d) => d.by === e.target.value)!)}>
            {DIMENSIONS.map((d) => <option key={d.by} value={d.by}>{d.label}</option>)}
          </select>
        </label>
      </div>
      {res.error && <p className="error-box" role="alert">{res.error}</p>}
      {res.loading && <p className="panel-meta" role="status">Loading data…</p>}
      <div className="table-wrap" tabIndex={0} role="region" aria-busy={res.loading} aria-labelledby="breakdown-h">
        <table className={`data${res.loading ? ' stale' : ''}`}>
          <thead>
            <tr>
              <th scope="col">{dim.label}</th>
              {head('crashes', 'Crashes')}
              {head('K', 'K')}
              {head('A', 'A')}
              {head('ka_share', 'K + A share')}
              {head('deaths', 'Deaths')}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const name = valueLabel(dim.by, r.value);
              return (
                <tr key={String(r.value)}>
                  <th scope="row">
                    {'filter' in dim && dim.filter && r.value != null
                      ? <button type="button" className="link" onClick={() => onFilter(dim.filter!, slug(String(r.value)))}>{name}</button>
                      : name}
                  </th>
                  <td className="num-col"><span className="cell-bar"><i style={{ width: `${(r.crashes / max) * 100}%` }} />{int(r.crashes)}</span></td>
                  <td className="num-col">{int(r.K)}</td>
                  <td className="num-col">{int(r.A)}</td>
                  <td className="num-col">{pct(r.ka_share)}</td>
                  <td className="num-col">{int(r.deaths)}</td>
                </tr>
              );
            })}
            {res.data && rows.length === 0 && <tr><td colSpan={6} className="empty">No crash matches these filters.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const PAGE = 25;

/** The crash records behind every number, newest first; a row opens the record and finds it on the map. */
export function Records({ query, total, onSelect, selected }: { query: string; total: number | null; onSelect: (id: number) => void; selected: number | null }) {
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<'newest' | 'oldest' | 'severity'>('newest');
  const [lastQuery, setLastQuery] = useState(query);
  if (query !== lastQuery) { setLastQuery(query); setPage(0); }
  const res = useApi<CrashPage>(api('/crashes', query, `limit=${PAGE}&offset=${page * PAGE}&sort=${sort}`));
  const pages = Math.max(1, Math.ceil((res.data?.total ?? 0) / PAGE));
  return (
    <div className="panel">
      <div className="panel-head">
        <h2 id="records-h">Crash records</h2>
        <div className="panel-tools">
          <label className="inline-select">
            <span className="sr-only">Sort records</span>
            <select value={sort} onChange={(e) => { setSort(e.target.value as typeof sort); setPage(0); }}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="severity">Most severe first</option>
            </select>
          </label>
          <a className="btn small" href={api('/crashes', query, 'format=csv')} download>
            <DownloadSimpleIcon aria-hidden="true" />Download CSV{total != null ? ` (${int(total)})` : ''}
          </a>
        </div>
      </div>
      {res.error && <p className="error-box" role="alert">{res.error}</p>}
      {res.loading && <p className="panel-meta" role="status">Loading data…</p>}
      <div className="table-wrap" tabIndex={0} role="region" aria-busy={res.loading} aria-labelledby="records-h">
        <table className={`data records${res.loading ? ' stale' : ''}`}>
          <thead>
            <tr>
              <th scope="col">Date</th><th scope="col">Sev</th><th scope="col">County</th><th scope="col">Street</th>
              <th scope="col">Road class</th><th scope="col">First factor</th><th scope="col" className="num-col">Persons</th>
            </tr>
          </thead>
          <tbody>
            {res.data?.crashes.map((c) => (
              <tr key={c.id} className={selected === c.id ? 'sel' : ''}>
                <th scope="row">
                  <button type="button" className="link" onClick={() => onSelect(c.id)} aria-label={`Open crash ${c.id}, ${dateLong(c.date)}`}>
                    {dateLong(c.date)}<span className="muted num"> {c.time ?? ''}</span>
                  </button>
                </th>
                <td><span className={`sev-chip ${c.severity.toLowerCase()}`}>{c.severity}</span></td>
                <td>{county(c.county)}</td>
                <td className="mono">{c.street ?? '–'}</td>
                <td>{title(c.road_class)}</td>
                <td>{c.factors[0] ? title(c.factors[0]) : '–'}{c.factors.length > 1 ? <span className="muted"> +{c.factors.length - 1}</span> : null}</td>
                <td className="num-col">{c.people}</td>
              </tr>
            ))}
            {res.data && res.data.crashes.length === 0 && <tr><td colSpan={7} className="empty">No crash matches these filters.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="pager">
        <button type="button" className="btn small" onClick={() => setPage((p) => p - 1)} disabled={res.loading || page === 0}>Previous</button>
        <span className="num">Page {page + 1} of {int(pages)}</span>
        <button type="button" className="btn small" onClick={() => setPage((p) => p + 1)} disabled={res.loading || page + 1 >= pages}>Next</button>
      </div>
    </div>
  );
}

const yesNo = (v: boolean | null) => (v == null ? '–' : v ? 'Yes' : 'No');

/** Every cleaned field of one crash, as the API returns it. */
export function CrashCard({ id, onClose }: { id: number; onClose: () => void }) {
  const res = useApi<Crash>(`/api/v1/crashes/${id}`);
  const c = res.data;
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current!;
    const opener = document.activeElement as HTMLElement | SVGElement | null;
    el.showModal();
    return () => {
      el.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog ref={dialog} className="crash-card" aria-labelledby="crash-h" onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <div className="crash-card-head">
        <h3 id="crash-h">Crash <span className="mono">{id}</span></h3>
        <button type="button" className="icon-btn small" onClick={onClose} aria-label="Close crash record"><XIcon aria-hidden="true" /></button>
      </div>
      {res.error && <p className="error-box" role="alert">{res.error}</p>}
      {res.loading && <p role="status">Loading crash record…</p>}
      {c && (
        <>
          <p className="crash-when">
            <span className={`sev-chip ${c.severity.toLowerCase()}`}>{c.severity}</span>
            {dateLong(c.date)}{c.time ? `, ${c.time}` : ''} · {county(c.county)} County
          </p>
          <dl className="kv">
            <dt>Killed</dt><dd>{c.deaths}</dd>
            <dt>Seriously injured</dt><dd>{c.serious_injuries}</dd>
            <dt>Injured (not killed)</dt><dd>{c.injuries}</dd>
            <dt>Persons involved</dt><dd>{c.people}</dd>
            <dt>Road users</dt><dd>{c.vru.length ? c.vru.map(title).join(', ') : 'Vehicle occupants only'}</dd>
            <dt>Factors</dt><dd>{c.factors.map(title).join('; ') || '–'}</dd>
            <dt>Collision</dt><dd>{title(c.collision)}</dd>
            <dt>First harmful event</dt><dd>{title(c.first_event)}</dd>
            <dt>Street</dt><dd className="mono">{c.street ?? '–'}</dd>
            <dt>Road class</dt><dd>{title(c.road_class)}</dd>
            <dt>Speed limit</dt><dd>{c.speed_limit ? `${c.speed_limit} mph` : 'Not recorded'}</dd>
            <dt>Intersection</dt><dd>{title(c.intersection)}</dd>
            <dt>Weather</dt><dd>{title(c.weather)}</dd>
            <dt>Area</dt><dd>{c.rural == null ? '–' : c.rural ? 'Rural' : 'Urban'}</dd>
            <dt>Work zone / school zone</dt><dd>{yesNo(c.construction_zone)} / {yesNo(c.school_zone)}</dd>
            <dt>Location</dt><dd className="mono">{c.lat != null ? `${c.lat.toFixed(5)}, ${c.lon!.toFixed(5)}` : 'Not recorded'}</dd>
          </dl>
          <a className="btn small" href={`/api/v1/crashes/${id}`} target="_blank" rel="noreferrer">
            <ArrowSquareOutIcon aria-hidden="true" />JSON
          </a>
        </>
      )}
    </dialog>
  );
}
