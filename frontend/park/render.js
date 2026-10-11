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
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { buildParkModel } from './placement.js';
import { TERRAIN } from './terrain.js';
import { pointAtFraction } from './spline.js';
import { clipFor, placeFor, badgeFor, lookFor, lampsFor } from './clips.js';
import { sunFor } from './sun.js';

export const CAMERA_MODES = Object.freeze(['orbit', 'fly', 'follow']);

const ASSETS = {
  tree: ['nature-kit/tree_pineTallA.glb', 'nature-kit/tree_pineRoundA.glb', 'nature-kit/tree_oak.glb', 'nature-kit/tree_default.glb'],
  rock: ['nature-kit/rock_largeA.glb', 'nature-kit/rock_largeB.glb', 'nature-kit/rock_smallA.glb'],
  station: { structure: 'survival-kit/structure.glb', tent: 'survival-kit/tent.glb', campfire: 'survival-kit/campfire-pit.glb', signpost: 'survival-kit/signpost.glb', tentOpen: 'nature-kit/tent_detailedOpen.glb', crate: 'survival-kit/box.glb', logs: 'nature-kit/campfire_logs.glb', fenceGate: 'nature-kit/fence_gate.glb', fenceSimple: 'nature-kit/fence_simple.glb' },
  gate: { doorway: 'survival-kit/fence-doorway.glb', fence: 'survival-kit/fence.glb', signpost: 'survival-kit/signpost.glb' },
  fixtures: { trailhead_sign: 'nature-kit/sign.glb', supply_cache: 'survival-kit/chest.glb' }, // radio_tower, field_office and outpost are built in code (makeTower, makeFieldOffice, makeOutpost)
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

// How each zone kind is dressed (data; kit pieces by key from ASSETS.station). The Ranger
// Station keeps its phase 1 look; camps are tents around a fire; the Visitor Center is a
// building with a counter crate; a trailhead is a signpost and a gate.
const ZONE_DRESS = {
  ranger_station: [['structure', -0.45, -0.45, Math.PI / 6, 4.2], ['tent', 0.5, -0.4, -Math.PI / 3, 3.6], ['campfire', 0.1, 0.1, 0, 2.8], ['signpost', -0.6, 0.55, Math.PI / 2, 3]],
  visitor_center: [['structure', 0, -0.4, 0, 4.6], ['crate', -0.45, 0.35, 0.3, 3], ['crate', -0.25, 0.4, -0.2, 3], ['signpost', 0.55, 0.45, Math.PI, 3]],
  trailhead: [['signpost', 0, 0, Math.PI / 4, 3.4], ['fenceGate', 0, 0.5, 0, 3.2], ['logs', -0.5, -0.3, 0, 2.4]],
  camp: [['tentOpen', -0.5, -0.4, Math.PI / 5, 3.4], ['tent', 0.5, -0.45, -Math.PI / 4, 3.4], ['campfire', 0, 0.15, 0, 2.6], ['signpost', -0.55, 0.55, Math.PI / 2, 3], ['crate', 0.55, 0.5, 0, 2.6]],
};
const DISC_COLORS = { gate: 0xc2ad86, peak: 0x9a948a, visitor_center: 0x8fbf6a, trailhead: 0x7fb15a, zone: 0x6fae52 };

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

  // ---- Rangers: one rigged template, cloned per agent (phase 2 step 7) ----
  const BODY_HEIGHT = 2.4;
  const template = { body: null, skin: null, clips: {}, baseScale: 1, baseY: 0 };
  const bodies = new Map(); // agentId -> { root, mixer, actions, current, badge, agent, look, walk: {...} }
  async function loadRanger() {
    try {
      const body = await loadFbx(ASSETS.ranger.body);
      const skin = await loadTex(ASSETS.ranger.skin);
      skin.colorSpace = THREE.SRGBColorSpace;
      skin.flipY = false;
      body.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.frustumCulled = false;
        }
      });
      const box = new THREE.Box3().setFromObject(body);
      const h = box.max.y - box.min.y || 1;
      const clips = {};
      for (const [name, p] of Object.entries(ASSETS.ranger.clips)) {
        try {
          const anim = await loadFbx(p);
          const clip = anim.animations && anim.animations[0];
          if (clip) clips[name] = clip;
        } catch (err) {
          status.problems.push(err.message);
        }
      }
      // The template is published only once its clips are in, so every clone gets actions.
      template.baseScale = BODY_HEIGHT / h;
      template.baseY = -box.min.y * template.baseScale;
      template.skin = skin;
      template.clips = clips;
      template.body = body;
      status.ranger = Object.keys(template.clips).length ? 'ready' : 'static (no clips loaded)';
    } catch (err) {
      status.ranger = 'missing';
      status.problems.push(err.message);
    }
    report();
  }

  function makeBody(agent) {
    if (!template.body) return null;
    const look = lookFor(agent);
    const body = SkeletonUtils.clone(template.body);
    body.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.frustumCulled = false;
        o.material = new THREE.MeshStandardMaterial({ map: template.skin, color: look.tint, roughness: 0.9, metalness: 0 });
      }
    });
    const scale = template.baseScale * look.scale;
    body.scale.setScalar(scale);
    body.position.y = template.baseY * look.scale;
    const root = new THREE.Group();
    root.add(body);
    root.userData.pick = { type: 'agent', id: agent.id };
    const mixer = new THREE.AnimationMixer(body);
    const actions = {};
    for (const [name, clip] of Object.entries(template.clips)) actions[name] = mixer.clipAction(clip);
    const badge = makeBadge();
    badge.position.y = BODY_HEIGHT * look.scale + 0.6;
    root.add(badge);
    const label = makeLabel(agent.name);
    label.position.y = BODY_HEIGHT * look.scale + 1.5;
    root.add(label);
    return { root, mixer, actions, current: null, badge, label, agent, look, walk: { handoffKey: null, handoff: null, deliveryKey: null, delivery: null } };
  }

  function makeLabel(text) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.font = '600 30px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(10,20,14,0.6)';
    ctx.fillRect(0, 8, 256, 48);
    ctx.fillStyle = '#eef5ea';
    ctx.fillText(String(text).slice(0, 18), 128, 32);
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sprite.scale.set(3.2, 0.8, 1);
    return sprite;
  }

  // Bodies follow the layout's agents: new agents get a body, removed agents lose it, a
  // changed role, name or pause changes the look.
  function syncBodies(state) {
    if (!template.body || !model) return;
    const wanted = new Map(model.agents.map((a) => [a.id, a]));
    for (const [id, b] of bodies) {
      const a = wanted.get(id);
      if (!a || a.role !== b.agent.role || a.name !== b.agent.name || Boolean(a.paused) !== Boolean(b.agent.paused)) {
        world.remove(b.root);
        const i = pickables.indexOf(b.root);
        if (i >= 0) pickables.splice(i, 1);
        bodies.delete(id);
      }
    }
    for (const a of model.agents) {
      if (bodies.has(a.id)) continue;
      const b = makeBody(a);
      if (!b) continue;
      bodies.set(a.id, b);
      world.add(b.root);
      pickables.push(b.root);
    }
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
    const colors = { thinking: '#dfe6ff', tool: '#ffd36b', gate: '#ffb347', error: '#ff6b6b', done: '#9ff09a', paused: '#bbbbbb' };
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
    } else if (kind === 'paused') {
      ctx.fillRect(40, 36, 16, 56);
      ctx.fillRect(72, 36, 16, 56);
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
    const discColor = c.kind === 'gate' ? DISC_COLORS.gate : c.kind === 'peak' ? DISC_COLORS.peak : DISC_COLORS[c.zoneKind] || DISC_COLORS.zone;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(c.radius, 40), new THREE.MeshStandardMaterial({ color: discColor, roughness: 1 }));
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(c.x, c.height + 0.06, c.z);
    disc.receiveShadow = true;
    disc.userData.pick = { type: c.kind === 'gate' ? 'gate' : c.kind === 'peak' ? 'peak' : 'zone', id: c.kind === 'gate' ? c.zoneId : c.id };
    g.add(disc);
    pickables.push(disc);
    const y = c.height;
    if (c.kind === 'zone') {
      const dress = ZONE_DRESS[c.zoneKind] || (c.zoneKind ? ZONE_DRESS.camp : ZONE_DRESS.ranger_station);
      for (const [key, fx, fz, rotation, scale] of dress) {
        const proto = kit.station[key];
        if (proto) g.add(place(proto.clone(), c.x + c.radius * fx, y, c.z + c.radius * fz, { rotation, scale }));
      }
      const sign = makeLabel(c.name);
      sign.position.set(c.x, y + 5.5, c.z);
      sign.scale.set(6, 1.5, 1);
      g.add(sign);
    } else if (c.kind === 'peak') {
      if (kit.station.structure) g.add(place(kit.station.structure.clone(), c.x, y, c.z - 1.5, { rotation: Math.PI / 5, scale: 3.4 }));
      if (kit.station.signpost) g.add(place(kit.station.signpost.clone(), c.x + 4, y, c.z + 3, { rotation: Math.PI / 3, scale: 3 }));
      if (kit.station.campfire) g.add(place(kit.station.campfire.clone(), c.x - 3.5, y, c.z + 2.5, { scale: 2.4 }));
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
    // Trails depend on which agents serve which venture, so the key includes that too.
    const key = JSON.stringify({ seed: layout.seed, rooms: layout.rooms, agents: layout.agents.map((a) => [a.id, a.roomId, a.venture || null, a.x, a.y]) });
    if (key === modelKey && terrain) return;
    modelKey = key;
    for (const old of world.children.filter((o) => o.userData.static)) {
      world.remove(old);
      disposeGroup(old);
    }
    pickables.length = 0;
    for (const b of bodies.values()) pickables.push(b.root);
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
      pickables.push(mesh);
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

  // The Radio tower: an original Maka piece made from primitives (no kit has one).
  function makeTower() {
    const g = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.6, metalness: 0.5 });
    const red = new THREE.MeshStandardMaterial({ color: 0xd94b3d, roughness: 0.7 });
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.28, 7, 8), steel);
    mast.position.y = 3.5;
    mast.castShadow = true;
    g.add(mast);
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.6 - i * 0.15, 0.04, 6, 16), steel);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 1.5 + i * 2;
      g.add(ring);
    }
    const dish = new THREE.Mesh(new THREE.SphereGeometry(0.7, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), steel);
    dish.rotation.x = -Math.PI / 2.4;
    dish.position.set(0.5, 5.6, 0);
    g.add(dish);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 8), red);
    beacon.position.y = 7.1;
    g.add(beacon);
    // Channel lamps (phase 4 step 3): one per owner channel when the tower stands at the
    // Peak, lit only by what channel.connect proved. Hidden until syncLamps shows them.
    g.userData.lamps = [];
    for (let i = 0; i < 4; i++) {
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), new THREE.MeshStandardMaterial({ color: 0x4a4f55, emissive: 0x000000, emissiveIntensity: 0 }));
      lamp.position.set(Math.cos((i / 4) * Math.PI * 2) * 0.75, 4.6, Math.sin((i / 4) * Math.PI * 2) * 0.75);
      lamp.visible = false;
      g.add(lamp);
      g.userData.lamps.push(lamp);
    }
    return g;
  }

  // The lamps on a Peak tower follow the channel registry's rows; a camp tower shows none.
  function syncLamps(state) {
    if (!model) return;
    const peakRooms = new Set(state.layout.rooms.filter((r) => r.kind === 'mountain_peak').map((r) => r.id));
    for (const f of model.fixtures) {
      if (f.kind !== 'radio_tower') continue;
      const obj = dynamic.fixtures.get(f.id);
      if (!obj || !obj.userData.lamps) continue;
      const lamps = lampsFor(state.channels, { atPeak: peakRooms.has(f.roomId) });
      obj.userData.lamps.forEach((lamp, i) => {
        const l = lamps[i];
        lamp.visible = Boolean(l);
        if (!l) return;
        lamp.material.color.setHex(l.look.color);
        lamp.material.emissive.setHex(l.look.emissive);
        lamp.material.emissiveIntensity = l.look.intensity;
      });
    }
  }

  // Field office (step 13): a small cabin with a lit screen, built from primitives.
  function makeFieldOffice() {
    const g = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: 0x8a6a46, roughness: 0.9 });
    const roofM = new THREE.MeshStandardMaterial({ color: 0x4e5b4a, roughness: 0.8 });
    const glow = new THREE.MeshStandardMaterial({ color: 0x9fd8ff, emissive: 0x3aa0ff, emissiveIntensity: 0.8 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.6, 2.0), wood);
    body.position.y = 0.8;
    body.castShadow = true;
    g.add(body);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(1.9, 1.0, 4), roofM);
    roof.rotation.y = Math.PI / 4;
    roof.position.y = 2.1;
    roof.castShadow = true;
    g.add(roof);
    const screen = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.6, 0.05), glow);
    screen.position.set(0, 1.0, 1.03);
    g.add(screen);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4, 6), new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 0.5 }));
    mast.position.set(0.9, 3.0, -0.6);
    g.add(mast);
    return g;
  }

  // Outpost (phase 4 step 4): a crate under a pennant pole, built from primitives.
  function makeOutpost() {
    const g = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.9 });
    const cloth = new THREE.MeshStandardMaterial({ color: 0x3a7bd5, roughness: 0.8, side: THREE.DoubleSide });
    const crate = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.0, 1.4), wood);
    crate.position.y = 0.5;
    crate.castShadow = true;
    g.add(crate);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 4.2, 6), new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 0.4 }));
    pole.position.set(0.5, 2.1, -0.5);
    g.add(pole);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.7), cloth);
    flag.position.set(1.15, 3.8, -0.5);
    g.add(flag);
    return g;
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
      const obj = proto ? proto.clone() : f.kind === 'radio_tower' ? makeTower() : f.kind === 'field_office' ? makeFieldOffice() : f.kind === 'outpost' ? makeOutpost() : new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), new THREE.MeshStandardMaterial({ color: 0xffffff }));
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

  // The sender's clearing id for a walk: the Superintendent hands work from the Gate.
  function clearingIdForZone(zoneId) {
    if (zoneId === 'entrance-gate') {
      const gate = model.clearings.find((c) => c.kind === 'gate');
      return gate ? gate.id : null;
    }
    return zoneId;
  }

  function updateBody(b, state, dt, t) {
    const agent = model.agents.find((a) => a.id === b.agent.id) || b.agent;
    const agentState = state.agentStates[agent.id] || 'idle';
    const gate = model.clearings.find((c) => c.kind === 'gate');
    const h = state.handoffs ? state.handoffs[agent.id] : null;
    const hKey = h ? `${h.workItemId}:${h.startedAt}` : null;
    if (hKey !== b.walk.handoffKey) {
      b.walk.handoffKey = hKey;
      b.walk.handoff = null;
      if (h) {
        const route = model.route(clearingIdForZone(h.fromZone), clearingIdForZone(h.toZone));
        if (route) b.walk.handoff = { trail: { table: route.table }, startedAt: h.startedAt };
      }
    }
    const d = state.deliveries ? state.deliveries[agent.id] : null;
    const dKey = d ? `${d.workItemId}:${d.startedAt}` : null;
    if (dKey !== b.walk.deliveryKey) {
      b.walk.deliveryKey = dKey;
      b.walk.delivery = null;
      if (d && model.visitorCenter) {
        const route = model.route(clearingIdForZone(d.fromZone), model.visitorCenter.id);
        if (route) b.walk.delivery = { trail: { table: route.table }, startedAt: d.startedAt };
      }
    }
    const p = placeFor({ agentState, home: agent.home, gate, handoff: b.walk.handoff, delivery: b.walk.delivery, now: Date.now(), pointAtFraction });
    const y = model.heightAt(p.x, p.z);
    b.root.position.set(p.x, y, p.z);
    b.root.rotation.y = p.heading;
    const clip = clipFor(agentState, p.walking);
    const action = b.actions[clip === 'walk' ? 'run' : 'idle'];
    if (action && b.current !== action) {
      if (b.current) b.current.fadeOut(0.2);
      action.reset().fadeIn(0.2).play();
      b.current = action;
    }
    if (b.current) b.current.paused = clip === 'error' || Boolean(agent.paused);
    b.mixer.update(dt);
    drawBadge(b.badge, badgeFor(agentState, { paused: Boolean(agent.paused) }), t);
  }

  function updateBodies(state, dt, t) {
    if (!model) return;
    for (const b of bodies.values()) updateBody(b, state, dt, t);
  }

  let followId = null; // the agent the follow camera tracks (the last clicked, else the first)
  function followTarget() {
    if (followId && bodies.has(followId)) return bodies.get(followId).root;
    const first = bodies.values().next();
    return first.done ? null : first.value.root;
  }

  function updateCamera(dt, t) {
    const followed = cameraMode === 'follow' ? followTarget() : null;
    if (followed) {
      const target = followed.position.clone();
      const behind = new THREE.Vector3(Math.sin(followed.rotation.y + Math.PI), 0.55, Math.cos(followed.rotation.y + Math.PI)).multiplyScalar(9);
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
      if (pick.type === 'agent') {
        followId = pick.id;
        return onPick({ type: 'agent', agent: state.layout.agents.find((a) => a.id === pick.id) || state.layout.agents[0] });
      }
      if (pick.type === 'trail' && model) {
        const trail = model.trails.find((tr) => tr.id === pick.id);
        return onPick({ type: 'trail', trail: trail ? { id: trail.id, from: trail.from, to: trail.to } : { id: pick.id }, point: { x: hit.point.x, z: hit.point.z } });
      }
      if (pick.type === 'object') return onPick({ type: 'object', object: state.layout.objects.find((ob) => ob.id === pick.id) });
      const point = { x: hit.point.x, z: hit.point.z };
      if (pick.type === 'zone') return onPick({ type: 'zone', room: state.layout.rooms.find((r) => r.id === pick.id), point });
      if (pick.type === 'gate') return onPick({ type: 'gate', room: state.layout.rooms.find((r) => r.id === pick.id), point });
      if (pick.type === 'peak') return onPick({ type: 'peak', point });
      if (pick.type === 'terrain' && model) {
        const c = model.clearings.find((cl) => Math.hypot(cl.x - hit.point.x, cl.z - hit.point.z) < cl.radius);
        if (c && c.kind === 'peak') return onPick({ type: 'peak', point });
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
  loadRanger().then(() => syncBodies(getState())); // not awaited: the park renders while the FBX files stream in

  function frame() {
    if (destroyed) return;
    requestAnimationFrame(frame);
    timer.update();
    const dt = Math.min(0.1, timer.getDelta());
    const t = timer.getElapsed();
    const state = getState();
    rebuild(state);
    syncFixtures(state);
    syncLamps(state);
    syncBodies(state);
    applySun();
    if (water) water.material.uniforms.uTime.value = t;
    updateBodies(state, dt, t);
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
    follow(agentId) {
      followId = agentId;
    },
    // Diagnostics for the headless check: which bodies exist and where they stand.
    bodies() {
      return [...bodies.values()].map((b) => ({ id: b.agent.id, role: b.agent.role || 'ranger', x: Math.round(b.root.position.x * 10) / 10, z: Math.round(b.root.position.z * 10) / 10, clip: b.current ? (b.current === b.actions.run ? 'run' : 'idle') : null }));
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
