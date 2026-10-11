// The creative kit (phase 4 step 8), composed once per sidecar:
//
//   createCreative({ env, keystorePath, fetch, netGuard, judge, ledger, caps, bus, workspaceRoot, config, clock })
//     -> { tools, images, status(), list() }
//
// tools: creative.copy (ad copy variants the Ranger wrote, judge reviewed) and creative.image
// (one image from a Hugging Face text-to-image model, judge policy check first, metered
// under the hosted worker cap). Both have no leash domain: they only write deliverables
// into outbox/creative/ of the Ranger's workspace. Uploads go through the ads connectors'
// publishing tools and the Gate.

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { resolveKey } from '../providers/keys.js';
import { copyTool } from './copy.js';
import { createImageGenerator, imageTool, HF_IMAGES_BASE_URL, HF_IMAGE_DEFAULT_MODEL } from './images.js';
import { CREATIVE_DIR } from './paths.js';

export const CREATIVE_TOOL_NAMES = Object.freeze(['creative.copy', 'creative.image']);

export function createCreative({ env = process.env, keystorePath, fetch: fetchImpl = globalThis.fetch, netGuard, judge = null, ledger = null, caps = null, bus = null, workspaceRoot, config = {}, clock = { now: () => Date.now() }, random } = {}) {
  const keyFor = (name) => resolveKey(name, { env, keystorePath });
  const images = createImageGenerator({ keyFor, fetch: fetchImpl, netGuard, baseUrl: config.hfImagesBaseUrl || (env.HF_IMAGES_BASE_URL || '').trim() || HF_IMAGES_BASE_URL, model: config.imageModel || (env.HF_IMAGE_MODEL || '').trim() || HF_IMAGE_DEFAULT_MODEL });
  const tools = Object.freeze({
    'creative.copy': copyTool({ judge, clock, random }),
    'creative.image': imageTool({ images, judge, ledger, caps, bus, clock, random }),
  });
  return {
    tools,
    images,
    async status() {
      const wired = await images.wired();
      const hosted = ledger ? ledger.hostedToday() : { calls: 0, tokens: 0 };
      return { images: wired ? 'huggingface' : 'not wired (HF_TOKEN)', imageKey: wired, model: images.model, judge: Boolean(judge), hostedToday: hosted.calls, hostedCap: caps ? caps.hostedWorkerCallsPerDay : null };
    },
    list: (opts) => listCreatives(workspaceRoot, opts),
  };
}

// Every creative deliverable in every Ranger's outbox, newest first (what the Peak lists):
// one row per <agent>/outbox/creative/<venture>/<id>/meta.json.
export async function listCreatives(workspaceRoot, { limit = 50, kind = null } = {}) {
  const out = [];
  let agents;
  try {
    agents = await fsp.readdir(workspaceRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const a of agents) {
    if (!a.isDirectory() || a.name.startsWith('_') || a.name.startsWith('.')) continue;
    const base = path.join(workspaceRoot, a.name, CREATIVE_DIR);
    let ventures;
    try {
      ventures = await fsp.readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const v of ventures) {
      if (!v.isDirectory()) continue;
      let ids;
      try {
        ids = await fsp.readdir(path.join(base, v.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of ids) {
        if (!d.isDirectory()) continue;
        try {
          const meta = JSON.parse(await fsp.readFile(path.join(base, v.name, d.name, 'meta.json'), 'utf8'));
          if (kind && meta.kind !== kind) continue;
          out.push({ id: meta.id, kind: meta.kind, venture: meta.venture, agentId: meta.agentId || a.name, runId: meta.runId || null, createdAt: meta.createdAt, name: meta.name, platform: meta.platform || null, variants: meta.variants || null, model: meta.model || null, bytes: meta.bytes || null, judge: meta.judge || null, policy: meta.policy || null, path: path.join(a.name, meta.path) });
        } catch {
          /* a torn or foreign folder is not a deliverable */
        }
      }
    }
  }
  return out.sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0)).slice(0, limit);
}

export { CREATIVE_DIR };
