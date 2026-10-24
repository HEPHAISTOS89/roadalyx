import * as THREE from 'three';
import counties from '../../data/counties.json';
import type { Points } from '../../lib/types';

/**
 * The Lubbock District at night, drawn from data: county lines from the Census boundary file,
 * one light per located crash at its CRIS coordinates. Fatal and serious-injury crashes stand
 * as thin posts. Nothing in the scene is invented: the road network you see is the crashes.
 *
 * Scene units are kilometres on a local equirectangular projection centred on the district.
 */

const LON0 = -102.05;
const LAT0 = 33.62;
const KX = 111.32 * Math.cos((LAT0 * Math.PI) / 180);
const KZ = 110.57;
export const project = (lon: number, lat: number) => new THREE.Vector3((lon - LON0) * KX, 0, -(lat - LAT0) * KZ);

const GROUND = 0x0b0c0b;
const FILL = 0x0d0e0d;
const FILL_HOVER = 0x1a1f1a;
const FILL_SELECTED = 0x23302a;
const SEV_INDEX: Record<string, number> = { K: 0, A: 1, B: 2, C: 3 };
// Same ramp as --sev-* in tokens.css (validated ordinal ramp: lightness falls from C to K).
const SEV_COLOR = ['#d31246', '#f27000', '#e7b63b', '#d0d8e1'].map((c) => new THREE.Color(c));

export interface CountyStat { name: string; crashes: number; ka: number }
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
  uniform float uDay;
  uniform float uPx;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSpark;
  uniform vec3 uColors[4];
  void main() {
    float age = uDay - day;
    float shown = step(0.0, age);
    // a crash flares for its first 40 days on the timeline, then settles to its resting light
    vSpark = shown * (1.0 - smoothstep(0.0, 40.0, age));
    int s = int(sev + 0.5);
    vColor = uColors[s];
    float base = s == 0 ? 7.0 : s == 1 ? 5.0 : s == 2 ? 3.2 : 2.4;
    vAlpha = shown * (s == 3 ? 0.55 : s == 2 ? 0.75 : 1.0);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float dist = max(-mv.z, 1.0);
    gl_PointSize = shown * uPx * base * (1.0 + 1.6 * vSpark) * clamp(220.0 / dist, 0.55, 1.8);
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
    float core = smoothstep(0.35, 0.0, r);
    float halo = (1.0 - r) * 0.35;
    vec3 col = mix(vColor, vec3(1.0), 0.55 * vSpark + 0.25 * core);
    gl_FragColor = vec4(col, vAlpha * (core + halo));
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
    vAlpha = step(0.0, age) * (1.0 - tip) * 0.85;
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
    vec3 zenith = vec3(0.028, 0.032, 0.04);
    vec3 glow = vec3(0.058, 0.05, 0.043);
    vec3 col = mix(glow, zenith, smoothstep(0.0, 0.32, h));
    col = mix(col, uGround, smoothstep(0.02, -0.04, h));
    gl_FragColor = vec4(col, 1.0);
  }
