// Ad images (phase 4 step 8) through Hugging Face Inference text-to-image models.
//
//   createImageGenerator({ keyFor, fetch, netGuard, baseUrl, model })
//     -> { generate({ prompt, negativePrompt, width, height }) -> { bytes, contentType, model }, model, baseUrl }
//   imageTool({ images, judge, ledger, caps, bus, clock })   the Ranger tool `creative.image`
//
// The call is one POST to <baseUrl>/<model> with the bearer HF_TOKEN, through the outbound
// guard (safety H1) like every other network path. It is metered like a hosted worker turn:
// refused once the day's hosted calls reach `caps.hostedWorkerCallsPerDay`, and every
// generated image emits `cost.estimate { tier: 'hosted_worker', usd: null }` (no price is
// reported), which the run manager's listener counts in the ledger.
//
// Policy, explicit and before any call: the judge reads the prompt and rejects faces,
// identifiable people, brand logos and trademarks (POLICY_SCOPE). No judge, a skipped review
// or anything but "approve" refuses the generation; the prompt also carries POLICY_SUFFIX and
// the negative prompt so the model is asked the same. The image bytes themselves are not
// inspected: meta.json says so (`policy.scope: 'prompt'`) and the Gate sees the file before
// any upload (uploads are publishing).

import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { guardedFetch } from '../netguard.js';
import { makeEvent } from '../../shared/events.js';
import { writeJsonAtomic } from '../store.js';
import { creativeDir, newId, slugOf } from './paths.js';

export const HF_IMAGES_BASE_URL = 'https://router.huggingface.co/hf-inference/models';
export const HF_IMAGE_DEFAULT_MODEL = 'black-forest-labs/FLUX.1-schnell';
export const IMAGE_LIMIT_BYTES = 8 * 1024 * 1024; // what meta_ads.upload_image accepts; Google's assets take 5 MB
export const IMAGE_SIZES = Object.freeze({ square: [1024, 1024], landscape: [1152, 640], portrait: [640, 1152] });
export const IMAGE_STYLES = Object.freeze({
  photo: 'a clean product photograph, soft natural light, shallow depth of field',
  illustration: 'a flat vector illustration, simple shapes, limited palette',
  watercolor: 'a soft watercolor painting on textured paper',
  minimal: 'a minimal studio shot on a plain background, lots of negative space',
});
export const POLICY_SUFFIX = 'No people, no faces, no hands, no text, no lettering, no logos, no brand marks, no watermarks.';
export const NEGATIVE_PROMPT = 'people, person, face, portrait, hands, crowd, text, letters, words, logo, brand, trademark, watermark, signature';
export const POLICY_SCOPE = 'SCOPE: the worker asked creative.image to generate an advertising image from the prompt below. This is a policy check, not a quality review. Approve only if the prompt asks for no human faces, no identifiable or named people (real or fictional), no celebrities, no brand logos, no trademarks, no trademarked characters, no product names or marks of other companies, and no text or lettering in the image. If it asks for any of those, or could only be satisfied by depicting one, reject and name what breaks the policy. Do not revise: the worker rewrites the prompt itself.';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);

export function imageType(bytes) {
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(PNG)) return 'image/png';
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(JPEG)) return 'image/jpeg';
  return null;
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');

