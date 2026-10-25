import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import counties from '../../data/counties.json';
import type { Points } from '../../lib/types';

/**
 * The Lubbock District at night, drawn from data: county lines from the Census boundary file,
 * the road network from Census TIGER/Line, and one light per located crash at its CRIS coordinates.
 * Fatal and serious-injury crashes stand as thin posts, and each fatal crash sends a ring across
 * the ground when the timeline reaches it. Route numbers sit on the highways, as on a road map.
 *
 * The camera orbits slowly and the timeline loops until the visitor drags, zooms, picks a county
 * or presses pause. With reduced motion, the scene is still and renders only on change.
 *
 * Scene units are kilometres on a local equirectangular projection centred on the district.
 */

const LON0 = -102.05;
const LAT0 = 33.62;
const KX = 111.32 * Math.cos((LAT0 * Math.PI) / 180);
const KZ = 110.57;
export const project = (lon: number, lat: number) => new THREE.Vector3((lon - LON0) * KX, 0, -(lat - LAT0) * KZ);

const GROUND = 0x0a0b0a;
const FILL = 0x0c0d0c;
const FILL_HOVER = 0x1a1f1a;
const FILL_SELECTED = 0x151c17;
const SEV_INDEX: Record<string, number> = { K: 0, A: 1, B: 2, C: 3 };
// Same ramp as --sev-* in tokens.css (validated ordinal ramp: lightness falls from C to K).
const SEV_COLOR = ['#d31246', '#f27000', '#e7b63b', '#d0d8e1'].map((c) => new THREE.Color(c));

const HOLD = 40;            // days the timeline runs past the last crash so the last flares settle
const LOOP_PAUSE = 4;       // seconds the full picture stays before the timeline replays
const ORBIT = 0.045;        // rad/s, one turn in about two and a half minutes
const IDLE_RESUME = 5;      // seconds after the last drag or zoom before the orbit resumes

export interface WorldOptions {
  host: HTMLElement;
  labels: HTMLElement;
  points: Points;
  still: boolean;
  onDay: (day: number) => void;
  onHover: (county: string | null, x: number, y: number) => void;
  onSelect: (county: string | null) => void;
}

export interface World {
  setDay(day: number): void;
  play(): void;
  pause(): void;
  isPlaying(): boolean;
  view(name: 'district' | 'lubbock'): void;
  focus(county: string | null): void;
  setActive(active: boolean): void;
  dispose(): void;
}

const POINT_VS = /* glsl */ `
  attribute float sev;
  attribute float day;
  attribute float phase;
  uniform float uDay;
  uniform float uTime;
  uniform float uPx;
  uniform vec3 uColors[4];
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSpark;
  void main() {
    float age = uDay - day;
    float shown = step(0.0, age);
    // a crash flares for its first 40 days on the timeline, then settles to its resting light
    vSpark = shown * (1.0 - smoothstep(0.0, 40.0, age));
    int s = int(sev + 0.5);
    vColor = uColors[s];
    float base = s == 0 ? 5.0 : s == 1 ? 3.6 : s == 2 ? 2.2 : 1.6;
    // resting lights breathe slightly out of step with each other, like a city seen from the air
    float breathe = 0.82 + 0.18 * sin(uTime * (0.6 + phase * 0.9) + phase * 6.2831);
    vAlpha = shown * (s == 3 ? 0.18 : s == 2 ? 0.28 : 0.8) * mix(breathe, 1.0, vSpark);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float dist = max(-mv.z, 1.0);
    gl_PointSize = shown * uPx * base * (1.0 + 0.65 * vSpark) * clamp(220.0 / dist, 0.55, 2.2);
  }
`;
const POINT_FS = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSpark;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r = dot(p, p);
    if (r > 1.0) discard;
    float core = smoothstep(0.3, 0.0, r);
    float halo = (1.0 - r) * 0.22;
    vec3 col = vColor;
    gl_FragColor = vec4(col, vAlpha * (core + halo));
  }
