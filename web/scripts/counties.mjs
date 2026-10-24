// Extracts the 17 counties of the TxDOT Lubbock District from us-atlas (US Census Bureau
// cartographic boundaries, 1:10M) into src/data/counties.json. Run with `npm run geo`.
import { readFileSync, writeFileSync } from 'node:fs';
import { feature } from 'topojson-client';

const DISTRICT = ['BAILEY', 'CASTRO', 'COCHRAN', 'CROSBY', 'DAWSON', 'FLOYD', 'GAINES', 'GARZA', 'HALE',
  'HOCKLEY', 'LAMB', 'LUBBOCK', 'LYNN', 'PARMER', 'SWISHER', 'TERRY', 'YOAKUM'];

const topo = JSON.parse(readFileSync(new URL('../node_modules/us-atlas/counties-10m.json', import.meta.url)));
const all = feature(topo, topo.objects.counties).features;
const round = (ring) => ring.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)]);
const counties = all
  .filter((f) => f.id.startsWith('48') && DISTRICT.includes(f.properties.name.toUpperCase()))
  .map((f) => ({
    type: 'Feature',
    id: f.id,
    properties: { name: f.properties.name.toUpperCase() },
    geometry: {
      type: f.geometry.type,
      coordinates: f.geometry.type === 'Polygon' ? f.geometry.coordinates.map(round)
        : f.geometry.coordinates.map((p) => p.map(round)),
    },
  }));
if (counties.length !== DISTRICT.length) throw new Error(`found ${counties.length} of ${DISTRICT.length} counties`);
writeFileSync(new URL('../src/data/counties.json', import.meta.url), JSON.stringify({
  type: 'FeatureCollection',
  source: 'US Census Bureau cartographic boundary files via us-atlas 3 (1:10,000,000)',
  features: counties,
}));
console.log(counties.map((c) => c.properties.name).join(', '));
