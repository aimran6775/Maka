// The park's mail client (D187): every department's mailbox, with the folders and the keys
// a person already knows from Gmail.
//
//   createMailbox({ parent, getState, api, onFlash }) -> { open(station), close(), toggle(),
//                                                          isOpen(), refresh() }
//
// It fills the screen rather than docking into a rail: mail is read, not glanced at, and a
// 348px panel cannot hold a thread. The park keeps running behind it.
//
// Three columns, left to right: the departments and their folders, the threads in the
// folder, and the thread you are reading. On a narrow window the reading pane takes over
// and Escape goes back, so the same code serves a phone-shaped window.
//
// What it shows is only what the store holds. A department with no address yet says so; a
// park with no RESEND_API_KEY says mail cannot be sent and the Compose button is disabled
// rather than failing when pressed.

import { el, setChildren } from './windows.js';
import { FOLDERS } from '../../shared/mail-folders.js';
import { stationsOf, addressFor, fold, fullDate, shortAddress, nextIndex, quoteReply, replyFields } from './mailbox-model.js';

const KEYS = [
  ['j / ↓', 'next thread'],
  ['k / ↑', 'previous'],
  ['Enter', 'open'],
  ['u / Esc', 'back to the list'],
  ['e', 'archive'],
  ['s', 'star'],
  ['#', 'trash'],
  ['r', 'reply'],
  ['a', 'reply to all'],
  ['c', 'compose'],
  ['/', 'search'],
  ['g then i', 'inbox'],
  ['m', 'mark read / unread'],
];

