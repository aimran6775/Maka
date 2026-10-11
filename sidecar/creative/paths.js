// Where creative deliverables live in a Ranger's workspace and how they are named.
import path from 'node:path';

export const CREATIVE_DIR = path.join('outbox', 'creative');

export function slugOf(name, fallback = 'creative') {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || fallback;
}

// outbox/creative/<venture or general>/<id>/
export function creativeDir(workspaceDir, venture, id) {
  return path.join(workspaceDir, CREATIVE_DIR, slugOf(venture, 'general'), id);
}

export function newId(kind, nowMs, random = Math.random) {
  return `${kind}-${new Date(nowMs).toISOString().slice(0, 10)}-${random().toString(36).slice(2, 7).padEnd(5, '0')}`;
}
