// The iMessage owner channel (D170): the park talks to the owner through Messages on
// their own Mac. The pure parts — the AppleScript it writes, the query it runs, the chat
// kinds it reports — plus the adapter driven over a fake `exec`, so none of this needs
// Messages, the database or macOS to be tested.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIMessageAdapter, sendScript, osaQuote, inboundQuery, chatTypeOf, parseRows, normalizeHandle, ownerHandles, signed, DEFAULT_DB } from '../sidecar/channels/imessage.js';
import { assertAdapter } from '../sidecar/channels/adapter.js';

const quiet = { error() {}, info() {} };

test('it is a well-formed adapter the registry will take', () => {
  const a = createIMessageAdapter({});
  assertAdapter(a);
  assert.equal(a.name, 'imessage');
  assert.equal(a.buttons, false, 'iMessage has no buttons, so cards go as text with slash commands');
  assert.deepEqual(a.keys, ['imessageHandle']);
  assert.match(DEFAULT_DB, /Library\/Messages\/chat\.db$/);
});

test('the AppleScript quotes whatever a Ranger wrote, so a message cannot become script', () => {
  assert.equal(osaQuote('hello'), '"hello"');
  assert.equal(osaQuote('say "hi"'), '"say \\"hi\\""');
  assert.equal(osaQuote('back\\slash'), '"back\\\\slash"');
  const nasty = 'Gate item" \n tell application "Finder" to delete';
  const script = sendScript('me@example.com', nasty);
  // The quote the message tried to close with is escaped, so the whole body stays one
  // literal and the second `tell` is text, not a command.
  assert.ok(script.includes('\\"'), 'the quote is escaped');
  assert.equal(script.split('tell application "Messages"').length, 2, 'exactly one tell block, the one we wrote');
  assert.ok(script.includes('send "Gate item\\" \n tell application \\"Finder\\" to delete"'));
  assert.ok(script.includes('service type = iMessage'), 'sent over iMessage, not SMS');
});

test('the query asks only for messages that came in after a point, and never for our own', () => {
  const q = inboundQuery(1234);
  assert.match(q, /is_from_me = 0/, 'what the park sent is not inbound');
  assert.match(q, /m\.ROWID > 1234/);
  assert.match(q, /LIMIT 50/, 'a long backlog cannot flood one poll');
  // The row id is a number in the SQL, never pasted text.
  assert.match(inboundQuery('7; DROP TABLE message'), /m\.ROWID > 0/, 'a non-number becomes 0');
  assert.match(inboundQuery(null), /m\.ROWID > 0/);
});

test('only a one-to-one conversation counts as private, so nothing else can pair', () => {
  assert.equal(chatTypeOf(43), 'private');
  assert.equal(chatTypeOf(45), 'group');
  assert.equal(chatTypeOf(0), 'unknown');
  assert.equal(chatTypeOf(undefined), 'unknown');
});

test('rows parse, and an empty result is not an error', () => {
  assert.deepEqual(parseRows(''), []);
  assert.deepEqual(parseRows('   '), []);
  assert.deepEqual(parseRows('not json'), []);
  assert.deepEqual(parseRows('[{"rowid":2,"text":"hi"}]'), [{ rowid: 2, text: 'hi' }]);
});

