// Which renderer the park uses (phase 4 step 15, D146), as a pure rule tested under Node.
//
// WebGPU when the browser has `navigator.gpu` (a secure context: the loopback page is one),
// WebGL2 otherwise; `?renderer=webgl2` forces WebGL2, `?renderer=webgpu` asks for WebGPU
// but cannot conjure it. render.js then requires a real WebGPU adapter: when Three.js's
// WebGPURenderer would run on its own WebGL2 backend instead, the park drops back to the
// plain WebGLRenderer and the status line says why. The status line names what runs.

export function chooseRenderer({ query = {}, hasGpu = false, secure = true } = {}) {
  const asked = String(query.renderer || 'auto').toLowerCase();
  if (asked === 'webgl2' || asked === 'webgl') return { path: 'webgl2', reason: 'renderer=webgl2 in the URL' };
  const missing = `navigator.gpu is missing${secure ? '' : ' (not a secure context)'}`;
  if (asked === 'webgpu') return hasGpu ? { path: 'webgpu', reason: 'renderer=webgpu in the URL' } : { path: 'webgl2', reason: `renderer=webgpu asked, but ${missing}` };
  if (asked !== 'auto') return hasGpu ? { path: 'webgpu', reason: `unknown renderer "${asked}" ignored; navigator.gpu exists` } : { path: 'webgl2', reason: `unknown renderer "${asked}" ignored; ${missing}` };
  return hasGpu ? { path: 'webgpu', reason: 'navigator.gpu exists' } : { path: 'webgl2', reason: missing };
}

// The status line's word for the renderer in use. A fallback names its reason.
export function rendererLabel({ path, fellBack = null }) {
  if (path === 'webgpu') return 'webgpu';
  return fellBack ? `webgl2 (${fellBack})` : 'webgl2';
}

// The park's options from the page's query string. Everything has a default; the bench and
// the dev overlay use these flags, a normal page carries none.
export function parkOptions(query = {}) {
  const density = Number(query.density);
  return {
    renderer: ['webgl2', 'webgl', 'webgpu'].includes(String(query.renderer || '').toLowerCase()) ? String(query.renderer).toLowerCase().replace(/^webgl$/, 'webgl2') : 'auto',
    lod: String(query.lod || 'on').toLowerCase() !== 'off',
    density: Number.isFinite(density) && density > 0 ? Math.min(6, density) : 1,
    overlay: query.dev === '1' || query.overlay === '1',
  };
}
