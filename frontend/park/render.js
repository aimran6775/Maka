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
//
// Phase 4 step 15 (D146): when the browser has WebGPU the WebGPU build (`three/webgpu`,
// `three/tsl`, the SkyMesh addon) is imported on demand and the park runs on
// WebGPURenderer with a real WebGPU adapter, the water written in TSL; otherwise, or when
// only the WebGPU build's own WebGL2 backend would run, the plain WebGLRenderer. Foliage and
// crew have distance levels of detail (lod.js); a dev overlay shows measured frame times;
// `options` come from the page's query (gpu.js `parkOptions`).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { Sky } from 'three/addons/objects/Sky.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildParkModel } from './placement.js';
import { TERRAIN, valueNoise } from './terrain.js';
import { hash2 } from './random.js';
import { detailGrayscale, foliageCard, layerMeans, terrainVertexColors, woodGrain } from './surface.js';
import { pointAtFraction } from './spline.js';
import { clipFor, placeFor, badgeFor, lookFor, lampsFor } from './clips.js';
import { sunFor } from './sun.js';
import { LOD, bucketFoliage, crewLod, shouldRebucket, clusterDecimate, cellSizeFor } from './lod.js';
import { createFrameStats, overlayLines } from './frametime.js';
import { chooseRenderer, rendererLabel } from './gpu.js';
import { movementFromKeys, isTyping, placesFor, MOVE_CODES } from './controls.js';

export const CAMERA_MODES = Object.freeze(['orbit', 'fly', 'follow']);

// Trees are original Maka geometry (D166): photoscan trees are 0.5–1 GB each, so realism
// comes from PBR bark, needle/leaf detail textures and irregular displaced shells instead.
// Rocks and grass clumps are Poly Haven photoscans; the terrain splats four Poly Haven
// PBR layers; the lake uses three.js's own water normal map.
const ASSETS = {
  rock: ['polyhaven/boulder_01/boulder_01_1k.gltf'],
  grass: ['polyhaven/grass_medium_02/grass_medium_02_1k.gltf'],
  terrain: { grass: 'polyhaven/leafy_grass', forest: 'polyhaven/forest_leaves_04', rock: 'polyhaven/rock_face', sand: 'polyhaven/sandy_gravel' },
  bark: 'polyhaven/pine_bark',
  waterNormals: '/vendor/three/textures/waternormals.jpg',
  // The station, gate and fixture pieces are built in code (buildProps): real-size
  // timber, canvas and stone instead of a bright low-poly kit (D166).
  ranger: { body: 'characters/characterMedium.fbx', skin: 'characters/skaterMaleA.png', clips: { idle: 'characters/idle.fbx', run: 'characters/run.fbx' } },
};
// The ground detail tiles about every two world units, the scale the textures were shot
// at; the macro colour comes from the terrain's vertex colours, not from a giant bake.
const TERRAIN_DETAIL_REPEAT = 120;
const GRASS_PARTS = 2; // how many of the grass scan's five tufts each clump keeps: hundreds are drawn at once

// How each zone kind is dressed (data; kit pieces by key from ASSETS.station). The Ranger
// Station keeps its phase 1 look; camps are tents around a fire; the Visitor Center is a
// building with a counter crate; a trailhead is a signpost and a gate.
// How each zone kind is dressed: [piece, x and z as a fraction of the clearing radius,
// turn, size]. The pieces are built at real size (buildProps), so the size is a nudge
// around 1, not a kit model's scale factor.
const ZONE_DRESS = {
  ranger_station: [['structure', -0.45, -0.45, Math.PI / 6, 1.15], ['tent', 0.5, -0.4, -Math.PI / 3, 1], ['campfire', 0.1, 0.1, 0, 1], ['signpost', -0.6, 0.55, Math.PI / 2, 1]],
  visitor_center: [['structure', 0, -0.4, 0, 1.3], ['crate', -0.45, 0.35, 0.3, 1], ['crate', -0.25, 0.4, -0.2, 0.85], ['signpost', 0.55, 0.45, Math.PI, 1]],
  trailhead: [['signpost', 0, 0, Math.PI / 4, 1.1], ['fenceGate', 0, 0.5, 0, 1], ['logs', -0.5, -0.3, 0, 1]],
  camp: [['tentOpen', -0.5, -0.4, Math.PI / 5, 1], ['tent', 0.5, -0.45, -Math.PI / 4, 1], ['campfire', 0, 0.15, 0, 0.9], ['signpost', -0.55, 0.55, Math.PI / 2, 1], ['crate', 0.55, 0.5, 0, 0.9]],
};
const DISC_COLORS = { gate: 0xc2ad86, peak: 0x9a948a, visitor_center: 0x8fbf6a, trailhead: 0x7fb15a, zone: 0x6fae52 };

// Three.js 0.186 writes `swizzle: 'rgba'` (the identity, from an earlier draft of the WebGPU
// spec) into every texture view descriptor and never asks for any other; a browser that
// exposes the final spec's `swizzle` member expects a dictionary there and throws on the
// string, which kills every frame. Dropping the identity changes nothing drawn. Our own
// code, not a patch to the vendored build; remove on the next Three.js bump (D146).
function shimTextureViewSwizzle() {
  const proto = globalThis.GPUTexture && globalThis.GPUTexture.prototype;
  if (!proto || typeof proto.createView !== 'function' || proto.createView.makaSwizzleShim) return;
  const original = proto.createView;
  const createView = function createViewWithoutStringSwizzle(descriptor) {
    if (descriptor && typeof descriptor.swizzle === 'string') {
      const copy = { ...descriptor };
      delete copy.swizzle;
      return original.call(this, copy);
    }
    return original.call(this, descriptor);
  };
  createView.makaSwizzleShim = true;
  proto.createView = createView;
}