`;
// Fatal crashes: a ring lying on the ground that widens to 6 km and fades over 120 days of timeline.
const RING_VS = /* glsl */ `
  attribute vec3 offset;
  attribute float day;
  uniform float uDay;
  varying float vT;
  varying vec2 vUv;
  void main() {
    float age = uDay - day;
    vT = age / 120.0;
    float on = step(0.0, age) * step(vT, 1.0);
    vUv = uv * 2.0 - 1.0;
    vec3 p = offset + vec3(position.x, 0.0, -position.y) * 12.0 * on;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;
const RING_FS = /* glsl */ `
  uniform vec3 uColor;
  varying float vT;
  varying vec2 vUv;
  void main() {
    float r = length(vUv);
    float rad = 0.06 + 0.94 * sqrt(clamp(vT, 0.0, 1.0));
    float ring = smoothstep(0.06, 0.0, abs(r - rad));
    float a = ring * (1.0 - vT) * (1.0 - vT);
    if (a < 0.003) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;
const POST_VS = /* glsl */ `
  attribute float day;
  attribute float tip;
  attribute vec3 color;
  uniform float uDay;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float age = uDay - day;
    float grow = smoothstep(0.0, 30.0, age);
    vec3 p = position;
    p.y *= grow;
    vAlpha = step(0.0, age) * (1.0 - tip) * 0.9;
    vColor = color;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;
const POST_FS = /* glsl */ `
  varying float vAlpha;
  varying vec3 vColor;
  void main() { gl_FragColor = vec4(vColor, vAlpha); }
`;
const SKY_VS = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const SKY_FS = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 uGround;
  void main() {
    float h = vDir.y;
    // Llano night: the ground colour fades into a faint warm glow low on the horizon, then the night sky
    vec3 zenith = vec3(0.022, 0.026, 0.036);
    vec3 glow = vec3(0.07, 0.055, 0.045);
    vec3 col = mix(glow, zenith, smoothstep(0.0, 0.3, h));
    col = mix(col, uGround, smoothstep(0.02, -0.04, h));
    gl_FragColor = vec4(col, 1.0);
  }
`;
const STAR_VS = /* glsl */ `
  attribute float phase;
  uniform float uTime;
  uniform float uPx;
  varying float vA;
  void main() {
    vA = 0.35 + 0.35 * sin(uTime * 0.8 + phase * 40.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uPx * (1.0 + phase * 1.4);
  }
`;
const STAR_FS = /* glsl */ `
  varying float vA;
  void main() { gl_FragColor = vec4(vec3(0.78, 0.8, 0.86), vA * 0.5); }
`;

const VIEWS = {
  district: { target: new THREE.Vector3(0, 0, -2), radius: 330, polar: 1.02, azimuth: -0.3 },
  lubbock: { target: project(-101.875, 33.565), radius: 58, polar: 1.02, azimuth: -0.42 },
};

export function createWorld(o: WorldOptions): World {
  const { host, labels, points, still } = o;
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(GROUND, 260, 720);
  const camera = new THREE.PerspectiveCamera(34, 1, 4, 2000);
  const px = renderer.getPixelRatio();
  const time = { value: 0 };

  // Sky dome, stars and ground.
  const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16),
    new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { uGround: { value: new THREE.Color(GROUND) } } }));
  scene.add(sky);
  {
    const N = 900;
    const sp = new Float32Array(N * 3);
    const ph = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      // upper hemisphere only, denser towards the zenith
      const az = Math.random() * Math.PI * 2;
      const el = Math.asin(0.06 + 0.94 * Math.random());
      sp.set([Math.cos(el) * Math.sin(az) * 850, Math.sin(el) * 850, Math.cos(el) * Math.cos(az) * 850], i * 3);
      ph[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    g.setAttribute('phase', new THREE.BufferAttribute(ph, 1));
    const stars = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: STAR_VS, fragmentShader: STAR_FS,
      uniforms: { uTime: time, uPx: { value: px } }, transparent: true, depthWrite: false, fog: false }));
    stars.frustumCulled = false;
    scene.add(stars);
  }
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), new THREE.MeshBasicMaterial({ color: GROUND }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  scene.add(ground);

  // Counties: a faint fill (hover target) and anti-aliased boundary lines. An edge shared by two
  // counties is an inner line; an edge used once is the district boundary, drawn brighter.
  // Draw order is explicit: ground, county fills, county lines, then the lights on top of everything.
  const fillMat = () => new THREE.MeshBasicMaterial({ color: FILL, depthWrite: false });
  const edges = new Map<string, { a: THREE.Vector3; b: THREE.Vector3; uses: number }>();
  const countyMeshes: THREE.Mesh[] = [];
  const labelEls: { el: HTMLElement; at: THREE.Vector3; name: string }[] = [];
  for (const f of counties.features) {
    const polys = (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates) as number[][][][];
    for (const poly of polys) {
      const ring = poly[0].map(([lon, lat]) => project(lon, lat));
      const shape = new THREE.Shape(ring.map((v) => new THREE.Vector2(v.x, -v.z)));
      const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), fillMat());
      mesh.rotation.x = -Math.PI / 2;
      mesh.userData.name = f.properties.name;
      mesh.renderOrder = 1;
      scene.add(mesh);
      countyMeshes.push(mesh);
      poly[0].forEach((p, i) => {
        const q = poly[0][(i + 1) % poly[0].length];
        if (p[0] === q[0] && p[1] === q[1]) return;
        const key = [p.join(), q.join()].sort().join('|');
        const e = edges.get(key);
        if (e) e.uses++;
        else edges.set(key, { a: ring[i].clone().setY(0.12), b: ring[(i + 1) % ring.length].clone().setY(0.12), uses: 1 });
      });
      const box = new THREE.Box3().setFromPoints(ring);
      const el = document.createElement('span');
      el.textContent = f.properties.name.charAt(0) + f.properties.name.slice(1).toLowerCase();
      labels.append(el);
      labelEls.push({ el, at: box.getCenter(new THREE.Vector3()), name: f.properties.name });
    }
  }

  const lineMats: LineMaterial[] = [];
  const addLines = (positions: number[], color: number, width: number, opacity: number, order = 2) => {
    const g = new LineSegmentsGeometry().setPositions(positions);
    const m = new LineMaterial({ color, linewidth: width, transparent: true, opacity, depthWrite: false });
    m.resolution.set(host.clientWidth, host.clientHeight);
    lineMats.push(m);
    const l = new LineSegments2(g, m);
    l.renderOrder = order;
    scene.add(l);
  };
  const edgeList = (list: { a: THREE.Vector3; b: THREE.Vector3 }[]) => list.flatMap(({ a, b }) => [a.x, a.y, a.z, b.x, b.y, b.z]);
  const all = [...edges.values()];
  addLines(edgeList(all.filter((e) => e.uses > 1)), 0x58625a, 1, 0.55);
  addLines(edgeList(all.filter((e) => e.uses === 1)), 0x9aa797, 1.6, 0.8);

  // Roads, from Census TIGER/Line: loaded after the first frame so the crashes never wait for them.
  // A cool grey hierarchy under the warm severity colours: interstates brightest and widest, then US
  // and state highways (FM roads included); every street and county road as a hairline.
  const routeEls: { el: HTMLElement; at: THREE.Vector3; near: number }[] = [];
  let disposed = false;
  let streets: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | null = null;
  void import('../../data/roads.json').then(({ default: roads }) => {
    if (disposed) return;
    const segments = (lines: number[][], y: number) => {
      const out: number[] = [];
      for (const l of lines) {
        for (let i = 0; i + 3 < l.length; i += 2) {
          const a = project(l[i], l[i + 1]), b = project(l[i + 2], l[i + 3]);
          out.push(a.x, y, a.z, b.x, y, b.z);
        }
      }
      return out;
    };
    // Lakes and playas, then the built-up area of each town, both just above the county fills.
    const fills = (rings: number[][], color: number, y: number, order: number) => {
      const shapes = rings.filter((r) => r.length >= 6).map((r) => {
        const pts: THREE.Vector2[] = [];
        for (let i = 0; i + 1 < r.length; i += 2) { const p = project(r[i], r[i + 1]); pts.push(new THREE.Vector2(p.x, -p.z)); }
        return new THREE.Shape(pts);
      });
      const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shapes), new THREE.MeshBasicMaterial({ color, depthWrite: false }));
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = y;
      mesh.renderOrder = order;
      scene.add(mesh);
    };
    fills(roads.water, 0x0f1d27, 0.005, 1.2);
    fills(roads.places, 0x161b19, 0.01, 1.3);
    for (const [name, lon, lat, km2] of roads.towns as [string, number, number, number][]) {
      const el = document.createElement('i');
      el.textContent = name;
      if (km2 >= 100) el.dataset.size = 'city';
      labels.append(el);
      // Lubbock reads from the whole district, county seats from mid range, villages only up close
      routeEls.push({ el, at: project(lon, lat), near: km2 >= 100 ? 700 : km2 >= 5 ? 240 : 110 });
    }
    const local = new THREE.BufferGeometry();
    local.setAttribute('position', new THREE.Float32BufferAttribute(segments(roads.l, 0.02), 3));
    streets = new THREE.LineSegments(local, new THREE.LineBasicMaterial({ color: 0x3a4341, transparent: true, opacity: 0.32, depthWrite: false }));
    streets.renderOrder = 1.5;
    streets.frustumCulled = false;
    scene.add(streets);
    addLines(segments(roads.s, 0.04), 0x66737a, 1, 0.55, 1.6);
    addLines(segments(roads.u, 0.05), 0x8d9ba3, 1.4, 0.7, 1.7);
    addLines(segments(roads.i, 0.06), 0xc2ccd2, 2, 0.85, 1.8);
    for (const [text, lon, lat] of roads.labels as [string, number, number][]) {
      const el = document.createElement('b');
      el.textContent = text;
      el.dataset.route = text.slice(0, 2).trim().replace('-', '');
      labels.append(el);
      // state highway numbers appear only closer in, so the district view stays readable
      routeEls.push({ el, at: project(lon, lat), near: text.startsWith('SH') ? 170 : 300 });
    }
    dirty = true;
  });

  // Crash lights.
  const n = points.lon.length;
  const pos = new Float32Array(n * 3);
  const sev = new Float32Array(n);
  const day = new Float32Array(n);
  const phase = new Float32Array(n);
  const order = [...Array(n).keys()].sort((a, b) => SEV_INDEX[points.severity[b]] - SEV_INDEX[points.severity[a]]);
  order.forEach((src, i) => {
    const v = project(points.lon[src], points.lat[src]);
    pos.set([v.x, 0.08 + 0.01 * (3 - SEV_INDEX[points.severity[src]]), v.z], i * 3);
    sev[i] = SEV_INDEX[points.severity[src]];
    day[i] = points.day[src];
    phase[i] = (src * 0.618034) % 1; // deterministic spread, no Math.random so reloads look the same
  });
  const lastDay = Math.max(...points.day, 0);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('sev', new THREE.BufferAttribute(sev, 1));
  geo.setAttribute('day', new THREE.BufferAttribute(day, 1));
  geo.setAttribute('phase', new THREE.BufferAttribute(phase, 1));
  const uniforms = {
    uDay: { value: lastDay + HOLD }, // open on the full picture; play() replays from 2020
    uTime: time,
    uPx: { value: px },
    uColors: { value: SEV_COLOR },
  };
  const lights = new THREE.Points(geo, new THREE.ShaderMaterial({
    vertexShader: POINT_VS, fragmentShader: POINT_FS, uniforms,
    transparent: true, depthWrite: false, blending: THREE.NormalBlending,
  }));
  lights.frustumCulled = false;
  lights.renderOrder = 4;
  scene.add(lights);

  // K and A crashes stand as posts (K 5 km, A 2 km), fading towards the tip.
  const severe = order.filter((src) => points.severity[src] === 'K' || points.severity[src] === 'A');
  const pp = new Float32Array(severe.length * 6);
  const pd = new Float32Array(severe.length * 2);
  const pt = new Float32Array(severe.length * 2);
  const pc = new Float32Array(severe.length * 6);
  severe.forEach((src, i) => {
    const v = project(points.lon[src], points.lat[src]);
    const k = points.severity[src] === 'K';
    pp.set([v.x, 0.1, v.z, v.x, k ? 5 : 2, v.z], i * 6);
    pd.set([points.day[src], points.day[src]], i * 2);
    pt.set([0, 1], i * 2);
    const c = SEV_COLOR[k ? 0 : 1];
    pc.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6);
  });
  const postGeo = new THREE.BufferGeometry();
  postGeo.setAttribute('position', new THREE.BufferAttribute(pp, 3));
  postGeo.setAttribute('day', new THREE.BufferAttribute(pd, 1));
  postGeo.setAttribute('tip', new THREE.BufferAttribute(pt, 1));
  postGeo.setAttribute('color', new THREE.BufferAttribute(pc, 3));
  const posts = new THREE.LineSegments(postGeo, new THREE.ShaderMaterial({
    vertexShader: POST_VS, fragmentShader: POST_FS, uniforms,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  posts.frustumCulled = false;
  posts.renderOrder = 3;
  scene.add(posts);

  // Fatal-crash rings.
  const fatal = order.filter((src) => points.severity[src] === 'K');
  const rp = new Float32Array(fatal.length * 3);
  const rd = new Float32Array(fatal.length);
  fatal.forEach((src, i) => {
    const v = project(points.lon[src], points.lat[src]);
    rp.set([v.x, 0.06, v.z], i * 3);
    rd[i] = points.day[src];
  });
  const plane = new THREE.PlaneGeometry(1, 1);
  const ringGeo = new THREE.InstancedBufferGeometry();
  ringGeo.index = plane.index;
  ringGeo.setAttribute('position', plane.attributes.position);
  ringGeo.setAttribute('uv', plane.attributes.uv);
  ringGeo.setAttribute('offset', new THREE.InstancedBufferAttribute(rp, 3));
  ringGeo.setAttribute('day', new THREE.InstancedBufferAttribute(rd, 1));
  ringGeo.instanceCount = fatal.length;
  const rings = new THREE.Mesh(ringGeo, new THREE.ShaderMaterial({
    vertexShader: RING_VS, fragmentShader: RING_FS,
    uniforms: { uDay: uniforms.uDay, uColor: { value: SEV_COLOR[0] } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  }));
  rings.frustumCulled = false;
  rings.renderOrder = 3;
  scene.add(rings);

  // Bloom gives the lights their glow; it reads the HDR-ish additive sum, so dense corridors glow more.
  // The composer's own target is multisampled: without it the thin county lines break into dashes.
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType }));
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.22, 0.2, 0.8);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // Camera: spherical coordinates around a target, eased towards the wanted values each frame.
  // Narrow screens look down more steeply so the taller frame shows ground, not the horizon.
  const views = { ...VIEWS, district: { ...VIEWS.district, radius: host.clientWidth < 700 ? 500 : VIEWS.district.radius, polar: host.clientWidth < 700 ? 0.98 : VIEWS.district.polar } };
  const cam = { ...views.district, target: views.district.target.clone() };
  const want = { ...views.district, target: views.district.target.clone() };
  const place = () => {
    const { radius, polar, azimuth, target } = cam;
    camera.position.set(
      target.x + radius * Math.sin(polar) * Math.sin(azimuth),
      target.y + radius * Math.cos(polar),
      target.z + radius * Math.sin(polar) * Math.cos(azimuth),
    );
    camera.lookAt(target);
  };

  let playing = false;   // timeline and orbit together: one pause control stops all motion
  let holdUntil = 0;
  let idleSince = -Infinity;
  let selected: string | null = null;
  let active = true;
  let dirty = true;
  let raf = 0;
  let last = performance.now();
  const touch = () => { idleSince = performance.now(); };

  // Drag to turn the view, wheel to zoom; vertical page scrolling stays native on touch.
  let drag: { x: number; y: number; az: number; po: number; moved: boolean } | null = null;
  const paint = () => {
    for (const m of countyMeshes) {
      const name = m.userData.name as string;
      (m.material as THREE.MeshBasicMaterial).color.set(name === selected ? FILL_SELECTED : m === hovered ? FILL_HOVER : FILL);
    }
    dirty = true;
  };
  const canvas = renderer.domElement;
  canvas.style.touchAction = 'pan-y';
  const down = (e: PointerEvent) => {
    drag = { x: e.clientX, y: e.clientY, az: want.azimuth, po: want.polar, moved: false };
    canvas.setPointerCapture(e.pointerId);
    touch();
  };
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let hovered: THREE.Mesh | null = null;
  const hitAt = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return (raycaster.intersectObjects(countyMeshes)[0]?.object as THREE.Mesh | undefined) ?? null;
  };
  const move = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    if (drag) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
      want.azimuth = drag.az - (e.clientX - drag.x) * 0.005;
      want.polar = THREE.MathUtils.clamp(drag.po - (e.clientY - drag.y) * 0.003, 0.35, 1.3);
      touch();
      return;
    }
    const hit = hitAt(e);
    if (hit !== hovered) {
      hovered = hit;
      canvas.style.cursor = hovered ? 'pointer' : '';
      paint();
    }
    o.onHover(hovered ? hovered.userData.name : null, e.clientX - r.left, e.clientY - r.top);
  };
  // A press that did not move is a click: select the county under the pointer (or clear the selection).
  const up = (e: PointerEvent) => {
    if (drag && !drag.moved) o.onSelect((hitAt(e)?.userData.name as string | undefined) ?? null); // works for taps too
    drag = null;
  };
  const leave = () => {
    hovered = null;
    paint();
    o.onHover(null, 0, 0);
  };
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    want.radius = THREE.MathUtils.clamp(want.radius * Math.exp(e.deltaY * 0.0012), 25, 600);
    touch();
  };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', leave);
  canvas.addEventListener('wheel', wheel, { passive: false });

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = host;
    if (!w || !h) return; // not laid out yet: a zero-size bloom target is an incomplete framebuffer
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    for (const m of lineMats) m.resolution.set(w, h);
    camera.aspect = w / Math.max(h, 1);
    // Reframe the default district view on resize, without undoing a user zoom.
    const oldRadius = views.district.radius;
    views.district.radius = w < 700 ? 500 : VIEWS.district.radius;
    if (!selected && want.radius === oldRadius) cam.radius = want.radius = views.district.radius;
    camera.fov = w < 700 ? 46 : 34;
    // Lift the picture above the timeline bar without moving the orbit's centre.
    camera.setViewOffset(w, h, 0, h * 0.09, w, h);
    camera.updateProjectionMatrix();
    dirty = true;
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  const DAYS_PER_SECOND = lastDay / 22; // six years in about twenty-two seconds
  const v = new THREE.Vector3();

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (playing) {
      time.value += dt; // breathing and stars stop with the pause button too
      if (holdUntil) {
        if (now >= holdUntil) { holdUntil = 0; uniforms.uDay.value = 0; }
      } else {
        uniforms.uDay.value = Math.min(uniforms.uDay.value + dt * DAYS_PER_SECOND, lastDay + HOLD);
        if (uniforms.uDay.value >= lastDay + HOLD) holdUntil = now + LOOP_PAUSE * 1000;
      }
      o.onDay(Math.min(uniforms.uDay.value, lastDay));
      // the orbit drifts only while nobody is steering and no county is open
      if (!drag && !selected && now - idleSince > IDLE_RESUME * 1000) want.azimuth += dt * ORBIT;
      dirty = true;
    }
    const ease = 1 - Math.exp(-dt * 3.2);
    const before = cam.radius + cam.polar + cam.azimuth + cam.target.x + cam.target.z;
    cam.radius += (want.radius - cam.radius) * ease;
    cam.polar += (want.polar - cam.polar) * ease;
    cam.azimuth += (want.azimuth - cam.azimuth) * ease;
    cam.target.lerp(want.target, ease);
    if (Math.abs(before - (cam.radius + cam.polar + cam.azimuth + cam.target.x + cam.target.z)) > 1e-5) dirty = true;
    if (!dirty || !host.clientWidth || !host.clientHeight) return;
    dirty = false;
    place();
    // the street grid comes up as the camera nears a town, and stays a hairline from the whole district
    if (streets) streets.material.opacity = THREE.MathUtils.clamp(0.75 - cam.radius / 700, 0.28, 0.62);
    composer.render();
    const { clientWidth: w, clientHeight: h } = host;
    for (const { el, at, near } of [...labelEls.map((l) => ({ ...l, near: 420 })), ...routeEls]) {
      v.copy(at).project(camera);
      const visible = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
      el.style.opacity = visible ? String(THREE.MathUtils.clamp(1.4 - camera.position.distanceTo(at) / near, 0, 0.85)) : '0';
      el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -50%)`;
    }
  };

  resize();
  place();
  raf = requestAnimationFrame(frame);

  return {
    setDay(d) { uniforms.uDay.value = d; holdUntil = 0; dirty = true; },
    play() {
      if (uniforms.uDay.value >= lastDay) uniforms.uDay.value = 0;
      holdUntil = 0;
      idleSince = -Infinity;
      playing = true;
    },
    pause() { playing = false; holdUntil = 0; },
    isPlaying: () => playing,
    view(name) {
      const t = views[name];
      Object.assign(want, { radius: t.radius, polar: t.polar, azimuth: t.azimuth });
      want.target.copy(t.target);
      touch();
      if (still) Object.assign(cam, { ...want, target: want.target.clone() });
    },
    focus(county) {
      selected = county;
      paint();
      const at = labelEls.find((l) => l.name === county)?.at;
      if (at) {
        Object.assign(want, { radius: 120, polar: 1.05 });
        want.target.copy(at);
        if (still) Object.assign(cam, { ...want, target: want.target.clone() });
      }
    },
    setActive(a) {
      if (a === active) return;
      active = a;
      if (a) { last = performance.now(); dirty = true; raf = requestAnimationFrame(frame); }
      else cancelAnimationFrame(raf);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('wheel', wheel);
      scene.traverse((obj) => {
        const m = obj as THREE.Mesh;
        m.geometry?.dispose();
        (Array.isArray(m.material) ? m.material : m.material ? [m.material] : []).forEach((x) => x.dispose());
      });
      bloom.dispose();
      composer.dispose();
      renderer.dispose();
      canvas.remove();
      labels.replaceChildren();
    },
  };
}
