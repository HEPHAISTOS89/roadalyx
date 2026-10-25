import counties from '../data/counties.json';
import type { Points } from './types';

export type XY = [number, number];
export type Bounds = [XY, XY];
// Local equirectangular projection: equal distances at the district's mid-latitude.
const longitudeScale = Math.cos(33.62 * Math.PI / 180);
export const project2d = (lon: number, lat: number): XY => [(lon + 102.05) * longitudeScale, 33.62 - lat];
export const countyShapes = counties.features.map((f) => {
  const ring = f.geometry.coordinates[0].map(([lon, lat]) => project2d(lon, lat));
  const xs = ring.map(([x]) => x), ys = ring.map(([, y]) => y);
  const bounds: Bounds = [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
  return { name: f.properties.name, ring, bounds, center: [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2] as XY };
});
export function countyAt([x, y]: XY) {
  for (const c of countyShapes) {
    let inside = false;
    for (let i = 0, j = c.ring.length - 1; i < c.ring.length; j = i++) {
      const [xi, yi] = c.ring[i], [xj, yj] = c.ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return c.name;
  }
  return null;
}

export const districtBounds: Bounds = [
  [Math.min(...countyShapes.map((c) => c.bounds[0][0])), Math.min(...countyShapes.map((c) => c.bounds[0][1]))],
  [Math.max(...countyShapes.map((c) => c.bounds[1][0])), Math.max(...countyShapes.map((c) => c.bounds[1][1]))],
];
export const lubbockBounds: Bounds = [project2d(-102.03, 33.71), project2d(-101.69, 33.43)];
export function pointBounds(points: Points | null): Bounds {
  if (!points?.id.length) return districtBounds;
  const xy = points.lon.map((lon, i) => project2d(lon, points.lat[i]));
  return [[Math.min(...xy.map(([x]) => x)), Math.min(...xy.map(([, y]) => y))],
    [Math.max(...xy.map(([x]) => x)), Math.max(...xy.map(([, y]) => y))]];
}
export function fitMap(bounds: Bounds, width: number, height: number, padding = 48) {
  return {
    x: (bounds[0][0] + bounds[1][0]) / 2,
    y: (bounds[0][1] + bounds[1][1]) / 2,
    scale: Math.min(Math.max(1, width - padding * 2) / Math.max(0.035, bounds[1][0] - bounds[0][0]),
      Math.max(1, height - padding * 2) / Math.max(0.035, bounds[1][1] - bounds[0][1])),
  };
}
export function visibleIndices(points: Points | null, maxDay = Infinity) {
  return points ? points.id.map((_, i) => i).filter((i) => points.day[i] <= maxDay)
    .sort((a, b) => 'CBAK'.indexOf(points.severity[a]) - 'CBAK'.indexOf(points.severity[b])) : [];
}
export function nearestPoint(points: Points, indices: number[], target: XY, radius: number) {
  let picked: number | null = null, distance = radius * radius;
  for (const i of indices) {
    const [x, y] = project2d(points.lon[i], points.lat[i]);
    const d = (x - target[0]) ** 2 + (y - target[1]) ** 2;
    if (d <= distance) { picked = points.id[i]; distance = d; }
  }
  return picked;
}

/** Release the probe context: retaining it competes with the actual map for GPU contexts. */
export function supportsWebGL2() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch { return false; }
}
