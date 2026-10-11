// Import from OpenClaw and Hermes homes (phase 4 step 19, D150): another agent's persona,
// operating instructions, memory and model become one Ranger here. Keys are never
// transferred: the files that hold them (`.env`, `auth.json`, `credentials*`, `*.key`,
// `*.pem`, sessions, databases) are never opened, the config is read for its model only,
// and every text that is imported goes through the memory redactor first.
//
// What the homes hold (their own docs, October 2026):
//   OpenClaw  ~/.openclaw/openclaw.json (config, credentials, sessions: only the model is
//             read from it) and the workspace, ~/.openclaw/workspace by default or
//             `agents.defaults.workspace` / `agent.workspace`: SOUL.md (persona, tone,
//             boundaries), AGENTS.md (operating instructions), IDENTITY.md (name, vibe),
//             USER.md (who the user is), TOOLS.md, HEARTBEAT.md, memory/<day>.md daily
//             logs, MEMORY.md where present.
//   Hermes    ~/.hermes: config.yaml (model and settings), .env (secrets) and auth.json
//             (OAuth) which are never opened, SOUL.md (persona), memories/MEMORY.md
//             (conventions, lessons) and memories/USER.md (the user's profile).
//
// USER.md is the owner's personal profile and stays out of a Ranger's memory (D142: no
// personal data in memory); it is listed as skipped.
//
//   readHome(dir, { fs, maxItems }) -> { kind, root, name, persona, instructions, memories,
//                                       model, policy, skipped, warnings, redactions, read }
//   (safety 2026-10-11 M4: symbolic links are never followed, the OpenClaw workspace stays
//   inside the home, the persona is SOUL.md alone and the instructions become a skill the
//   owner enables)
//   candidates({ home, fs })        -> the known homes that exist on this machine
//   createImporter({ agents, memory, workspaceRoot, bus, clock, log }) -> { preview, run }

import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { makeEvent } from '../../shared/events.js';
import { SPECIALTIES } from '../../shared/world.js';
import { redact } from '../memory/redact.js';

export const HOME_KINDS = Object.freeze(['openclaw', 'hermes', 'unknown']);
export const KNOWN_HOMES = Object.freeze([
  { kind: 'openclaw', dir: '.openclaw', label: 'OpenClaw (~/.openclaw)' },
  { kind: 'hermes', dir: '.hermes', label: 'Hermes (~/.hermes)' },
]);
// Never opened, whatever the home: where keys and sessions live.
export const NEVER_READ = Object.freeze([/^\.env($|\.)/i, /^auth\.json$/i, /^credentials/i, /\.key$/i, /\.pem$/i, /^sessions?$/i, /\.db$/i, /\.sqlite3?$/i, /^secrets?/i, /^token/i]);
export const PERSONA_MAX = 4000; // shared/world.js: an agent's persona
export const INSTRUCTIONS_MAX = 4000; // sidecar/recipes/schema.js: a skill's instructions
export const MEMORY_ITEM_MAX = 600;
export const MEMORY_ITEMS_MAX = 40;
export const DAILY_LOGS_MAX = 7;
// A home's model to the park's worker providers; anything else is a warning, not a guess.
export const PROVIDER_MAP = Object.freeze({ anthropic: 'anthropic', openrouter: 'openrouter', ollama: 'ollama', local: 'ollama' });

export function neverRead(name) {
  return NEVER_READ.some((re) => re.test(name));
}

// Is this path a symbolic link? (lstat, so the link itself is looked at; an fs without
// lstat cannot say, and then nothing is read: safety 2026-10-11 M4.)
async function isSymlink(fs, file) {
  if (typeof fs.lstat !== 'function') return true;
  try {
    return (await fs.lstat(file)).isSymbolicLink();
  } catch {
    return false;
  }
}

