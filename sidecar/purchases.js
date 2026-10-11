// Supplier purchasing through the browser (phase 4 step 17, D148).
//
// A purchase is a work item with money attached: a Ranger (or the Chief, or the
// Superintendent from the Peak) requests it with the venture, the supplier URL, the items
// and the amount; the amount is money_out, so the leash and the Gate decide on the request
// as on any money action, and once allowed the amount is HELD in the leash ledger (it counts
// against the money_out cap until the receipt or a cancel). The work item goes to a Ranger
// in a Field office, whose browser drives the supplier's site up to the payment page. The
// payment page ALWAYS hands off to the Superintendent (sidecar/browser/control.js refuses
// every click, type and upload on it for a purchase run, after a hand-back too): the
// browser never submits a payment. When the Superintendent has paid in the window and handed
// the page back with notes, the Ranger reads the confirmation and files `purchase.receipt`
// with the order id and the total as the page shows them; the receipt goes to the outbox
// with the trace's screenshot as evidence, the hold becomes money_out spend at the paid
// amount, and the purchase waits for reconciliation against a connector charge.
// Reconciliation is honest about its sources: a connector that holds the owner's outgoing
// charges exposes `outgoingCharges(data)`; none of the wired connectors does today, so a
// paid purchase reads `no_source` rather than pretending a match.
//
//   createPurchases({ bus, store, trails, ledger, browser, getLayout, getConnectors, knownVentures,
//                     netGuard, workspaceRoot, clock, log })
//     .init() -> { tools, request(input, { by, runId }), receipt(input, { agentId, runId }),
//                  cancel(id, { by }), reconcile(), list(), get(id), summary(), isPurchaseRun(runId),
//                  close() }

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { makeEvent } from '../shared/events.js';
import { agentOf } from '../shared/world.js';
import { writeJsonAtomic } from './store.js';
import { defaultNetGuard } from './netguard.js';

export const PURCHASE_TOOL_NAMES = Object.freeze(['purchase.request', 'purchase.receipt']);
export const PURCHASE_STATUSES = Object.freeze(['requested', 'driving', 'handoff', 'paid', 'cancelled', 'failed']);
export const PURCHASE_OPEN = Object.freeze(['requested', 'driving', 'handoff']);
export const PURCHASE_DEFAULT_BUDGET_USD = 0.6; // model spend for the run that drives the browser
export const PURCHASE_MAX_AMOUNT_USD = 10000;
export const PURCHASE_MAX_ITEMS = 50;
export const PURCHASES_KEEP = 500;
export const RECONCILE_WINDOW_DAYS = 7; // a charge within this many days of the payment can match
export const RECONCILE_TOLERANCE_USD = 0.01;
export const RECONCILE_GIVE_UP_DAYS = 30; // after this a paid purchase stays unmatched

// HTTP statuses for the codes (the routes pass them through).
const STATUS_FOR = { BAD_REQUEST: 400, BAD_SUPPLIER_URL: 400, UNKNOWN_VENTURE: 400, NO_EXECUTOR: 400, NO_BROWSER: 503, FORBIDDEN: 403, UNKNOWN_PURCHASE: 404, BAD_STATE: 409, NOT_PAID_BY_SUPERINTENDENT: 409 };

function fail(code, message, status = STATUS_FOR[code]) {
  const err = new Error(message);
  err.code = code;
  if (status) err.status = status;
  return err;
}