export function createImageGenerator({ keyFor, fetch: fetchImpl = globalThis.fetch, netGuard, baseUrl = HF_IMAGES_BASE_URL, model = HF_IMAGE_DEFAULT_MODEL } = {}) {
  if (typeof keyFor !== 'function') throw new TypeError('createImageGenerator needs keyFor');
  return {
    model,
    baseUrl,
    async wired() {
      return Boolean(await keyFor('huggingface'));
    },
    // `netGuard` per call lets the run's own guard (the tool context's) stand in for the kit's.
    async generate({ prompt, negativePrompt = NEGATIVE_PROMPT, width, height, signal, netGuard: guardOverride = null } = {}) {
      const token = await keyFor('huggingface');
      if (!token) throw fail('NOT_WIRED', 'image generation is not wired: set HF_TOKEN or add the Hugging Face key at the Peak');
      const url = `${baseUrl.replace(/\/+$/, '')}/${model}`;
      const init = { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'image/png' }, body: JSON.stringify({ inputs: prompt, parameters: { negative_prompt: negativePrompt, width, height } }), signal };
      let res;
      try {
        res = await guardedFetch(url, init, { fetch: fetchImpl, guard: guardOverride || netGuard });
      } catch (err) {
        if (err && err.code) throw err; // the guard's own refusal, with its code
        throw fail('HF_UNREACHABLE', `Hugging Face is unreachable: ${err && err.message ? err.message : err}`);
      }
      if (res.status === 401 || res.status === 403) throw fail('HF_AUTH', 'Hugging Face refused the token (HF_TOKEN); check it at the Peak');
      if (res.status === 503) {
        let wait = null;
        try {
          wait = (await res.json()).estimated_time;
        } catch {
          /* no body */
        }
        throw fail('MODEL_LOADING', `the model ${model} is loading on Hugging Face${wait ? ` (about ${Math.ceil(wait)} s)` : ''}; try again shortly`);
      }
      if (!res.ok) {
        let detail = '';
        try {
          detail = clip(await res.text(), 200);
        } catch {
          /* no body */
        }
        throw fail('HF_ERROR', `Hugging Face answered ${res.status}${detail ? `: ${detail}` : ''}`);
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      const contentType = imageType(bytes);
      if (!contentType) throw fail('NOT_AN_IMAGE', `Hugging Face answered ${bytes.length} byte(s) that are not a PNG or JPEG`);
      if (bytes.length > IMAGE_LIMIT_BYTES) throw fail('TOO_LARGE', `the image is ${bytes.length} bytes; the limit is ${IMAGE_LIMIT_BYTES}`);
      return { bytes, contentType, model };
    },
  };
}

export const IMAGE_SCHEMA = Object.freeze({
  type: 'object',
  required: ['name', 'prompt'],
  additionalProperties: false,
  properties: {
    venture: { type: 'string', maxLength: 80, description: 'The venture this image is for (a folder name in your outbox)' },
    name: { type: 'string', minLength: 1, maxLength: 60, description: 'A short file name, e.g. "lantern-hero"' },
    prompt: { type: 'string', minLength: 10, maxLength: 1000, description: 'What the image shows: the product, the scene, the mood. No people, no faces, no logos, no text.' },
    style: { type: 'string', enum: Object.keys(IMAGE_STYLES) },
    size: { type: 'string', enum: Object.keys(IMAGE_SIZES), description: 'square (1024×1024), landscape (1152×640) or portrait (640×1152)' },
  },
});

export function fullPrompt(input) {
  return `${input.prompt.trim().replace(/\.?\s*$/, '')}${input.style ? `, ${IMAGE_STYLES[input.style]}` : ''}. ${POLICY_SUFFIX}`;
}

