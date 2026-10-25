import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import FilterBar from '../src/components/explorer/FilterBar';
import { NO_FILTERS, type Filters } from '../src/lib/filters';
import type { Meta } from '../src/lib/types';

const meta = {
  filters: { county: [], road_class: [], factor: [], year: [2020, 2021, 2026], severity: ['K', 'A', 'B', 'C'], vru: [] },
  definitions: { severity: { K: 'Fatal injury', A: 'Suspected serious injury', B: 'Suspected minor injury', C: 'Possible injury' } },
} as unknown as Meta;
const render = (filters: Filters = NO_FILTERS) => renderToStaticMarkup(<FilterBar meta={meta} filters={filters} set={() => {}} />);

describe('filter toolbar', () => {
  it('connects the disclosure button to its initially hidden panel', () => {
    const html = render();
    const id = html.match(/class="btn small advanced-toggle"[^>]*aria-controls="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(`id="${id}" class="advanced-controls" hidden=""`);
    expect(html).not.toContain('<details');
  });

  it('disables reset only when there are no active filters', () => {
    expect(render()).toMatch(/class="btn small reset"[^>]*disabled=""/);
    expect(render({ ...NO_FILTERS, severity: ['K'], yearFrom: 2021 })).not.toMatch(/class="btn small reset"[^>]*disabled/);
    expect(render()).toContain('Reset');
  });

  it('retains native labelled year selects and the advanced filter count', () => {
    const html = render({ ...NO_FILTERS, roadClass: ['city-street'], vru: ['pedestrian'] });
    expect(html).toContain('From year');
    expect(html).toContain('To year');
    expect((html.match(/<select/g) ?? []).length).toBe(2);
    expect(html).toContain('aria-label="More filters (2 active)"');
  });
});