`;

const VIEWS = {
  district: { target: new THREE.Vector3(6, 0, -14), radius: 215, polar: 1.27, azimuth: -0.3 },
  lubbock: { target: project(-101.875, 33.565), radius: 58, polar: 1.02, azimuth: -0.42 },
};

export function createWorld(o: WorldOptions): World {
  const { host, labels, points, still } = o;
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(GROUND, 260, 700);
  const camera = new THREE.PerspectiveCamera(34, 1, 0.5, 2000);

  // Sky dome and ground.
  const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16),
    new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { uGround: { value: new THREE.Color(GROUND) } } }));
  scene.add(sky);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), new THREE.MeshBasicMaterial({ color: GROUND }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  scene.add(ground);

  // Counties: a faint fill (hover target) and survey lines.
  // Draw order is explicit: ground, county fills, county lines, then the lights on top of everything.
  const fillMat = () => new THREE.MeshBasicMaterial({ color: FILL, depthWrite: false });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x343b34 });
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
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ring.map((v) => v.clone().setY(0.02))), edgeMat);
      line.renderOrder = 2;
      scene.add(line);
      const box = new THREE.Box3().setFromPoints(ring);
      const el = document.createElement('span');
      el.textContent = f.properties.name.charAt(0) + f.properties.name.slice(1).toLowerCase();
      labels.append(el);
      labelEls.push({ el, at: box.getCenter(new THREE.Vector3()), name: f.properties.name });
    }
  }

  // Crash lights.
  const n = points.lon.length;
  const pos = new Float32Array(n * 3);
  const sev = new Float32Array(n);
  const day = new Float32Array(n);
  const order = [...Array(n).keys()].sort((a, b) => SEV_INDEX[points.severity[b]] - SEV_INDEX[points.severity[a]]);
  order.forEach((src, i) => {
    const v = project(points.lon[src], points.lat[src]);
    pos.set([v.x, 0.08 + 0.01 * (3 - SEV_INDEX[points.severity[src]]), v.z], i * 3);
    sev[i] = SEV_INDEX[points.severity[src]];
    day[i] = points.day[src];
  });
  const lastDay = Math.max(...points.day, 0);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('sev', new THREE.BufferAttribute(sev, 1));
  geo.setAttribute('day', new THREE.BufferAttribute(day, 1));
  const uniforms = {
    uDay: { value: lastDay + 40 }, // open on the full picture; the timeline replays on demand
    uPx: { value: renderer.getPixelRatio() },
    uColors: { value: SEV_COLOR },
  };
  const lights = new THREE.Points(geo, new THREE.ShaderMaterial({
    vertexShader: POINT_VS, fragmentShader: POINT_FS, uniforms,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
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

  // Camera: spherical coordinates around a target, eased towards the wanted values each frame.
  const cam = { ...VIEWS.district, target: VIEWS.district.target.clone() };
  const want = { ...VIEWS.district, target: VIEWS.district.target.clone() };
  const place = () => {
    const { radius, polar, azimuth, target } = cam;
    camera.position.set(
      target.x + radius * Math.sin(polar) * Math.sin(azimuth),
      target.y + radius * Math.cos(polar),
      target.z + radius * Math.sin(polar) * Math.cos(azimuth),
    );
    camera.lookAt(target);
  };

  // Drag to turn the view; vertical page scrolling stays native.
  let drag: { x: number; y: number; az: number; po: number; moved: boolean } | null = null;
  let selected: string | null = null;
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
      want.polar = THREE.MathUtils.clamp(drag.po - (e.clientY - drag.y) * 0.003, 0.35, 1.25);
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
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', leave);

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = host;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(h, 1);
    // narrow screens see the whole district by stepping back
    camera.fov = w < 700 ? 46 : 34;
    // On wide screens the headline owns the left third: shift the projection so the district sits right of it.
    if (w >= 1000) camera.setViewOffset(w, h, -w * 0.22, h * 0.06, w, h);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
    dirty = true;
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  let playing = false;
  let active = true;
  let dirty = true;
  let raf = 0;
  let last = performance.now();
  const DAYS_PER_SECOND = lastDay / 16; // six years in about sixteen seconds
  const v = new THREE.Vector3();

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (playing) {
      uniforms.uDay.value = Math.min(uniforms.uDay.value + dt * DAYS_PER_SECOND, lastDay + 40);
      o.onDay(Math.min(uniforms.uDay.value, lastDay));
      if (uniforms.uDay.value >= lastDay + 40) playing = false;
      dirty = true;
    }
    const ease = 1 - Math.exp(-dt * 3.2);
    const before = cam.radius + cam.polar + cam.azimuth + cam.target.x + cam.target.z;
    cam.radius += (want.radius - cam.radius) * ease;
    cam.polar += (want.polar - cam.polar) * ease;
    cam.azimuth += (want.azimuth - cam.azimuth) * ease;
    cam.target.lerp(want.target, ease);
    if (Math.abs(before - (cam.radius + cam.polar + cam.azimuth + cam.target.x + cam.target.z)) > 1e-5) dirty = true;
    if (!dirty) return;
    dirty = false;
    place();
    renderer.render(scene, camera);
    const { clientWidth: w, clientHeight: h } = host;
    for (const { el, at } of labelEls) {
      v.copy(at).project(camera);
      const visible = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
      el.style.opacity = visible ? String(THREE.MathUtils.clamp(1.4 - camera.position.distanceTo(at) / 420, 0, 0.85)) : '0';
      el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -50%)`;
    }
  };

  resize();
  place();
  raf = requestAnimationFrame(frame);

  return {
    setDay(d) { uniforms.uDay.value = d; dirty = true; },
    play() {
      if (uniforms.uDay.value >= lastDay) uniforms.uDay.value = 0;
      playing = true;
    },
    pause() { playing = false; },
    isPlaying: () => playing,
    view(name) {
      const t = VIEWS[name];
      Object.assign(want, { radius: t.radius, polar: t.polar, azimuth: t.azimuth });
      want.target.copy(t.target);
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
      if (a) { last = performance.now(); raf = requestAnimationFrame(frame); }
      else cancelAnimationFrame(raf);
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('pointerleave', leave);
      scene.traverse((obj) => {
        const m = obj as THREE.Mesh;
        m.geometry?.dispose();
        (Array.isArray(m.material) ? m.material : m.material ? [m.material] : []).forEach((x) => x.dispose());
      });
      renderer.dispose();
      canvas.remove();
      labels.replaceChildren();
    },
  };
}
