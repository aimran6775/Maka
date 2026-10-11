// Ad copy variants (phase 4 step 8): the Ranger's own worker writes them, the tool checks
// them against the platform's limits, the judge reviews them against the product facts the
// Ranger supplied, and they land as a deliverable in the Ranger's outbox
// (outbox/creative/<venture>/<id>/copy.json + copy.md + meta.json). No leash domain: the
// copy goes nowhere until meta_ads.create_creative / google_ads.create_rsa carry it, and
// those wait at the Gate under publishing.
//
//   COPY_SCHEMA, COPY_LIMITS, copyProblem(input), renderCopy(record), copyTool({ judge })

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { validate } from '../../shared/schema.js';
import { writeJsonAtomic } from '../store.js';
import { CREATIVE_DIR, creativeDir, newId, slugOf } from './paths.js';

export const COPY_PLATFORMS = Object.freeze(['meta', 'google', 'generic']);

// Hard limits per platform (characters). Google's are the responsive search ad's own
// (sidecar/connectors/google-ads-groups.js refuses longer lines too); Meta's follow the
// Marketing API's accepted lengths, not the shorter "recommended" ones.
export const COPY_LIMITS = Object.freeze({
  meta: { headline: 40, primaryText: 1000, description: 125, requires: ['headline', 'primaryText'] },
  google: { headline: 30, primaryText: 0, description: 90, requires: ['headline', 'description'] },
  generic: { headline: 80, primaryText: 1000, description: 200, requires: ['headline'] },
});

const str = (max) => ({ type: 'string', minLength: 1, maxLength: max });

export const COPY_SCHEMA = Object.freeze({
  type: 'object',
  required: ['name', 'platform', 'product', 'variants'],
  additionalProperties: false,
  properties: {
    venture: { type: 'string', maxLength: 80, description: 'The venture this copy is for (a folder name in your outbox)' },
    name: { type: 'string', minLength: 1, maxLength: 60, description: 'A short name for this set of variants, e.g. "lantern-launch"' },
    platform: { type: 'string', enum: [...COPY_PLATFORMS], description: 'Which limits apply: meta (headline 40, primary text 1000, description 125), google (headline 30, description 90), generic' },
    product: str(2000), // the facts the copy may claim; the judge checks every claim against them
    audience: { type: 'string', maxLength: 400 },
    landingUrl: { type: 'string', maxLength: 500, pattern: '^https?://' },
    variants: {
      type: 'array',
      minItems: 2,
      maxItems: 10,
      items: { type: 'object', required: ['headline'], additionalProperties: false, properties: { headline: str(1000), primaryText: { type: 'string', maxLength: 2000 }, description: { type: 'string', maxLength: 2000 }, cta: { type: 'string', maxLength: 40 } } },
    },
  },
});

// Platform limits beyond the schema: returns a sentence naming the variant and line, or null.
export function copyProblem(input) {
  const lim = COPY_LIMITS[input.platform];
  if (!lim) return `unknown platform "${input.platform}"`;
  for (let i = 0; i < input.variants.length; i++) {
    const v = input.variants[i];
    for (const field of lim.requires) if (!v[field] || !String(v[field]).trim()) return `variant ${i + 1} needs a ${field} for ${input.platform}`;
    for (const field of ['headline', 'primaryText', 'description']) {
      if (v[field] === undefined) continue;
      if (lim[field] === 0) return `variant ${i + 1}: ${input.platform} ads have no ${field}`;
      if (v[field].length > lim[field]) return `variant ${i + 1}: the ${field} is ${v[field].length} characters; ${input.platform} allows ${lim[field]}`;
    }
  }
  return null;
}

export function renderCopy(record) {
  const c = record.copy;
  const lines = [`# Ad copy: ${c.name} (${c.platform})`, ''];
  lines.push(`${record.id} · by ${record.agentId || 'a Ranger'} · ${new Date(record.createdAt).toISOString()}${c.venture ? ` · venture ${c.venture}` : ''}`, '');
  if (record.judge) lines.push(`Judge: ${record.judge.verdict}${record.judge.notes ? ` — ${record.judge.notes}` : record.judge.reason ? ` (${record.judge.reason})` : ''}`, '');
  lines.push('## Product facts', '', c.product, '');
  if (c.audience) lines.push('## Audience', '', c.audience, '');
  if (c.landingUrl) lines.push(`Landing page: ${c.landingUrl}`, '');
  lines.push('## Variants', '');
  c.variants.forEach((v, i) => {
    lines.push(`### ${i + 1}. ${v.headline}`);
    if (v.primaryText) lines.push('', v.primaryText);
    if (v.description) lines.push('', `_${v.description}_`);
    if (v.cta) lines.push('', `CTA: ${v.cta}`);
    lines.push('');
  });
  return lines.join('\n');
}