// One text file of the home. A symbolic link is never followed (safety 2026-10-11 M4: a
// SOUL.md pointing at a private key would otherwise land in the park) and is listed as
// skipped; a never-read name is not opened.
async function readText(fs, file, read, skipped = null) {
  const base = path.basename(file);
  if (neverRead(base)) return null;
  if (await isSymlink(fs, file)) {
    if (skipped) skipped.push(`${base} (a symbolic link: not followed, nothing read)`);
    return null;
  }
  try {
    const text = await fs.readFile(file, 'utf8');
    read.push(file);
    return text;
  } catch {
    return null;
  }
}

async function exists(fs, file) {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

// Is `child` inside `parent` (or the same)? Both resolved; no `..` escape.
export function insideDir(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// The model named in a config, as { provider, model } or null. JSON (OpenClaw) is parsed and
// only model-shaped keys are looked at; YAML (Hermes) is read line by line for `model:` and
// `provider:` (a base URL names no provider here). Nothing that looks like a key is kept.
export function modelFromConfig(text, format) {
  if (!text) return null;
  const clean = (s) => String(s || '').trim().replace(/^["']|["']$/g, '');
  if (format === 'json') {
    let cfg;
    try {
      cfg = JSON.parse(text);
    } catch {
      return null;
    }
    const found = findModel(cfg, 0);
    return found ? splitModel(found) : null;
  }
  let model = null;
  let provider = null;
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(model|provider)\s*:\s*(.+?)\s*$/i.exec(line);
    if (!m) continue;
    const v = clean(m[2]);
    if (/key|token|secret|password/i.test(v) || !v || v.startsWith('{')) continue;
    if (m[1].toLowerCase() === 'model' && !model) model = v;
    if (m[1].toLowerCase() === 'provider' && !provider) provider = v.toLowerCase();
  }
  if (!model) return null;
  // With a provider of its own (Hermes), the model id is kept whole: OpenRouter's carry a
  // vendor prefix. Without one, "vendor/model" names the provider.
  const split = splitModel(model);
  if (provider) return { provider, model: model.toLowerCase().startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model };
  return { provider: split.provider, model: split.model };
}

function findModel(node, depth) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  for (const [k, v] of Object.entries(node)) {
    if (/key|token|secret|password|auth|credential/i.test(k)) continue;
    if (k === 'model' && typeof v === 'string' && v.trim()) return v.trim();
    if (k === 'model' && v && typeof v === 'object' && typeof v.primary === 'string') return v.primary.trim();
  }
  for (const [k, v] of Object.entries(node)) {
    if (/key|token|secret|password|auth|credential|session/i.test(k)) continue;
    if (v && typeof v === 'object') {
      const found = findModel(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// "anthropic/claude-x" -> { provider: 'anthropic', model: 'claude-x' }; a bare model name
// guesses no provider.
export function splitModel(s) {
  const v = String(s).trim();
  const m = /^([a-z0-9_-]+)\/(.+)$/i.exec(v);
  if (m) return { provider: m[1].toLowerCase(), model: m[2] };
  if (/^claude/i.test(v)) return { provider: 'anthropic', model: v };
  return { provider: null, model: v };
}

// The park's worker policy for an imported model, or null with the reason.
export function mapModel(spec) {
  if (!spec || !spec.model) return { policy: null, warning: 'no model named in the home; the Ranger uses the park\'s default worker' };
  const provider = spec.provider ? PROVIDER_MAP[spec.provider] : null;
  if (!provider) return { policy: null, warning: `no Maka provider for "${spec.provider || 'unknown provider'}" (${spec.model}); the Ranger uses the park's default worker` };
  return { policy: { worker: { provider, model: spec.model } }, warning: null };
}

const SECRET_KINDS = ['api key', 'bot token', 'jwt', 'bearer token', 'secret assignment', 'opaque token'];

// Memory text into items: bullets and paragraphs, headings kept as context, each redacted
// and clipped. A line that carried a key or a token is dropped whole (counted under
// `dropped`, its redactions kept for the report): no sentence about a secret is worth keeping.
export function splitMemory(text, { source, max = MEMORY_ITEMS_MAX, kind = 'fact' } = {}) {
  const out = [];
  const dropped = [];
  let heading = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const h = /^#+\s*(.+)$/.exec(line);
    if (h) {
      heading = h[1].trim();
      continue;
    }
    const body = line.replace(/^[-*•]\s+/, '').replace(/^\d+[.)]\s+/, '').trim();
    if (body.length < 8) continue;
    const red = redact(body);
    if (red.redactions.some((r) => SECRET_KINDS.includes(r.kind))) {
      dropped.push({ source, redactions: red.redactions });
      continue;
    }
    const prefixed = heading && !red.text.toLowerCase().startsWith(heading.toLowerCase()) ? `${heading}: ${red.text}` : red.text;
    out.push({ kind: /^(always|never|when |if |before |after |use |run |do |don'?t )/i.test(body) ? 'procedure' : kind, text: prefixed.slice(0, MEMORY_ITEM_MAX), source, redactions: red.redactions });
    if (out.length >= max) break;
  }
  return { items: out, dropped };
}

export function memoryItems(text, opts) {
  return splitMemory(text, opts).items;
}

// Reads a home. `dir` may be the config dir (~/.openclaw, ~/.hermes) or the OpenClaw
// workspace itself; the kind is told from what is there.
export async function readHome(dir, { fs = fsp, maxItems = MEMORY_ITEMS_MAX } = {}) {
  const root = path.resolve(dir);
  const read = [];
  const skipped = [];
  const warnings = [];
  if (!(await exists(fs, root))) throw Object.assign(new Error(`no such directory: ${root}`), { code: 'NO_HOME', status: 400 });
  const has = (...p) => exists(fs, path.join(root, ...p));
  let kind = 'unknown';
  if ((await has('openclaw.json')) || (await has('workspace', 'SOUL.md')) || (await has('AGENTS.md'))) kind = 'openclaw';
  else if ((await has('config.yaml')) || (await has('memories')) || (await has('.env'))) kind = 'hermes';
  // Where the files are: OpenClaw's workspace may be elsewhere (openclaw.json says).
  let workspace = root;
  let model = null;
  if (kind === 'openclaw') {
    const cfgText = await readText(fs, path.join(root, 'openclaw.json'), read);
    if (cfgText) {
      model = modelFromConfig(cfgText, 'json');
      try {
        const cfg = JSON.parse(cfgText);
        const ws = (cfg.agents && cfg.agents.defaults && cfg.agents.defaults.workspace) || (cfg.agent && cfg.agent.workspace) || cfg.workspace;
        if (typeof ws === 'string' && ws.trim()) {
          const wanted = path.resolve(root, ws.replace(/^~(?=$|\/)/, os.homedir()));
          // The workspace stays inside the home (safety 2026-10-11 M4): a config pointing
          // anywhere else would make the import read that place.
          if (insideDir(root, wanted) && !(await isSymlink(fs, wanted))) workspace = wanted;
          else warnings.push(`openclaw.json names a workspace outside the home (${wanted}): not followed; only files under ${root} are read`);
        }
      } catch {
        warnings.push('openclaw.json is not valid JSON; the model was not read');
      }
      skipped.push('openclaw.json (only the model was read; credentials and sessions stay)');
    }
    if (workspace === root && (await has('workspace'))) workspace = path.join(root, 'workspace');
  } else if (kind === 'hermes') {
    const cfgText = await readText(fs, path.join(root, 'config.yaml'), read);
    if (cfgText) {
      model = modelFromConfig(cfgText, 'yaml');
      skipped.push('config.yaml (only the model was read)');
    }
    for (const f of ['.env', 'auth.json']) if (await has(f)) skipped.push(`${f} (never opened: keys stay where they are)`);
  }
  for (const f of ['.env', 'auth.json', 'credentials.json', 'sessions']) if (kind !== 'hermes' && (await has(f))) skipped.push(`${f} (never opened: keys and sessions stay where they are)`);
  const soul = await readText(fs, path.join(workspace, 'SOUL.md'), read, skipped);
  const agentsMd = await readText(fs, path.join(workspace, 'AGENTS.md'), read, skipped);
  const identity = await readText(fs, path.join(workspace, 'IDENTITY.md'), read, skipped);
  const toolsMd = await readText(fs, path.join(workspace, 'TOOLS.md'), read, skipped);
  if (await exists(fs, path.join(workspace, 'USER.md'))) skipped.push('USER.md (the owner\'s profile: personal data stays out of a Ranger\'s memory)');
  if (await exists(fs, path.join(workspace, 'memories', 'USER.md'))) skipped.push('memories/USER.md (the owner\'s profile: personal data stays out of a Ranger\'s memory)');
  if (await exists(fs, path.join(workspace, 'HEARTBEAT.md'))) skipped.push('HEARTBEAT.md (a schedule for that agent, not a Ranger\'s)');
  const redactions = [];
  const note = (r) => redactions.push(...r.redactions);
  const personaRed = redact(soul || '');
  note(personaRed);
  const instructionsRed = redact([agentsMd, toolsMd ? `Tool notes:\n${toolsMd}` : ''].filter(Boolean).join('\n\n'));
  note(instructionsRed);
  let name = null;
  if (identity) {
    const m = /^\s*(?:#\s*)?(?:name|Name)\s*[:=]\s*(.+)$/m.exec(identity) || /^#\s+(.+)$/m.exec(identity);
    if (m) name = redact(m[1]).text.trim().slice(0, 60);
  }
  const memories = [];
  const dropped = [];
  const take = (t, source) => {
    const r = splitMemory(t, { source, max: maxItems - memories.length });
    memories.push(...r.items);
    dropped.push(...r.dropped);
  };
  for (const f of ['MEMORY.md', path.join('memories', 'MEMORY.md'), path.join('memory', 'MEMORY.md')]) {
    const t = await readText(fs, path.join(workspace, f), read, skipped);
    if (t) take(t, f);
  }
  // OpenClaw's daily logs: the last few days, newest first.
  const logDir = path.join(workspace, 'memory');
  try {
    if (await isSymlink(fs, logDir)) skipped.push('memory/ (a symbolic link: not followed)');
    else {
      const days = (await fs.readdir(logDir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse().slice(0, DAILY_LOGS_MAX);
      for (const d of days) {
        if (memories.length >= maxItems) break;
        const t = await readText(fs, path.join(logDir, d), read, skipped);
        if (t) take(t, `memory/${d}`);
      }
    }
  } catch {
    /* no daily logs */
  }
  for (const m of memories) redactions.push(...m.redactions);
  for (const d of dropped) redactions.push(...d.redactions);
  if (dropped.length) skipped.push(`${dropped.length} memory line(s) that carried a key or a token (dropped whole, never kept)`);
  const mapped = mapModel(model);
  if (mapped.warning) warnings.push(mapped.warning);
  if (!soul) warnings.push('no SOUL.md: the Ranger gets no persona from the home');
  // The persona is SOUL.md alone; AGENTS.md and TOOLS.md are operating instructions, kept
  // apart so they become a skill the owner enables, never words in the system prompt the
  // owner did not choose (safety 2026-10-11 M4).
  const persona = personaRed.text.trim();
  const instructions = instructionsRed.text.trim();
  if (persona.length > PERSONA_MAX) warnings.push(`the persona was clipped to ${PERSONA_MAX} characters`);
  if (instructions.length > INSTRUCTIONS_MAX) warnings.push(`the instructions were clipped to ${INSTRUCTIONS_MAX} characters`);
  const counts = {};
  for (const r of redactions) counts[r.kind] = (counts[r.kind] || 0) + r.count;
  return {
    kind,
    root,
    workspace,
    name,
    persona: persona.slice(0, PERSONA_MAX),
    instructions: instructions.slice(0, INSTRUCTIONS_MAX),
    personaChars: persona.length,
    instructionsChars: instructions.length,
    memories: memories.map((m) => ({ kind: m.kind, text: m.text, source: m.source })),
    model,
    policy: mapped.policy,
    skipped,
    warnings,
    redactions: Object.entries(counts).map(([k, count]) => ({ kind: k, count })),
    read: read.map((f) => path.relative(root, f) || '.'),
  };
}

// The known homes present on this machine.
export async function candidates({ home = os.homedir(), fs = fsp } = {}) {
  const out = [];
  for (const k of KNOWN_HOMES) {
    const dir = path.join(home, k.dir);
    if (await exists(fs, dir)) out.push({ kind: k.kind, label: k.label, path: dir });
  }
  return out;
}

export function createImporter({ agents, memory = null, skills = null, getLayout, workspaceRoot, bus, clock = { now: () => Date.now() }, fs = fsp, home = os.homedir(), log = console } = {}) {
  if (!agents || !workspaceRoot || !bus || !getLayout) throw new TypeError('createImporter needs agents, getLayout, workspaceRoot and bus');
  // Where the Ranger stands: the zone given, else the specialty's camp (made if missing, as
  // the Chief does when hiring), else the Ranger Station; never the Peak or the Gate.
  async function zoneFor({ zoneId, specialty }) {
    if (zoneId) return zoneId;
    if (specialty && SPECIALTIES[specialty]) return (await agents.ensureZone(SPECIALTIES[specialty].zoneKind)).id;
    const rooms = (getLayout().rooms || []).filter((r) => r.kind !== 'mountain_peak' && r.kind !== 'entrance_gate');
    const station = rooms.find((r) => r.kind === 'ranger_station') || rooms[0];
    if (!station) throw Object.assign(new Error('no zone to stand in: place a zone first'), { code: 'NO_ZONE', status: 409 });
    return station.id;
  }
  const emit = (type, payload) => bus.emit(makeEvent(type, payload, { ts: clock.now() }));
  return {
    candidates: () => candidates({ home, fs }),
    async preview({ path: dir } = {}) {
      if (typeof dir !== 'string' || !dir.trim()) throw Object.assign(new Error('path is required'), { code: 'BAD_REQUEST', status: 400 });
      const r = await readHome(dir, { fs });
      // The whole persona and the whole instructions (safety 2026-10-11 M4): what the owner
      // approves is what they read, not its first 600 characters.
      return { ...r, personaPreview: r.persona, instructionsPreview: r.instructions, memories: r.memories.slice(0, 10), memoryCount: r.memories.length };
    },
    // Creates the Ranger, then its memory items through the judge; without a judge the
    // items go to the Ranger's import folder as a file, never into memory (D142).
    async run({ path: dir, name, specialty, zoneId, venture } = {}) {
      if (typeof dir !== 'string' || !dir.trim()) throw Object.assign(new Error('path is required'), { code: 'BAD_REQUEST', status: 400 });
      const r = await readHome(dir, { fs });
      const rangerName = (typeof name === 'string' && name.trim()) || r.name || `${r.kind === 'unknown' ? 'Imported' : r.kind[0].toUpperCase() + r.kind.slice(1)} Ranger`;
      const spec = { name: rangerName.slice(0, 60), role: 'ranger', persona: r.persona || undefined, zoneId: await zoneFor({ zoneId, specialty }) };
      if (specialty) spec.specialty = specialty;
      if (venture) spec.venture = venture;
      if (r.policy) spec.policy = r.policy;
      const agent = await agents.create(spec, { by: 'superintendent' });
      // The operating instructions become a skill, saved but attached to nobody: the owner
      // reads it and enables it on the Ranger's card (safety 2026-10-11 M4). Without the
      // skills module they go to the import folder as a file.
      let skill = null;
      let skillNote = 'none (no instructions in the home)';
      if (r.instructions) {
        const id = `imported-${agent.id.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`.replace(/-+$/, '').slice(0, 60);
        if (skills && typeof skills.saveSkill === 'function') {
          try {
            skill = await skills.saveSkill({ id, title: `Imported instructions for ${agent.name}`.slice(0, 120), summary: `AGENTS.md / TOOLS.md of the ${r.kind} home at ${r.root}, redacted; not attached until you enable it`.slice(0, 300), instructions: r.instructions, source: `import:${r.kind}` }, { by: 'superintendent' });
            skillNote = `saved as skill "${skill.id}" (not attached: enable it on the Ranger's card after reading it)`;
          } catch (err) {
            skillNote = `could not be saved as a skill (${err.message}); written to import/instructions.md instead`;
          }
        } else skillNote = 'written to import/instructions.md (no skills module); nothing of it is in the persona';
      }
      const stored = [];
      const notStored = [];
      for (const m of r.memories) {
        let result = null;
        if (memory && typeof memory.write === 'function') {
          try {
            result = await memory.write({ agentId: agent.id, scope: 'agent', kind: m.kind, text: m.text, tags: ['imported', r.kind], by: 'superintendent', turn: 1, brief: `imported from a ${r.kind} home` });
          } catch (err) {
            result = { stored: false, reason: err.message };
          }
        } else result = { stored: false, reason: 'no memory module' };
        if (result.stored) stored.push(result.item.id);
        else notStored.push({ text: m.text, source: m.source, reason: result.reason });
      }
      const dirOut = path.join(workspaceRoot, agent.id, 'import');
      await fsp.mkdir(dirOut, { recursive: true });
      const report = [
        `# Imported from a ${r.kind} home`,
        '',
        `Source: ${r.root}${r.workspace !== r.root ? ` (workspace ${r.workspace})` : ''}`,
        `Ranger: ${agent.name} (${agent.id})`,
        `Persona: ${r.personaChars} character(s) from SOUL.md (the instructions are not in it)`,
        `Instructions: ${r.instructionsChars} character(s) from AGENTS.md / TOOLS.md: ${skillNote}`,
        `Model: ${r.model ? `${r.model.provider || '?'} / ${r.model.model}` : 'none named'}${r.policy ? ` → worker ${r.policy.worker.provider} ${r.policy.worker.model}` : ''}`,
        `Memory: ${stored.length} item(s) stored through the judge, ${notStored.length} not stored`,
        `Redacted before anything was kept: ${r.redactions.length ? r.redactions.map((x) => `${x.count} ${x.kind}`).join(', ') : 'nothing'}`,
        `Read: ${r.read.join(', ') || 'nothing'}`,
        `Skipped: ${r.skipped.join('; ') || 'nothing'}`,
        r.warnings.length ? `Warnings: ${r.warnings.join('; ')}` : '',
        'Keys were never transferred: the files that hold them were never opened.',
      ].filter((l) => l !== '').join('\n');
      await fsp.writeFile(path.join(dirOut, 'README.md'), `${report}\n`);
      if (notStored.length) await fsp.writeFile(path.join(dirOut, 'memory.md'), `# Memory items not stored (${notStored[0].reason})\n\n${notStored.map((m) => `- ${m.text}  (${m.source})`).join('\n')}\n`);
      if (r.instructions && !skill) await fsp.writeFile(path.join(dirOut, 'instructions.md'), `# Operating instructions from the ${r.kind} home (not applied)\n\nRead them, and save what you want as a skill at the Peak.\n\n${r.instructions}\n`);
      emit('import.home', { kind: r.kind, agentId: agent.id, persona: r.personaChars > 0, instructions: r.instructionsChars > 0, memoriesStored: stored.length, memoriesSkipped: notStored.length, model: r.policy ? `${r.policy.worker.provider}/${r.policy.worker.model}` : '', redactions: r.redactions.reduce((n, x) => n + x.count, 0), skipped: r.skipped.length, ...(skill ? { skillId: skill.id } : {}) });
      log.info && log.info(`import: ${agent.id} from ${r.kind} home ${r.root}: ${stored.length} memory item(s) stored, ${notStored.length} not`);
      return { agent, kind: r.kind, root: r.root, persona: r.personaChars, instructions: r.instructionsChars, skillId: skill ? skill.id : null, memoriesStored: stored, memoriesSkipped: notStored.length, model: r.model, policy: r.policy, redactions: r.redactions, skipped: r.skipped, warnings: r.warnings, report: path.join(agent.id, 'import', 'README.md') };
    },
  };
}