export function createMailbox({ parent, getState, api, onFlash = () => {} }) {
  let open = false;
  let station = null;
  let folderId = 'inbox';
  let threads = [];
  let rows = [];
  let cursor = -1;
  let thread = null; // the messages of the thread being read
  let counts = {};
  let addresses = [];
  let query = '';
  let gPending = false;
  let composing = null; // { to, cc, subject, text, replyTo }

  const root = el('div', { class: 'mailbox', hidden: true, tabindex: '-1', role: 'dialog', 'aria-label': 'Park mail' });
  const railStations = el('div', { class: 'mb-stations' });
  const railFolders = el('div', { class: 'mb-folders' });
  const listEl = el('div', { class: 'mb-list', role: 'list' });
  const readEl = el('div', { class: 'mb-read' });
  const searchEl = el('input', { class: 'mb-search', type: 'search', placeholder: 'Search this mailbox', 'aria-label': 'Search this mailbox' });
  const statusEl = el('div', { class: 'mb-status' });
  const composeEl = el('div', { class: 'mb-compose', hidden: true });

  searchEl.addEventListener('input', () => {
    query = searchEl.value.trim();
    clearTimeout(searchEl._t);
    searchEl._t = setTimeout(() => void load(), 180);
  });

  const composeBtn = el('button', { class: 'mb-btn primary', text: 'Compose', onclick: () => startCompose() });
  const syncBtn = el('button', { class: 'mb-btn', text: 'Sync', title: 'Pull new mail from the provider now', onclick: () => void sync() });
  const closeBtn = el('button', { class: 'mb-btn ghost', text: 'Close', title: 'Escape', onclick: () => close() });

  const head = el('header', { class: 'mb-head' },
    el('div', { class: 'mb-brand' }, el('span', { class: 'mb-mark', 'aria-hidden': 'true' }), el('span', { class: 'mb-brand-name', text: 'Park Mail' })),
    searchEl,
    el('div', { class: 'mb-head-actions' }, composeBtn, syncBtn, closeBtn),
  );

  const keysEl = el('div', { class: 'mb-keys' }, ...KEYS.map(([k, what]) => el('span', { class: 'mb-key' }, el('kbd', { text: k }), el('span', { text: what }))));

  root.append(
    head,
    el('div', { class: 'mb-body' },
      el('aside', { class: 'mb-rail' }, railStations, railFolders, keysEl),
      el('section', { class: 'mb-mid' }, statusEl, listEl),
      el('section', { class: 'mb-pane' }, readEl),
    ),
    composeEl,
  );
  parent.append(root);

  // ---- data ----------------------------------------------------------------

  // The app's api returns { ok, status, body } so a caller can see a failure without a
  // throw. The mailbox wants the body and an error it can show, so it unwraps here once
  // rather than at every call site.
  async function read(path) {
    const r = await api.get(path);
    if (!r || !r.ok) {
      const err = new Error((r && r.body && (r.body.error || r.body.message)) || `${path} answered ${r ? r.status : 'nothing'}`);
      err.status = r && r.status;
      throw err;
    }
    return r.body;
  }

  async function write(path, body) {
    const r = await api.post(path, body);
    if (!r || !r.ok) {
      const err = new Error((r && r.body && (r.body.error || r.body.message)) || `${path} answered ${r ? r.status : 'nothing'}`);
      err.status = r && r.status;
      throw err;
    }
    return r.body;
  }

  function stations() {
    const st = getState();
    return stationsOf((st && st.layout) || { rooms: [] });
  }

  function ownAddresses() {
    const mine = addressFor(addresses, station);
    return mine ? [mine] : [];
  }

  async function load() {
    if (!open) return;
    const q = new URLSearchParams({ folder: folderId, limit: '100' });
    if (station) q.set('station', station);
    if (query) q.set('q', query);
    try {
      const [t, c, a] = await Promise.all([
        read(`/api/mail/threads?${q}`),
        read(`/api/mail/folders?${station ? `station=${encodeURIComponent(station)}` : ''}`),
        addresses.length ? Promise.resolve(addresses) : read('/api/mail/addresses'),
      ]);
      threads = Array.isArray(t) ? t : [];
      counts = c || {};
      addresses = Array.isArray(a) ? a : (a && a.addresses) || [];
      rows = fold(threads, { own: ownAddresses() });
      if (cursor >= rows.length) cursor = rows.length - 1;
      render();
    } catch (err) {
      statusEl.textContent = `Could not read the mailbox: ${err && err.message ? err.message : err}`;
    }
  }

  async function openThread(i) {
    cursor = i;
    const row = rows[i];
    if (!row) return;
    try {
      thread = await read(`/api/mail/threads?threadId=${encodeURIComponent(row.threadId)}`);
      // Reading it marks the arrived messages read, which is what the count means.
      const unread = (thread || []).filter((m) => m.direction === 'in' && !(m.labels || []).includes('read'));
      if (unread.length) {
        await Promise.all(unread.map((m) => write(`/api/mail/messages/${encodeURIComponent(m.id)}/labels`, { add: ['read'] })));
        await load();
      }
      render();
    } catch (err) {
      onFlash(err);
    }
  }

  async function act(labels) {
    const row = rows[cursor];
    if (!row) return;
    const msgs = thread && thread.length && thread[0].threadId === row.threadId ? thread : await read(`/api/mail/threads?threadId=${encodeURIComponent(row.threadId)}`);
    try {
      await Promise.all((msgs || []).map((m) => write(`/api/mail/messages/${encodeURIComponent(m.id)}/labels`, labels)));
      thread = null;
      await load();
    } catch (err) {
      onFlash(err);
    }
  }

  async function sync() {
    syncBtn.disabled = true;
    try {
      await write('/api/mail/sync', {});
      await load();
      onFlash('Mail synced', 'ok');
    } catch (err) {
      onFlash(err);
    } finally {
      syncBtn.disabled = false;
    }
  }

  // ---- compose -------------------------------------------------------------

  function startCompose(prefill = {}) {
    const from = addressFor(addresses, station);
    composing = { to: '', cc: '', subject: '', text: '', ...prefill };
    const to = el('input', { class: 'mb-inp', value: composing.to, placeholder: 'To' });
    const cc = el('input', { class: 'mb-inp', value: composing.cc, placeholder: 'Cc (optional)' });
    const subject = el('input', { class: 'mb-inp', value: composing.subject, placeholder: 'Subject' });
    const text = el('textarea', { class: 'mb-area', rows: 14, placeholder: 'Write your message' });
    text.value = composing.text;
    const note = el('div', { class: 'mb-note' });
    const send = el('button', { class: 'mb-btn primary', text: 'Send' });
    const draft = el('button', { class: 'mb-btn', text: 'Save draft' });

    const finish = async (kind) => {
      const body = {
        station,
        to: to.value.split(',').map((x) => x.trim()).filter(Boolean),
        cc: cc.value.split(',').map((x) => x.trim()).filter(Boolean),
        subject: subject.value.trim(),
        text: text.value,
        kind: 'reply',
        ...(composing.replyTo ? { inReplyTo: composing.replyTo } : {}),
        ...(kind === 'draft' ? { draft: true } : {}),
      };
      if (!body.to.length) { note.textContent = 'Give it at least one recipient.'; return; }
      if (!body.subject) { note.textContent = 'Give it a subject.'; return; }
      send.disabled = true;
      draft.disabled = true;
      try {
        await write('/api/mail/send', body);
        onFlash(kind === 'draft' ? 'Draft saved' : 'Sent', 'ok');
        closeCompose();
        await load();
      } catch (err) {
        note.textContent = err && err.message ? err.message : String(err);
        send.disabled = false;
        draft.disabled = false;
      }
    };
    send.addEventListener('click', () => void finish('send'));
    draft.addEventListener('click', () => void finish('draft'));

    setChildren(composeEl,
      el('div', { class: 'mb-compose-card' },
        el('div', { class: 'mb-compose-bar' },
          el('span', { class: 'mb-compose-title', text: composing.replyTo ? 'Reply' : 'New message' }),
          el('button', { class: 'mb-x', text: '×', title: 'Escape', onclick: () => closeCompose() }),
        ),
        el('div', { class: 'mb-from' }, 'From ', el('b', { text: from || 'this department has no address yet' })),
        to, cc, subject, text, note,
        el('div', { class: 'mb-compose-actions' }, send, draft),
      ),
    );
    composeEl.hidden = false;
    to.focus();
    if (composing.to) subject.focus();
    if (composing.subject) text.focus();
  }

  function closeCompose() {
    composing = null;
    composeEl.hidden = true;
    setChildren(composeEl);
    root.focus();
  }

  function reply({ all = false } = {}) {
    const msgs = thread || [];
    const last = [...msgs].reverse().find((m) => m.direction === 'in') || msgs[msgs.length - 1];
    if (!last) return;
    const f = replyFields(last, ownAddresses(), { all });
    startCompose({ to: f.to.join(', '), cc: f.cc.join(', '), subject: f.subject, text: quoteReply(last), replyTo: last.messageId || '' });
  }

  // ---- render --------------------------------------------------------------

  function render() {
    const list = stations();
    if (!station && list.length) station = list[0].id;

    setChildren(railStations,
      el('div', { class: 'mb-rail-head', text: 'Departments' }),
      ...list.map((s) => {
        const mine = addressFor(addresses, s.id);
        return el('button', {
          class: `mb-station${s.id === station ? ' on' : ''}`,
          onclick: () => { station = s.id; thread = null; cursor = -1; void load(); },
        },
          el('span', { class: 'mb-station-name', text: s.label }),
          el('span', { class: 'mb-station-addr', text: mine ? shortAddress(mine) : 'no address' }),
        );
      }),
    );

    setChildren(railFolders,
      el('div', { class: 'mb-rail-head', text: 'Folders' }),
      ...FOLDERS.map((f) => {
        const c = counts[f.id] || { threads: 0, unread: 0 };
        return el('button', {
          class: `mb-folder${f.id === folderId ? ' on' : ''}${c.unread ? ' has-unread' : ''}`,
          onclick: () => { folderId = f.id; thread = null; cursor = -1; void load(); },
        },
          el('span', { text: f.label }),
          el('span', { class: 'mb-count', text: c.unread ? String(c.unread) : c.threads ? String(c.threads) : '' }),
        );
      }),
    );

    const here = list.find((s) => s.id === station);
    const mine = addressFor(addresses, station);
    statusEl.textContent = rows.length
      ? `${here ? here.label : station} · ${rows.length} thread${rows.length === 1 ? '' : 's'}${query ? ` matching “${query}”` : ''}${mine ? ` · ${mine}` : ''}`
      : query
        ? `Nothing in this folder matches “${query}”.`
        : mine
          ? 'This folder is empty.'
          : `${here ? here.label : station} has no address yet, so nothing can arrive here. Create one at the Peak.`;

    setChildren(listEl, ...rows.map((r, i) => el('button', {
      class: `mb-row${r.unread ? ' unread' : ''}${i === cursor ? ' on' : ''}`,
      role: 'listitem',
      onclick: () => void openThread(i),
    },
      el('span', { class: `mb-star${r.starred ? ' on' : ''}`, title: r.starred ? 'Starred' : 'Not starred', text: r.starred ? '★' : '☆', onclick: (e) => { e.stopPropagation(); cursor = i; void act({ [r.starred ? 'remove' : 'add']: ['starred'] }); } }),
      el('span', { class: 'mb-from-cell', text: r.from }),
      el('span', { class: 'mb-subject' },
        el('span', { class: 'mb-subject-text', text: r.subject }),
        r.count > 1 ? el('span', { class: 'mb-thread-count', text: String(r.count) }) : null,
        r.venture ? el('span', { class: 'mb-tag', text: r.venture }) : null,
        r.kind === 'briefing' ? el('span', { class: 'mb-tag soft', text: 'briefing' }) : null,
      ),
      el('span', { class: 'mb-when', text: r.when }),
    )));

    if (!thread || !thread.length) {
      setChildren(readEl, el('div', { class: 'mb-empty' },
        el('p', { text: rows.length ? 'Pick a thread.' : 'Nothing to read here.' }),
        el('p', { class: 'mb-empty-hint', text: 'j and k move, Enter opens, c writes a new message.' }),
      ));
      root.classList.remove('reading');
      return;
    }

    const first = thread[0];
    setChildren(readEl,
      el('div', { class: 'mb-read-head' },
        el('h2', { class: 'mb-read-subject', text: first.subject || '(no subject)' }),
        el('div', { class: 'mb-read-actions' },
          el('button', { class: 'mb-btn', text: 'Reply', title: 'r', onclick: () => reply() }),
          el('button', { class: 'mb-btn', text: 'Reply all', title: 'a', onclick: () => reply({ all: true }) }),
          el('button', { class: 'mb-btn', text: 'Archive', title: 'e', onclick: () => void act({ add: ['archived'] }) }),
          el('button', { class: 'mb-btn', text: 'Trash', title: '#', onclick: () => void act({ add: ['trashed'] }) }),
          el('button', { class: 'mb-btn ghost mb-back', text: 'Back', title: 'u', onclick: () => { thread = null; render(); } }),
        ),
      ),
      ...thread.map((m) => el('article', { class: `mb-msg${m.direction === 'out' ? ' out' : ''}` },
        el('div', { class: 'mb-msg-head' },
          el('span', { class: 'mb-msg-from', text: shortAddress(m.from) }),
          el('span', { class: 'mb-msg-to', text: `to ${(m.to || []).map(shortAddress).join(', ')}` }),
          el('span', { class: 'mb-msg-when', text: fullDate(m.date) }),
        ),
        m.status === 'draft' ? el('div', { class: 'mb-draft-mark', text: 'Draft — not sent' }) : null,
        el('pre', { class: 'mb-msg-body', text: m.text || '(no text)' }),
        (m.attachments || []).length
          ? el('div', { class: 'mb-attach' }, `${m.attachments.length} attachment${m.attachments.length === 1 ? '' : 's'}: `, (m.attachments || []).map((a) => a.filename || a.name || 'file').join(', '))
          : null,
      )),
    );
    root.classList.add('reading');
  }

  // ---- keys ----------------------------------------------------------------

  root.addEventListener('keydown', (e) => {
    if (!open) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!composeEl.hidden) return closeCompose();
      if (typing) { e.target.blur(); return; }
      if (thread) { thread = null; return render(); }
      return close();
    }
    if (typing || !composeEl.hidden) return;

    const k = e.key;
    if (gPending) {
      gPending = false;
      if (k === 'i') { folderId = 'inbox'; thread = null; cursor = -1; return void load(); }
      if (k === 's') { folderId = 'starred'; thread = null; cursor = -1; return void load(); }
      if (k === 't') { folderId = 'sent'; thread = null; cursor = -1; return void load(); }
      if (k === 'd') { folderId = 'drafts'; thread = null; cursor = -1; return void load(); }
      return;
    }
    if (k === 'g') { gPending = true; return; }
    if (k === '/') { e.preventDefault(); return searchEl.focus(); }
    if (k === 'c') { e.preventDefault(); return startCompose(); }
    if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); cursor = nextIndex(rows.length, cursor, 1); return thread ? void openThread(cursor) : render(); }
    if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); cursor = nextIndex(rows.length, cursor, -1); return thread ? void openThread(cursor) : render(); }
    if (k === 'Enter') { e.preventDefault(); return void openThread(cursor < 0 ? 0 : cursor); }
    if (k === 'u') { e.preventDefault(); thread = null; return render(); }
    if (k === 'e') { e.preventDefault(); return void act({ add: ['archived'] }); }
    if (k === '#') { e.preventDefault(); return void act({ add: ['trashed'] }); }
    if (k === 's') { e.preventDefault(); const r = rows[cursor]; return r ? void act({ [r.starred ? 'remove' : 'add']: ['starred'] }) : undefined; }
    if (k === 'm') { e.preventDefault(); const r = rows[cursor]; return r ? void act({ [r.unread ? 'add' : 'remove']: ['read'] }) : undefined; }
    if (k === 'r' && thread) { e.preventDefault(); return reply(); }
    if (k === 'a' && thread) { e.preventDefault(); return reply({ all: true }); }
  });

  function applyStatus() {
    const st = getState();
    const m = st && st.mail;
    const canSend = Boolean(m && m.resendReady);
    composeBtn.disabled = !canSend;
    composeBtn.title = canSend ? 'c' : 'Mail cannot be sent: no provider key is wired';
    syncBtn.disabled = !canSend;
    syncBtn.title = canSend ? 'Pull new mail from the provider now' : 'No provider key is wired';
  }

  function close() {
    open = false;
    root.hidden = true;
    closeCompose();
    document.body.classList.remove('mailbox-open');
  }

  return {
    isOpen: () => open,
    open(which = null) {
      open = true;
      if (which) station = which;
      root.hidden = false;
      document.body.classList.add('mailbox-open');
      applyStatus();
      root.focus();
      void load();
    },
    close,
    toggle(which = null) {
      return open ? close() : this.open(which);
    },
    refresh() {
      if (!open) return;
      applyStatus();
      void load();
    },
  };
}
