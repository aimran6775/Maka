#!/usr/bin/env node
// The phase 2 demo against the fakes (docs/PHASE2_BRIEF.md "Done means"): boots a test
// sidecar with scripted providers and a fake Stripe, then walks the chain and checks each
// link with real events: mission → plan → hire → delegation → a Books Ranger's run with
// tools → a refund (money_out) waits at the Entrance Gate → approve → the refund posts →
// a report lands in the outbox and walks to the Visitor Center → the ledger matches what
// the fake provider reported → the reflection posts. Nothing is simulated: every check
// reads an event or a file the sidecar wrote. Exit 1 on the first broken link.
//
//   node scripts/demo-phase2.mjs

import { startTestServer } from '../test/helpers/test-server.js';
import { startFakeStripe } from '../test/helpers/fake-stripe.js';
import { fakeProvider, text, toolCall, end } from '../test/helpers/fake-provider.js';
import { stripeSpec } from '../sidecar/connectors/stripe.js';

const CHIEF_PRICE = { inputPerMTok: 4, outputPerMTok: 20 };
const PLAN = {
  summary: 'One venture: Lantern Co. Keep the books straight first: refund the broken lantern and report.',
  ventures: [{ id: 'lantern-co', name: 'Lantern Co', summary: 'Paper lanterns sold online; Stripe is connected.', budgetUsd: 2, roles: [{ specialty: 'books', name: 'Bea' }], tasks: [{ id: 't1', title: 'Refund the broken lantern', specialty: 'books', brief: 'Check the Stripe balance, refund $5 of charge ch_3 (duplicate), write outbox/refund-report.md.', budgetUsd: 1 }] }],
  risks: ['Refunds above the daily cap need the Superintendent'],
  needsSuperintendent: [],
};
const REFLECTION = {
  portfolio: 'Lantern Co: 1 work item done with 1 deliverable; one $5.00 refund approved at the Gate; revenue from Stripe is in the store.',
  ventures: [{ id: 'lantern-co', worked: ['1 work item done, 1 deliverable in the outbox'], didNot: ['no listing work yet'], planStillRight: true, revisions: [], morale: 'Bea finished 1 of 1 tasks on budget ($0.00 of $1.00).' }],
  briefings: [{ zoneId: 'finance', text: 'Finance: 1 refund done ($5.00); keep refunds under the $0 default cap unless approved.' }],
};
const CHIEF_USAGE = { inputTokens: 1000, outputTokens: 100 };
const REFLECT_USAGE = { inputTokens: 2000, outputTokens: 400 };
const usd = (u, p) => (u.inputTokens * p.inputPerMTok + u.outputTokens * p.outputPerMTok) / 1_000_000;

function step(n, label) {
  console.log(`\n[${n}] ${label}`);
}
function check(cond, what) {
  if (!cond) {
    console.error(`    ✗ ${what}`);
    process.exit(1);
  }
  console.log(`    ✓ ${what}`);
}

