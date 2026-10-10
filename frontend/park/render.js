// The only module that touches Three.js. Builds the park scene from the pure model in
// placement.js, applies the real-clock sun, and maps harness state to the Ranger's clip and
// place through clips.js. Everything it shows comes from the frontend state, which comes
// from sidecar events; nothing here owns state.
//
//   createPark({ container, getState, onPick, onStatus })
//     -> { update(), setCameraMode(mode), cameraMode, destroy(), status }
//
// Loads Three.js through the import map in index.html (frontend/vendor/three). If that
// import fails the caller shows "renderer not vendored" instead of a scene.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { buildParkModel } from './placement.js';
import { TERRAIN } from './terrain.js';
import { pointAtFraction } from './spline.js';
import { clipFor, placeFor, badgeFor } from './clips.js';
import { sunFor } from './sun.js';

export const CAMERA_MODES = Object.freeze(['orbit', 'fly', 'follow']);

const ASSETS = {
  tree: ['nature-kit/tree_pineTallA.glb', 'nature-kit/tree_pineRoundA.glb', 'nature-kit/tree_oak.glb', 'nature-kit/tree_default.glb'],
  rock: ['nature-kit/rock_largeA.glb', 'nature-kit/rock_largeB.glb', 'nature-kit/rock_smallA.glb'],
  station: { structure: 'survival-kit/structure.glb', tent: 'survival-kit/tent.glb', campfire: 'survival-kit/campfire-pit.glb', signpost: 'survival-kit/signpost.glb' },
  gate: { doorway: 'survival-kit/fence-doorway.glb', fence: 'survival-kit/fence.glb', signpost: 'survival-kit/signpost.glb' },
  fixtures: { trailhead_sign: 'nature-kit/sign.glb', supply_cache: 'survival-kit/chest.glb' },
  ranger: { body: 'characters/characterMedium.fbx', skin: 'characters/skaterMaleA.png', clips: { idle: 'characters/idle.fbx', run: 'characters/run.fbx' } },
};

const WATER_VERT = `
  uniform float uTime;
  varying vec2 vUv;
  varying float vWave;
  void main() {
    vUv = uv;
    vec3 p = position;
    float w = sin(p.x * 0.35 + uTime * 1.3) * 0.12 + sin(p.y * 0.5 - uTime * 0.9) * 0.08;
    p.z += w;
    vWave = w;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }`;
const WATER_FRAG = `
  uniform vec3 uColor;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  varying vec2 vUv;
  varying float vWave;
  void main() {
    float glint = smoothstep(0.08, 0.2, vWave) * 0.5;
    vec3 c = uColor + vec3(glint);
    float depth = gl_FragCoord.z / gl_FragCoord.w;
    float f = smoothstep(uFogNear, uFogFar, depth);
    gl_FragColor = vec4(mix(c, uFogColor, f), 0.78);
  }`;

