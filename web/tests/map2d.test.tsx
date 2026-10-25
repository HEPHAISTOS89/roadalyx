import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import CanvasMap from '../src/components/maps/CanvasMap';
import { countyAt, countyShapes, districtBounds, fitMap, nearestPoint, pointBounds, project2d, supportsWebGL2, visibleIndices } from '../src/lib/map2d';
import type { Points } from '../src/lib/types';

const points = { id: [1, 2, 3, 4], lon: [-101.8, -102, -102.2, -102.3], lat: [33.5, 33.6, 33.7, 33.8],
  severity: 'KABC', day: [10, 5, 3, 1], located: 4, total: 5, start: '2020-01-01' } as Points;
afterEach(() => vi.unstubAllGlobals());
describe('GPU-independent crash map', () => {
  it('uses all 17 real county boundaries and keeps the north at the top', () => {
    expect(countyShapes).toHaveLength(17);
    expect(project2d(-102, 34)[1]).toBeLessThan(project2d(-102, 33)[1]);
    expect(countyShapes.every((c) => c.ring.length >= 4)).toBe(true);
  });
  it('picks the county under a map click, not just its label', () => {
    expect(countyAt(project2d(-101.8, 33.6))).toBe('LUBBOCK');
    expect(countyAt(project2d(-101.85, 34.05))).toBe('HALE');
    expect(countyAt(project2d(-100, 35))).toBeNull();
  });
  it('frames filtered points, including an empty set and a single crash', () => {
    expect(pointBounds(null)).toEqual(districtBounds);
    expect(pointBounds({ ...points, id: [] })).toEqual(districtBounds);
    const bounds = pointBounds(points);
    const fitted = fitMap(bounds, 600, 500);
    for (let i = 0; i < points.id.length; i++) {
      const [x, y] = project2d(points.lon[i], points.lat[i]);
      expect(Math.abs((x - fitted.x) * fitted.scale)).toBeLessThanOrEqual(252);
      expect(Math.abs((y - fitted.y) * fitted.scale)).toBeLessThanOrEqual(202);
    }
    expect(Number.isFinite(fitMap([bounds[0], bounds[0]], 320, 420).scale)).toBe(true);
  });
  it('uses the timeline cut-off and draws the worst severities last', () => {
    expect(visibleIndices(points)).toEqual([3, 2, 1, 0]);
    expect(visibleIndices(points, 5)).toEqual([3, 2, 1]);
    expect(visibleIndices(null)).toEqual([]);
  });
  it('selects only a nearby visible crash, never one outside the date range', () => {
    const target = project2d(points.lon[0], points.lat[0]);
    expect(nearestPoint(points, visibleIndices(points), target, .01)).toBe(1);
    expect(nearestPoint(points, visibleIndices(points, 5), target, .01)).toBeNull();
    expect(nearestPoint(points, [], target, .01)).toBeNull();
  });
  it('offers accessible zoom, keyboard instructions, and fullscreen without WebGL', () => {
    const html = renderToStaticMarkup(<CanvasMap points={points} onSelect={() => {}} />);
    expect(html).toContain('4 located crashes');
    expect(html).toContain('Arrow keys pan');
    expect(html).toContain('aria-label="Zoom in"');
    expect(html).toContain('aria-label="Full screen map"');
    expect(html).not.toContain('Interstate');
  });
  it('keeps all counties keyboard-selectable on District map', () => {
    const html = renderToStaticMarkup(<CanvasMap points={points} onCounty={() => {}} view="district" />);
    expect((html.match(/class="canvas-county"/g) ?? [])).toHaveLength(17);
    expect(html).toContain('aria-label="Hale County"');
    expect(html).not.toContain('Full screen map'); // The Hero already has its own fullscreen control.
  });
  it('detects unavailable WebGL and releases a successful probe context', () => {
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) });
    expect(supportsWebGL2()).toBe(false);
    const release = vi.fn();
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ getExtension: () => ({ loseContext: release }) }) }) });
    expect(supportsWebGL2()).toBe(true);
    expect(release).toHaveBeenCalledOnce();
    vi.stubGlobal('document', { createElement: () => { throw new Error('blocked'); } });
    expect(supportsWebGL2()).toBe(false);
  });
});
