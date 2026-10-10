// The venture brief (phase 2 step 18): the Scout's deliverable, validated against
// VENTURE_BRIEF_SCHEMA, reviewed by the judge (approve / revise / reject with notes),
// written as JSON and Markdown into the Ranger's outbox (so it walks to the Visitor
// Center as a deliverable) and listed at the Peak. The Chief decides go / no-go within
// the mission budget; the brief only recommends.
//
//   VENTURE_BRIEF_SCHEMA, renderBrief(brief), briefSubmitTool({ judge }), listBriefs(root)

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { validate } from '../../shared/schema.js';
import { writeJsonAtomic } from '../store.js';

export const BRIEFS_DIR = path.join('outbox', 'briefs');
export const GO_NO_GO = Object.freeze(['go', 'no_go', 'needs_more_evidence']);

const str = (max) => ({ type: 'string', minLength: 1, maxLength: max });

export const VENTURE_BRIEF_SCHEMA = Object.freeze({
  type: 'object',
  required: ['title', 'summary', 'opportunity', 'evidence', 'costs', 'revenueModel', 'risks', 'recommendation', 'confidence'],
  additionalProperties: false,
  properties: {
    ventureId: { type: 'string', maxLength: 80, description: 'The venture in the plan this brief is for, if any' },
    title: str(140),
    summary: str(1200),
    opportunity: str(4000),
    customer: { type: 'string', maxLength: 1500 },
    evidence: {
      type: 'array',
      minItems: 2,
      maxItems: 30,
      items: { type: 'object', required: ['claim', 'source'], additionalProperties: false, properties: { claim: str(600), source: { type: 'string', minLength: 8, maxLength: 1000, pattern: '^https?://' }, date: { type: 'string', maxLength: 40 }, quote: { type: 'string', maxLength: 600 } } },
    },
    costs: {
      type: 'array',
      minItems: 1,
      maxItems: 30,
      items: { type: 'object', required: ['item', 'usd', 'basis'], additionalProperties: false, properties: { item: str(200), usd: { type: 'number', minimum: 0 }, basis: str(400), recurring: { type: 'string', enum: ['one_off', 'monthly', 'per_unit'] } } },
    },
    revenueModel: str(2000),
    risks: { type: 'array', minItems: 1, maxItems: 20, items: str(400) },
    recommendation: { type: 'string', enum: [...GO_NO_GO] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    firstSteps: { type: 'array', maxItems: 10, items: str(300) },
  },
});

export function totalCosts(brief) {
  const t = { one_off: 0, monthly: 0, per_unit: 0 };
  for (const c of brief.costs || []) t[c.recurring || 'one_off'] += Number(c.usd) || 0;
  return t;
}

export function renderBrief(brief, { id, agentId, submittedAt, judge } = {}) {
  const t = totalCosts(brief);
  const lines = [`# ${brief.title}`, '', `${brief.summary}`, ''];
  if (id) lines.push(`Brief ${id} · by ${agentId || 'a Scout'} · ${new Date(submittedAt || Date.now()).toISOString()}${brief.ventureId ? ` · venture ${brief.ventureId}` : ''}`, '');
  lines.push(`**Recommendation: ${brief.recommendation.replace(/_/g, ' ')}** (confidence ${(brief.confidence * 100).toFixed(0)} %)`, '');
  if (judge) lines.push(`Judge: ${judge.verdict}${judge.notes ? ` — ${judge.notes}` : judge.reason ? ` (${judge.reason})` : ''}`, '');
  lines.push('## Opportunity', '', brief.opportunity, '');
  if (brief.customer) lines.push('## Customer', '', brief.customer, '');
  lines.push('## Evidence', '', ...brief.evidence.map((e) => `- ${e.claim} — ${e.source}${e.date ? ` (${e.date})` : ''}${e.quote ? `\n  > ${e.quote}` : ''}`), '');
  lines.push('## Costs', '', ...brief.costs.map((c) => `- ${c.item}: $${c.usd.toFixed(2)} ${c.recurring ? c.recurring.replace('_', ' ') : 'one off'} — ${c.basis}`), '', `One-off $${t.one_off.toFixed(2)} · monthly $${t.monthly.toFixed(2)} · per unit $${t.per_unit.toFixed(2)}`, '');
  lines.push('## Revenue model', '', brief.revenueModel, '');
  lines.push('## Risks', '', ...brief.risks.map((r) => `- ${r}`), '');
  if (brief.firstSteps && brief.firstSteps.length) lines.push('## First steps', '', ...brief.firstSteps.map((s, i) => `${i + 1}. ${s}`), '');
  return lines.join('\n');
}

export function briefSubmitTool({ judge = null } = {}) {
  return {
    name: 'brief.submit',
    description: 'Submit a venture brief: evidence with source URLs (from web.search / web.read / web.trends), real costs with their basis, a revenue model, risks and a go / no-go recommendation with confidence. The judge reviews it and the Chief decides within budget. Written to outbox/briefs/ in your workspace as the deliverable.',
    inputSchema: VENTURE_BRIEF_SCHEMA,
    confirm: false,
    summarize: (input) => `submit the venture brief "${input.title.slice(0, 60)}" (${input.recommendation.replace(/_/g, ' ')})`,
    async run(input, ctx) {
      const v = validate(VENTURE_BRIEF_SCHEMA, input);
      if (!v.ok) return { ok: false, code: 'INVALID_BRIEF', error: `the brief is not complete: ${v.errors.slice(0, 3).join('; ')}` };
      if (!ctx.workspaceDir) return { ok: false, error: 'no workspace for this run' };
      const id = `brief-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 7)}`;
      const submittedAt = Date.now();
      let review = null;
      const j = ctx.judge || judge;
      if (j && typeof j.reviewDocument === 'function') {
        try {
          review = await j.reviewDocument({ runId: ctx.runId || 'none', agentId: ctx.agentId || 'none', turn: ctx.turn || 0, tool: 'brief.submit', title: 'venture brief', text: renderBrief(input, { id, agentId: ctx.agentId, submittedAt }), brief: ctx.brief || '' });
        } catch (err) {
          review = { verdict: 'skipped', reason: `judge failed: ${err.message}` };
        }
      } else review = { verdict: 'skipped', reason: 'no judge wired' };
      const dir = path.join(ctx.workspaceDir, BRIEFS_DIR);
      await fsp.mkdir(dir, { recursive: true });
      const record = { id, agentId: ctx.agentId || null, runId: ctx.runId || null, submittedAt, judge: review, brief: input, totals: totalCosts(input) };
      await writeJsonAtomic(path.join(dir, `${id}.json`), record);
      await fsp.writeFile(path.join(dir, `${id}.md`), renderBrief(input, { id, agentId: ctx.agentId, submittedAt, judge: review }));
      const rel = path.join(BRIEFS_DIR, `${id}.md`);
      const verdictLine = review.verdict === 'skipped' ? `The judge did not review it (${review.reason}); the Chief will read it as is.` : `The judge says ${review.verdict}${review.notes ? `: ${review.notes}` : ''}.${review.verdict === 'revise' ? ' Fix what the judge named and submit again.' : review.verdict === 'reject' ? ' Do not resubmit without new evidence.' : ''}`;
      return { ok: true, output: JSON.stringify({ id, path: rel, recommendation: input.recommendation, confidence: input.confidence, totals: record.totals, judge: review }) + `\n${verdictLine}` };
    },
  };
}

// Every brief in every Ranger's outbox, newest first (what the Peak lists).
export async function listBriefs(workspaceRoot, { limit = 50 } = {}) {
  const out = [];
  let agents;
  try {
    agents = await fsp.readdir(workspaceRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const a of agents) {
    if (!a.isDirectory() || a.name.startsWith('_') || a.name.startsWith('.')) continue;
    const dir = path.join(workspaceRoot, a.name, BRIEFS_DIR);
    let files;
    try {
      files = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
        out.push({ id: rec.id, agentId: rec.agentId || a.name, runId: rec.runId, submittedAt: rec.submittedAt, title: rec.brief.title, ventureId: rec.brief.ventureId || null, recommendation: rec.brief.recommendation, confidence: rec.brief.confidence, judge: rec.judge, totals: rec.totals, evidence: rec.brief.evidence.length, path: path.join(a.name, BRIEFS_DIR, f.replace(/\.json$/, '.md')) });
      } catch {
        /* a torn or foreign file is not a brief */
      }
    }
  }
  return out.sort((x, y) => (y.submittedAt || 0) - (x.submittedAt || 0)).slice(0, limit);
}