export async function createPark({ container, getState, onPick, onStatus = () => {} }) {
  const status = { renderer: 'webgl2', assets: 'loading', ranger: 'loading', fps: 0, problems: [] };
  const report = () => onStatus({ ...status });

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  container.append(renderer.domElement);
  renderer.domElement.style.display = 'block';

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.5, 900);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.minDistance = 6;
  controls.maxDistance = 220;

  const sky = new Sky();
  sky.scale.setScalar(4000);
  scene.add(sky);
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -90;
  sun.shadow.camera.right = 90;
  sun.shadow.camera.top = 90;
  sun.shadow.camera.bottom = -90;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 400;
  sun.shadow.bias = -0.0008;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x3b5a2a, 0.5);
  scene.add(hemi);
  scene.fog = new THREE.Fog(0xbcd6e8, 90, 320);

  const world = new THREE.Group();
  scene.add(world);
  const gltf = new GLTFLoader();
  const fbx = new FBXLoader();
  const texLoader = new THREE.TextureLoader();
  const loadGltf = (p) => new Promise((resolve, reject) => gltf.load(`/assets/${p}`, resolve, undefined, () => reject(new Error(`could not load ${p}`))));
  const loadFbx = (p) => new Promise((resolve, reject) => fbx.load(`/assets/${p}`, resolve, undefined, () => reject(new Error(`could not load ${p}`))));
  const loadTex = (p) => new Promise((resolve, reject) => texLoader.load(`/assets/${p}`, resolve, undefined, () => reject(new Error(`could not load ${p}`))));

  let model = null; // placement model for the current layout
  let modelKey = '';
  let terrain = null;
  let water = null;
  let foliage = [];
  const pickables = [];
  const dynamic = { fixtures: new Map(), clearings: new Map() };
  const timer = new THREE.Timer();
  let cameraPlaced = false;
  let cameraMode = 'orbit';
  let destroyed = false;
  let frames = 0;
  let fpsAt = performance.now();

  // ---- static kit models (loaded once, cloned per use) ----
  const kit = { trees: [], rocks: [], station: {}, gate: {}, fixtures: {} };
  async function loadKit() {
    const tryLoad = async (p) => {
      try {
        const g = await loadGltf(p);
        g.scene.traverse((o) => {
          if (o.isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
        });
        return g.scene;
      } catch (err) {
        status.problems.push(err.message);
        return null;
      }
    };
    kit.trees = (await Promise.all(ASSETS.tree.map(tryLoad))).filter(Boolean);
    kit.rocks = (await Promise.all(ASSETS.rock.map(tryLoad))).filter(Boolean);
    for (const [k, p] of Object.entries(ASSETS.station)) kit.station[k] = await tryLoad(p);
    for (const [k, p] of Object.entries(ASSETS.gate)) kit.gate[k] = await tryLoad(p);
    for (const [k, p] of Object.entries(ASSETS.fixtures)) kit.fixtures[k] = await tryLoad(p);
    status.assets = status.problems.length ? 'partial' : 'ready';
    report();
  }

  // ---- Ranger ----
  const ranger = { root: null, mixer: null, actions: {}, current: null, badge: null, height: 2.4 };
  async function loadRanger() {
    try {
      const body = await loadFbx(ASSETS.ranger.body);
      const skin = await loadTex(ASSETS.ranger.skin);
      skin.colorSpace = THREE.SRGBColorSpace;
      skin.flipY = false;
      body.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.material = new THREE.MeshStandardMaterial({ map: skin, roughness: 0.9, metalness: 0 });
          o.frustumCulled = false;
        }
      });
      const box = new THREE.Box3().setFromObject(body);
      const h = box.max.y - box.min.y || 1;
      const scale = ranger.height / h;
      body.scale.setScalar(scale);
      body.position.y = -box.min.y * scale;
      const root = new THREE.Group();
      root.add(body);
      root.userData.pick = { type: 'agent' };
      ranger.root = root;
      ranger.mixer = new THREE.AnimationMixer(body);
      for (const [name, p] of Object.entries(ASSETS.ranger.clips)) {
        try {
          const anim = await loadFbx(p);
          const clip = anim.animations && anim.animations[0];
          if (clip) ranger.actions[name] = ranger.mixer.clipAction(clip);
        } catch (err) {
          status.problems.push(err.message);
        }
      }
      ranger.badge = makeBadge();
      ranger.badge.position.y = ranger.height + 0.6;
      root.add(ranger.badge);
      pickables.push(root);
      world.add(root);
      status.ranger = Object.keys(ranger.actions).length ? 'ready' : 'static (no clips loaded)';
    } catch (err) {
      status.ranger = 'missing';
      status.problems.push(err.message);
    }
    report();
  }

  function makeBadge() {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sprite.scale.set(1.4, 1.4, 1);
    sprite.userData.canvas = canvas;
    sprite.userData.tex = tex;
    sprite.userData.kind = null;
    sprite.visible = false;
    return sprite;
  }

  function drawBadge(sprite, kind, t) {
    const ctx = sprite.userData.canvas.getContext('2d');
    ctx.clearRect(0, 0, 128, 128);
    if (!kind) {
      sprite.visible = false;
      return;
    }
    sprite.visible = true;
    const colors = { thinking: '#dfe6ff', tool: '#ffd36b', gate: '#ffb347', error: '#ff6b6b', done: '#9ff09a' };
    ctx.fillStyle = 'rgba(10,20,14,0.75)';
    ctx.beginPath();
    ctx.arc(64, 64, 52, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = colors[kind] || '#fff';
    ctx.lineWidth = 10;
    ctx.strokeStyle = colors[kind] || '#fff';
    if (kind === 'thinking') {
      for (let i = 0; i < 3; i++) {
        const phase = (t * 3 + i * 0.6) % 1.8;
        ctx.globalAlpha = 0.3 + 0.7 * Math.max(0, Math.sin(phase * Math.PI));
        ctx.beginPath();
        ctx.arc(40 + i * 24, 64, 9, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else if (kind === 'tool') {
      ctx.save();
      ctx.translate(64, 64);
      ctx.rotate(t * 2.5);
      for (let i = 0; i < 6; i++) {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos((i * Math.PI) / 3) * 36, Math.sin((i * Math.PI) / 3) * 36);
        ctx.stroke();
      }
      ctx.restore();
    } else if (kind === 'gate') {
      ctx.font = 'bold 72px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', 64, 68);
    } else if (kind === 'done') {
      ctx.beginPath();
      ctx.moveTo(34, 66);
      ctx.lineTo(56, 88);
      ctx.lineTo(96, 42);
      ctx.stroke();
    } else if (kind === 'error') {
      ctx.beginPath();
      ctx.moveTo(38, 38);
      ctx.lineTo(90, 90);
      ctx.moveTo(90, 38);
      ctx.lineTo(38, 90);
      ctx.stroke();
    }
    sprite.userData.tex.needsUpdate = true;
  }

  // ---- terrain, water, trails, clearings, foliage from the pure model ----
  function disposeGroup(g) {
    g.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material.dispose && !o.userData.sharedMaterial) o.material.dispose();
    });
  }

  function buildTerrain(m) {
    const seg = TERRAIN.segments;
    const geo = new THREE.PlaneGeometry(TERRAIN.size, TERRAIN.size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const grass = new THREE.Color(0x5e9a46);
    const dark = new THREE.Color(0x3f7433);
    const rock = new THREE.Color(0x8c8577);
    const sand = new THREE.Color(0xc9b58e);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = m.heightAt(x, z);
      pos.setY(i, y);
      const slope = Math.abs(m.heightAt(x + 1, z) - y) + Math.abs(m.heightAt(x, z + 1) - y);
      if (y < TERRAIN.waterLevel + 0.9) c.copy(sand);
      else if (slope > 1.6 || y > 14) c.copy(rock);
      else c.copy(grass).lerp(dark, Math.min(1, Math.max(0, (y + 2) / 14)));
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }));
    mesh.receiveShadow = true;
    mesh.userData.pick = { type: 'terrain' };
    return mesh;
  }

  function buildWater() {
    const geo = new THREE.PlaneGeometry(TERRAIN.size, TERRAIN.size, 60, 60);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(0x3d8fc2) },
        uFogColor: { value: scene.fog.color },
        uFogNear: { value: scene.fog.near },
        uFogFar: { value: scene.fog.far },
      },
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = TERRAIN.waterLevel;
    return mesh;
  }

  function buildTrail(m, trail) {
    const width = 2.2;
    const s = trail.table.samples;
    const verts = [];
    const idx = [];
    for (let i = 0; i < s.length; i++) {
      const a = s[Math.max(0, i - 1)];
      const b = s[Math.min(s.length - 1, i + 1)];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len;
      const nz = dx / len;
      const p = s[i];
      for (const side of [-1, 1]) {
        const x = p.x + nx * side * width * 0.5;
        const z = p.z + nz * side * width * 0.5;
        verts.push(x, m.heightAt(x, z) + 0.1, z);
      }
      if (i > 0) {
        const o = (i - 1) * 2;
        idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xb9a37c, roughness: 1, side: THREE.DoubleSide }));
    mesh.receiveShadow = true;
    mesh.userData.pick = { type: 'trail', id: trail.id };
    return mesh;
  }

  function place(obj, x, y, z, { rotation = 0, scale = 1 } = {}) {
    obj.position.set(x, y, z);
    obj.rotation.y = rotation;
    obj.scale.setScalar(scale);
    return obj;
  }

  function buildClearing(m, c) {
    const g = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CircleGeometry(c.radius, 40), new THREE.MeshStandardMaterial({ color: c.kind === 'gate' ? 0xc2ad86 : 0x6fae52, roughness: 1 }));
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(c.x, c.height + 0.06, c.z);
    disc.receiveShadow = true;
    disc.userData.pick = { type: c.kind === 'gate' ? 'gate' : 'zone', id: c.kind === 'gate' ? c.zoneId : c.id };
    g.add(disc);
    pickables.push(disc);
    const y = c.height;
    if (c.kind === 'zone') {
      if (kit.station.structure) g.add(place(kit.station.structure.clone(), c.x - c.radius * 0.45, y, c.z - c.radius * 0.45, { rotation: Math.PI / 6, scale: 4.2 }));
      if (kit.station.tent) g.add(place(kit.station.tent.clone(), c.x + c.radius * 0.5, y, c.z - c.radius * 0.4, { rotation: -Math.PI / 3, scale: 3.6 }));
      if (kit.station.campfire) g.add(place(kit.station.campfire.clone(), c.x + c.radius * 0.1, y, c.z + c.radius * 0.1, { scale: 2.8 }));
      if (kit.station.signpost) g.add(place(kit.station.signpost.clone(), c.x - c.radius * 0.6, y, c.z + c.radius * 0.55, { rotation: Math.PI / 2, scale: 3 }));
    } else {
      if (kit.gate.doorway) g.add(place(kit.gate.doorway.clone(), c.x, y, c.z, { scale: 4 }));
      if (kit.gate.fence) {
        for (const side of [-1, 1]) for (let k = 1; k <= 2; k++) g.add(place(kit.gate.fence.clone(), c.x + side * k * 5.2, y, c.z, { scale: 4 }));
      }
      if (kit.gate.signpost) g.add(place(kit.gate.signpost.clone(), c.x + 5.5, y, c.z + 3.5, { rotation: Math.PI, scale: 3 }));
    }
    g.traverse((o) => {
      if (o.isMesh && !o.userData.pick) o.userData.pick = disc.userData.pick;
    });
    return g;
  }

  function buildFoliage(m) {
    const out = [];
    const byKind = { tree: kit.trees, rock: kit.rocks };
    for (const kind of ['tree', 'rock']) {
      const variants = byKind[kind];
      if (!variants.length) continue;
      for (let v = 0; v < variants.length; v++) {
        const items = m.foliage.filter((f) => f.kind === kind && f.variant % variants.length === v);
        if (!items.length) continue;
        const source = variants[v];
        source.updateMatrixWorld(true);
        source.traverse((mesh) => {
          if (!mesh.isMesh) return;
          const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, items.length);
          inst.castShadow = true;
          inst.receiveShadow = true;
          const mat = new THREE.Matrix4();
          const local = mesh.matrixWorld.clone();
          const q = new THREE.Quaternion();
          const pos = new THREE.Vector3();
          const scl = new THREE.Vector3();
          items.forEach((it, i) => {
            const s = it.scale * (kind === 'tree' ? 2.6 : 2.2);
            q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), it.rotation);
            pos.set(it.x, it.y, it.z);
            scl.set(s, s, s);
            mat.compose(pos, q, scl).multiply(local);
            inst.setMatrixAt(i, mat);
          });
          inst.instanceMatrix.needsUpdate = true;
          inst.userData.sharedMaterial = true;
          out.push(inst);
        });
      }
    }
    return out;
  }

  function rebuild(state) {
    const layout = state.layout;
    const key = JSON.stringify({ seed: layout.seed, rooms: layout.rooms });
    if (key === modelKey && terrain) return;
    modelKey = key;
    for (const old of world.children.filter((o) => o.userData.static)) {
      world.remove(old);
      disposeGroup(old);
    }
    pickables.length = 0;
    if (ranger.root) pickables.push(ranger.root);
    dynamic.clearings.clear();
    model = buildParkModel(layout);
    terrain = buildTerrain(model);
    terrain.userData.static = true;
    world.add(terrain);
    pickables.push(terrain);
    water = buildWater();
    water.userData.static = true;
    world.add(water);
    for (const t of model.trails) {
      const mesh = buildTrail(model, t);
      mesh.userData.static = true;
      world.add(mesh);
    }
    for (const c of model.clearings) {
      const g = buildClearing(model, c);
      g.userData.static = true;
      world.add(g);
      dynamic.clearings.set(c.id, c);
    }
    foliage = buildFoliage(model);
    for (const f of foliage) {
      f.userData.static = true;
      world.add(f);
    }
    const station = model.clearings[0];
    if (station && !cameraPlaced) {
      controls.target.set(station.x, station.height + 1, station.z);
      camera.position.set(station.x + 18, station.height + 14, station.z + 30);
      cameraPlaced = true;
      controls.update();
    }
  }

  function syncFixtures(state) {
    if (!model) return;
    const wanted = new Map(model.fixtures.map((f) => [f.id, f]));
    for (const [id, obj] of dynamic.fixtures) {
      if (!wanted.has(id)) {
        world.remove(obj);
        dynamic.fixtures.delete(id);
        const i = pickables.indexOf(obj);
        if (i >= 0) pickables.splice(i, 1);
      }
    }
    for (const f of model.fixtures) {
      if (dynamic.fixtures.has(f.id)) continue;
      const proto = kit.fixtures[f.kind];
      const obj = proto ? proto.clone() : new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), new THREE.MeshStandardMaterial({ color: 0xffffff }));
      place(obj, f.x, f.y, f.z, { scale: proto ? 3.2 : 1 });
      obj.userData.pick = { type: 'object', id: f.id };
      obj.traverse((o) => (o.userData.pick = obj.userData.pick));
      world.add(obj);
      pickables.push(obj);
      dynamic.fixtures.set(f.id, obj);
    }
  }

  // ---- per-frame ----
  function applySun() {
    const s = sunFor(new Date());
    const dir = new THREE.Vector3(s.direction.x, s.direction.y, s.direction.z);
    sun.position.copy(dir).multiplyScalar(180);
    sun.target.position.set(0, 0, 0);
    sun.intensity = s.intensity;
    sun.color.setHex(s.color);
    hemi.intensity = s.ambient;
    scene.fog.color.setHex(s.fog);
    const u = sky.material.uniforms;
    u.sunPosition.value.copy(dir);
    u.turbidity.value = s.night ? 2 : 6;
    u.rayleigh.value = s.night ? 0.2 : 1.8;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.8;
    renderer.toneMappingExposure = s.night ? 0.35 : 0.85;
  }

  const walkerState = { lastHandoffKey: null, handoff: null };
  function updateRanger(state, dt, t) {
    if (!ranger.root || !model) return;
    const agent = model.agents[0];
    if (!agent) return;
    const agentState = state.agentStates[agent.id] || 'idle';
    const gate = model.clearings.find((c) => c.kind === 'gate');
    const h = state.handoffs ? state.handoffs[agent.id] : null;
    const key = h ? `${h.workItemId}:${h.startedAt}` : null;
    if (key !== walkerState.lastHandoffKey) {
      walkerState.lastHandoffKey = key;
      walkerState.handoff = null;
      if (h) {
        const trail = model.trails.find((tr) => (tr.from === h.fromZone && tr.to === h.toZone) || (tr.from === h.toZone && tr.to === h.fromZone));
        if (trail) {
          const reversed = trail.from !== h.fromZone;
          const table = reversed ? reverseTable(trail.table) : trail.table;
          walkerState.handoff = { trail: { ...trail, table }, startedAt: h.startedAt };
        }
      }
    }
    const p = placeFor({ agentState, home: agent.home, gate, handoff: walkerState.handoff, now: Date.now(), pointAtFraction });
    const y = model.heightAt(p.x, p.z);
    ranger.root.position.set(p.x, y, p.z);
    ranger.root.rotation.y = p.walking ? p.heading : p.heading;
    const clip = clipFor(agentState, p.walking);
    const action = ranger.actions[clip === 'walk' ? 'run' : clip === 'work' ? 'idle' : clip === 'error' ? 'idle' : 'idle'];
    if (action && ranger.current !== action) {
      if (ranger.current) ranger.current.fadeOut(0.2);
      action.reset().fadeIn(0.2).play();
      ranger.current = action;
    }
    if (ranger.current) ranger.current.paused = clip === 'error';
    if (ranger.mixer) ranger.mixer.update(dt);
    drawBadge(ranger.badge, badgeFor(agentState), t);
  }

  function reverseTable(table) {
    const samples = [...table.samples].reverse().map((s, i, arr) => ({ ...s, dist: table.length - s.dist, t: i / (arr.length - 1) }));
    return { samples, length: table.length };
  }

  function updateCamera(dt, t) {
    if (cameraMode === 'follow' && ranger.root) {
      const target = ranger.root.position.clone();
      const behind = new THREE.Vector3(Math.sin(ranger.root.rotation.y + Math.PI), 0.55, Math.cos(ranger.root.rotation.y + Math.PI)).multiplyScalar(9);
      camera.position.lerp(target.clone().add(behind).add(new THREE.Vector3(0, 2.5, 0)), Math.min(1, dt * 3));
      controls.target.lerp(target.add(new THREE.Vector3(0, 1.6, 0)), Math.min(1, dt * 5));
      controls.update();
    } else if (cameraMode === 'fly') {
      const r = 95;
      const station = model ? model.clearings[0] : { x: 0, z: 0, height: 0 };
      camera.position.set(station.x + Math.cos(t * 0.08) * r, station.height + 48, station.z + Math.sin(t * 0.08) * r);
      controls.target.set(station.x, station.height, station.z);
      controls.update();
    } else {
      controls.update();
    }
  }

  function resize() {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }

  // ---- picking ----
  const raycaster = new THREE.Raycaster();
  let down = null;
  const onDown = (e) => (down = { x: e.clientX, y: e.clientY });
  const onUp = (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return (down = null);
    down = null;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(pickables, true);
    const state = getState();
    for (const hit of hits) {
      let o = hit.object;
      while (o && !o.userData.pick) o = o.parent;
      if (!o) continue;
      const pick = o.userData.pick;
      if (pick.type === 'agent') return onPick({ type: 'agent', agent: state.layout.agents[0] });
      if (pick.type === 'object') return onPick({ type: 'object', object: state.layout.objects.find((ob) => ob.id === pick.id) });
      const point = { x: hit.point.x, z: hit.point.z };
      if (pick.type === 'zone') return onPick({ type: 'zone', room: state.layout.rooms.find((r) => r.id === pick.id), point });
      if (pick.type === 'gate') return onPick({ type: 'gate', room: state.layout.rooms.find((r) => r.id === pick.id), point });
      if (pick.type === 'terrain' && model) {
        const c = model.clearings.find((cl) => Math.hypot(cl.x - hit.point.x, cl.z - hit.point.z) < cl.radius);
        if (c) return onPick(c.kind === 'gate' ? { type: 'gate', room: state.layout.rooms.find((r) => r.id === c.zoneId), point } : { type: 'zone', room: state.layout.rooms.find((r) => r.id === c.id), point });
        return onPick({ type: 'ground', point });
      }
    }
    onPick(null);
  };
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('pointerup', onUp);
  window.addEventListener('resize', resize);

  await loadKit();
  resize();
  rebuild(getState());
  syncFixtures(getState());
  loadRanger(); // not awaited: the park renders while the FBX files stream in

  function frame() {
    if (destroyed) return;
    requestAnimationFrame(frame);
    timer.update();
    const dt = Math.min(0.1, timer.getDelta());
    const t = timer.getElapsed();
    const state = getState();
    rebuild(state);
    syncFixtures(state);
    applySun();
    if (water) water.material.uniforms.uTime.value = t;
    updateRanger(state, dt, t);
    updateCamera(dt, t);
    renderer.render(scene, camera);
    frames++;
    const now = performance.now();
    if (now - fpsAt > 1000) {
      status.fps = Math.round((frames * 1000) / (now - fpsAt));
      frames = 0;
      fpsAt = now;
      report();
    }
  }
  frame();
  report();

  return {
    status,
    get cameraMode() {
      return cameraMode;
    },
    setCameraMode(mode) {
      if (!CAMERA_MODES.includes(mode)) return;
      cameraMode = mode;
      controls.enabled = mode === 'orbit';
    },
    update() {
      /* state is read every frame */
    },
    destroy() {
      destroyed = true;
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      window.removeEventListener('resize', resize);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