export async function createPark({ container, getState, onPick, onStatus = () => {}, onDeviceLost = () => {}, options = {} }) {
  const opts = { renderer: 'auto', lod: true, density: 1, overlay: false, fellBack: null, ...options };
  const status = { renderer: 'choosing', assets: 'loading', ranger: 'loading', fps: 0, problems: [], lod: opts.lod, density: opts.density };
  const report = () => onStatus({ ...status });

  // ---- the renderer: WebGPU with a real adapter, else WebGL2 (phase 4 step 15, D146) ----
  let renderer = null;
  let gpu = null; // the WebGPU build's exports, only on that path
  let tsl = null; // the shading language, only on that path
  let SkyMeshClass = null;
  const choice = chooseRenderer({ query: { renderer: opts.renderer }, hasGpu: typeof navigator !== 'undefined' && Boolean(navigator.gpu), secure: typeof isSecureContext === 'undefined' || isSecureContext });
  // `opts.fellBack` is the reason app.js restarted the park on WebGL2 (a lost WebGPU device).
  let fellBack = choice.path === 'webgpu' ? null : opts.fellBack || choice.reason;
  let deviceLost = false;
  if (choice.path === 'webgpu') {
    try {
      // The adapter first: without one the 2.3 MB WebGPU build is not even fetched.
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) throw Object.assign(new Error('no WebGPU adapter'), { plain: true });
      const [g, t, skyMod] = await Promise.all([import('three/webgpu'), import('three/tsl'), import('three/addons/objects/SkyMesh.js')]);
      shimTextureViewSwizzle();
      const r = new g.WebGPURenderer({ antialias: true, powerPreference: 'high-performance' });
      await r.init();
      if (r.backend && r.backend.isWebGPUBackend) {
        renderer = r;
        gpu = g;
        tsl = t;
        SkyMeshClass = skyMod.SkyMesh;
        // A device can be lost at any time (a GPU reset, a driver update, a browser that
        // cannot present WebGPU to a canvas): the park reports it and app.js restarts it on
        // WebGL2 with the reason in the status line, instead of a frozen canvas.
        if (r.backend.device && r.backend.device.lost) {
          r.backend.device.lost.then((info) => {
            if (deviceLost) return;
            deviceLost = true;
            const message = info && info.message ? String(info.message).replace(/\.$/, '') : 'no message';
            status.problems.push(`WebGPU device lost: ${message}`);
            report();
            onDeviceLost({ reason: 'WebGPU device lost', message });
          });
        }
      } else {
        // Three.js would run its WebGL2 backend under the WebGPU renderer; the proven
        // WebGL2 path with its GLSL is the stricter choice, and the label says so.
        r.dispose();
        fellBack = 'no WebGPU adapter';
      }
    } catch (err) {
      fellBack = err && err.plain ? err.message : `WebGPU failed: ${err && err.message ? err.message : err}`;
    }
  }
  if (!renderer) renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  status.renderer = rendererLabel({ path: gpu ? 'webgpu' : 'webgl2', fellBack });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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

  const sky = SkyMeshClass ? new SkyMeshClass() : new Sky();
  sky.scale.setScalar(4000);
  scene.add(sky);
  // Both skies take the same five values; the WebGL one keeps them in shader uniforms, the
  // TSL one in uniform nodes, each with a `.value`.
  const skyU = SkyMeshClass ? { sunPosition: sky.sunPosition, turbidity: sky.turbidity, rayleigh: sky.rayleigh, mieCoefficient: sky.mieCoefficient, mieDirectionalG: sky.mieDirectionalG } : sky.material.uniforms;
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
  // Exponential haze, not a linear band: distance is the strongest depth cue a landscape
  // has, and real air thickens with the square of it. The far hills dissolve into the
  // sky's own colour, which is what stops the park reading as a flat painted model.
  scene.fog = new THREE.FogExp2(0xbcd6e8, 0.0042);

  // ---- environment lighting (D166): a sky gradient lights the scene through a PMREM ----
  // The Sky mesh itself is not the source: its shader carries real sky radiance (the sun
  // disk runs into the thousands), and prefiltering that floods every material to white.
  // This is the same sky read as a bounded gradient — zenith, horizon, ground bounce,
  // from the clock's own sun colours — so the ambient is the sky's colour at a brightness
  // the park can be lit by. Rebuilt only when the sun moves a visible step.
  const ENV_W = 128;
  const ENV_H = 64;
  const envCanvas = document.createElement('canvas');
  envCanvas.width = ENV_W;
  envCanvas.height = ENV_H;
  const envTex = new THREE.CanvasTexture(envCanvas);
  envTex.mapping = THREE.EquirectangularReflectionMapping;
  envTex.colorSpace = THREE.SRGBColorSpace;
  let pmremGen = null;
  let envTarget = null;
  let envBucket = null;
  let envBroken = false;
  function updateEnvironment(bucket, s) {
    if (envBroken || bucket === envBucket) return;
    envBucket = bucket;
    try {
      const ctx = envCanvas.getContext('2d');
      const grad = ctx.createLinearGradient(0, 0, 0, ENV_H);
      const zenith = new THREE.Color(s.zenith);
      const sky7 = new THREE.Color(s.sky);
      const fog7 = new THREE.Color(s.fog);
      const ground = new THREE.Color(s.night ? 0x0a0f14 : 0x4a4332);
      grad.addColorStop(0, `#${zenith.getHexString()}`);
      grad.addColorStop(0.3, `#${sky7.getHexString()}`);
      grad.addColorStop(0.48, `#${fog7.getHexString()}`);
      grad.addColorStop(0.52, `#${fog7.clone().lerp(ground, 0.65).getHexString()}`);
      grad.addColorStop(1, `#${ground.getHexString()}`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, ENV_W, ENV_H);
      envTex.needsUpdate = true;
      if (!pmremGen) {
        const Pmrem = gpu && gpu.PMREMGenerator ? gpu.PMREMGenerator : THREE.PMREMGenerator;
        pmremGen = new Pmrem(renderer);
      }
      const next = pmremGen.fromEquirectangular(envTex);
      if (envTarget) envTarget.dispose();
      envTarget = next;
      scene.environment = next.texture;
    } catch (err) {
      envBroken = true;
      scene.environment = null;
      status.problems.push(`environment lighting unavailable: ${err && err.message ? err.message : err}`);
      report();
    }
  }

  const world = new THREE.Group();
  scene.add(world);
  const gltf = new GLTFLoader();
  const fbx = new FBXLoader();
  const texLoader = new THREE.TextureLoader();
  const loadGltf = (p) => new Promise((resolve, reject) => gltf.load(`/assets/${p}`, resolve, undefined, () => reject(new Error(`could not load ${p}`))));
  const loadFbx = (p) => new Promise((resolve, reject) => fbx.load(`/assets/${p}`, resolve, undefined, () => reject(new Error(`could not load ${p}`))));
  const loadTex = (p) => new Promise((resolve, reject) => texLoader.load(p.startsWith('/') ? p : `/assets/${p}`, resolve, undefined, () => reject(new Error(`could not load ${p}`))));

  const maxAniso = renderer.capabilities && renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 4;
  // A tiling PBR map: wrap, repeat, anisotropy, sRGB for color maps only.
  async function tilingTex(p, { srgb = false, repeat = 1 } = {}) {
    const t = await loadTex(p);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = Math.min(8, maxAniso);
    return t;
  }
  // The three maps of a Poly Haven material (diffuse, GL normal, AO/rough/metal) as one
  // MeshStandardMaterial-shaped bundle; the arm map serves as roughnessMap (G channel).
  async function pbrMaps(base, { repeat = 1 } = {}) {
    const [map, normalMap, armMap] = await Promise.all([
      tilingTex(`${base}_diff_1k.jpg`, { srgb: true, repeat }),
      tilingTex(`${base}_nor_gl_1k.jpg`, { repeat }),
      tilingTex(`${base}_arm_1k.jpg`, { repeat }),
    ]);
    return { map, normalMap, armMap };
  }
  // An image's raw RGBA pixels, for the terrain bake.
  async function loadPixels(p) {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error(`could not load ${p}`));
      i.src = `/assets/${p}`;
    });
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0);
    return { data: cx.getImageData(0, 0, img.width, img.height).data, width: img.width, height: img.height };
  }
  // A texture from baked RGBA pixels (the terrain albedo, the needle/leaf maps).
  function textureFromPixels(pixels, size, { srgb = false, repeat = 1 } = {}) {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    c.getContext('2d').putImageData(new ImageData(pixels, size, size), 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = Math.min(8, maxAniso);
    return t;
  }

  let model = null; // placement model for the current layout
  let modelKey = '';
  let terrain = null;
  let water = null;
  const pickables = [];
  const dynamic = { fixtures: new Map(), clearings: new Map() };
  const timer = new THREE.Timer();
  let cameraPlaced = false;
  let cameraMode = 'orbit';
  let destroyed = false;
  let frames = 0;
  let fpsAt = performance.now();
  const frameTimes = createFrameStats({ size: 240 }); // between frames
  const workTimes = createFrameStats({ size: 240 }); // inside a frame: sync, update, render
  let lastFrameAt = null;

  // ---- static kit models (loaded once, cloned per use) and the PBR surfaces (D166) ----
  const kit = { trees: [], rocks: [], grass: [], station: {}, gate: {}, fixtures: {} };
  // Filled by loadKit: the terrain's baked-albedo inputs and the shared materials.
  const surfaces = { means: null, detailMap: null, detail: null, trail: null, disc: null, bark: null, waterNormals: null };

  // Thins a photoscanned mesh for the near view, keeping its UVs (lod.js nearCells, D166).
  // Geometry whose triangles are already modest is left alone.
  function thinForNear(geometry, cells = LOD.nearCells) {
    const posAttr = geometry.getAttribute('position');
    const uvAttr = geometry.getAttribute('uv');
    const before = triangleCount(geometry);
    if (before < 2500) return geometry;
    const positions = positionsOf(posAttr);
    const attributes = uvAttr ? { uv: { array: uvAttr.array, itemSize: uvAttr.itemSize } } : null;
    const d = clusterDecimate({ positions, index: geometry.index ? geometry.index.array : null, attributes }, cellSizeFor(positions, cells));
    if (d.trianglesAfter < 200 || d.trianglesAfter >= before) return geometry;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
    if (d.attributes && d.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(d.attributes.uv.array, d.attributes.uv.itemSize));
    g.setIndex(new THREE.BufferAttribute(d.index, 1));
    g.computeVertexNormals();
    return g;
  }

  // Scales a loaded model so its longest side is `target` world units (photoscans come in
  // metres at whatever size the real object had).
  function normalizeTo(scene3, target) {
    const box = new THREE.Box3().setFromObject(scene3);
    const sz = new THREE.Vector3();
    box.getSize(sz);
    const longest = Math.max(sz.x, sz.y, sz.z) || 1;
    scene3.scale.setScalar(target / longest);
    scene3.position.y -= box.min.y * (target / longest); // feet on the ground
    const root = new THREE.Group();
    root.add(scene3);
    return root;
  }

  // One tree variant: a bent, flared bark trunk and a crown of alpha-cutout foliage cards
  // (surface.js foliageCard). Original geometry — Poly Haven's photoscanned trees are
  // 0.5–1 GB each (D166) — and the cards are what make the silhouette read as needles and
  // gaps instead of a cone. Built about 2 units tall; buildFoliage scales each instance.
  function trunkGeometry({ height: hTrunk, radius, bend, seedN }) {
    const geo = new THREE.CylinderGeometry(radius * 0.32, radius, hTrunk, 9, 7);
    geo.translate(0, hTrunk / 2, 0);
    const pos = geo.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const t = Math.min(1, Math.max(0, v.y / hTrunk));
      // A lean that grows with height, a root flare at the foot, and a little noise so no
      // two sides of the bole are the same.
      const flare = t < 0.14 ? 1 + (0.14 - t) * 3.4 : 1;
      const n = (valueNoise(v.x * 6 + seedN, v.y * 5, seedN) - 0.5) * 0.09;
      pos.setXYZ(i, v.x * flare + bend * t * t + n, v.y, v.z * flare + bend * 0.45 * t * t + n);
    }
    geo.computeVertexNormals();
    return geo;
  }

  // One foliage card placed in the crown: a quad whose pivot is its inner edge, swung to
  // `azimuth` around the trunk, drooping by `droop`, its tip `length` out and `up` high.
  function cardAt({ length, width, azimuth, droop, up, out, roll }) {
    const geo = new THREE.PlaneGeometry(length, width);
    geo.translate(length / 2, 0, 0); // pivot at the branch's attachment
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler(roll, azimuth, -droop, 'YZX');
    q.setFromEuler(e);
    m.compose(new THREE.Vector3(Math.cos(azimuth) * out, up, -Math.sin(azimuth) * out), q, new THREE.Vector3(1, 1, 1));
    geo.applyMatrix4(m);
    return geo;
  }

  function makeTree({ kind, seedN, needleMat, leafMat, barkMat, tint }) {
    const g = new THREE.Group();
    const conifer = kind !== 'broadleaf';
    const rnd = (i) => hash2(i, seedN, seedN + 13);
    const top = kind === 'tall' ? 2.25 : kind === 'sparse' ? 1.5 : 2.0;
    const trunkH = conifer ? top * 0.96 : top * 0.52;
    const trunk = new THREE.Mesh(trunkGeometry({ height: trunkH, radius: conifer ? 0.075 : 0.11, bend: (rnd(1) - 0.5) * (conifer ? 0.1 : 0.3), seedN }), barkMat);
    trunk.castShadow = true;
    trunk.userData.farColor = 0x5a4632;
    g.add(trunk);

    const cards = [];
    if (conifer) {
      // Whorls up the trunk, each a ring of sprays; the crown narrows and the branches
      // lift as they go up, the way a fir carries its load.
      const whorls = kind === 'sparse' ? 5 : kind === 'tall' ? 9 : 8;
      const first = trunkH * (kind === 'sparse' ? 0.3 : 0.22);
      for (let w = 0; w < whorls; w++) {
        const f = w / (whorls - 1); // 0 at the bottom whorl, 1 at the leader
        const up = first + (trunkH - first) * f;
        const spread = (kind === 'wide' ? 0.78 : 0.62) * (1 - 0.82 * f) + 0.07;
        const perWhorl = Math.max(3, Math.round((kind === 'sparse' ? 4 : 6) * (1 - 0.45 * f)));
        for (let b = 0; b < perWhorl; b++) {
          const j = rnd(w * 31 + b * 7);
          const azimuth = (b / perWhorl) * Math.PI * 2 + w * 0.7 + j * 0.5;
          cards.push(cardAt({
            length: spread * (0.85 + j * 0.4),
            width: spread * (0.62 + j * 0.25),
            azimuth,
            droop: 0.55 - 0.5 * f + (j - 0.5) * 0.25, // lower branches hang, the top lifts
            up,
            out: 0.035,
            roll: (j - 0.5) * 0.5,
          }));
        }
      }
      // The leader: two crossed cards standing up at the very top.
      for (let i = 0; i < 2; i++) cards.push(cardAt({ length: 0.42, width: 0.3, azimuth: i * Math.PI * 0.5, droop: -1.15, up: trunkH - 0.12, out: 0.01, roll: 0 }));
    } else {
      // A broadleaf canopy: sprays packed around a few branch directions.
      const branches = 7;
      for (let b = 0; b < branches; b++) {
        const j = rnd(b * 17);
        const azimuth = (b / branches) * Math.PI * 2 + j;
        const up = trunkH + 0.12 + j * 0.42;
        for (let k = 0; k < 4; k++) {
          const jk = rnd(b * 17 + k * 5 + 1);
          cards.push(cardAt({
            length: 0.52 + jk * 0.3,
            width: 0.42 + jk * 0.22,
            azimuth: azimuth + (jk - 0.5) * 0.8,
            droop: -0.35 + jk * 0.75,
            up: up + (jk - 0.5) * 0.35,
            out: 0.05 + jk * 0.12,
            roll: (jk - 0.5) * 1.2,
          }));
        }
      }
    }
    const foliage = new THREE.Mesh(mergeGeometries(cards), conifer ? needleMat : leafMat);
    foliage.castShadow = true;
    foliage.receiveShadow = true;
    foliage.userData.tint = tint; // per-instance HSL jitter around this base (buildFoliage)
    foliage.userData.farColor = tint.far;
    foliage.userData.cards = true; // never vertex-cluster a pile of loose quads
    g.add(foliage);
    return g;
  }

  // ---- the park's built pieces (D166) ----
  // The Kenney kits were bright low-poly toys standing in a photographic landscape, which
  // is the thing the eye catches first. Every station, gate and fixture piece is now built
  // here from boxes and cylinders at real size, in sawn timber, round poles, canvas and
  // stone, so they belong to the same world as the ground they stand on. Simple shapes,
  // honest materials — no kit, nothing to attribute.
  const props = {};
  function buildProps() {
    const grain = woodGrain({ size: 256, seed: 5, planks: 4 });
    const timber = new THREE.MeshStandardMaterial({
      map: textureFromPixels(grain.albedo, grain.size, { srgb: true }),
      normalMap: textureFromPixels(grain.normal, grain.size),
      roughness: 0.88,
      metalness: 0,
    });
    const weathered = timber.clone();
    weathered.color = new THREE.Color(0x8e8777); // roofs and old boards go grey
    const pole = surfaces.bark
      ? new THREE.MeshStandardMaterial({ map: surfaces.bark.map, normalMap: surfaces.bark.normalMap, roughnessMap: surfaces.bark.armMap, roughness: 1 })
      : new THREE.MeshStandardMaterial({ color: 0x6b5236, roughness: 1 });
    const stone = surfaces.disc
      ? new THREE.MeshStandardMaterial({ map: surfaces.disc.map, normalMap: surfaces.disc.normalMap, roughnessMap: surfaces.disc.armMap, color: 0x9d9a94, roughness: 1 })
      : new THREE.MeshStandardMaterial({ color: 0x8d8a84, roughness: 1 });
    const canvasMat = new THREE.MeshStandardMaterial({ color: 0xc8bda2, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
    const charcoal = new THREE.MeshStandardMaterial({ color: 0x241f1c, roughness: 1 });
    const iron = new THREE.MeshStandardMaterial({ color: 0x3b3a38, roughness: 0.6, metalness: 0.6 });
    const shadowed = (mesh) => {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      return mesh;
    };
    const box = (w, h, d, mat, x = 0, y = 0, z = 0, ry = 0) => {
      const m = shadowed(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat));
      m.position.set(x, y, z);
      m.rotation.y = ry;
      return m;
    };
    const cyl = (rTop, rBot, h, mat, x = 0, y = 0, z = 0, seg = 8) => shadowed(new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), mat)).translateX(x).translateY(y).translateZ(z);

    // A round post with a little lean, the way a post set by hand stands.
    const post = (h, r, x, z, seedN) => {
      const p = cyl(r * 0.9, r, h, pole, x, h / 2, z);
      p.rotation.z = (hash2(seedN, 1, 7) - 0.5) * 0.06;
      p.rotation.x = (hash2(seedN, 2, 7) - 0.5) * 0.06;
      return p;
    };

    // A ridge tent: canvas over a ridge pole, pegged out. `open` darkens the doorway.
    const tent = (open) => {
      const g = new THREE.Group();
      const len = 2.6;
      const halfW = 0.95;
      const h = 1.45;
      const sheet = new THREE.BufferGeometry();
      // Two sloping panels and two end triangles, written out by hand so the canvas has
      // no thickness and no bottom face.
      const v = [];
      const push = (...xs) => v.push(...xs);
      for (const s of [-1, 1]) push(0, h, -len / 2, 0, h, len / 2, s * halfW, 0, len / 2, 0, h, -len / 2, s * halfW, 0, len / 2, s * halfW, 0, -len / 2);
      push(0, h, -len / 2, -halfW, 0, -len / 2, halfW, 0, -len / 2); // the back wall
      sheet.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
      sheet.computeVertexNormals();
      const skin = shadowed(new THREE.Mesh(sheet, canvasMat));
      g.add(skin);
      g.add(cyl(0.035, 0.035, len + 0.3, pole, 0, h, 0).rotateX(Math.PI / 2));
      for (const s of [-1, 1]) g.add(post(h + 0.1, 0.04, 0, (s * (len + 0.25)) / 2, s + 3));
      if (open) {
        const mouth = new THREE.Mesh(new THREE.BufferGeometry(), charcoal);
        mouth.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, h - 0.06, len / 2 + 0.01, -halfW + 0.12, 0.02, len / 2 + 0.01, halfW - 0.12, 0.02, len / 2 + 0.01], 3));
        mouth.geometry.computeVertexNormals();
        g.add(mouth);
      }
      return g;
    };

    // A timber cabin: boarded walls, a pitched shingle roof with an overhang, a doorway.
    const cabin = (w, d, h) => {
      const g = new THREE.Group();
      g.add(box(w, h, d, timber, 0, h / 2, 0));
      const pitch = 0.62;
      for (const s of [-1, 1]) {
        const slope = box(w + 0.45, 0.1, Math.hypot(d / 2 + 0.3, pitch) * 1.04, weathered, 0, h + pitch / 2, (s * (d / 4 + 0.12)) / 1);
        slope.rotation.x = s * -Math.atan2(pitch, d / 2 + 0.3);
        g.add(slope);
      }
      // The gable ends fill the triangle the roof leaves open.
      for (const s of [-1, 1]) {
        const gable = new THREE.Mesh(new THREE.BufferGeometry(), timber);
        gable.geometry.setAttribute('position', new THREE.Float32BufferAttribute([-w / 2, h, (s * d) / 2, w / 2, h, (s * d) / 2, 0, h + pitch, (s * d) / 2], 3));
        gable.geometry.computeVertexNormals();
        shadowed(gable);
        g.add(gable);
      }
      g.add(box(0.72, 1.55, 0.06, charcoal, 0, 0.78, d / 2 + 0.01)); // the doorway
      g.add(box(0.86, 0.12, 0.1, weathered, 0, 1.62, d / 2 + 0.03)); // its lintel
      return g;
    };

    // A ring of stones round a bed of ash, with burnt logs leaning in.
    const campfire = () => {
      const g = new THREE.Group();
      const ring = 0.62;
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2 + hash2(i, 5, 11) * 0.3;
        const r = 0.11 + hash2(i, 6, 11) * 0.07;
        const s = shadowed(new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), stone));
        s.position.set(Math.cos(a) * ring, r * 0.65, Math.sin(a) * ring);
        s.rotation.set(hash2(i, 7, 11) * 3, hash2(i, 8, 11) * 3, hash2(i, 9, 11) * 3);
        s.scale.y = 0.8;
        g.add(s);
      }
      const ash = new THREE.Mesh(new THREE.CircleGeometry(ring * 0.9, 16), new THREE.MeshStandardMaterial({ color: 0x4a443f, roughness: 1 }));
      ash.rotation.x = -Math.PI / 2;
      ash.position.y = 0.02;
      ash.receiveShadow = true;
      g.add(ash);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.6;
        const log = cyl(0.045, 0.06, 0.9, charcoal, Math.cos(a) * 0.22, 0.2, Math.sin(a) * 0.22);
        log.rotation.set(Math.PI / 2.6, a, 0);
        g.add(log);
      }
      return g;
    };

    // A signpost: a leaning round post with one or two boards bolted across it.
    const signpost = (boards = 1) => {
      const g = new THREE.Group();
      g.add(post(2.0, 0.07, 0, 0, 21));
      for (let i = 0; i < boards; i++) {
        const b = box(1.05, 0.26, 0.05, timber, 0.32, 1.72 - i * 0.34, 0, i ? -0.25 : 0.06);
        g.add(b);
      }
      return g;
    };

    const crate = (s = 0.72) => {
      const g = new THREE.Group();
      g.add(box(s, s, s, timber, 0, s / 2, 0));
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) g.add(box(0.06, s, 0.06, weathered, (x * s) / 2, s / 2, (z * s) / 2));
      return g;
    };

    const chest = () => {
      const g = new THREE.Group();
      g.add(box(1.05, 0.52, 0.66, timber, 0, 0.26, 0));
      const lid = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 1.05, 12, 1, false, 0, Math.PI), timber));
      lid.rotation.z = Math.PI / 2;
      lid.position.y = 0.52;
      g.add(lid);
      for (const x of [-0.32, 0.32]) g.add(box(0.07, 0.56, 0.68, iron, x, 0.28, 0));
      return g;
    };

    const logs = () => {
      const g = new THREE.Group();
      for (let i = 0; i < 3; i++) {
        const l = cyl(0.11, 0.12, 1.5, pole, (i - 1) * 0.26, 0.12 + (i === 1 ? 0.22 : 0), i === 1 ? 0.1 : 0);
        l.rotation.z = Math.PI / 2;
        l.rotation.y = (hash2(i, 2, 31) - 0.5) * 0.3;
        g.add(l);
      }
      return g;
    };

    // Fences: posts with two rails. A gate is two tall posts and a lintel.
    const fence = (spans = 2) => {
      const g = new THREE.Group();
      const step = 1.7;
      for (let i = 0; i <= spans; i++) g.add(post(1.15, 0.065, (i - spans / 2) * step, 0, 40 + i));
      for (const y of [0.52, 0.95]) g.add(box(step * spans, 0.09, 0.05, timber, 0, y, 0));
      return g;
    };
    const gateway = () => {
      const g = new THREE.Group();
      for (const s of [-1, 1]) g.add(post(2.35, 0.1, s * 1.35, 0, 51 + s));
      g.add(box(3.1, 0.18, 0.12, timber, 0, 2.38, 0));
      g.add(box(2.6, 0.12, 0.08, weathered, 0, 2.18, 0));
      return g;
    };

    props.structure = cabin(3.4, 2.8, 2.3);
    props.tent = tent(false);
    props.tentOpen = tent(true);
    props.campfire = campfire();
    props.signpost = signpost(1);
    props.crate = crate();
    props.logs = logs();
    props.fenceSimple = fence(2);
    props.fenceGate = gateway();
    props.doorway = gateway();
    props.fence = fence(2);
    props.chest = chest();
    props.sign = signpost(2);
  }

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
    const tryStep = async (what, fn) => {
      try {
        return await fn();
      } catch (err) {
        status.problems.push(`${what}: ${err.message}`);
        return null;
      }
    };
    // The PBR surfaces: the four terrain layers' mean colours, the tiled greyscale detail
    // and its normal/roughness, the trails, the clearing discs, the bark.
    await tryStep('terrain layers', async () => {
      const entries = await Promise.all(Object.entries(ASSETS.terrain).map(async ([k, base]) => [k, await loadPixels(`${base}_diff_1k.jpg`)]));
      const layers = Object.fromEntries(entries);
      surfaces.means = layerMeans(layers);
      const gray = detailGrayscale(layers.grass);
      surfaces.detailMap = textureFromPixels(new Uint8ClampedArray(gray.data), gray.width, { srgb: true, repeat: TERRAIN_DETAIL_REPEAT });
    });
    surfaces.detail = await tryStep('terrain detail', () => pbrMaps(ASSETS.terrain.grass, { repeat: TERRAIN_DETAIL_REPEAT }));
    surfaces.trail = await tryStep('trail surface', () => pbrMaps(ASSETS.terrain.sand, { repeat: 1 }));
    // A clearing is a wide piece of ground: its gravel has to tile often enough to read
    // as ground rather than as a painted plate.
    surfaces.disc = await tryStep('clearing surface', () => pbrMaps(ASSETS.terrain.sand, { repeat: 12 }));
    surfaces.bark = await tryStep('bark', () => pbrMaps(ASSETS.bark, { repeat: 1 }));
    surfaces.waterNormals = await tryStep('water normals', () => tilingTex(ASSETS.waterNormals, { repeat: 8 }));
    // The trees: four original variants built from alpha-cutout foliage cards.
    await tryStep('trees', async () => {
      const needle = foliageCard({ size: 256, seed: 11, kind: 'needle' });
      const leaf = foliageCard({ size: 256, seed: 23, kind: 'leaf', base: [44, 72, 28], tip: [126, 158, 66] });
      // alphaTest, not transparency: the cutout needs no sorting, and three carries the
      // same test into the shadow pass, so the shadows are needle-shaped too.
      const cardMaterial = (card, roughness) =>
        new THREE.MeshStandardMaterial({
          map: textureFromPixels(card.albedo, card.size, { srgb: true }),
          normalMap: textureFromPixels(card.normal, card.size),
          alphaTest: 0.42,
          side: THREE.DoubleSide,
          roughness,
          metalness: 0,
        });
      const needleMat = cardMaterial(needle, 0.92);
      const leafMat = cardMaterial(leaf, 0.85);
      const barkMat = surfaces.bark
        ? new THREE.MeshStandardMaterial({ map: surfaces.bark.map, normalMap: surfaces.bark.normalMap, roughnessMap: surfaces.bark.armMap, roughness: 1, metalness: 0 })
        : new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 1 });
      // level: how bright this variant's crown is; warm: how far toward yellow-green.
      const dark = { level: 0.78, warm: 0.92, far: 0x33502c };
      const mid = { level: 1.0, warm: 1.0, far: 0x3f5c31 };
      const bright = { level: 1.18, warm: 1.1, far: 0x567a38 };
      kit.trees = [
        makeTree({ kind: 'tall', seedN: 5, needleMat, leafMat, barkMat, tint: dark }),
        makeTree({ kind: 'wide', seedN: 29, needleMat, leafMat, barkMat, tint: mid }),
        makeTree({ kind: 'broadleaf', seedN: 47, needleMat, leafMat, barkMat, tint: bright }),
        makeTree({ kind: 'sparse', seedN: 71, needleMat, leafMat, barkMat, tint: mid }),
      ];
    });
    // Photoscanned rocks and grass clumps (Poly Haven, 1k), thinned for the near view.
    const boulder = await tryLoad(ASSETS.rock[0]);
    kit.rocks = boulder ? [normalizeTo(boulder, 1.3)] : [];
    if (kit.rocks[0]) kit.rocks[0].traverse((o) => {
      if (o.isMesh) {
        o.geometry = thinForNear(o.geometry);
        o.userData.farColor = 0x79705f;
      }
    });
    const grassClump = await tryLoad(ASSETS.grass[0]);
    kit.grass = grassClump ? [normalizeTo(grassClump, 1.05)] : [];
    if (kit.grass[0]) {
      // The scan is five separate tufts of eight thousand triangles together, and the
      // park draws hundreds of clumps at once: keep the two lightest, drop the rest.
      const meshes = [];
      kit.grass[0].traverse((o) => {
        if (o.isMesh) meshes.push(o);
      });
      meshes
        .sort((a, b) => triangleCount(a.geometry) - triangleCount(b.geometry))
        .slice(GRASS_PARTS)
        .forEach((o) => o.parent && o.parent.remove(o));
      for (const o of meshes.slice(0, GRASS_PARTS)) {
        // Grass is thin dressing: no shadows, and its blades keep both faces.
        o.castShadow = false;
        o.receiveShadow = false;
        if (o.material) o.material.side = THREE.DoubleSide;
        o.userData.farColor = 0x4e7034;
      }
    }
    // The built pieces: they need the bark and stone maps above, so they come last.
    await tryStep('built pieces', async () => {
      buildProps();
      kit.station = { structure: props.structure, tent: props.tent, tentOpen: props.tentOpen, campfire: props.campfire, signpost: props.signpost, crate: props.crate, logs: props.logs, fenceGate: props.fenceGate, fenceSimple: props.fenceSimple };
      kit.gate = { doorway: props.doorway, fence: props.fence, signpost: props.signpost };
      kit.fixtures = { trailhead_sign: props.sign, supply_cache: props.chest };
    });
    status.assets = status.problems.length ? 'partial' : 'ready';
    report();
  }

  // The crew's skin came off a bright cartoon character sheet, and a figure in primary
  // colours standing in a photographic park is the first thing the eye picks out as
  // wrong. Pulled most of the way to its own luminance and warmed a little, the same
  // figure reads as somebody in work clothes (D166). The role tint still multiplies on
  // top, so the Chief is still the Chief.
  function muted(tex, { toward = 0.62, warm = [1.03, 1.0, 0.9] } = {}) {
    const img = tex.image;
    if (!img || !img.width) return tex;
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < d.data.length; i += 4) {
      const [r, g, b] = [d.data[i], d.data[i + 1], d.data[i + 2]];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      d.data[i] = Math.min(255, (r + (lum - r) * toward) * warm[0]);
      d.data[i + 1] = Math.min(255, (g + (lum - g) * toward) * warm[1]);
      d.data[i + 2] = Math.min(255, (b + (lum - b) * toward) * warm[2]);
    }
    cx.putImageData(d, 0, 0);
    const out = new THREE.CanvasTexture(c);
    out.anisotropy = Math.min(8, maxAniso);
    return out;
  }

  // ---- Rangers: one rigged template, cloned per agent (phase 2 step 7) ----
  const BODY_HEIGHT = 2.4;
  const template = { body: null, skin: null, clips: {}, baseScale: 1, baseY: 0 };
  const bodies = new Map(); // agentId -> { root, mixer, actions, current, badge, agent, look, walk: {...} }
  async function loadRanger() {
    try {
      const body = await loadFbx(ASSETS.ranger.body);
      const skin = muted(await loadTex(ASSETS.ranger.skin));
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
    return { root, mixer, actions, current: null, badge, label, agent, look, walk: { handoffKey: null, handoff: null, deliveryKey: null, delivery: null }, lod: { level: -1, acc: 0, tick: 0 } };
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
      if (o.geometry && !o.userData.sharedGeometry) o.geometry.dispose();
      if (o.material && o.material.dispose && !o.userData.sharedMaterial) o.material.dispose();
    });
  }

  function buildTerrain(m) {
    const seg = TERRAIN.segments;
    const geo = new THREE.PlaneGeometry(TERRAIN.size, TERRAIN.size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, m.heightAt(pos.getX(i), pos.getZ(i)));
    geo.computeVertexNormals();
    // The splatted albedo is baked per seed + clearings (never per agent change) from the
    // four Poly Haven layers; micro detail rides in the tiled normal/roughness maps, which
    // have their own repeat (per-map UV transforms). Without the layers (a failed load)
    // the terrain stays a plain green so nothing pretends (truthful telemetry).
    let mat;
    if (surfaces.detailMap && surfaces.means) {
      // Macro colour per vertex (grass → forest floor → rock → shore), sharp ground
      // detail from the small greyscale map tiled many times over. One stock material,
      // so WebGL2 and WebGPU draw the same thing (D166).
      const colors = terrainVertexColors({ positions: geo.attributes.position.array, sampleHeight: m.heightAt, seed: m.seed, means: surfaces.means });
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      mat = new THREE.MeshStandardMaterial({ map: surfaces.detailMap, vertexColors: true, roughness: 1, metalness: 0 });
      if (surfaces.detail) {
        mat.normalMap = surfaces.detail.normalMap;
        mat.normalScale = new THREE.Vector2(1.6, 1.6);
        mat.roughnessMap = surfaces.detail.armMap;
      }
    } else {
      mat = new THREE.MeshStandardMaterial({ color: 0x5e9a46, roughness: 0.95, metalness: 0 });
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.userData.pick = { type: 'terrain' };
    return mesh;
  }

  function buildWater(m) {
    // One physically-based surface on both renderer paths (D166): the environment map
    // supplies the sun glints, the scrolling three.js water normal map the ripples. The
    // old GLSL/TSL twin shaders are gone — the same material runs under WebGL2 and WebGPU.
    // Depth on the vertices: water over a shallow bank is pale and sandy, water over the
    // channel is dark. A flat sheet of one blue is the thing that reads as plastic.
    const seg = 96;
    const geo = new THREE.PlaneGeometry(TERRAIN.size, TERRAIN.size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const wpos = geo.attributes.position;
    const wcol = new Float32Array(wpos.count * 3);
    const shallow = new THREE.Color(0x6f8f82).convertSRGBToLinear();
    const deep = new THREE.Color(0x14323f).convertSRGBToLinear();
    const c = new THREE.Color();
    for (let i = 0; i < wpos.count; i++) {
      const depth = TERRAIN.waterLevel - m.heightAt(wpos.getX(i), wpos.getZ(i));
      c.copy(shallow).lerp(deep, Math.min(1, Math.max(0, depth / 3.2)));
      wcol[i * 3] = c.r;
      wcol[i * 3 + 1] = c.g;
      wcol[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(wcol, 3));
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.06,
      metalness: 0.1,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
    });
    if (surfaces.waterNormals) {
      mat.normalMap = surfaces.waterNormals;
      mat.normalScale = new THREE.Vector2(0.55, 0.55);
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.setTime = (t) => {
      if (!mat.normalMap) return;
      mat.normalMap.offset.set((t * 0.015) % 1, (t * 0.011) % 1);
    };
    mesh.position.y = TERRAIN.waterLevel; // the plane is already laid flat by the geometry
    return mesh;
  }

  function buildTrail(m, trail) {
    const width = 2.2;
    const s = trail.table.samples;
    const verts = [];
    const uvs = [];
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
        uvs.push(side === -1 ? 0 : 1, p.dist / (width * 2)); // tiles the gravel along the walk
      }
      if (i > 0) {
        const o = (i - 1) * 2;
        idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    // Trodden earth, not poured concrete: the gravel maps under a warm tint. The tint
    // stays light — it multiplies a mid-tone map, and anything darker turns to mud.
    const mat = surfaces.trail
      ? new THREE.MeshStandardMaterial({ map: surfaces.trail.map, normalMap: surfaces.trail.normalMap, roughnessMap: surfaces.trail.armMap, color: 0xd9bb92, roughness: 1, side: THREE.DoubleSide })
      : new THREE.MeshStandardMaterial({ color: 0xb9a37c, roughness: 1, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.userData.pick = { type: 'trail', id: trail.id };
    return mesh;
  }

  // The clearing's edge: opaque in the middle, gone by the rim, with the boundary
  // wobbled by a little noise so no clearing is a drawn circle. Built once, shared.
  let discAlphaTex = null;
  function discAlpha() {
    if (discAlphaTex) return discAlphaTex;
    const size = 256;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const dx = (i + 0.5) / size - 0.5;
        const dy = (j + 0.5) / size - 0.5;
        const r = Math.hypot(dx, dy) * 2; // 0 at the centre, 1 at the inscribed circle
        const wobble = (valueNoise(Math.atan2(dy, dx) * 2.2, r * 3, 17) - 0.5) * 0.22;
        const t = Math.min(1, Math.max(0, (r - (0.55 + wobble)) / 0.4));
        const a = (1 - t * t * (3 - 2 * t)) * 255;
        const o = (j * size + i) * 4;
        img.data[o] = 255;
        img.data[o + 1] = 255;
        img.data[o + 2] = 255;
        img.data[o + 3] = a;
      }
    }
    ctx.putImageData(img, 0, 0);
    discAlphaTex = new THREE.CanvasTexture(c);
    discAlphaTex.anisotropy = Math.min(8, maxAniso);
    return discAlphaTex;
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
    // Worn earth where the crew walks, carrying only a hint of the zone's colour, and
    // faded out at the rim so the clearing meets the grass instead of being a coloured
    // plate laid on top of it.
    const discMat = surfaces.disc
      ? new THREE.MeshStandardMaterial({
          map: surfaces.disc.map,
          normalMap: surfaces.disc.normalMap,
          roughnessMap: surfaces.disc.armMap,
          alphaMap: discAlpha(),
          transparent: true,
          // A stain on the ground, not a replacement for it: the terrain's own grass
          // reads through the worn earth everywhere, strongest at the rim.
          opacity: 0.82,
          depthWrite: false,
          roughness: 1,
          color: new THREE.Color(discColor).lerp(new THREE.Color(0xd9cdb4), 0.76),
        })
      : new THREE.MeshStandardMaterial({ color: discColor, roughness: 1 });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(c.radius, 40), discMat);
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
      if (kit.station.structure) g.add(place(kit.station.structure.clone(), c.x, y, c.z - 1.5, { rotation: Math.PI / 5, scale: 1.3 }));
      if (kit.station.signpost) g.add(place(kit.station.signpost.clone(), c.x + 4, y, c.z + 3, { rotation: Math.PI / 3, scale: 1 }));
      if (kit.station.campfire) g.add(place(kit.station.campfire.clone(), c.x - 3.5, y, c.z + 2.5, { scale: 1 }));
    } else {
      if (kit.gate.doorway) g.add(place(kit.gate.doorway.clone(), c.x, y, c.z, { scale: 1 }));
      if (kit.gate.fence) {
        for (const side of [-1, 1]) for (let k = 1; k <= 2; k++) g.add(place(kit.gate.fence.clone(), c.x + side * (1.35 + (k - 0.5) * 3.4), y, c.z, { scale: 1 }));
      }
      if (kit.gate.signpost) g.add(place(kit.gate.signpost.clone(), c.x + 5.5, y, c.z + 3.5, { rotation: Math.PI, scale: 1 }));
    }
    g.traverse((o) => {
      if (o.isMesh && !o.userData.pick) o.userData.pick = disc.userData.pick;
    });
    return g;
  }

  // ---- foliage: instanced, two levels by distance (phase 4 step 15, D146) ----
  // Each kit mesh of each variant becomes two InstancedMeshes over the same items: `near`
  // (the kit geometry, shadows) and `far` (the vertex-clustered geometry, flat shaded, no
  // shadow). `rebucketFoliage` sorts the items between them by camera distance; an item
  // beyond LOD.foliageFar is not drawn. With `lod: false` everything is near.
  let foliageSets = [];
  let foliageAt = null; // where and when the buckets were last done
  const lodCounts = { foliage: [0, 0, 0], crew: [0, 0, 0], triangles: { near: 0, far: 0 } };

  function positionsOf(attr) {
    const out = new Float32Array(attr.count * 3);
    for (let i = 0; i < attr.count; i++) {
      out[i * 3] = attr.getX(i);
      out[i * 3 + 1] = attr.getY(i);
      out[i * 3 + 2] = attr.getZ(i);
    }
    return out;
  }
  const triangleCount = (geometry) => Math.floor((geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3);

  // The far geometry of a kit mesh, or the kit mesh itself when clustering would not pay.
  // A pile of loose foliage quads is never clustered: the corners of neighbouring cards
  // would collapse into each other and the crown would turn to mush (D166).
  function farGeometry(geometry, { cards = false } = {}) {
    if (cards) return { geometry, triangles: triangleCount(geometry), shared: true };
    const positions = positionsOf(geometry.getAttribute('position'));
    const d = clusterDecimate({ positions, index: geometry.index ? geometry.index.array : null }, cellSizeFor(positions, LOD.decimateCells));
    if (d.trianglesAfter < 4 || d.trianglesAfter >= d.trianglesBefore) return { geometry, triangles: d.trianglesBefore, shared: true };
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
    g.setIndex(new THREE.BufferAttribute(d.index, 1));
    g.computeVertexNormals();
    return { geometry: g, triangles: d.trianglesAfter, shared: false };
  }

  const FOLIAGE_SCALE = { tree: 2.6, rock: 2.2, grass: 2.2 };
  function buildFoliage(m) {
    const sets = [];
    const byKind = { tree: kit.trees, rock: kit.rocks, grass: kit.grass };
    const up = new THREE.Vector3(0, 1, 0);
    for (const kind of ['tree', 'rock', 'grass']) {
      const variants = byKind[kind];
      if (!variants.length) continue;
      for (let v = 0; v < variants.length; v++) {
        const idx = [];
        m.foliage.forEach((f, i) => {
          if (f.kind === kind && f.variant % variants.length === v) idx.push(i);
        });
        if (!idx.length) continue;
        const source = variants[v];
        source.updateMatrixWorld(true);
        source.traverse((mesh) => {
          if (!mesh.isMesh) return;
          const n = idx.length;
          const all = new Float32Array(16 * n);
          const mat = new THREE.Matrix4();
          const local = mesh.matrixWorld.clone();
          const q = new THREE.Quaternion();
          const pos = new THREE.Vector3();
          const scl = new THREE.Vector3();
          idx.forEach((fi, i) => {
            const it = m.foliage[fi];
            const sc = it.scale * (FOLIAGE_SCALE[kind] || 2.2);
            q.setFromAxisAngle(up, it.rotation);
            pos.set(it.x, it.y, it.z);
            scl.set(sc, sc, sc);
            mat.compose(pos, q, scl).multiply(local);
            mat.toArray(all, 16 * i);
          });
          const near = new THREE.InstancedMesh(mesh.geometry, mesh.material, n);
          near.castShadow = mesh.castShadow !== false;
          near.receiveShadow = true;
          near.count = 0;
          near.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          near.userData.sharedMaterial = true;
          near.userData.sharedGeometry = true;
          // Per-instance tint (the trees): a deterministic HSL jitter around the variant's
          // base, kept beside the matrices so rebucketing permutes both together.
          let colors = null;
          if (mesh.userData.tint) {
            // A multiplier around 1, never a second coat of green: the card's own texture
            // carries the colour, and this only varies brightness and warmth from tree to
            // tree so a stand does not read as one stamped shape.
            const t = mesh.userData.tint;
            colors = new Float32Array(3 * n);
            idx.forEach((fi, i) => {
              const it = m.foliage[fi];
              const j = hash2(Math.round(it.x * 7), Math.round(it.z * 7), 97);
              const level = t.level * (0.82 + j * 0.4);
              colors[3 * i] = level * (t.warm - 0.07 + j * 0.16);
              colors[3 * i + 1] = level;
              colors[3 * i + 2] = level * (0.82 + j * 0.22);
            });
            near.setColorAt(0, new THREE.Color(1, 1, 1)); // allocates instanceColor at capacity n
            near.instanceColor.setUsage(THREE.DynamicDrawUsage);
          }
          const tintFar = Boolean(colors && mesh.userData.cards); // so a crown keeps its colour across the LOD line
          const isCards = Boolean(mesh.userData.cards);
          const farColor = mesh.userData.farColor ?? (mesh.material.color ? mesh.material.color.getHex() : 0xffffff);
          const farG = farGeometry(mesh.geometry, { cards: isCards });
          // Cards keep their cutout material far away (a flat quad would be a green slab);
          // solid kit meshes fall back to the cheap flat-shaded colour as before.
          const farMat = isCards ? mesh.material : new THREE.MeshLambertMaterial({ color: farColor, flatShading: true });
          const far = new THREE.InstancedMesh(farG.geometry, farMat, n);
          far.castShadow = false;
          far.receiveShadow = false;
          far.count = 0;
          far.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          far.userData.sharedGeometry = farG.shared;
          far.userData.sharedMaterial = isCards;
          if (tintFar) {
            far.setColorAt(0, new THREE.Color(1, 1, 1));
            far.instanceColor.setUsage(THREE.DynamicDrawUsage);
          }
          sets.push({ idx, all, near, far, colors, tintFar, triangles: { near: triangleCount(mesh.geometry), far: farG.triangles } });
        });
      }
    }
    return sets;
  }

  function rebucketFoliage(force = false) {
    if (!model || !foliageSets.length) return;
    const cam = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
    const now = performance.now();
    if (!force && !shouldRebucket(foliageAt, cam, now)) return;
    foliageAt = { ...cam, at: now };
    const { levels, counts } = bucketFoliage(model.foliage, cam, { enabled: opts.lod });
    lodCounts.foliage = counts;
    let triNear = 0;
    let triFar = 0;
    for (const set of foliageSets) {
      let ni = 0;
      let fi = 0;
      const na = set.near.instanceMatrix.array;
      const fa = set.far.instanceMatrix.array;
      const nc = set.colors && set.near.instanceColor ? set.near.instanceColor.array : null;
      const fc = set.tintFar && set.far.instanceColor ? set.far.instanceColor.array : null;
      for (let i = 0; i < set.idx.length; i++) {
        const lv = levels[set.idx[i]];
        if (lv === 0) {
          // The instance's colour travels with its matrix into the same near slot.
          if (nc) nc.set(set.colors.subarray(3 * i, 3 * i + 3), 3 * ni);
          na.set(set.all.subarray(16 * i, 16 * i + 16), 16 * ni++);
        } else if (lv === 1) {
          if (fc) fc.set(set.colors.subarray(3 * i, 3 * i + 3), 3 * fi);
          fa.set(set.all.subarray(16 * i, 16 * i + 16), 16 * fi++);
        }
      }
      set.near.count = ni;
      set.far.count = fi;
      set.near.visible = ni > 0;
      set.far.visible = fi > 0;
      set.near.instanceMatrix.needsUpdate = true;
      if (nc) set.near.instanceColor.needsUpdate = true;
      set.far.instanceMatrix.needsUpdate = true;
      if (fc) set.far.instanceColor.needsUpdate = true;
      if (ni) set.near.computeBoundingSphere();
      if (fi) set.far.computeBoundingSphere();
      triNear += ni * set.triangles.near;
      triFar += fi * set.triangles.far;
    }
    lodCounts.triangles = { near: triNear, far: triFar };
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
    model = buildParkModel(layout, { density: opts.density });
    terrain = buildTerrain(model);
    terrain.userData.static = true;
    world.add(terrain);
    pickables.push(terrain);
    water = buildWater(model);
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
    foliageSets = buildFoliage(model);
    for (const set of foliageSets) {
      for (const o of [set.near, set.far]) {
        o.userData.static = true;
        world.add(o);
      }
    }
    foliageAt = null;
    rebucketFoliage(true);
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

  // Ledger desk (phase 4 step 16): a writing desk with an open ledger and a lamp, built from
  // primitives (no kit has one).
  function makeLedgerDesk() {
    const g = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: 0x6e4b2e, roughness: 0.85 });
    const paper = new THREE.MeshStandardMaterial({ color: 0xf1e9d2, roughness: 1 });
    const leather = new THREE.MeshStandardMaterial({ color: 0x5a2d1a, roughness: 0.9 });
    const brass = new THREE.MeshStandardMaterial({ color: 0xc9a85c, roughness: 0.4, metalness: 0.7 });
    const top = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.12, 1.1), wood);
    top.position.y = 1.05;
    top.castShadow = true;
    g.add(top);
    for (const [x, z] of [[-0.9, -0.45], [0.9, -0.45], [-0.9, 0.45], [0.9, 0.45]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.0, 0.1), wood);
      leg.position.set(x, 0.5, z);
      g.add(leg);
    }
    const cover = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.04, 0.6), leather);
    cover.position.set(-0.2, 1.13, 0);
    g.add(cover);
    for (const side of [-1, 1]) {
      const page = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.03, 0.56), paper);
      page.position.set(-0.2 + side * 0.22, 1.165, 0);
      page.rotation.z = side * -0.08;
      g.add(page);
    }
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 0.6, 8), brass);
    stem.position.set(0.7, 1.41, -0.3);
    g.add(stem);
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.2, 12, 1, true), new THREE.MeshStandardMaterial({ color: 0x2f6b4f, roughness: 0.6, side: THREE.DoubleSide }));
    shade.position.set(0.7, 1.78, -0.3);
    g.add(shade);
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), new THREE.MeshStandardMaterial({ color: 0xfff2c0, emissive: 0xffd27a, emissiveIntensity: 0.9 }));
    glow.position.set(0.7, 1.7, -0.3);
    g.add(glow);
    return g;
  }

  // Control desk (phase 4 step 18): a desk with a screen that shows a small banner, built
  // from primitives (no kit has one).
  function makeControlDesk() {
    const g = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: 0x5c4a3a, roughness: 0.85 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.6, metalness: 0.3 });
    const screen = new THREE.MeshStandardMaterial({ color: 0x1b2a3a, emissive: 0x2f7fbf, emissiveIntensity: 0.6 });
    const top = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.1, 1.0), wood);
    top.position.y = 1.0;
    top.castShadow = true;
    g.add(top);
    for (const [x, z] of [[-0.9, -0.4], [0.9, -0.4], [-0.9, 0.4], [0.9, 0.4]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.95, 0.08), dark);
      leg.position.set(x, 0.48, z);
      g.add(leg);
    }
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.12, 0.3, 8), dark);
    stand.position.set(0, 1.2, -0.2);
    g.add(stand);
    const monitor = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.7, 0.05), dark);
    monitor.position.set(0, 1.7, -0.2);
    monitor.castShadow = true;
    g.add(monitor);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.6), screen);
    glass.position.set(0, 1.7, -0.17);
    g.add(glass);
    const keyboard = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.03, 0.3), dark);
    keyboard.position.set(0, 1.07, 0.2);
    g.add(keyboard);
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
      const obj = proto ? proto.clone() : f.kind === 'radio_tower' ? makeTower() : f.kind === 'field_office' ? makeFieldOffice() : f.kind === 'outpost' ? makeOutpost() : f.kind === 'ledger_desk' ? makeLedgerDesk() : f.kind === 'control_desk' ? makeControlDesk() : new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), new THREE.MeshStandardMaterial({ color: 0xffffff }));
      place(obj, f.x, f.y, f.z, { scale: 1 });
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
    scene.fog.color.setHex(s.fog);
    const u = skyU;
    u.sunPosition.value.copy(dir);
    u.turbidity.value = s.night ? 2 : 6;
    u.rayleigh.value = s.night ? 0.2 : 1.8;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.8;
    renderer.toneMappingExposure = s.night ? 0.35 : 0.85;
    // The sky's own light, rebuilt only when the sun has moved a visible step (24 buckets
    // over the day's arc) — a PMREM render per frame would cost more than it shows.
    updateEnvironment(`${s.night ? 'n' : 'd'}${Math.round(s.direction.y * 24)}`, s);
    // The environment carries most of the ambient; without one the hemisphere light is
    // the only ambient there is, as before.
    scene.environmentIntensity = s.night ? 0.45 : 1;
    hemi.intensity = scene.environment ? 0.12 * s.ambient : s.ambient;
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
    // Distance level of detail (phase 4 step 15): the body stands where it stands every
    // frame; far away its mixer runs less often (the time still adds up), the label, then
    // the badge and the shadow go.
    const lod = crewLod(camera.position.distanceTo(b.root.position), { enabled: opts.lod });
    if (lod.level !== b.lod.level) {
      b.lod.level = lod.level;
      b.label.visible = lod.label;
      if (!lod.badge) b.badge.visible = false;
      b.root.traverse((o) => {
        if (o.isMesh) o.castShadow = lod.shadow;
      });
    }
    lodCounts.crew[lod.level]++;
    b.lod.acc += dt;
    b.lod.tick++;
    if (b.lod.tick % lod.mixerEvery === 0) {
      b.mixer.update(b.lod.acc);
      b.lod.acc = 0;
    }
    if (lod.badge) drawBadge(b.badge, badgeFor(agentState, { paused: Boolean(agent.paused) }), t);
  }

  function updateBodies(state, dt, t) {
    if (!model) return;
    lodCounts.crew = [0, 0, 0];
    for (const b of bodies.values()) updateBody(b, state, dt, t);
  }

  let followId = null; // the agent the follow camera tracks (the last clicked, else the first)
  function followTarget() {
    if (followId && bodies.has(followId)) return bodies.get(followId).root;
    const first = bodies.values().next();
    return first.done ? null : first.value.root;
  }

  // ---- walking the view (D167) ----
  // The keys held right now, and a jump in progress. Orbit mode carries both the camera
  // and what it looks at, so moving feels like walking the park rather than dragging a
  // model around; fly and follow drive themselves and ignore the keys.
  const pressed = new Set();
  let jump = null; // { from, to, fromTarget, toTarget, t }
  const tmpF = new THREE.Vector3();
  const tmpR = new THREE.Vector3();

  function walk(dt) {
    const move = movementFromKeys(pressed, { sprint: pressed.has('ShiftLeft') || pressed.has('ShiftRight') });
    if (!move.moving) return false;
    jump = null; // a key cancels a jump: the person took the wheel
    // Forward is where the camera looks, flattened onto the ground.
    tmpF.subVectors(controls.target, camera.position);
    tmpF.y = 0;
    if (tmpF.lengthSq() < 1e-6) tmpF.set(0, 0, -1);
    tmpF.normalize();
    tmpR.crossVectors(tmpF, new THREE.Vector3(0, 1, 0)).normalize();
    const step = new THREE.Vector3()
      .addScaledVector(tmpF, move.forward * dt)
      .addScaledVector(tmpR, move.right * dt)
      .addScaledVector(new THREE.Vector3(0, 1, 0), move.up * dt);
    camera.position.add(step);
    controls.target.add(step);
    return true;
  }

  // Move the view to a place over about a second, easing in and out. `focus` is what the
  // Jump to menu calls; the camera keeps its own angle and only changes where it stands.
  function focusOn({ x, z, y = 0 }, { distance = 34, height = 18 } = {}) {
    if (cameraMode !== 'orbit') api.setCameraMode('orbit');
    const target = new THREE.Vector3(x, y + 1.5, z);
    const dir = new THREE.Vector3().subVectors(camera.position, controls.target);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize().multiplyScalar(distance);
    jump = {
      fromTarget: controls.target.clone(),
      toTarget: target,
      from: camera.position.clone(),
      to: target.clone().add(dir).add(new THREE.Vector3(0, height, 0)),
      t: 0,
    };
  }

  function updateCamera(dt, t) {
    const followed = cameraMode === 'follow' ? followTarget() : null;
    if (cameraMode === 'orbit' && jump) {
      jump.t = Math.min(1, jump.t + dt / 0.9);
      const e = jump.t < 0.5 ? 2 * jump.t * jump.t : 1 - (-2 * jump.t + 2) ** 2 / 2; // ease in and out
      camera.position.lerpVectors(jump.from, jump.to, e);
      controls.target.lerpVectors(jump.fromTarget, jump.toTarget, e);
      if (jump.t >= 1) jump = null;
      controls.update();
      return;
    }
    if (cameraMode === 'orbit' && walk(dt)) {
      controls.update();
      return;
    }
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
    if (destroyed || deviceLost) return;
    requestAnimationFrame(frame);
    const started = performance.now();
    if (lastFrameAt !== null) frameTimes.push(started - lastFrameAt);
    lastFrameAt = started;
    timer.update();
    const dt = Math.min(0.1, timer.getDelta());
    const t = timer.getElapsed();
    const state = getState();
    rebuild(state);
    syncFixtures(state);
    syncLamps(state);
    syncBodies(state);
    applySun();
    if (water) water.userData.setTime(t);
    updateBodies(state, dt, t);
    updateCamera(dt, t);
    rebucketFoliage();
    renderer.render(scene, camera);
    const now = performance.now();
    workTimes.push(now - started);
    frames++;
    if (now - fpsAt > 1000) {
      status.fps = Math.round((frames * 1000) / (now - fpsAt));
      frames = 0;
      fpsAt = now;
      report();
    }
    updateOverlay(now);
  }

  // ---- dev overlay (phase 4 step 15): measured frame times, draw calls, the LOD buckets ----
  const overlay = document.createElement('pre');
  overlay.className = 'park-overlay';
  overlay.hidden = !opts.overlay;
  container.append(overlay);
  let overlayAt = 0;
  function frameStats() {
    const info = renderer.info && renderer.info.render ? renderer.info.render : {};
    return {
      renderer: status.renderer,
      fps: status.fps,
      frameMs: frameTimes.snapshot(),
      workMs: workTimes.snapshot(),
      frames: frameTimes.total,
      calls: typeof info.drawCalls === 'number' ? info.drawCalls : typeof info.calls === 'number' ? info.calls : null,
      triangles: typeof info.triangles === 'number' ? info.triangles : null,
      lod: { enabled: opts.lod, foliage: [...lodCounts.foliage], crew: [...lodCounts.crew], triangles: { ...lodCounts.triangles } },
      density: opts.density,
      foliage: model ? model.foliage.length : 0,
      bodies: bodies.size,
    };
  }
  function updateOverlay(now) {
    if (overlay.hidden || now - overlayAt < 250) return;
    overlayAt = now;
    overlay.textContent = overlayLines(frameStats()).join('\n');
  }
  // The movement keys are held, not tapped, so the park tracks them down and up and reads
  // the set every frame (controls.js). Typing in a brief never moves the camera.
  const onKey = (e) => {
    if (isTyping(e.target)) return;
    if (e.key === '`') overlay.hidden = !overlay.hidden;
    if (MOVE_CODES.includes(e.code)) {
      pressed.add(e.code);
      e.preventDefault(); // the arrows would otherwise scroll the page
    }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') pressed.add(e.code);
  };
  const onKeyUp = (e) => {
    pressed.delete(e.code);
  };
  // A window that loses focus never hears the key go up, and the camera would drift away
  // on its own until the key is pressed and released again.
  const onBlur = () => pressed.clear();
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  frame();
  report();

  const api = {
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
    options: opts,
    // Measured frame statistics for the overlay and scripts/park-bench.mjs; nothing projected.
    frameStats,
    resetFrameStats() {
      frameTimes.reset();
      workTimes.reset();
      lastFrameAt = null;
    },
    // Diagnostics for the headless check: which bodies exist and where they stand.
    bodies() {
      return [...bodies.values()].map((b) => ({ id: b.agent.id, role: b.agent.role || 'ranger', x: Math.round(b.root.position.x * 10) / 10, z: Math.round(b.root.position.z * 10) / 10, clip: b.current ? (b.current === b.actions.run ? 'run' : 'idle') : null }));
    },
    update() {
      /* state is read every frame */
    },
    // Where a person can jump to, and the jump itself (D167): the Jump to menu reads the
    // first and calls the second, and the park eases the view over rather than cutting.
    places() {
      return placesFor(model, model ? model.agents : []);
    },
    // Where the view stands and what it looks at: the headless check reads this to prove
    // the movement keys and the Jump to menu actually move the camera.
    camera() {
      return {
        x: Math.round(camera.position.x * 100) / 100,
        y: Math.round(camera.position.y * 100) / 100,
        z: Math.round(camera.position.z * 100) / 100,
        target: { x: Math.round(controls.target.x * 100) / 100, z: Math.round(controls.target.z * 100) / 100 },
      };
    },
    focus(place, opts) {
      if (place) focusOn(place, opts);
    },
    destroy() {
      destroyed = true;
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      overlay.remove();
      if (envTarget) envTarget.dispose();
      if (pmremGen) pmremGen.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
  return api;
}