export function imageTool({ images, judge = null, ledger = null, caps = null, bus = null, clock = { now: () => Date.now() }, random = Math.random } = {}) {
  if (!images) throw new TypeError('imageTool needs an image generator');
  const emit = (type, payload) => bus && bus.emit(makeEvent(type, payload, { ts: clock.now() }));
  return {
    name: 'creative.image',
    description: `Generate one advertising image with a hosted text-to-image model (${images.model}) from your prompt, into outbox/creative/ in your workspace. Policy: no people or faces, no identifiable persons, no brand logos or trademarks, no text in the image; the judge checks the prompt first and a prompt that breaks the policy is refused. Metered under the hosted worker's daily call cap. Nothing is uploaded: meta_ads.upload_image or google_ads.upload_image_asset carry the file, and those wait at the Gate under publishing.`,
    inputSchema: IMAGE_SCHEMA,
    confirm: false,
    summarize: (input) => `generate the ad image "${input.name}" (${input.size || 'square'}${input.style ? `, ${input.style}` : ''})`,
    async run(input, ctx) {
      if (!ctx.workspaceDir) return { ok: false, error: 'no workspace for this run' };
      if (!(await images.wired())) return { ok: false, code: 'NOT_WIRED', error: 'image generation is not wired: set HF_TOKEN or add the Hugging Face key at the Peak' };
      // Safety 2026-10-11 L4: the call is reserved against the cap before anything else, so
      // concurrent calls at cap−1 cannot all pass; the reservation is released once the
      // cost.estimate has counted the call, or when nothing was generated.
      const reservation = ledger && caps ? ledger.reserveHosted({ cap: caps.hostedWorkerCallsPerDay }) : { ok: true, release: () => false };
      if (!reservation.ok) return { ok: false, code: 'HOSTED_CAP', error: `the hosted worker reached its daily cap of ${caps.hostedWorkerCallsPerDay} call(s); image generation counts against it, so no image today` };
      try {
        return await generateReserved(input, ctx);
      } finally {
        reservation.release();
      }
    },
  };

  async function generateReserved(input, ctx) {
    {
      const prompt = fullPrompt(input);
      const j = 'judge' in ctx ? ctx.judge : judge; // the run's context wins, even when it says none
      if (!j || typeof j.reviewDocument !== 'function') return { ok: false, code: 'POLICY_UNCHECKED', error: 'no judge is wired to check the prompt against the no-faces / no-logos policy, so no image is generated' };
      let review;
      try {
        review = await j.reviewDocument({ runId: ctx.runId || 'none', agentId: ctx.agentId || 'none', turn: ctx.turn || 0, tool: 'creative.image', title: 'image prompt', text: `Prompt as the model will receive it:\n\n${prompt}\n\nNegative prompt: ${NEGATIVE_PROMPT}`, brief: ctx.brief || '', scope: POLICY_SCOPE });
      } catch (err) {
        review = { verdict: 'skipped', reason: `judge failed: ${err.message}` };
      }
      if (review.verdict === 'skipped') return { ok: false, code: 'POLICY_UNCHECKED', error: `the judge could not check the prompt (${review.reason}), so no image is generated` };
      if (review.verdict !== 'approve') return { ok: false, code: 'POLICY_REJECTED', error: `the judge refused the prompt under the no-faces / no-logos policy${review.notes ? `: ${review.notes}` : ''}. Rewrite the prompt without people, faces, brands or text.` };
      const [width, height] = IMAGE_SIZES[input.size || 'square'];
      let made;
      try {
        made = await images.generate({ prompt, width, height, signal: ctx.signal, netGuard: ctx.netGuard || null });
      } catch (err) {
        return { ok: false, code: err.code || 'HF_ERROR', error: err.message };
      }
      const createdAt = clock.now();
      const id = newId('image', createdAt, random);
      emit('cost.estimate', { runId: ctx.runId || `creative-${id}`, turn: Math.max(1, ctx.turn | 0), provider: 'huggingface', model: made.model, inputTokens: 0, outputTokens: 0, usd: null, reconciled: false, tier: 'hosted_worker' });
      const dir = creativeDir(ctx.workspaceDir, input.venture, id);
      await fsp.mkdir(dir, { recursive: true });
      const file = `${slugOf(input.name, 'image')}.${made.contentType === 'image/png' ? 'png' : 'jpg'}`;
      await fsp.writeFile(path.join(dir, file), made.bytes);
      const rel = path.relative(ctx.workspaceDir, path.join(dir, file));
      const meta = { id, kind: 'image', venture: input.venture || null, agentId: ctx.agentId || null, runId: ctx.runId || null, createdAt, name: input.name, prompt: input.prompt, fullPrompt: prompt, negativePrompt: NEGATIVE_PROMPT, provider: 'huggingface', model: made.model, size: input.size || 'square', width, height, bytes: made.bytes.length, sha256: createHash('sha256').update(made.bytes).digest('hex'), contentType: made.contentType, policy: { verdict: 'approve', notes: review.notes || '', checkedBy: 'judge', scope: 'prompt', usd: review.usd ?? null }, judge: { verdict: 'approve', notes: review.notes || '' }, path: rel, files: [file] };
      await writeJsonAtomic(path.join(dir, 'meta.json'), meta);
      return { ok: true, output: JSON.stringify({ id, path: rel, bytes: meta.bytes, width, height, model: made.model, policy: meta.policy }) + `\nWritten to ${rel}. The judge approved the prompt under the no-faces / no-logos policy; the image itself was not inspected. Upload it only through meta_ads.upload_image or google_ads.upload_image_asset, which wait at the Gate under publishing.` };
    }
  }
}
