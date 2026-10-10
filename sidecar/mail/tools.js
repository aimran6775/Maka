// Mail tools for Rangers (phase 2 step 12), granted by the Radio tower fixture.
//
// Scope: a Ranger sees the mail of its station (its zone's shared mailbox) and its own
// aliases; the Chief sees everything. Reads are research; mail.send's leash domain follows
// the message kind (sidecar/mail/send.js), mail.create_address is account_creation,
// mail.draft only writes to the local store. The tools act through toolContext.mail
// (sidecar/mail/system.js) and the agents registry.

import { SPECIALTIES } from '../../shared/world.js';
import { MAX_RECIPIENTS } from './send.js';

function noMail(ctx) {
  return !ctx.mail ? { ok: false, error: 'the mail system is not available in this run' } : null;
}

function scopeFor(ctx) {
  const me = ctx.agents ? ctx.agents.get(ctx.agentId) : null;
  if (!me) return { all: false, station: null, agentId: ctx.agentId };
  return { all: (me.role || 'ranger') === 'chief_ranger', station: me.roomId, agentId: me.id, venture: me.venture || null, me };
}

function visible(scope, m) {
  if (scope.all) return true;
  return m.station === scope.station || m.agentId === scope.agentId;
}

function brief(m) {
  return { id: m.id, threadId: m.threadId, direction: m.direction, from: m.from, to: m.to, subject: m.subject, date: new Date(m.date).toISOString(), station: m.station, venture: m.venture, classification: m.classification, status: m.status, labels: m.labels, attachments: m.attachments, snippet: m.snippet };
}

export const mailSearch = {
  name: 'mail.search',
  description: "Search your station's mail (and your own aliases). Returns summaries with ids; read one in full with mail.read. Filters: query text, threadId, venture, direction (in|out), label, unreadOnly.",
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', description: 'Text to match in subject, sender, recipients or snippet' },
      threadId: { type: 'string' },
      venture: { type: 'string' },
      direction: { type: 'string', enum: ['in', 'out'] },
      label: { type: 'string' },
      unreadOnly: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
  },
  confirm: false,
  async run(input, ctx) {
    const missing = noMail(ctx);
    if (missing) return missing;
    const scope = scopeFor(ctx);
    const store = ctx.mail.mailStore;
    let rows = input.query ? store.search(input.query, { limit: 500 }) : store.list({ threadId: input.threadId, venture: input.venture, direction: input.direction, label: input.label, limit: 500 });
    rows = rows.filter((m) => visible(scope, m));
    if (input.threadId) rows = rows.filter((m) => m.threadId === input.threadId);
    if (input.venture) rows = rows.filter((m) => m.venture === input.venture);
    if (input.direction) rows = rows.filter((m) => m.direction === input.direction);
    if (input.label) rows = rows.filter((m) => m.labels.includes(input.label));
    if (input.unreadOnly) rows = rows.filter((m) => m.direction === 'in' && !m.labels.includes('read'));
    return { ok: true, output: JSON.stringify({ count: rows.length, messages: rows.slice(0, input.limit || 20).map(brief) }) };
  },
};

export const mailRead = {
  name: 'mail.read',
  description: 'Read one message in full (headers, text, attachment list) by id, or a whole thread by threadId. Marks the message read.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, threadId: { type: 'string' } } },
  confirm: false,
  async run(input, ctx) {
    const missing = noMail(ctx);
    if (missing) return missing;
    const scope = scopeFor(ctx);
    const store = ctx.mail.mailStore;
    if (input.threadId) {
      const msgs = (await store.thread(input.threadId)).filter((m) => visible(scope, m));
      if (!msgs.length) return { ok: false, error: `no thread ${input.threadId} in your mail` };
      for (const m of msgs) if (m.direction === 'in' && !m.labels.includes('read')) m.labels = await store.setLabels(m.id, { add: ['read'] });
      return { ok: true, output: JSON.stringify(msgs.map(full)) };
    }
    if (!input.id) return { ok: false, error: 'id or threadId is required' };
    const m = await store.get(input.id);
    if (!m || !visible(scope, m)) return { ok: false, error: `no message ${input.id} in your mail` };
    if (m.direction === 'in' && !m.labels.includes('read')) m.labels = await store.setLabels(m.id, { add: ['read'] });
    return { ok: true, output: JSON.stringify(full(m)) };
  },
};

