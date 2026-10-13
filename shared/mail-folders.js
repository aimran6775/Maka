// Mail folders (D187): the shape a mailbox has, shared by the store and the client so one
// cannot drift from the other.
//
// The store already held everything a mailbox needs — every message carries a `direction`
// (`in` / `out`), a `status` (`draft` once sent becomes `sent`), a `station` (the zone whose
// address it routed to, which is the department that owns it) and a set of `labels`. What
// it did not have was the idea of a *folder*, so the park could list a department's mail
// but not its inbox.
//
// A folder is therefore not a field: it is a question asked of a message. `archived` and
// `trashed` are labels because a message can be moved in and out of them without rewriting
// what it is; `draft` and `sent` are statuses because they are what a message *is*. Reading
// is a label (`read`) because unread is the absence of one, which is how the store already
// counted it.
//
// Trash wins over archive, and both hide a thread from the inbox: a message the owner has
// thrown away should not come back because it also happens to be starred.

export const FOLDERS = Object.freeze([
  {
    id: 'inbox',
    label: 'Inbox',
    // What arrived and has not been filed away.
    match: (m) => m.direction === 'in' && m.status !== 'draft' && !has(m, 'archived') && !has(m, 'trashed'),
    unreadCounts: true,
  },
  {
    id: 'starred',
    label: 'Starred',
    match: (m) => has(m, 'starred') && !has(m, 'trashed'),
  },
  {
    id: 'sent',
    label: 'Sent',
    match: (m) => m.direction === 'out' && m.status !== 'draft' && !has(m, 'trashed'),
  },
  {
    id: 'drafts',
    label: 'Drafts',
    match: (m) => m.status === 'draft' && !has(m, 'trashed'),
  },
  {
    id: 'archive',
    label: 'Archive',
    match: (m) => has(m, 'archived') && !has(m, 'trashed'),
  },
  {
    id: 'trash',
    label: 'Trash',
    match: (m) => has(m, 'trashed'),
  },
  {
    id: 'all',
    label: 'All mail',
    // Everything the park holds for this department except what was thrown away.
    match: (m) => !has(m, 'trashed'),
  },
]);

export const FOLDER_IDS = Object.freeze(FOLDERS.map((f) => f.id));
const BY_ID = new Map(FOLDERS.map((f) => [f.id, f]));

function has(m, label) {
  return Array.isArray(m.labels) && m.labels.includes(label);
}

export function folder(id) {
  return BY_ID.get(id) || null;
}

// Does this message belong in that folder? An unknown folder matches nothing rather than
// everything: a typo should show an empty mailbox, not the whole archive.
export function inFolder(m, id) {
  const f = BY_ID.get(id);
  return f ? Boolean(f.match(m)) : false;
}

// Is this message unread? Only something that arrived can be: the park's own sent mail is
// not waiting to be read by anyone.
export function isUnread(m) {
  return m.direction === 'in' && m.status !== 'draft' && !has(m, 'read');
}

// The labels a folder move adds and removes. Moving to the inbox is "not filed anywhere",
// which is why it removes rather than adds.
export const MOVES = Object.freeze({
  inbox: { add: [], remove: ['archived', 'trashed'] },
  archive: { add: ['archived'], remove: ['trashed'] },
  trash: { add: ['trashed'], remove: [] },
});

export function moveFor(folderId) {
  return MOVES[folderId] || null;
}
