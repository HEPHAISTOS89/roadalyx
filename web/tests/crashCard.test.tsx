import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Crash } from '../src/lib/types';
import { CrashCard } from '../src/components/explorer/Tables';

const { response } = vi.hoisted(() => ({ response: { data: null as Crash | null, loading: false, error: null } }));
vi.mock('../src/lib/api', () => ({ useApi: () => response }));

beforeEach(() => {
  response.data = {
    id: 101, date: '2024-01-01', time: null, year: 2024, month: 1, weekday: 0, hour: null,
    county: 'LUBBOCK', severity: 'B', deaths: 0, serious_injuries: 0, injuries: 1, people: 2,
    factors: [], road_class: null, speed_limit: null, lat: null, lon: null, rural: null,
    intersection: null, at_intersection: null, weather: null, collision: null, first_event: null,
    street: null, construction_zone: null, school_zone: null, reportable: null, vru: [],
  };
});

const render = () => renderToStaticMarkup(<CrashCard id={101} onClose={() => {}} />);

describe('crash record interpretation', () => {
  it('does not infer vehicle occupants from the absence of a recorded VRU', () => {
    const html = render();
    expect(html).toContain('No pedestrian, cyclist or motorcyclist recorded');
    expect(html).not.toContain('Vehicle occupants only');
  });

  it('keeps recognized road-user involvement', () => {
    response.data!.vru = ['pedestrian', 'motorcyclist'];
    expect(render()).toContain('<dt>Road users</dt><dd>Pedestrian, Motorcyclist</dd>');
  });

  it.each([
    [null, null], [33.5, null], [null, -101.8],
  ])('shows an unknown location for incomplete coordinates (%s, %s)', (lat, lon) => {
    Object.assign(response.data!, { lat, lon });
    expect(render()).toContain('<dt>Location</dt><dd class="num">Not recorded</dd>');
  });

  it('shows both coordinates when both are recorded', () => {
    Object.assign(response.data!, { lat: 33.5, lon: -101.8 });
    expect(render()).toContain('33.50000, -101.80000');
  });

  it('shows a missing street without inventing a road name', () => {
    expect(render()).toContain('<dt>Street</dt><dd>–</dd>');
  });
});