async function main() {
  const stripe = await startFakeStripe();
  // The Chief, the Chief's follow-up and the reflection all run on the "anthropic" tier.
  const chief = fakeProvider([
    [...toolCall('p1', 'plan.submit', PLAN), end('tool_use', CHIEF_USAGE)],
    [...toolCall('h1', 'crew.hire', { name: 'Bea', specialty: 'books', venture: 'lantern-co' }), end('tool_use', CHIEF_USAGE)],
    (req) => {
      const hire = JSON.parse(req.messages.at(-1).content[0].content);
      return [...toolCall('d1', 'delegate', { toAgentId: hire.agentId, brief: PLAN.ventures[0].tasks[0].brief, budgetUsd: 1 }), end('tool_use', CHIEF_USAGE)];
    },
    [text('Delegated the books task to Bea.'), end('end_turn', CHIEF_USAGE)],
    [text('Noted: the refund is done and the report is in. Nothing else to do now.'), end('end_turn', CHIEF_USAGE)],
    [text(`Reflection: ${JSON.stringify(REFLECTION)}`), end('end_turn', REFLECT_USAGE)],
  ], { name: 'anthropic' });
  // Bea, the Books Ranger, on the local worker (unpriced).
  const worker = fakeProvider([
    [...toolCall('w1', 'stripe.balance', { fresh: true }), end('tool_use')],
    [...toolCall('w2', 'stripe.refund', { chargeId: 'ch_3', amountUsd: 5, reason: 'duplicate', note: 'demo: duplicate charge' }), end('tool_use')],
    (req) => {
      const refund = req.messages.at(-1).content[0].content;
      return [...toolCall('w3', 'fs.write', { path: 'outbox/refund-report.md', content: `# Refund report\n\nStripe refund result: ${refund}\n` }), end('tool_use')];
    },
    [text('Refunded $5 of ch_3 and wrote outbox/refund-report.md.'), end()],
  ], { name: 'ollama' });
  const makeProvider = async (name, opts) => (name === 'anthropic' ? { provider: chief, model: opts.model || 'claude-opus-5-5', price: CHIEF_PRICE } : { provider: worker, model: 'local-worker', price: null });
  const srv = await startTestServer({ makeProvider, withChief: true, maxConcurrent: 3, env: { STRIPE_API_KEY: stripe.apiKey }, connectors: [stripeSpec({ baseUrl: stripe.url })], connectorConfig: { syncOnBoot: false } });
  const stream = await srv.sse();
  const waitFor = (pred, label, ms = 15000) => stream.waitFor(pred, ms).catch(() => { console.error(`    ✗ timed out waiting for ${label}`); process.exit(1); });
  try {
    step(1, 'A Finance camp with a Fee booth (Stripe) and a Supply cache (files); Stripe connected from the environment');
    await srv.agents.ensureZone('finance');
    const finance = srv.layoutState.get().rooms.find((r) => r.id === 'finance');
    await srv.layoutState.place({ kind: 'fee_booth', roomId: 'finance', x: finance.x + 1, y: finance.y + 1 });
    await srv.layoutState.place({ kind: 'supply_cache', roomId: 'finance', x: finance.x + 2, y: finance.y + 1 });
    const connectors = (await srv.get('/api/connectors')).body;
    check(connectors[0].kind === 'stripe' && connectors[0].connected && connectors[0].by === 'env', 'Stripe is connected (STRIPE_API_KEY)');

    step(2, 'Mission → the Chief plans on the judge tier, hires Bea, delegates');
    const mission = await srv.post('/api/mission', { text: 'Run Lantern Co; keep the books straight.', budgetUsd: 3, horizon: '30 days' });
    check(mission.status === 202, `mission accepted (${mission.body.mission && mission.body.mission.id})`);
    const plan = await waitFor((e) => e.type === 'plan.updated' && e.payload.change === 'submitted', 'plan.updated');
    check(plan.payload.version === 1 && plan.payload.ventures.length === 1, 'plan v1 submitted with one venture');
    const hired = await waitFor((e) => e.type === 'crew.agent' && e.payload.change === 'created' && e.payload.agent && e.payload.agent.name === 'Bea', 'crew.agent');
    const bea = hired.payload.agent;
    check(bea.specialty === 'books' && bea.roomId === 'finance', `Bea hired into ${bea.roomId}`);
    const handoff = await waitFor((e) => e.type === 'work.handoff' && e.payload.toAgentId === bea.id, 'work.handoff');
    check(handoff.payload.toRoomId === 'finance', `work item ${handoff.payload.workItemId} handed to Bea`);

    step(3, "Bea's run with tools: the balance (research), then a refund that is money out");
    const start = await waitFor((e) => e.type === 'agent.run.start' && e.payload.agentId === bea.id, 'agent.run.start');
    check(start.payload.tools.includes('stripe.refund') && start.payload.tools.includes('fs.write'), `run ${start.payload.runId} has ${start.payload.tools.length} tools`);
    const balance = await waitFor((e) => e.type === 'agent.tool_result' && e.payload.callId === 'w1', 'stripe.balance result');
    check(balance.payload.ok && /"available"/.test(balance.payload.output), 'stripe.balance answered from a fresh sync');

    step(4, 'The refund waits at the Entrance Gate with its amount; the Superintendent approves');
    const item = await waitFor((e) => e.type === 'gate.item' && e.payload.status === 'pending' && e.payload.tool === 'stripe.refund', 'gate.item pending');
    check(item.payload.domain === 'money_out' && item.payload.amountUsd === 5, `Gate item ${item.payload.itemId}: ${item.payload.summary} ($${item.payload.amountUsd})`);
    const waiting = await waitFor((e) => e.type === 'agent.waiting' && e.payload.itemId === item.payload.itemId, 'agent.waiting');
    check(Boolean(waiting), 'Bea waits at the Gate');
    const approve = await srv.post(`/api/gate/${item.payload.itemId}`, { decision: 'approve', notes: 'demo approval' });
    check(approve.status === 200, 'approved through POST /api/gate/:id');
    const refund = await waitFor((e) => e.type === 'agent.tool_result' && e.payload.callId === 'w2', 'stripe.refund result');
    check(refund.payload.ok && /"amount":5/.test(refund.payload.output), 'the refund posted to Stripe');
    check(stripe.state.calls.some((c) => c.method === 'POST' && c.path === '/v1/refunds' && c.body.amount === '500'), 'the fake Stripe saw POST /v1/refunds amount=500');

    step(5, 'The report is written to the outbox (file writes ask per call) and walks to the Visitor Center');
    const prompt = await waitFor((e) => e.type === 'permission.prompt' && e.payload.tool === 'fs.write', 'permission.prompt');
    const allow = await srv.post('/api/permission', { promptId: prompt.payload.promptId, runId: prompt.payload.runId, allow: true });
    check(allow.status === 200, 'fs.write allowed');
    const done = await waitFor((e) => e.type === 'work.done' && e.payload.workItemId === handoff.payload.workItemId, 'work.done');
    check(done.payload.status === 'done' && done.payload.deliverables.includes('outbox/refund-report.md'), `work item done; deliverables: ${done.payload.deliverables.join(', ')}`);
    const { promises: fsp } = await import('node:fs');
    const path = await import('node:path');
    const report = await fsp.readFile(path.join(srv.workspaceRoot, bea.id, 'outbox', 'refund-report.md'), 'utf8');
    check(/Refund report/.test(report) && /"status":"succeeded"/.test(report), 'the report file exists with the refund result');
    await waitFor((e) => e.type === 'agent.run.end' && e.payload.runId !== start.payload.runId && e.seq > done.seq, "the Chief's follow-up run");
    await srv.runs.waitForIdle();

    step(6, "The ledger matches the fake provider's reported usage");
    const costs = stream.events.filter((e) => e.type === 'cost.estimate').map((e) => e.payload);
    const reconciled = costs.filter((c) => c.reconciled).reduce((n, c) => n + c.usd, 0);
    const unreconciled = costs.filter((c) => !c.reconciled).length;
    const chiefTurns = chief.requests.length;
    const expected = chiefTurns * usd(CHIEF_USAGE, CHIEF_PRICE);
    const spend = await srv.store.loadSpend();
    check(Math.abs(reconciled - expected) < 1e-9, `reconciled $${reconciled.toFixed(6)} = ${chiefTurns} Chief turns × $${usd(CHIEF_USAGE, CHIEF_PRICE).toFixed(6)}`);
    check(Math.abs(spend.totalUsd - reconciled) < 1e-9 && spend.unreconciledTurns === unreconciled, `spend.json: $${spend.totalUsd.toFixed(6)} reconciled, ${spend.unreconciledTurns} unpriced worker turn(s)`);
    const ledger = (await srv.get('/api/state')).body.ledger;
    check(ledger.domains.money_out.usd === 5 && ledger.domains.money_out.actions === 1, 'leash ledger: money_out $5.00 in 1 action');

    step(7, 'The reflection posts from real data');
    const reflect = await srv.post('/api/reflect', { reason: 'demo' });
    check(reflect.status === 202, 'reflection started');
    const posted = await waitFor((e) => e.type === 'reflection.posted', 'reflection.posted');
    check(posted.payload.status === 'posted' && posted.payload.briefings.includes('finance'), `reflection ${posted.payload.reflectionId} posted; briefed: ${posted.payload.briefings.join(', ')}`);
    const reflectCost = stream.events.filter((e) => e.type === 'cost.estimate' && e.seq > posted.seq - 50 && e.payload.inputTokens === REFLECT_USAGE.inputTokens).length;
    check(reflectCost >= 1, 'the reflection turn was priced');
    const reflectionPrompt = chief.requests.at(-1).messages[0].content[0].text;
    check(/Stripe: balance/.test(reflectionPrompt), 'the reflection saw the Stripe figures from the sync');
    const briefs = await fsp.readdir(path.join(srv.workspaceRoot, '_stations', 'finance', 'notes')).catch(() => []);
    check(briefs.length >= 1, `briefing written to _stations/finance/notes/ (${briefs[0] || 'none'})`);

    console.log('\nDEMO OK: mission → plan → delegation → tools → Gate → outbox → ledger → reflection, all from recorded events.');
  } finally {
    stream.close();
    await srv.close();
    await stripe.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