// What the judge is asked about the copy (replaces the venture-brief scope of reviewDocument).
export const COPY_REVIEW_SCOPE = 'SCOPE: the worker submitted ad copy variants through creative.copy for the platform named. The "Product facts" section is everything the copy may rely on. Approve only if every claim in every variant is supported by those facts, no variant states a price, result, guarantee or figure the facts do not state, none names a competitor, a celebrity or a trademark that is not in the facts, there is no invented urgency or scarcity, and each variant fits the platform limits noted. Otherwise revise, naming the variant and the line, or reject.';

export function copyTool({ judge = null, clock = { now: () => Date.now() }, random = Math.random } = {}) {
  return {
    name: 'creative.copy',
    description: `Submit ad copy variants you wrote: 2 to 10 variants (headline, primaryText, description, cta) with the product facts they rely on. Checked against the platform's limits (meta: headline ${COPY_LIMITS.meta.headline}, primary text ${COPY_LIMITS.meta.primaryText}, description ${COPY_LIMITS.meta.description}; google: headline ${COPY_LIMITS.google.headline}, description ${COPY_LIMITS.google.description}), reviewed by the judge, written to outbox/creative/ in your workspace as the deliverable. Nothing is published: meta_ads.create_creative or google_ads.create_rsa carry the copy, and those wait at the Gate under publishing.`,
    inputSchema: COPY_SCHEMA,
    confirm: false,
    summarize: (input) => `submit ${input.variants.length} ad copy variant(s) "${input.name}" for ${input.platform}`,
    async run(input, ctx) {
      const v = validate(COPY_SCHEMA, input);
      if (!v.ok) return { ok: false, code: 'INVALID_COPY', error: `the copy is not complete: ${v.errors.slice(0, 3).join('; ')}` };
      const problem = copyProblem(input);
      if (problem) return { ok: false, code: 'COPY_LIMIT', error: problem };
      if (!ctx.workspaceDir) return { ok: false, error: 'no workspace for this run' };
      const createdAt = clock.now();
      const id = newId('copy', createdAt, random);
      const record = { id, kind: 'copy', venture: input.venture || null, agentId: ctx.agentId || null, runId: ctx.runId || null, createdAt, judge: null, copy: input };
      const j = 'judge' in ctx ? ctx.judge : judge; // the run's context wins, even when it says none
      if (j && typeof j.reviewDocument === 'function') {
        try {
          record.judge = await j.reviewDocument({ runId: ctx.runId || 'none', agentId: ctx.agentId || 'none', turn: ctx.turn || 0, tool: 'creative.copy', title: 'ad copy', text: renderCopy(record), brief: ctx.brief || '', scope: COPY_REVIEW_SCOPE });
        } catch (err) {
          record.judge = { verdict: 'skipped', reason: `judge failed: ${err.message}` };
        }
      } else record.judge = { verdict: 'skipped', reason: 'no judge wired' };
      const dir = creativeDir(ctx.workspaceDir, input.venture, id);
      await fsp.mkdir(dir, { recursive: true });
      await writeJsonAtomic(path.join(dir, 'copy.json'), record);
      await fsp.writeFile(path.join(dir, 'copy.md'), renderCopy(record));
      const rel = path.relative(ctx.workspaceDir, path.join(dir, 'copy.md'));
      await writeJsonAtomic(path.join(dir, 'meta.json'), { id, kind: 'copy', venture: record.venture, agentId: record.agentId, runId: record.runId, createdAt, name: input.name, platform: input.platform, variants: input.variants.length, judge: record.judge, path: rel, files: ['copy.json', 'copy.md'] });
      const verdictLine = record.judge.verdict === 'skipped' ? `The judge did not review it (${record.judge.reason}); the Gate will read it before anything is published.` : `The judge says ${record.judge.verdict}${record.judge.notes ? `: ${record.judge.notes}` : ''}.${record.judge.verdict === 'revise' ? ' Fix what the judge named and submit again.' : record.judge.verdict === 'reject' ? ' Do not reuse these lines.' : ''}`;
      return { ok: true, output: JSON.stringify({ id, path: rel, platform: input.platform, variants: input.variants.length, judge: record.judge }) + `\n${verdictLine}` };
    },
  };
}

export { CREATIVE_DIR, slugOf };
