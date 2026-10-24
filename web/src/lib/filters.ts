import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Sev } from './types';

/** The Explorer selection. It lives in the URL, so every view can be bookmarked and shared. */
export interface Filters {
  county: string[]; severity: Sev[]; roadClass: string[]; vru: string[];
  yearFrom: number | null; yearTo: number | null; factor: string | null;
}

const list = (v: string | null) => (v ? v.split(',').filter(Boolean) : []);
const num = (v: string | null) => (v && /^\d{4}$/.test(v) ? Number(v) : null);

export function parseFilters(q: URLSearchParams): Filters {
  return {
    county: list(q.get('county')),
    severity: list(q.get('severity')).map((s) => s.toUpperCase()).filter((s): s is Sev => 'KABC'.includes(s) && s.length === 1),
    roadClass: list(q.get('road_class')),
    vru: list(q.get('vru')),
    yearFrom: num(q.get('year_from')),
    yearTo: num(q.get('year_to')),
    factor: q.get('factor') || null,
  };
}

/** Query string for the API and for the page URL: one format for both. */
export function toQuery(f: Filters): string {
  const q = new URLSearchParams();
  if (f.county.length) q.set('county', f.county.join(','));
  if (f.severity.length) q.set('severity', f.severity.join(','));
  if (f.roadClass.length) q.set('road_class', f.roadClass.join(','));
  if (f.vru.length) q.set('vru', f.vru.join(','));
  if (f.yearFrom != null) q.set('year_from', String(f.yearFrom));
  if (f.yearTo != null) q.set('year_to', String(f.yearTo));
  if (f.factor) q.set('factor', f.factor);
  return q.toString();
}

export const NO_FILTERS: Filters = { county: [], severity: [], roadClass: [], vru: [], yearFrom: null, yearTo: null, factor: null };

export function isEmpty(f: Filters) {
  return toQuery(f) === '';
}

export function useFilters() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => parseFilters(params), [params]);
  const set = useCallback((next: Partial<Filters>) => {
    setParams((prev) => {
      const merged = { ...parseFilters(prev), ...next };
      const q = new URLSearchParams(toQuery(merged));
      for (const [k, v] of prev) if (!['county', 'severity', 'road_class', 'vru', 'year_from', 'year_to', 'factor'].includes(k)) q.set(k, v);
      return q;
    }, { replace: true });
  }, [setParams]);
  return { filters, set, query: toQuery(filters) };
}

/** API URL with the current filters: `api('/severity', q)` -> `/api/v1/severity?county=hale`. */
export const api = (path: string, query = '', extra = '') =>
  `/api/v1${path}${query || extra ? '?' : ''}${[query, extra].filter(Boolean).join('&')}`;