function full(m) {
  return { id: m.id, threadId: m.threadId, direction: m.direction, from: m.from, to: m.to, cc: m.cc, subject: m.subject, date: new Date(m.date).toISOString(), messageId: m.messageId, inReplyTo: m.inReplyTo, station: m.station, venture: m.venture, classification: m.classification, status: m.status, labels: m.labels, text: (m.text || '').slice(0, 20000), attachments: (m.attachments || []).map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.size, path: a.path ? `_mail/${a.path}` : null, problem: a.problem || null })) };
}

export const mailDraft = {
  name: 'mail.draft',
  description: 'Save a draft in the station mailbox (not sent). Returns the draft id; send it later with mail.send { draftId }. Use it to prepare a reply the Superintendent or the judge may want to see first.',
  inputSchema: {
    type: 'object',
    required: ['to', 'subject', 'text'],
    additionalProperties: false,
    properties: {
      from: { type: 'string', description: 'One of your addresses; defaults to your station address' },
      to: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_RECIPIENTS },
      subject: { type: 'string', minLength: 1 },
      text: { type: 'string', minLength: 1 },
      inReplyTo: { type: 'string', description: 'Message-ID being answered (from mail.read)' },
      kind: { type: 'string', enum: ['reply', 'notification', 'campaign'], description: 'Only "campaign" is taken at its word; otherwise the kind follows the recipients and the thread' },
    },
  },
  confirm: false,
  async run(input, ctx) {
    const missing = noMail(ctx);
    if (missing) return missing;
    const scope = scopeFor(ctx);
    const from = input.from || defaultFrom(ctx, scope);
    if (!from) return { ok: false, error: 'you have no address to send from (no station address)' };
    const kind = ctx.mail.policy.kindOf({ to: input.to, inReplyTo: input.inReplyTo, kind: input.kind });
    const d = await ctx.mail.mailStore.add({ direction: 'out', from, to: input.to, subject: input.subject, text: input.text, inReplyTo: input.inReplyTo || null, kind, station: scope.station || 'unknown', venture: scope.venture, agentId: scope.agentId, status: 'draft', labels: ['draft'] });
    return { ok: true, output: JSON.stringify({ draftId: d.id, threadId: d.threadId, from, to: d.to, kind: d.kind }) };
  },
};

function defaultFrom(ctx, scope) {
  const allowed = ctx.mail.policy.allowedFrom(scope.agentId);
  const station = ctx.mail.addresses.forStation(scope.station || '').find((r) => r.kind === 'station');
  return (station && allowed.includes(station.address) ? station.address : allowed[0]) || null;
}