test('start reads where the history ends, then hands on only what arrives after it', async () => {
  const calls = [];
  // A stand-in for the Messages database that honours the watermark the adapter asks
  // with, so a row is handed on once and only once however often the poll runs.
  let table = [];
  const exec = async (file, args) => {
    calls.push({ file, args });
    const sql = args[args.length - 1];
    if (/MAX\(ROWID\)/.test(sql)) return '[{"rowid":100}]';
    const after = Number((sql.match(/m\.ROWID > (\d+)/) || [])[1] || 0);
    return JSON.stringify(table.filter((r) => r.rowid > after));
  };
  const got = [];
  const a = createIMessageAdapter({ exec, pollMs: 5, log: quiet, clock: { now: () => 1 } });
  const { detail } = await a.start({ keys: { imessageHandle: 'me@example.com' }, onInbound: (m) => got.push(m), log: quiet });
  assert.match(detail, /me@example\.com/);
  // Nothing from before the park started: the first query asks after row 100.
  table = [
    { rowid: 101, handle: 'me@example.com', text: 'hello park', chat: 'me@example.com', style: 43 },
    { rowid: 102, handle: '+15550000', text: 'from a group', chat: 'chat9', style: 45 },
  ];
  await new Promise((r) => setTimeout(r, 40));
  await a.stop();
  assert.ok(calls.some((c) => /m\.ROWID > 100/.test(c.args[c.args.length - 1])), 'asked only for what came after the start');
  // Only the owner's own one-to-one chat is handed on, exactly once however many polls
  // ran; the group row is dropped by the owner-only rule.
  assert.equal(got.length, 1);
  assert.deepEqual(got.map((m) => [m.chatId, m.userId, m.chatType, m.text]), [['me@example.com', 'me@example.com', 'private', 'hello park']]);
  assert.deepEqual(got.map((m) => m.updateId), ['imessage:101'], 'a replayed row is droppable by the registry');
  // The database is only ever opened read-only.
  for (const c of calls) if (/sqlite3$/.test(c.file)) assert.ok(c.args.includes('-readonly'), 'chat.db is never opened for writing');
});

test('without Full Disk Access it refuses to start and says which setting to change', async () => {
  const exec = async () => {
    throw Object.assign(new Error('unable to open database file'), { code: 'EXEC' });
  };
  const a = createIMessageAdapter({ exec, log: quiet });
  await assert.rejects(a.start({ keys: { imessageHandle: 'me@example.com' }, onInbound() {}, log: quiet }), (e) => {
    assert.equal(e.code, 'NO_DISK_ACCESS');
    assert.match(e.message, /Full Disk Access/);
    return true;
  });
  // And with no handle at all it says that instead of pretending to watch.
  await assert.rejects(createIMessageAdapter({ exec }).start({ keys: {}, onInbound() {}, log: quiet }), (e) => e.code === 'NO_HANDLE');
});

test('sending goes through osascript, and a refused automation prompt is named', async () => {
  const sent = [];
  const a = createIMessageAdapter({
    exec: async (file, args) => {
      sent.push({ file, args });
      if (/Finder/.test(args[1] || '')) throw Object.assign(new Error('Not authorized to send Apple events'), { stderr: 'Not authorized to send Apple events to Messages. (-1743)' });
      return '';
    },
    log: quiet,
    clock: { now: () => 7 },
  });
  await a.start({ keys: { imessageHandle: 'me@example.com' }, onInbound() {}, log: quiet });
  sent.length = 0; // the start's own database read is not a send
  const res = await a.sendText('me@example.com', 'the Gate has an item');
  assert.equal(res.messageId, 'imessage-7');
  assert.match(sent[0].file, /osascript$/);
  assert.match(sent[0].args[1], /send "Maka · the Gate has an item" to targetBuddy/);

  let started = false;
  const denied = createIMessageAdapter({
    exec: async (file) => {
      if (!started && /sqlite3$/.test(file)) return '[{"rowid":0}]';
      throw Object.assign(new Error('x'), { stderr: 'Not authorized to send Apple events to Messages. (-1743)' });
    },
    log: quiet,
  });
  await denied.start({ keys: { imessageHandle: 'me@example.com' }, onInbound() {}, log: quiet });
  started = true;
  await assert.rejects(denied.sendText('me@example.com', 'hi'), (e) => {
    assert.equal(e.code, 'NO_AUTOMATION');
    assert.match(e.message, /Privacy & Security → Automation/);
    return true;
  });
});

test('two spellings of the same person are the same person, and the owner list is an allow-list', () => {
  assert.equal(normalizeHandle('Me@Example.COM '), 'me@example.com');
  // Messages reports the same contact three ways; all three are one handle.
  assert.equal(normalizeHandle('+1 (555) 000-1234'), '5550001234');
  assert.equal(normalizeHandle('+15550001234'), '5550001234');
  assert.equal(normalizeHandle('5550001234'), '5550001234');
  assert.equal(normalizeHandle(''), '');
  assert.equal(normalizeHandle(null), '');
  assert.deepEqual([...ownerHandles('me@example.com, +1 555 000 1234')], ['me@example.com', '5550001234']);
  assert.equal(ownerHandles('').size, 0);
});

