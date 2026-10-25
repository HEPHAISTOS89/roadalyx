import { useId, useState } from 'react';
import { ArrowCounterClockwiseIcon, CaretDownIcon, FunnelIcon } from '@phosphor-icons/react';
import Picker from './Picker';
import { Seg } from '../ui';
import { county, title } from '../../lib/format';
import { isEmpty, NO_FILTERS, type Filters } from '../../lib/filters';
import { SEVS, type Meta, type Sev } from '../../lib/types';

const SEV_NAME: Record<Sev, string> = { K: 'Fatal', A: 'Susp. serious', B: 'Susp. minor', C: 'Possible' };
const VRU = [
  { value: 'pedestrian', label: 'Pedestrian' },
  { value: 'pedalcyclist', label: 'Cyclist' },
  { value: 'motorcyclist', label: 'Motorcyclist' },
];

interface Props { meta: Meta; filters: Filters; set: (f: Partial<Filters>) => void }

export default function FilterBar({ meta, filters, set }: Props) {
  const years = meta.filters.year;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedId = useId();
  const advancedCount = filters.roadClass.length + Number(!!filters.factor) + filters.vru.length;
  const toggle = <T extends string>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <div className="filters" role="search" aria-label="Filter crashes">
      <div className="filters-main">
        <Picker label="County" choices={meta.filters.county} selected={filters.county} format={county}
          onChange={(v) => set({ county: v })} search />

        <Seg as="fieldset" multi aria-label="Severity">
          <legend className="sr-only">Severity (KABCO)</legend>
          {SEVS.map((s) => (
            <button key={s} type="button" aria-pressed={filters.severity.includes(s)} className={`seg-sev ${s.toLowerCase()}`}
              onClick={() => set({ severity: toggle(filters.severity, s) })} title={meta.definitions.severity[s]}>
              <i className={`sw ${s.toLowerCase()}`} aria-hidden="true" />{s}<span className="sr-only"> {SEV_NAME[s]}</span>
            </button>
          ))}
        </Seg>

        <div className="years">
          <label>
            <span className="sr-only">From year</span>
            <select value={filters.yearFrom ?? ''} onChange={(e) => {
              const from = e.target.value ? Number(e.target.value) : null;
              set({ yearFrom: from, yearTo: from && filters.yearTo && filters.yearTo < from ? from : filters.yearTo });
            }}>
              <option value="">{years[0]}</option>
              {years.slice(1).map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <CaretDownIcon size={14} aria-hidden="true" />
          </label>
          <span aria-hidden="true">–</span>
          <label>
            <span className="sr-only">To year</span>
            <select value={filters.yearTo ?? ''} onChange={(e) => {
              const to = e.target.value ? Number(e.target.value) : null;
              set({ yearTo: to, yearFrom: to && filters.yearFrom && filters.yearFrom > to ? to : filters.yearFrom });
            }}>
              <option value="">{years[years.length - 1]}</option>
              {years.slice(0, -1).map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <CaretDownIcon size={14} aria-hidden="true" />
          </label>
        </div>

        <button type="button" className="btn small advanced-toggle" aria-expanded={advancedOpen} aria-controls={advancedId}
          aria-label={`More filters${advancedCount > 0 ? ` (${advancedCount} active)` : ''}`}
          onClick={() => setAdvancedOpen((open) => !open)}>
          <FunnelIcon size={16} aria-hidden="true" />More{advancedCount > 0 ? ` · ${advancedCount}` : ''}
        </button>
        <button type="button" className="btn small reset" onClick={() => set(NO_FILTERS)} disabled={isEmpty(filters)}
          title={isEmpty(filters) ? 'No active filters' : 'Clear all filters and restore the full dataset'}>
          <ArrowCounterClockwiseIcon size={16} aria-hidden="true" />Reset
        </button>
      </div>

      <div id={advancedId} className="advanced-controls" hidden={!advancedOpen}>
        <Picker label="Road class" choices={meta.filters.road_class} selected={filters.roadClass} format={title}
          onChange={(v) => set({ roadClass: v })} />
        <Picker label="Factor" choices={meta.filters.factor} selected={filters.factor ? [filters.factor] : []} format={title}
          onChange={(v) => set({ factor: v[0] ?? null })} multiple={false} search />

        <Seg as="fieldset" multi aria-label="Road users involved">
          <legend className="sr-only">Road users involved</legend>
          {VRU.map((u) => (
            <button key={u.value} type="button" aria-pressed={filters.vru.includes(u.value)}
              onClick={() => set({ vru: toggle(filters.vru, u.value) })}>{u.label}</button>
          ))}
        </Seg>
      </div>
    </div>
  );
}