export const mailSend = {
  name: 'mail.send',
  description: 'Send mail from one of your addresses through the park\'s mail system. The kind is decided by the park, not by you: a reply (one recipient, answering a message the park holds, keeps the thread) is an outbound message; anything else, more than one recipient included, is a campaign (publishing; an unsubscribe footer is added). Pass draftId to send a saved draft, or the fields directly. At most 50 recipients; suppressed recipients are dropped; hourly ceilings apply.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      draftId: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'array', items: { type: 'string' }, maxItems: MAX_RECIPIENTS },
      subject: { type: 'string' },
      text: { type: 'string' },
      html: { type: 'string' },
      inReplyTo: { type: 'string' },
      kind: { type: 'string', enum: ['reply', 'notification', 'campaign'], description: 'Only "campaign" is taken at its word; otherwise the kind follows the recipients and the thread' },
    },
  },
  confirm: false,
  // The domain follows the derived kind (safety M5). The mail system replaces this with
  // the policy's own function, which loads a named draft; this stand-in, used only when
  // the tool is registered without the system, can take no draft and judges the strict
  // way: a campaign unless one recipient answers a known message.
  domain: (input) => (input && !input.draftId && Array.isArray(input.to) && input.to.length === 1 && input.inReplyTo && input.kind !== 'campaign' ? 'outbound_messages' : 'publishing'),
  amountUsd: () => 0,
  summarize: (input) => `send ${input.kind || (input.inReplyTo ? 'reply' : 'mail')} to ${(input.to || []).join(', ') || (input.draftId ? `draft ${input.draftId}` : '?')}: "${(input.subject || '').slice(0, 60)}"`,
  judgeAtDraft: null, // set by the mail system (policy.judgeAtDraft) when wired
  async run(input, ctx) {
    const missing = noMail(ctx);
    if (missing) return missing;
    const scope = scopeFor(ctx);
    let msg = { from: input.from, to: input.to, subject: input.subject, text: input.text, html: input.html, inReplyTo: input.inReplyTo, kind: input.kind };
    if (input.draftId) {
      const d = await ctx.mail.mailStore.get(input.draftId);
      if (!d || !visible(scope, d) || d.status !== 'draft') return { ok: false, error: `no draft ${input.draftId} in your mail` };
      msg = { from: input.from || d.from, to: input.to || d.to, subject: input.subject || d.subject, text: input.text || d.text, html: input.html || d.html, inReplyTo: input.inReplyTo || d.inReplyTo, kind: input.kind || d.kind };
    }
    if (!msg.from) msg.from = defaultFrom(ctx, scope);
    try {
      const sent = await ctx.mail.policy.send(msg, { by: scope.agentId });
      if (input.draftId) await ctx.mail.mailStore.setLabels(input.draftId, { add: ['sent-as:' + sent.id], remove: ['draft'] }).catch(() => {});
      return { ok: true, output: JSON.stringify({ messageId: sent.id, threadId: sent.threadId, resendId: sent.resendId, to: sent.to, dropped: sent.dropped, kind: sent.kind }) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  },
};

const slug = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export const mailCreateAddress = {
  name: 'mail.create_address',
  description: 'Ask for a venture address of your own, <role>-<venture>@<domain>, routed into your station with the venture tag. Creating an address is an account_creation action under the leash.',
  inputSchema: {
    type: 'object',
    required: ['venture'],
    additionalProperties: false,
    properties: {
      venture: { type: 'string', minLength: 1, description: 'The venture id or slug' },
      role: { type: 'string', description: 'Optional role word for the local part; defaults to your specialty or "ranger"' },
    },
  },
  confirm: false,
  domain: 'account_creation',
  summarize: (input) => `create address ${slug(input.role || 'ranger')}-${slug(input.venture)}@ for the venture ${slug(input.venture)}`,
  async run(input, ctx) {
    const missing = noMail(ctx);
    if (missing) return missing;
    const scope = scopeFor(ctx);
    if (!scope.station) return { ok: false, error: 'you have no station to route the address into' };
    const role = slug(input.role || (scope.me && scope.me.specialty) || 'ranger');
    const venture = slug(input.venture);
    try {
      const rule = await ctx.mail.addresses.createAlias({ local: `${role}-${venture}`, agentId: scope.agentId, venture, station: scope.station }, { by: scope.agentId });
      return { ok: true, output: JSON.stringify({ address: rule.address, station: rule.station, venture: rule.venture }) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  },
};

export const MAIL_TOOLS = Object.freeze({ 'mail.search': mailSearch, 'mail.read': mailRead, 'mail.draft': mailDraft, 'mail.send': mailSend, 'mail.create_address': mailCreateAddress });
export { SPECIALTIES };