test('the park writes to its owner and to nobody else, whatever it is asked to do', async () => {
  const sent = [];
  const a = createIMessageAdapter({
    exec: async (file, args) => {
      if (/sqlite3$/.test(file)) return '[{"rowid":1}]';
      sent.push(args[1]);
      return '';
    },
    log: quiet,
    clock: { now: () => 1 },
  });
  await a.start({ keys: { imessageHandle: 'me@example.com, +1 555 000 1234' }, onInbound() {}, log: quiet });

  // The owner, in either spelling, including a differently formatted phone number.
  await a.sendText('me@example.com', 'hello');
  await a.sendText('+15550001234', 'hello');
  assert.equal(sent.length, 2);

  // Anyone else is refused before Messages is even asked.
  for (const stranger of ['someone@else.com', '+1 999 888 7777', 'chat12345']) {
    await assert.rejects(a.sendText(stranger, 'hello'), (e) => {
      assert.equal(e.code, 'NOT_THE_OWNER');
      return true;
    }, stranger);
  }
  assert.equal(sent.length, 2, 'not one more message left the Mac');
  await a.stop();
});

test('a message from anyone but the owner never reaches the registry, so the park cannot answer a stranger', async () => {
  let table = [];
  const a = createIMessageAdapter({
    exec: async (file, args) => {
      const sql = args[args.length - 1];
      if (/MAX\(ROWID\)/.test(sql)) return '[{"rowid":0}]';
      const after = Number((sql.match(/m\.ROWID > (\d+)/) || [])[1] || 0);
      return JSON.stringify(table.filter((r) => r.rowid > after));
    },
    pollMs: 5,
    log: quiet,
  });
  const got = [];
  await a.start({ keys: { imessageHandle: 'me@example.com' }, onInbound: (m) => got.push(m), log: quiet });
  table = [
    { rowid: 1, handle: 'stranger@spam.com', text: 'JA66RLVY', chat: 'stranger@spam.com', style: 43 },
    { rowid: 2, handle: '+15550009999', text: 'hello?', chat: '+15550009999', style: 43 },
    { rowid: 3, handle: 'me@example.com', text: 'approve w1', chat: 'me@example.com', style: 43 },
    { rowid: 4, handle: 'me@example.com', text: 'in a group', chat: 'chat77', style: 45 },
  ];
  await new Promise((r) => setTimeout(r, 40));
  await a.stop();
  // Only the owner's own one-to-one chat got through. A stranger guessing a pairing code
  // is never even considered, and the owner's own message in a group chat is not the
  // owner's chat, so it is dropped too.
  assert.deepEqual(got.map((m) => m.text), ['approve w1']);
});

test('a Gate card goes out as the text a channel without buttons gets', async () => {
  const sent = [];
  const a = createIMessageAdapter({ exec: async (f, args) => (/sqlite3$/.test(f) ? '[{"rowid":0}]' : (sent.push(args[1]), '')), log: quiet, clock: { now: () => 1 } });
  await a.start({ keys: { imessageHandle: 'me@example.com' }, onInbound() {}, log: quiet });
  await a.sendCard('me@example.com', { kind: 'action', title: 'fs.write wants to write outbox/plan.md', lines: ['Ranger: Ada', 'Leash: draft'], buttons: [{ label: 'Approve', data: 'approve:w1' }], itemId: 'w1' });
  const script = sent[0];
  assert.match(script, /fs\.write wants to write/);
  assert.match(script, /Ada/);
  // The buttons become the commands that do the same thing, since iMessage has none.
  assert.match(script, /\/approve|approve/i);
});

