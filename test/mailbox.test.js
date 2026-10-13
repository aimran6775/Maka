// D187: the mail client's own thinking, tested under Node.
//
// The client's DOM lives in frontend/ui/mailbox.js and its reasoning in
// frontend/ui/mailbox-model.js, the same split the park uses so the maths can be tested
// without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stationsOf, addressFor, fold, shortDate, fullDate, shortAddress,
  participantsLabel, nextIndex, quoteReply, replyFields, EXTRA_STATIONS,
} from '../frontend/ui/mailbox-model.js';
import { DEPARTMENT_KINDS, ZONE_LABELS } from '../shared/world.js';

const LAYOUT = {
  rooms: [
    { id: 'ranger-station', name: 'Ranger Station', kind: 'ranger_station' },
    { id: 'mountain-peak', name: 'Mountain Peak', kind: 'mountain_peak' },
    { id: 'finance', name: 'Finance Camp', kind: 'finance' },
    { id: 'research', name: 'Research Camp', kind: 'research' },
    { id: 'trailhead-x', name: 'A trailhead', kind: 'trailhead' },
  ],
};

test('a mailbox per department, in the park\'s own order, plus the park\'s own places', () => {
  const list = stationsOf(LAYOUT);
  const ids = list.map((s) => s.id);
  // Departments first, in the order the park lists them.
  assert.deepEqual(ids.slice(0, 2), ['research', 'finance'], 'research comes before finance, as DEPARTMENT_KINDS does');
  assert.equal(list[0].label, ZONE_LABELS.research);
  assert.ok(list[0].department);
  // Then the park's own places, which hold the mail that is not a department's.
  assert.ok(ids.includes('ranger-station') && ids.includes('mountain-peak'));
  assert.equal(list.find((s) => s.id === 'mountain-peak').department, false);
  // A trailhead is a venture marker, not a mailbox.
  assert.ok(!ids.includes('trailhead-x'));
  // A camp that was never built has no mailbox to show.
  assert.ok(!ids.includes('legal'), 'the Legal Camp is not in this layout');
  assert.deepEqual(stationsOf({ rooms: [] }), []);
  assert.deepEqual(stationsOf(null), []);
  // Every extra station named is a real place the park builds.
  for (const id of EXTRA_STATIONS) assert.equal(typeof id, 'string');
  assert.ok(DEPARTMENT_KINDS.length >= 10);
});

test('which address a department sends from, and what it reads as', () => {
  const rows = [
    { address: 'finance@makapark.com', station: 'finance', kind: 'station' },
    { address: 'ada-lantern@makapark.com', station: 'finance', kind: 'alias' },
    { address: 'research@makapark.com', station: 'research', kind: 'station' },
  ];
  assert.equal(addressFor(rows, 'finance'), 'finance@makapark.com', 'the station address, not a Ranger\'s alias');
  assert.equal(addressFor(rows, 'research'), 'research@makapark.com');
  assert.equal(addressFor(rows, 'legal'), null, 'a department with no address yet says so');
  assert.equal(addressFor({ addresses: rows }, 'finance'), 'finance@makapark.com', 'either shape');
  assert.equal(addressFor(null, 'finance'), null);

  // Inside the park an address reads as a name; outside it keeps its domain, so a stranger
  // never looks like staff.
  assert.equal(shortAddress('finance@makapark.com'), 'finance');
  assert.equal(shortAddress('customer@example.com'), 'customer@example.com');
  assert.equal(shortAddress('Customer <c@example.com>'), 'Customer <c@example.com>');
  assert.equal(shortAddress(''), '');
});

test('a row says who it is from — the other party, not ourselves', () => {
  const own = ['finance@makapark.com'];
  assert.equal(participantsLabel({ participants: ['finance@makapark.com', 'c@example.com'] }, own), 'c@example.com');
  // Two others are both named; more than two counts the rest.
  assert.equal(participantsLabel({ participants: ['a@x.com', 'b@x.com', 'finance@makapark.com'] }, own), 'a@x.com, b@x.com');
  assert.equal(participantsLabel({ participants: ['a@x.com', 'b@x.com', 'c@x.com'] }, own), 'a@x.com +2');
  // A thread with nobody else on it is the park talking to itself, which is a briefing.
  assert.equal(participantsLabel({ participants: ['finance@makapark.com'] }, own), 'finance');
  assert.equal(participantsLabel({ participants: [] }, own), 'the park');
});

