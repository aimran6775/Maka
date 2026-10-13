// D187: a department's mail has folders.
//
// The owner: "Do we have a email management system in the park. Every dept should have
// their own email system. Inbox, sent etc. everything gmail has."
//
// Most of it was already there: every message carries a direction, a status, a station (the
// department whose address it routed to) and labels, and threads were already grouped. What
// was missing was the idea of a *folder*, so the park could list a department's mail but
// not its inbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createMailStore } from '../sidecar/mail/store.js';
import { FOLDERS, FOLDER_IDS, inFolder, isUnread, moveFor, folder } from '../shared/mail-folders.js';

const msg = (over = {}) => ({
  direction: 'in',
  from: 'Customer <c@example.com>',
  to: ['support@makapark.com'],
  subject: 'Where is my order',
  text: 'hello',
  date: 1000,
  station: 'operations-support',
  labels: [],
  ...over,
});

async function store() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-mailfolders-'));
  const s = createMailStore({ root: dir, clock: { now: () => 1000 } });
  await s.init();
  return { s, dir, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

test('a folder is a question asked of a message, and the set is what a mailbox needs', () => {
  assert.deepEqual([...FOLDER_IDS], ['inbox', 'starred', 'sent', 'drafts', 'spam', 'archive', 'trash', 'all']);
  for (const f of FOLDERS) {
    assert.ok(f.label && typeof f.match === 'function', `${f.id} needs a label and a rule`);
  }
  // An unknown folder matches nothing rather than everything: a typo should show an empty
  // mailbox, not the whole archive.
  assert.equal(inFolder(msg(), 'nonsense'), false);
  assert.equal(folder('nonsense'), null);
  assert.equal(folder('inbox').label, 'Inbox');
});

test('where each message belongs', () => {
  const arrived = msg();
  assert.ok(inFolder(arrived, 'inbox'));
  assert.ok(inFolder(arrived, 'all'));
  assert.ok(!inFolder(arrived, 'sent'));

  // Sent mail is out and not a draft.
  const sent = msg({ direction: 'out', status: 'sent' });
  assert.ok(inFolder(sent, 'sent'));
  assert.ok(!inFolder(sent, 'inbox'), 'the park\'s own mail is not in its inbox');

  // A draft is what a message *is*, so it is a status, and it is never in sent.
  const draft = msg({ direction: 'out', status: 'draft' });
  assert.ok(inFolder(draft, 'drafts'));
  assert.ok(!inFolder(draft, 'sent'));
  assert.ok(!inFolder(draft, 'inbox'));

  // Filing is a label, so it can be undone without rewriting what the message is.
  const archived = msg({ labels: ['archived'] });
  assert.ok(inFolder(archived, 'archive'));
  assert.ok(!inFolder(archived, 'inbox'), 'archiving takes it out of the inbox');
  assert.ok(inFolder(archived, 'all'));

  // Trash wins over everything: something thrown away does not come back because it also
  // happens to be starred or archived.
  const trashed = msg({ labels: ['trashed', 'starred', 'archived'] });
  assert.ok(inFolder(trashed, 'trash'));
  for (const id of ['inbox', 'starred', 'sent', 'drafts', 'spam', 'archive', 'all']) {
    assert.ok(!inFolder(trashed, id), `trashed mail is not in ${id}`);
  }

  // Starred is its own view of mail that lives elsewhere.
  const starred = msg({ labels: ['starred'] });
  assert.ok(inFolder(starred, 'starred') && inFolder(starred, 'inbox'));
});

test('unread is the absence of a label, and only on mail that arrived', () => {
  assert.equal(isUnread(msg()), true);
  assert.equal(isUnread(msg({ labels: ['read'] })), false);
  assert.equal(isUnread(msg({ direction: 'out', status: 'sent' })), false, 'the park\'s own mail is not waiting to be read');
  assert.equal(isUnread(msg({ direction: 'out', status: 'draft' })), false);
});

test('moving mail: to the inbox is "not filed anywhere"', () => {
  assert.deepEqual(moveFor('inbox'), { add: [], remove: ['archived', 'trashed'] });
  assert.deepEqual(moveFor('archive'), { add: ['archived'], remove: ['trashed'] });
  assert.deepEqual(moveFor('trash'), { add: ['trashed'], remove: [] });
  // Sent and drafts are not places you can move mail to — they are what it is.
  assert.equal(moveFor('sent'), null);
  assert.equal(moveFor('drafts'), null);
  assert.equal(moveFor('nonsense'), null);
});

test('each department has its own mailbox, and one department\'s mail never shows in another\'s', async () => {
  const h = await store();
  try {
    await h.s.add(msg({ subject: 'A customer', station: 'operations-support' }));
    await h.s.add(msg({ subject: 'An invoice', station: 'finance' }));
    await h.s.add(msg({ subject: 'A reply we sent', station: 'finance', direction: 'out', status: 'sent', from: 'finance@makapark.com', to: ['c@example.com'] }));

    const support = h.s.threads({ station: 'operations-support', folder: 'inbox' });
    assert.equal(support.length, 1);
    assert.equal(support[0].subject, 'A customer');

    const finance = h.s.threads({ station: 'finance', folder: 'inbox' });
    assert.equal(finance.length, 1);
    assert.equal(finance[0].subject, 'An invoice', 'and not the one it sent');

    assert.equal(h.s.threads({ station: 'finance', folder: 'sent' }).length, 1);
    assert.equal(h.s.threads({ station: 'operations-support', folder: 'sent' }).length, 0);

    // The whole park, when no department is named.
    assert.equal(h.s.threads({ folder: 'all' }).length, 3);
  } finally {
    await h.cleanup();
  }
});

test('the folder rail counts threads and unread, per department', async () => {
  const h = await store();
  try {
    const a = await h.s.add(msg({ subject: 'One', station: 'finance' }));
    await h.s.add(msg({ subject: 'Two', station: 'finance', date: 2000 }));
    await h.s.add(msg({ subject: 'Read already', station: 'finance', date: 3000, labels: ['read'] }));
    await h.s.add(msg({ subject: 'Elsewhere', station: 'sales' }));

    const f = h.s.folders({ station: 'finance' });
    assert.equal(f.inbox.threads, 3);
    assert.equal(f.inbox.unread, 2, 'the one already read does not count');
    assert.equal(f.sent.threads, 0);
    assert.equal(f.trash.threads, 0);

    // Reading one moves the count, and nothing else changes.
    await h.s.setLabels(a.id, { add: ['read'] });
    assert.equal(h.s.folders({ station: 'finance' }).inbox.unread, 1);

    // Archiving takes it out of the inbox and puts it in the archive.
    await h.s.setLabels(a.id, { add: ['archived'] });
    const after = h.s.folders({ station: 'finance' });
    assert.equal(after.inbox.threads, 2);
    assert.equal(after.archive.threads, 1);

    // Trashing hides it from both.
    await h.s.setLabels(a.id, { add: ['trashed'] });
    const end = h.s.folders({ station: 'finance' });
    assert.equal(end.archive.threads, 0);
    assert.equal(end.trash.threads, 1);
    assert.equal(end.all.threads, 2, 'all mail excludes the bin');

    // Another department's rail is its own.
    assert.equal(h.s.folders({ station: 'sales' }).inbox.threads, 1);
    // And the whole park's.
    assert.equal(h.s.folders({}).inbox.threads, 3);
  } finally {
    await h.cleanup();
  }
});

test('searching inside a department narrows the same list', async () => {
  const h = await store();
  try {
    await h.s.add(msg({ subject: 'Invoice 4012', station: 'finance', from: 'Supplier <s@wax.example>' }));
    await h.s.add(msg({ subject: 'Refund please', station: 'finance', date: 2000 }));

    assert.equal(h.s.threads({ station: 'finance', folder: 'inbox' }).length, 2);
    assert.equal(h.s.threads({ station: 'finance', folder: 'inbox', q: 'invoice' }).length, 1);
    assert.equal(h.s.threads({ station: 'finance', folder: 'inbox', q: 'wax.example' }).length, 1, 'the sender counts too');
    assert.equal(h.s.threads({ station: 'finance', folder: 'inbox', q: 'nothing like this' }).length, 0);
    // A search with no folder still respects the department.
    assert.equal(h.s.threads({ station: 'sales', q: 'invoice' }).length, 0);
  } finally {
    await h.cleanup();
  }
});

test('a reply to an archived thread brings the thread back to the inbox', async () => {
  const h = await store();
  try {
    // A thread the department filed away.
    const first = await h.s.add(msg({ subject: 'Order 12', station: 'finance', messageId: '<m1@example.com>' }));
    await h.s.setLabels(first.id, { add: ['archived', 'read'] });
    assert.equal(h.s.threads({ station: 'finance', folder: 'inbox' }).length, 0);

    // The customer writes again, into the same thread.
    const reply = await h.s.add(msg({ subject: 'Re: Order 12', station: 'finance', date: 5000, messageId: '<m2@example.com>', inReplyTo: '<m1@example.com>' }));
    assert.equal(reply.threadId, first.threadId, 'it joined the thread');
    const inbox = h.s.threads({ station: 'finance', folder: 'inbox' });
    assert.equal(inbox.length, 1, 'the thread is back, because one of its messages is unfiled');
    assert.equal(inbox[0].unread, 1);
    // It is in the archive too, because the earlier message is still filed there. A thread
    // belongs to a folder when any of its messages does.
    assert.equal(h.s.threads({ station: 'finance', folder: 'archive' }).length, 1);
  } finally {
    await h.cleanup();
  }
});

// D187: every department has an address, or nothing can reach it.
//
// D178 added Sales, People, Business, Legal and Infrastructure as departments with heads
// and standing duties, and the mail system did not know about four of them: `ensureStations`
// maps a zone *kind* to a local part, and those kinds were not in the map. So the camps
// existed, had heads, ran duties — and had no address. The mailbox said so for each of
// them, which is how it was noticed.
test('every department the park can build has a station address', async () => {
  const { STATION_LOCALS } = await import('../sidecar/mail/addresses.js');
  const { DEPARTMENT_KINDS, ZONE_LABELS } = await import('../shared/world.js');
  for (const kind of DEPARTMENT_KINDS) {
    assert.ok(STATION_LOCALS[kind], `the ${ZONE_LABELS[kind] || kind} has no address: nothing could reach it`);
    assert.match(STATION_LOCALS[kind], /^[a-z][a-z0-9-]*$/, `${kind}'s local part must be a usable address`);
  }
  // And the park's own places keep theirs.
  for (const kind of ['mountain_peak', 'ranger_station', 'visitor_center']) {
    assert.ok(STATION_LOCALS[kind], `${kind} has no address`);
  }
  // No two departments share one, or their mail would land in the same box.
  const locals = DEPARTMENT_KINDS.map((k) => STATION_LOCALS[k]);
  assert.equal(new Set(locals).size, locals.length, 'each department needs its own address');
});

// D188: the gaps between this and a mail client people recognise.
test('spam is the classifier\'s reading, and it keeps spam out of the inbox', () => {
  const spam = msg({ classification: 'spam' });
  assert.ok(inFolder(spam, 'spam'));
  assert.ok(!inFolder(spam, 'inbox'), 'the inbox is what is left after spam');
  // A message the owner filed or binned is where they put it, not back in spam.
  assert.ok(!inFolder(msg({ classification: 'spam', labels: ['archived'] }), 'spam'));
  assert.ok(!inFolder(msg({ classification: 'spam', labels: ['trashed'] }), 'spam'));
  // Mail nobody has classified is in the inbox: an unread classifier is not a reason to
  // hide someone's mail.
  assert.ok(inFolder(msg({ classification: null }), 'inbox'));
  assert.ok(inFolder(msg({ classification: 'customer' }), 'inbox'));
  // The park's own sent mail is never spam.
  assert.ok(!inFolder(msg({ direction: 'out', status: 'sent', classification: 'spam' }), 'spam'));
});

test('a custom label is a view of its own, and the reserved ones are not offered as labels', async () => {
  const { inLabel } = await import('../shared/mail-folders.js');
  assert.ok(inLabel(msg({ labels: ['suppliers'] }), 'suppliers'));
  assert.ok(!inLabel(msg({ labels: ['suppliers'] }), 'customers'));
  assert.ok(!inLabel(msg({ labels: ['suppliers', 'trashed'] }), 'suppliers'), 'binned mail leaves its labels behind');
  assert.ok(!inLabel(msg({ labels: [] }), ''), 'no label is not every label');

  const h = await store();
  try {
    await h.s.add(msg({ station: 'finance', labels: ['suppliers', 'read'] }));
    await h.s.add(msg({ station: 'finance', date: 2000, labels: ['suppliers'] }));
    await h.s.add(msg({ station: 'finance', date: 3000, labels: ['urgent', 'starred'] }));
    const labels = h.s.labels({ station: 'finance' });
    assert.deepEqual(labels, [{ label: 'suppliers', messages: 2 }, { label: 'urgent', messages: 1 }], 'in order, counted, and read/starred are the folders\' own');
    assert.equal(h.s.threads({ station: 'finance', label: 'suppliers' }).length, 2);
    assert.equal(h.s.threads({ station: 'finance', label: 'nothing' }).length, 0);
    assert.deepEqual(h.s.labels({ station: 'sales' }), []);
  } finally {
    await h.cleanup();
  }
});

test('a row carries the newest message\'s preview text', async () => {
  const h = await store();
  try {
    const a = await h.s.add(msg({ station: 'finance', subject: 'Order 12', text: 'The first word on this', messageId: '<a@x>' }));
    await h.s.add(msg({ station: 'finance', subject: 'Re: Order 12', text: 'The latest word on this', date: 9000, messageId: '<b@x>', inReplyTo: '<a@x>' }));
    const [t] = h.s.threads({ station: 'finance', folder: 'inbox' });
    assert.equal(t.count, 2);
    assert.match(t.snippet, /The latest word/, 'the newest, which is what a reader wants');
    assert.ok(Array.isArray(t.ids) && t.ids.length === 2, 'and the ids, so an action needs no second fetch');
    assert.ok(t.ids.includes(a.id));
  } finally {
    await h.cleanup();
  }
});

test('throwing mail away for good is only possible from the bin', async () => {
  const h = await store();
  try {
    const m = await h.s.add(msg({ station: 'finance' }));
    // There is no path from the inbox straight to gone — that is what a bin is for.
    await assert.rejects(h.s.purge(m.id), (e) => e.code === 'CONFLICT' && /move it there first/.test(e.message));
    await h.s.setLabels(m.id, { add: ['trashed'] });
    assert.deepEqual(await h.s.purge(m.id), { purged: m.id });
    assert.equal(h.s.folders({ station: 'finance' }).trash.threads, 0);
    assert.equal(h.s.summary(m.id), null, 'and it is gone from the index');
    assert.equal(await h.s.get(m.id), null, 'and from disk');
    await assert.rejects(h.s.purge(m.id), (e) => e.code === 'NOT_FOUND');
  } finally {
    await h.cleanup();
  }
});