test('every message goes to one handle, whichever of the owner\'s the chat is filed under', async () => {
  const sent = [];
  const a = createIMessageAdapter({
    exec: async (file, args) => {
      if (/sqlite3$/.test(file)) return '[{"rowid":0}]';
      sent.push(args[1]);
      return '';
    },
    log: quiet,
    clock: { now: () => 1 },
  });
  // The phone first: that is where the park answers. The Apple ID is still the owner.
  const { detail } = await a.start({ keys: { imessageHandle: '+18135550000, me@example.com' }, onInbound() {}, log: quiet });
  assert.match(detail, /\+18135550000 only/);

  // A chat filed under the Apple ID is still answered on the phone, so the owner keeps
  // one conversation instead of collecting a duplicate thread per handle.
  await a.sendText('me@example.com', 'from the email thread');
  await a.sendText('+18135550000', 'from the phone thread');
  assert.equal(sent.length, 2);
  for (const script of sent) assert.match(script, /participant "\+18135550000"/, 'always the first handle');

  // The allow-list still holds: a stranger is refused, and nothing was sent.
  await assert.rejects(a.sendText('someone@else.com', 'hi'), (e) => e.code === 'NOT_THE_OWNER');
  assert.equal(sent.length, 2);
  await a.stop();
});

test('the park does not read its own messages back as the owner talking', async () => {
  // The Mac is signed in as the owner and the park writes to the owner, so Messages
  // files every outgoing message twice: once sent, once received on the same account
  // with the owner's handle on it. Read naively the park would answer itself.
  let table = [];
  let row = 100;
  const a = createIMessageAdapter({
    exec: async (file, args) => {
      if (/osascript$/.test(file)) {
        // Messages echoes what was just sent back as an incoming line.
        const body = (args[1].match(/send "([\s\S]*)" to targetBuddy/) || [])[1] || '';
        table.push({ rowid: ++row, handle: 'me@example.com', text: body.replace(/\\"/g, '"'), chat: 'me@example.com', style: 43 });
        return '';
      }
      const sql = args[args.length - 1];
      if (/MAX\(ROWID\)/.test(sql)) return `[{"rowid":${row}}]`;
      const after = Number((sql.match(/m\.ROWID > (\d+)/) || [])[1] || 0);
      return JSON.stringify(table.filter((r) => r.rowid > after));
    },
    pollMs: 5,
    log: quiet,
    clock: { now: () => Date.now() },
  });
  const got = [];
  await a.start({ keys: { imessageHandle: 'me@example.com' }, onInbound: (m) => got.push(m), log: quiet });
  await a.sendText('me@example.com', 'the Gate has an item: /approve w1');
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(got, [], 'its own card did not come back as a question');

  // A real reply from the owner still gets through.
  table.push({ rowid: ++row, handle: 'me@example.com', text: '/approve w1', chat: 'me@example.com', style: 43 });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(got.map((m) => m.text), ['/approve w1']);

  // And the same words said twice by the owner are not swallowed as an echo: only one
  // copy of each sent message is ever consumed.
  table.push({ rowid: ++row, handle: 'me@example.com', text: '/approve w1', chat: 'me@example.com', style: 43 });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(got.length, 2);
  await a.stop();
});

test('the park signs its messages, and can send as its own Apple ID when it has one', async () => {
  const scripts = [];
  const mk = (keys) => {
    const a = createIMessageAdapter({
      exec: async (file, args) => (/sqlite3$/.test(file) ? '[{"rowid":0}]' : (scripts.push(args[1]), '')),
      log: quiet,
      clock: { now: () => 1 },
    });
    return a.start({ keys, onInbound() {}, log: quiet }).then(() => a);
  };

  // With no account of its own: the first iMessage account, which on the owner's Mac is
  // the owner — so the park appears to be messaging itself.
  const plain = await mk({ imessageHandle: '+18135550000' });
  await plain.sendText('+18135550000', 'the Gate has an item');
  assert.match(scripts.at(-1), /1st account whose service type = iMessage/);
  assert.match(scripts.at(-1), /send "Maka · the Gate has an item"/, 'every message says who is talking');
  await plain.stop();

  // With its own: Messages sends as that account instead, so the message comes from the
  // park rather than from the owner.
  scripts.length = 0;
  const own = await mk({ imessageHandle: '+18135550000', imessageFrom: 'communications@makapark.com' });
  await own.sendText('+18135550000', 'hello');
  assert.match(scripts.at(-1), /service id "E:communications@makapark\.com"/);
  assert.match(scripts.at(-1), /participant "\+18135550000"/);
  await own.stop();

  // The signature is added once, never stacked.
  assert.equal(signed(signed('x')), 'Maka · x');
});