test('threads fold into rows the list can draw without further work', () => {
  const now = Date.UTC(2026, 9, 12, 15, 0);
  const rows = fold([
    { threadId: 't1', subject: 'Order 12', participants: ['c@example.com', 'finance@makapark.com'], count: 3, unread: 2, labels: ['starred'], last: now - 3600000, venture: 'etsy-canva', kind: null },
    { threadId: 't2', subject: '', participants: ['finance@makapark.com'], count: 1, unread: 0, labels: ['read'], last: now - 30 * 86400000, kind: 'briefing' },
  ], { now, own: ['finance@makapark.com'] });

  assert.equal(rows[0].from, 'c@example.com');
  assert.equal(rows[0].unread, true);
  assert.equal(rows[0].starred, true);
  assert.equal(rows[0].venture, 'etsy-canva');
  assert.equal(rows[0].count, 3);
  assert.match(rows[0].when, /^\d{2}:\d{2}$/, 'today shows a time');

  assert.equal(rows[1].subject, '(no subject)', 'a thread with no subject still reads');
  assert.equal(rows[1].unread, false);
  assert.equal(rows[1].starred, false);
  assert.equal(rows[1].kind, 'briefing');
  assert.match(rows[1].when, /^\d{1,2} [A-Z][a-z]{2}$/, 'this year shows a day and month');

  assert.deepEqual(fold(null), []);
});

test('dates read the way a mail client\'s do', () => {
  const now = Date.UTC(2026, 9, 12, 15, 30);
  assert.match(shortDate(Date.UTC(2026, 9, 12, 9, 5), now), /^\d{2}:\d{2}$/);
  assert.equal(shortDate(Date.UTC(2026, 9, 1, 9, 5), now), '1 Oct');
  assert.equal(shortDate(Date.UTC(2024, 2, 3), now), '2024');
  assert.equal(shortDate(NaN, now), '');
  assert.ok(fullDate(now).length > 10);
  assert.equal(fullDate(undefined), '');
});

test('j and k stop at the ends rather than wrapping', () => {
  // Wrapping from the last message to the first is disorienting in a list you read down.
  assert.equal(nextIndex(5, -1, 1), 0, 'the first press selects the first row');
  assert.equal(nextIndex(5, -1, -1), 4, 'and k from nothing selects the last');
  assert.equal(nextIndex(5, 0, -1), 0, 'k at the top stays');
  assert.equal(nextIndex(5, 4, 1), 4, 'j at the bottom stays');
  assert.equal(nextIndex(5, 2, 1), 3);
  assert.equal(nextIndex(0, -1, 1), -1, 'an empty list has no cursor');
});

test('a reply goes back to the right people, with the right subject', () => {
  const own = ['support@makapark.com'];
  const m = {
    from: 'Customer <c@example.com>',
    to: ['support@makapark.com', 'someone@else.com'],
    cc: ['watcher@else.com'],
    subject: 'Where is my order',
    messageId: '<abc@example.com>',
    date: 1000,
    text: 'Two lines\nof question',
  };

  const one = replyFields(m, own);
  assert.deepEqual(one.to, ['Customer <c@example.com>']);
  assert.deepEqual(one.cc, [], 'a plain reply copies nobody');
  assert.equal(one.subject, 'Re: Where is my order');

  const all = replyFields(m, own, { all: true });
  assert.deepEqual(all.to, ['Customer <c@example.com>']);
  assert.ok(all.cc.includes('someone@else.com') && all.cc.includes('watcher@else.com'));
  assert.ok(!all.cc.some((a) => a.includes('support@makapark.com')), 'we are never a recipient of our own reply');

  // Reply-To wins over From, which is what it is for.
  assert.deepEqual(replyFields({ ...m, replyTo: ['billing@example.com'] }, own).to, ['billing@example.com']);
  // A subject already a reply is not prefixed twice.
  assert.equal(replyFields({ ...m, subject: 'Re: Where is my order' }, own).subject, 'Re: Where is my order');
  assert.equal(replyFields({ ...m, subject: 'RE: shouting' }, own).subject, 'RE: shouting');
  assert.deepEqual(replyFields(null).to, []);

  // The quoted body carries every line, marked.
  const q = quoteReply(m);
  assert.match(q, /> Two lines/);
  assert.match(q, /> of question/);
  assert.match(q, /wrote:/);
  assert.equal(quoteReply(null), '');
});