export function supplierHost(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Who drives the purchase: a Ranger standing in a zone with a Field office, other than the
// requester and never the Chief; `toAgentId` names one, else a Ranger of the venture, else
// the first. Returns { agent } or { error }.
export function pickExecutor(layout, { venture, requesterId = null, toAgentId = null } = {}) {
  const offices = new Set((layout.objects || []).filter((o) => o.kind === 'field_office').map((o) => o.roomId));
  const candidates = (layout.agents || []).filter((a) => offices.has(a.roomId) && a.id !== requesterId && (a.role || 'ranger') !== 'chief_ranger');
  if (toAgentId) {
    const a = candidates.find((x) => x.id === toAgentId);
    return a ? { agent: a } : { error: fail('NO_EXECUTOR', `"${toAgentId}" is not a Ranger standing in a Field office zone${toAgentId === requesterId ? ' other than the requester' : ''}`) };
  }
  const a = candidates.find((x) => x.venture === venture) || candidates[0];
  return a ? { agent: a } : { error: fail('NO_EXECUTOR', `no Ranger stands in a Field office zone${requesterId ? ' other than the requester' : ''}; place a Field office and a Ranger in it first`) };
}

// The work item's brief: what to do and, above all, what never to do.
export function purchaseBrief(p) {
  const lines = [
    `PURCHASE ${p.id} for venture ${p.venture}: buy from the supplier through your browser, up to the payment page.`,
    '',
    `Supplier: ${p.supplierUrl}`,
    'Items:',
    ...p.items.map((it) => `- ${it.qty} × ${it.name}${typeof it.unitUsd === 'number' ? ` at $${it.unitUsd.toFixed(2)}` : ''}`),
    `Declared amount: $${p.amountUsd.toFixed(2)} ${p.currency}. If the cart total comes out higher than this, stop and say so in your summary; do not proceed to checkout.`,
    '',
    'Steps: browser.open the supplier, add exactly these items to the cart, check the quantities and the total, proceed to checkout and fill the shipping details you have been given. The payment page is NOT yours: the browser hands it to the Superintendent on its own and refuses every click, type or upload on it. Wait for the hand-back. If the notes say the order was paid, browser.read the confirmation page, browser.screenshot it, then call purchase.receipt with the order id, the total and the currency exactly as the page shows them. If the notes say to stop, end your run and say so; never try another way to pay.',
    `Deliverable: the receipt (purchase.receipt writes outbox/purchases/${p.id}.json and .md).`,
  ];
  if (p.note) lines.push('', `Note from the requester: ${p.note}`);
  return lines.join('\n');
}

// Matches a paid purchase against outgoing-charge candidates [{ id, source, amountUsd,
// currency, at, description }]: one charge within the tolerance and the window is a match,
// several are ambiguous, none is unmatched (and stays so after the give-up window).
export function matchCharge(p, candidates, { now = Date.now() } = {}) {
  if (!p.receipt || typeof p.paidUsd !== 'number') return { status: 'pending', note: 'not paid yet' };
  const paidAt = p.receipt.paidAt ? Date.parse(p.receipt.paidAt) : p.updatedAt;
  const windowMs = RECONCILE_WINDOW_DAYS * 86_400_000;
  const hits = candidates.filter((c) => typeof c.amountUsd === 'number' && Math.abs(c.amountUsd - p.paidUsd) <= RECONCILE_TOLERANCE_USD && (!c.currency || !p.currency || c.currency === p.currency) && (!c.at || Math.abs(Date.parse(c.at) - paidAt) <= windowMs));
  if (hits.length === 1) return { status: 'matched', chargeId: hits[0].id, source: hits[0].source, note: `matched ${hits[0].source} charge ${hits[0].id}` };
  if (hits.length > 1) return { status: 'unmatched', note: `${hits.length} charges of the same amount within ${RECONCILE_WINDOW_DAYS} days; not chosen between` };
  const gaveUp = now - paidAt > RECONCILE_GIVE_UP_DAYS * 86_400_000;
  return { status: 'unmatched', note: gaveUp ? `no matching charge within ${RECONCILE_GIVE_UP_DAYS} days` : 'no matching charge yet' };
}

function validateRequest(input) {
  if (!input || typeof input !== 'object') throw fail('BAD_REQUEST', 'a purchase request needs venture, supplierUrl, items and amountUsd');
  const { venture, supplierUrl, items, amountUsd, currency = 'USD', note = '', toAgentId = null } = input;
  if (typeof venture !== 'string' || !venture.trim() || venture.length > 80) throw fail('BAD_REQUEST', 'venture is required (the venture id)');
  if (typeof supplierUrl !== 'string' || !/^https?:\/\//i.test(supplierUrl)) throw fail('BAD_REQUEST', 'supplierUrl must be an http(s) URL');
  if (!supplierHost(supplierUrl)) throw fail('BAD_REQUEST', 'supplierUrl is not a valid URL');
  if (!Array.isArray(items) || !items.length || items.length > PURCHASE_MAX_ITEMS) throw fail('BAD_REQUEST', `items must list 1 to ${PURCHASE_MAX_ITEMS} entries`);
  const cleanItems = items.map((it) => {
    if (!it || typeof it.name !== 'string' || !it.name.trim()) throw fail('BAD_REQUEST', 'every item needs a name');
    const qty = it.qty === undefined ? 1 : it.qty;
    if (!Number.isInteger(qty) || qty < 1 || qty > 10000) throw fail('BAD_REQUEST', `item "${it.name}": qty must be a whole number from 1`);
    const unitUsd = it.unitUsd === undefined || it.unitUsd === null ? null : it.unitUsd;
    if (unitUsd !== null && !(typeof unitUsd === 'number' && Number.isFinite(unitUsd) && unitUsd >= 0)) throw fail('BAD_REQUEST', `item "${it.name}": unitUsd must be a non-negative number`);
    return { name: it.name.trim().slice(0, 200), qty, ...(unitUsd !== null ? { unitUsd } : {}) };
  });
  if (!(typeof amountUsd === 'number' && Number.isFinite(amountUsd) && amountUsd > 0 && amountUsd <= PURCHASE_MAX_AMOUNT_USD)) throw fail('BAD_REQUEST', `amountUsd must be a number above 0 and at most ${PURCHASE_MAX_AMOUNT_USD}`);
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw fail('BAD_REQUEST', 'currency must be a three-letter code');
  if (typeof note !== 'string' || note.length > 500) throw fail('BAD_REQUEST', 'note must be a string of at most 500 characters');
  if (toAgentId !== null && (typeof toAgentId !== 'string' || !toAgentId)) throw fail('BAD_REQUEST', 'toAgentId must be an agent id');
  return { venture: venture.trim(), supplierUrl, items: cleanItems, amountUsd: Math.round(amountUsd * 100) / 100, currency, note: note.trim(), toAgentId };
}

export function createPurchases({ bus, store, trails, ledger, browser = null, getLayout, getConnectors = null, knownVentures = null, netGuard = defaultNetGuard(), workspaceRoot, clock = { now: () => Date.now() }, log = console } = {}) {
  if (!bus || !store || !trails || !ledger || !getLayout || !workspaceRoot) throw new TypeError('createPurchases needs bus, store, trails, ledger, getLayout and workspaceRoot');
  let purchases = [];
  let saving = Promise.resolve();
  const unsubscribe = [];
  const emit = (type, payload) => bus.emit(makeEvent(type, payload, { ts: clock.now() }));
  const save = () => {
    saving = saving.then(() => store.savePurchases({ version: 1, purchases })).catch((err) => log.error('purchases save failed:', err));
    return saving;
  };
  const find = (id) => purchases.find((p) => p.id === id) || null;
  const publicView = (p) => JSON.parse(JSON.stringify(p));
  const eventFor = (p, status, extra = {}) => {
    const payload = { purchaseId: p.id, status, venture: p.venture, amountUsd: p.amountUsd, currency: p.currency, supplierHost: p.supplierHost, by: p.requestedBy, ...extra };
    if (p.workItemId) payload.workItemId = p.workItemId;
    if (p.agentId) payload.agentId = p.agentId;
    if (p.runId) payload.runId = p.runId;
    if (typeof p.paidUsd === 'number') payload.paidUsd = p.paidUsd;
    if (p.receipt && p.receipt.path) payload.receiptPath = p.receipt.path;
    if (p.reconciliation && p.reconciliation.status) payload.reconciliation = p.reconciliation.status;
    emit('purchase.update', payload);
  };
  async function setStatus(p, status, { reason = null, event = status } = {}) {
    p.status = status;
    p.updatedAt = clock.now();
    if (reason) p.reason = reason;
    p.history.push({ at: p.updatedAt, status, ...(reason ? { reason } : {}) });
    eventFor(p, event, reason ? { reason } : {});
    await save();
  }

  // Candidates from connectors that hold the owner's outgoing charges, if any.
  function chargeCandidates() {
    const reg = getConnectors ? getConnectors() : null;
    if (!reg || typeof reg.kinds !== 'function') return { candidates: [], sources: [] };
    const candidates = [];
    const sources = [];
    for (const kind of reg.kinds()) {
      const spec = reg.spec(kind);
      if (!spec || typeof spec.outgoingCharges !== 'function') continue;
      sources.push(kind);
      try {
        for (const c of spec.outgoingCharges(reg.data(kind)) || []) candidates.push({ source: kind, ...c });
      } catch (err) {
        log.error(`${kind} outgoingCharges failed:`, err);
      }
    }
    return { candidates, sources };
  }

  async function request(input, { by, runId = null } = {}) {
    if (!by) throw fail('BAD_REQUEST', 'a purchase request needs a requester (by)');
    const clean = validateRequest(input);
    if (knownVentures) {
      const known = knownVentures();
      if (Array.isArray(known) && known.length && !known.includes(clean.venture)) throw fail('UNKNOWN_VENTURE', `no venture "${clean.venture}" in the plan; known: ${known.join(', ')}`);
    }
    const verdict = await netGuard.check(clean.supplierUrl);
    if (!verdict.ok) throw fail('BAD_SUPPLIER_URL', `the supplier URL is not on the public internet: ${verdict.reason}`);
    if (!browser) throw fail('NO_BROWSER', 'no browser control is wired, so no purchase can be driven');
    const layout = getLayout();
    const picked = pickExecutor(layout, { venture: clean.venture, requesterId: by === 'superintendent' ? null : by, toAgentId: clean.toAgentId });
    if (picked.error) throw picked.error;
    const id = `buy-${randomUUID().slice(0, 8)}`;
    const now = clock.now();
    const p = {
      id,
      venture: clean.venture,
      supplierUrl: clean.supplierUrl,
      supplierHost: supplierHost(clean.supplierUrl),
      items: clean.items,
      amountUsd: clean.amountUsd,
      currency: clean.currency,
      note: clean.note,
      status: 'requested',
      requestedBy: by,
      requestRunId: runId,
      agentId: picked.agent.id,
      workItemId: null,
      runId: null,
      createdAt: now,
      updatedAt: now,
      hold: { amountUsd: clean.amountUsd, since: now },
      receipt: null,
      paidUsd: null,
      reconciliation: { status: 'pending', note: 'not paid yet', checkedAt: null },
      reason: null,
      history: [{ at: now, status: 'requested' }],
    };
    await ledger.hold({ id, domain: 'money_out', amountUsd: clean.amountUsd, agentId: picked.agent.id, note: `purchase ${id} for ${clean.venture} at ${p.supplierHost}` });
    // The record is in before the delegation: the run may start (and say so on the bus)
    // before delegate() returns, and the start must find its purchase.
    purchases.push(p);
    eventFor(p, 'requested');
    let item;
    try {
      item = await trails.delegate({ toAgentId: picked.agent.id, brief: purchaseBrief(p), budgetUsd: PURCHASE_DEFAULT_BUDGET_USD, evidence: [`outbox/purchases/${id}.json`] }, { by });
    } catch (err) {
      purchases = purchases.filter((x) => x !== p);
      await ledger.releaseHold(id);
      eventFor(p, 'failed', { reason: `no work item: ${err.message}` });
      throw err;
    }
    p.workItemId = item.id;
    if (!p.runId) p.runId = item.runId || null;
    if (purchases.length > PURCHASES_KEEP) purchases = purchases.filter((x) => PURCHASE_OPEN.includes(x.status)).concat(purchases.filter((x) => !PURCHASE_OPEN.includes(x.status)).slice(-PURCHASES_KEEP));
    await save();
    return publicView(p);
  }

  // The receipt: only the Ranger driving the purchase, only after the Superintendent handed a
  // payment page back with notes for this run. Settles the hold at the paid amount.
  async function receipt(input, { agentId, runId = null } = {}) {
    if (!input || typeof input.purchaseId !== 'string') throw fail('BAD_REQUEST', 'purchaseId is required');
    const p = find(input.purchaseId);
    if (!p) throw fail('UNKNOWN_PURCHASE', `no purchase "${input.purchaseId}"`);
    if (p.agentId !== agentId) throw fail('FORBIDDEN', `purchase ${p.id} is driven by ${p.agentId}, not ${agentId}`, 403);
    if (!PURCHASE_OPEN.includes(p.status)) throw fail('BAD_STATE', `purchase ${p.id} is ${p.status}; no receipt can be filed`);
    if (typeof input.orderId !== 'string' || !input.orderId.trim()) throw fail('BAD_REQUEST', 'orderId is required, as the confirmation page shows it');
    if (!(typeof input.totalUsd === 'number' && Number.isFinite(input.totalUsd) && input.totalUsd >= 0)) throw fail('BAD_REQUEST', 'totalUsd must be a non-negative number, as the confirmation page shows it');
    const currency = input.currency || p.currency;
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw fail('BAD_REQUEST', 'currency must be a three-letter code');
    const handedBack = (browser && typeof browser.handoffs === 'function' ? browser.handoffs() : []).find((h) => h.kind === 'payment' && h.status === 'returned' && h.notes && h.agentId === agentId && (!p.runId || h.runId === p.runId || h.runId === runId));
    if (!handedBack) throw fail('NOT_PAID_BY_SUPERINTENDENT', 'no payment page was handed back with notes by the Superintendent for this run; a receipt records the Superintendent\'s payment and nothing else');
    // Evidence: the trace's latest entry (the confirmation page the Ranger read or shot).
    let evidence = null;
    if (browser && typeof browser.trace === 'function') {
      const trace = await browser.trace(agentId, { limit: 10 }).catch(() => []);
      const last = trace.find((e) => e.ok && (e.action === 'read' || e.action === 'screenshot')); // newest first
      if (last) evidence = { url: last.url || null, title: last.title || null, screenshot: last.screenshot || null, at: last.ts };
    }
    const totalUsd = Math.round(input.totalUsd * 100) / 100;
    const dir = path.join(workspaceRoot, agentId, 'outbox', 'purchases');
    await fsp.mkdir(dir, { recursive: true });
    const rel = path.posix.join('outbox', 'purchases', `${p.id}.json`);
    p.receipt = { orderId: input.orderId.trim().slice(0, 120), totalUsd, currency, paidAt: input.paidAt && !Number.isNaN(Date.parse(input.paidAt)) ? new Date(Date.parse(input.paidAt)).toISOString() : new Date(clock.now()).toISOString(), notes: typeof input.notes === 'string' ? input.notes.slice(0, 500) : '', handoffId: handedBack.handoffId, handoffNotes: handedBack.notes, evidence, path: rel };
    p.paidUsd = totalUsd;
    if (Math.abs(totalUsd - p.amountUsd) > RECONCILE_TOLERANCE_USD) p.receipt.differsFromDeclared = Math.round((totalUsd - p.amountUsd) * 100) / 100;
    await writeJsonAtomic(path.join(dir, `${p.id}.json`), { purchase: publicView({ ...p, status: 'paid' }) });
    const md = [
      `# Purchase ${p.id} — ${p.venture}`,
      '',
      `Supplier: ${p.supplierUrl}`,
      `Items: ${p.items.map((it) => `${it.qty} × ${it.name}`).join('; ')}`,
      `Declared: $${p.amountUsd.toFixed(2)} ${p.currency} · Paid: ${totalUsd.toFixed(2)} ${currency}${p.receipt.differsFromDeclared ? ` (differs from the declared amount by ${p.receipt.differsFromDeclared})` : ''}`,
      `Order id: ${p.receipt.orderId} · Paid at: ${p.receipt.paidAt}`,
      `Paid by the Superintendent in the browser window (handoff ${handedBack.handoffId}: "${handedBack.notes}").`,
      evidence ? `Evidence: ${evidence.url || 'page'}${evidence.screenshot ? ` · screenshot ${evidence.screenshot}` : ''}` : 'Evidence: none captured (read or screenshot the confirmation page before filing)',
      p.receipt.notes ? `Notes: ${p.receipt.notes}` : '',
    ].filter((l) => l !== '').join('\n');
    await fsp.writeFile(path.join(dir, `${p.id}.md`), `${md}\n`);
    await ledger.settleHold(p.id, { amountUsd: totalUsd });
    p.reconciliation = { status: 'pending', note: 'paid; waiting for a connector charge', checkedAt: null };
    await setStatus(p, 'paid');
    await reconcile();
    return publicView(p);
  }

  async function cancel(id, { by = 'superintendent', reason = 'cancelled by the Superintendent' } = {}) {
    const p = find(id);
    if (!p) throw fail('UNKNOWN_PURCHASE', `no purchase "${id}"`, 404);
    if (!PURCHASE_OPEN.includes(p.status)) throw fail('BAD_STATE', `purchase ${id} is ${p.status}`, 409);
    if (p.workItemId) {
      const item = trails.get(p.workItemId);
      if (item && (item.status === 'queued' || item.status === 'running')) {
        try {
          await trails.cancel(p.workItemId);
        } catch (err) {
          log.error(`purchase ${id}: work item cancel failed:`, err);
        }
      }
    }
    await ledger.releaseHold(id);
    await setStatus(p, 'cancelled', { reason: `${reason} (${by})` });
    return publicView(p);
  }

  // Paid purchases against the connectors' outgoing charges; no connector exposing them
  // means `no_source`, said plainly.
  async function reconcile() {
    const { candidates, sources } = chargeCandidates();
    const now = clock.now();
    let changed = false;
    for (const p of purchases) {
      if (p.status !== 'paid' || (p.reconciliation && p.reconciliation.status === 'matched')) continue;
      const next = sources.length ? matchCharge(p, candidates, { now }) : { status: 'no_source', note: 'no wired connector holds the owner\'s outgoing charges; the receipt is the record' };
      const before = p.reconciliation ? p.reconciliation.status : null;
      p.reconciliation = { ...next, checkedAt: now, sources };
      if (next.status !== before) {
        changed = true;
        p.updatedAt = now;
        if (next.status === 'matched') {
          p.history.push({ at: now, status: 'reconciled', note: next.note });
          eventFor(p, 'reconciled');
        }
      }
    }
    if (changed) await save();
    return summary();
  }

  function summary() {
    const open = purchases.filter((p) => PURCHASE_OPEN.includes(p.status));
    return {
      open: open.length,
      heldUsd: Math.round(open.reduce((n, p) => n + p.amountUsd, 0) * 100) / 100,
      paid: purchases.filter((p) => p.status === 'paid').length,
      paidUsd: Math.round(purchases.filter((p) => p.status === 'paid').reduce((n, p) => n + (p.paidUsd || 0), 0) * 100) / 100,
      unreconciled: purchases.filter((p) => p.status === 'paid' && p.reconciliation && p.reconciliation.status !== 'matched').length,
      sources: chargeCandidates().sources,
      recent: purchases.slice(-20).reverse().map((p) => ({ id: p.id, venture: p.venture, supplierHost: p.supplierHost, amountUsd: p.amountUsd, currency: p.currency, status: p.status, agentId: p.agentId, workItemId: p.workItemId, paidUsd: p.paidUsd, reconciliation: p.reconciliation ? p.reconciliation.status : null, updatedAt: p.updatedAt })),
    };
  }

  const tools = Object.freeze({
    'purchase.request': {
      name: 'purchase.request',
      description: 'Request a supplier purchase through a Field office Ranger\'s browser: the venture, the supplier URL, the items (name, qty, unitUsd) and the amount in USD. The amount is money out: the leash and the Entrance Gate decide, then it is held against the money_out cap until the receipt. The purchase becomes a work item for a Ranger in a Field office (toAgentId, or chosen by venture) who drives the site up to the payment page; the payment page always hands off to the Superintendent and the browser never submits a payment.',
      inputSchema: {
        type: 'object',
        required: ['venture', 'supplierUrl', 'items', 'amountUsd'],
        additionalProperties: false,
        properties: {
          venture: { type: 'string', minLength: 1, maxLength: 80 },
          supplierUrl: { type: 'string', minLength: 8, maxLength: 2000 },
          items: { type: 'array', minItems: 1, maxItems: PURCHASE_MAX_ITEMS, items: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, qty: { type: 'integer', minimum: 1, maximum: 10000 }, unitUsd: { type: 'number', minimum: 0 } } } },
          amountUsd: { type: 'number', exclusiveMinimum: 0, maximum: PURCHASE_MAX_AMOUNT_USD },
          currency: { type: 'string', pattern: '^[A-Z]{3}$' },
          note: { type: 'string', maxLength: 500 },
          toAgentId: { type: 'string', minLength: 1, maxLength: 120 },
        },
      },
      confirm: false,
      settlesLater: true,
      amountUsd: (input) => (typeof input.amountUsd === 'number' && Number.isFinite(input.amountUsd) && input.amountUsd > 0 ? input.amountUsd : null),
      summarize: (input) => `request a $${Number(input.amountUsd || 0).toFixed(2)} purchase for ${input.venture} at ${supplierHost(input.supplierUrl) || input.supplierUrl}`,
      async run(input, ctx) {
        try {
          const p = await request(input, { by: ctx.agentId, runId: ctx.runId });
          return { ok: true, output: JSON.stringify({ purchaseId: p.id, status: p.status, workItemId: p.workItemId, executor: p.agentId, heldUsd: p.amountUsd, note: 'the amount is held against the money_out cap until the receipt; the payment page hands off to the Superintendent' }) };
        } catch (err) {
          return { ok: false, code: err.code || 'PURCHASE', error: err.message };
        }
      },
    },
    'purchase.receipt': {
      name: 'purchase.receipt',
      description: 'File the receipt of a purchase you are driving, after the Superintendent paid on the handed-off payment page and handed it back with notes: the order id, the total and the currency exactly as the confirmation page shows them (browser.read and browser.screenshot it first; the latest is attached as evidence). Writes outbox/purchases/<id>.json and .md and settles the held amount at what was paid.',
      inputSchema: {
        type: 'object',
        required: ['purchaseId', 'orderId', 'totalUsd'],
        additionalProperties: false,
        properties: {
          purchaseId: { type: 'string', minLength: 1, maxLength: 40 },
          orderId: { type: 'string', minLength: 1, maxLength: 120 },
          totalUsd: { type: 'number', minimum: 0 },
          currency: { type: 'string', pattern: '^[A-Z]{3}$' },
          paidAt: { type: 'string', maxLength: 40 },
          notes: { type: 'string', maxLength: 500 },
        },
      },
      confirm: false,
      summarize: (input) => `file the receipt for ${input.purchaseId} (order ${input.orderId}, ${Number(input.totalUsd || 0).toFixed(2)})`,
      async run(input, ctx) {
        try {
          const p = await receipt(input, { agentId: ctx.agentId, runId: ctx.runId });
          return { ok: true, output: JSON.stringify({ purchaseId: p.id, status: p.status, paidUsd: p.paidUsd, receipt: p.receipt.path, reconciliation: p.reconciliation.status }) };
        } catch (err) {
          return { ok: false, code: err.code || 'RECEIPT', error: err.message };
        }
      },
    },
  });

  const api = {
    tools,
    request,
    receipt,
    cancel,
    reconcile,
    summary,
    list: () => purchases.slice().reverse().map(publicView),
    get: (id) => (find(id) ? publicView(find(id)) : null),
    isPurchaseRun: (runId) => Boolean(runId) && purchases.some((p) => p.runId === runId && PURCHASE_OPEN.includes(p.status)),
    async init() {
      const loaded = await store.loadPurchases(null);
      if (loaded && loaded.version === 1 && Array.isArray(loaded.purchases)) purchases = loaded.purchases;
      // A purchase whose hold is gone (a ledger reset) keeps its record; a hold whose
      // purchase is gone is released, so nothing is counted twice or forever.
      const ids = new Set(purchases.filter((p) => PURCHASE_OPEN.includes(p.status)).map((p) => p.id));
      for (const h of ledger.holds()) if (h.id.startsWith('buy-') && !ids.has(h.id)) await ledger.releaseHold(h.id);
      unsubscribe.push(bus.listen((e) => {
        const q = e.payload || {};
        if (e.type === 'agent.run.start') {
          // The run's brief names the purchase (purchaseBrief); the work item's runId is set
          // by the trails only after the start, so the brief is the sure link.
          const m = /PURCHASE (buy-[0-9a-f]+) for venture/.exec(q.prompt || '');
          const p = m ? purchases.find((x) => x.id === m[1] && x.agentId === q.agentId && PURCHASE_OPEN.includes(x.status)) : null;
          if (p) {
            p.runId = q.runId;
            setStatus(p, 'driving').catch((err) => log.error('purchase status failed:', err));
          }
          return;
        }
        if (e.type === 'browser.handoff' && q.kind === 'payment') {
          const p = purchases.find((x) => x.runId && x.runId === q.runId && PURCHASE_OPEN.includes(x.status));
          if (!p) return;
          if (q.status === 'waiting' && p.status !== 'handoff') setStatus(p, 'handoff', { reason: `payment page ${q.url || ''} handed to the Superintendent` }).catch((err) => log.error('purchase status failed:', err));
          else if (q.status === 'returned' && p.status === 'handoff') setStatus(p, 'driving', { reason: `page handed back${q.notes ? `: ${q.notes}` : ''}` }).catch((err) => log.error('purchase status failed:', err));
          return;
        }
        if (e.type === 'work.done' && q.workItemId) {
          const p = purchases.find((x) => x.workItemId === q.workItemId && PURCHASE_OPEN.includes(x.status));
          if (!p) return;
          ledger.releaseHold(p.id).then(() => setStatus(p, 'failed', { reason: q.status === 'done' ? 'the run ended without a receipt; the hold is released' : `the run ${q.reason || 'failed'} before a receipt; the hold is released` })).catch((err) => log.error('purchase status failed:', err));
          return;
        }
        if (e.type === 'connector.sync' && q.status === 'done') reconcile().catch((err) => log.error('purchase reconcile failed:', err));
      }));
      if (browser && typeof browser.setPurchaseCheck === 'function') browser.setPurchaseCheck(api.isPurchaseRun);
      return api;
    },
    async close() {
      for (const u of unsubscribe) if (typeof u === 'function') u();
      await saving;
    },
  };
  return api;
}
