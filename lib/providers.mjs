// Which AI providers a person can use, with which models and plan, and in what
// order to try them. One JSON file holds all of it, so every person (and every
// repo) can have a different setup and the agents still follow one rule: take the
// first enabled provider, in the file's order, that is capable of the task.
//
// Layers, first found wins:
//   1. <repo>/.ai/providers.json      this repo only
//   2. providers.json next to the Relayrace config file (RELAYKIT_PROVIDERS overrides)
//   3. the built-in default order below
//
// The file never holds keys or tokens: a value that looks like one is refused.
//
// Dependency-free: Node 18+ built-ins only.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { configFilePath, expandPath, readEnv } from './config.mjs';

export const FAMILIES = ['anthropic', 'google', 'openai', 'local', 'other'];
export const KINDS = ['qwen', 'jules', 'antigravity', 'codex', 'claude', 'other'];
export const COSTS = ['free', 'low', 'mid', 'high'];
/**
 * What a provider can be trusted with. `critical` is money, permissions,
 * schema changes and architecture: it never goes to a provider that lacks it.
 */
export const CAPABILITIES = ['mechanical', 'edit', 'implement', 'review', 'visual', 'test', 'critical'];

const model = (id, cost, restricted = false) => (restricted ? { id, cost, restricted } : { id, cost });

/** The default order; a person with other subscriptions edits the file or runs `relayrace providers ui`. */
export const DEFAULT_PROVIDERS = [
  { id: 'qwen', label: 'Qwen (local)', kind: 'qwen', family: 'local', enabled: true, plan: 'local model, no quota',
    models: [model('qwen-local', 'free')], can: ['mechanical'],
    notes: 'Mechanical work with an exact expected output. Optional: if the server is down the next provider does it.' },
  { id: 'jules', label: 'Jules (cloud)', kind: 'jules', family: 'google', enabled: true, plan: '',
    models: [], can: ['mechanical', 'implement'],
    notes: 'Bounded cloud tasks on their own branch and a pushed SHA. Never a reviewer.' },
  { id: 'gemini', label: 'Gemini via Antigravity', kind: 'antigravity', family: 'google', enabled: true, plan: '',
    models: [model('gemini-3.8-flash-low', 'low'), model('gemini-4-argon-medium', 'mid')], can: ['mechanical', 'review', 'visual'],
    notes: 'Reviews, visual checks and drafts. Flash for mechanical work.' },
  { id: 'agy-claude', label: 'Claude via Antigravity', kind: 'antigravity', family: 'anthropic', enabled: true, plan: '',
    models: [model('claude-sonnet-5-5-low', 'low'), model('claude-opus-5-5-high', 'high', true)], can: ['edit'],
    notes: 'Edit-only tasks with every path listed; a headless run dies on the first denied command.' },
  { id: 'codex', label: 'Codex', kind: 'codex', family: 'openai', enabled: true, plan: '',
    models: [], can: ['mechanical', 'edit', 'implement', 'review', 'test', 'critical'],
    notes: 'Implementation, reviews and tests. Weekly reset.' },
  { id: 'claude', label: 'Claude Code', kind: 'claude', family: 'anthropic', enabled: true, plan: '',
    models: [model('haiku', 'low'), model('sonnet', 'mid'), model('opus', 'high', true)],
    can: ['mechanical', 'edit', 'implement', 'review', 'visual', 'test', 'critical'],
    notes: 'Last. The cheapest model that solves the task; Opus only in extreme cases.' },
];

const SECRET = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{16}|xox[bp]-[A-Za-z0-9-]+)\b|Bearer\s+\S+/;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function text(value, label, max, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${label} is required.`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  if (value.length > max) throw new Error(`${label} is longer than ${max} characters.`);
  if (CONTROL.test(value)) throw new Error(`${label} has control characters.`);
  if (SECRET.test(value)) throw new Error(`${label} looks like a key or token; this file never holds secrets.`);
  return value.trim();
}

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label} must be one of ${allowed.join(', ')}.`);
  return value;
}

function normalizeModel(raw, label) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label} must be an object.`);
  const id = text(raw.id, `${label}.id`, 80, { required: true });
  if (/fable/i.test(id)) throw new Error(`${label}: Fable is never configured here; it needs the owner's yes for each use (RELAYKIT_ALLOW_FABLE=1 for that run).`);
  const result = { id, cost: oneOf(raw.cost ?? 'mid', COSTS, `${label}.cost`) };
  if (raw.restricted !== undefined) {
    if (typeof raw.restricted !== 'boolean') throw new Error(`${label}.restricted must be true or false.`);
    if (raw.restricted) result.restricted = true;
  }
  return result;
}

/** One provider entry, validated and reduced to the known fields. Throws on anything off. */
export function normalizeProvider(raw, index = 0) {
  const label = `providers[${index}]`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label} must be an object.`);
  const id = text(raw.id, `${label}.id`, 40, { required: true });
  if (!ID.test(id)) throw new Error(`${label}.id must be lowercase letters, digits and dashes.`);
  const models = raw.models ?? [];
  if (!Array.isArray(models) || models.length > 20) throw new Error(`${label}.models must be a list of at most 20.`);
  const can = raw.can ?? [];
  if (!Array.isArray(can) || can.length > CAPABILITIES.length * 2) throw new Error(`${label}.can must be a short list of capabilities.`);
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error(`${label}.enabled must be true or false.`);
  const normalized = {
    id,
    label: text(raw.label, `${label}.label`, 60) || id,
    kind: oneOf(raw.kind ?? 'other', KINDS, `${label}.kind`),
    family: oneOf(raw.family ?? 'other', FAMILIES, `${label}.family`),
    enabled: raw.enabled ?? true,
    plan: text(raw.plan, `${label}.plan`, 100),
    models: models.map((item, i) => normalizeModel(item, `${label}.models[${i}]`)),
    can: [...new Set(can.map(item => oneOf(item, CAPABILITIES, `${label}.can`)))],
    notes: text(raw.notes, `${label}.notes`, 300),
  };
  if (normalized.can.includes('critical') && !criticalAllowed(normalized)) {
    throw new Error(`${label}: "critical" (money, permissions, schema, architecture) cannot go to the local model, Jules or a Flash model.`);
  }
  return normalized;
}

/**
 * Money, permissions, schema and architecture never go to a provider that
 * cannot reason about them: the local model, Jules, or any Flash model.
 */
export function criticalAllowed(provider) {
  if (['qwen', 'jules'].includes(provider.kind) || provider.family === 'local') return false;
  return !provider.models.some(item => /flash/i.test(item.id));
}

/** The whole file's content. Order of the list is the priority. */
export function normalizeProviders(raw, source = 'providers') {
  const list = Array.isArray(raw) ? raw : raw?.providers;
  if (!Array.isArray(list) || !list.length) throw new Error(`${source}: needs a nonempty "providers" list.`);
  if (list.length > 30) throw new Error(`${source}: at most 30 providers.`);
  const providers = list.map((item, index) => normalizeProvider(item, index));
  const seen = new Set();
  for (const provider of providers) {
    if (seen.has(provider.id)) throw new Error(`${source}: duplicate provider id "${provider.id}".`);
    seen.add(provider.id);
  }
  return providers;
}

/** The user-level providers file: next to config.json, or RELAYKIT_PROVIDERS. */
export function providersFilePath({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  const explicit = readEnv(env, 'RELAYKIT_PROVIDERS');
  if (explicit) return expandPath(explicit.value, home);
  return join(dirname(configFilePath({ env, platform, home })), 'providers.json');
}

export const repoProvidersPath = cwd => resolve(cwd, '.ai', 'providers.json');

/**
 * Load the effective list. A file that exists but is invalid throws, so a typo
 * never silently falls back to a different order.
 */
export function loadProviders({ cwd = process.cwd(), env = process.env, platform = process.platform, home = homedir(),
  exists = existsSync, read = path => readFileSync(path, 'utf8') } = {}) {
  const candidates = [
    { source: 'repo', file: repoProvidersPath(cwd) },
    { source: 'user', file: providersFilePath({ env, platform, home }) },
  ];
  for (const { source, file } of candidates) {
    if (!exists(file)) continue;
    return { source, file, providers: readProvidersFile(file, read) };
  }
  return { source: 'default', file: candidates[1].file, providers: normalizeProviders(DEFAULT_PROVIDERS, 'defaults') };
}

const MAX_FILE_BYTES = 256 * 1024;

function readProvidersFile(file, read) {
  const content = read(file);
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error(`${file} is larger than ${MAX_FILE_BYTES} bytes.`);
  let raw;
  try { raw = JSON.parse(content.replace(/^﻿/, '')); } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }
  return normalizeProviders(raw, file);
}

/**
 * Only the user-level file (or the default when there is none): what the editor
 * shows and saves, so a repo override is never written over the personal file.
 */
export function loadUserProviders({ env = process.env, platform = process.platform, home = homedir(),
  exists = existsSync, read = path => readFileSync(path, 'utf8') } = {}) {
  const file = providersFilePath({ env, platform, home });
  if (!exists(file)) return { source: 'default', file, providers: normalizeProviders(DEFAULT_PROVIDERS, 'defaults') };
  return { source: 'user', file, providers: readProvidersFile(file, read) };
}

const COST_RANK = { free: 0, low: 1, mid: 2, high: 3 };

/** The cheapest model of a provider; restricted ones only when `extreme`. */
export function cheapestModel(provider, { extreme = false } = {}) {
  const usable = provider.models.filter(item => extreme || !item.restricted);
  if (!usable.length) return null;
  return usable.reduce((best, item) => (COST_RANK[item.cost] < COST_RANK[best.cost] ? item : best));
}

/**
 * First enabled provider, in list order, that can do `capability`. A reviewer
 * passes the implementer's family in `excludeFamilies`: independence counts by
 * model family, not by CLI. Returns `{ provider, model, skipped }` or null.
 */
export function pick(providers, { capability, excludeFamilies = [], extreme = false } = {}) {
  oneOf(capability, CAPABILITIES, 'capability');
  const skipped = [];
  for (const provider of providers) {
    if (!provider.enabled) { skipped.push({ id: provider.id, reason: 'disabled' }); continue; }
    if (!provider.can.includes(capability)) { skipped.push({ id: provider.id, reason: `cannot ${capability}` }); continue; }
    if (excludeFamilies.includes(provider.family)) { skipped.push({ id: provider.id, reason: `family ${provider.family} excluded` }); continue; }
    if (capability === 'critical' && !criticalAllowed(provider)) { skipped.push({ id: provider.id, reason: 'cannot decide critical work' }); continue; }
    const model = cheapestModel(provider, { extreme });
    // Models are listed but none may be used here: skip, never return a model-less pick.
    if (provider.models.length && !model) { skipped.push({ id: provider.id, reason: 'only extreme-case models (use --extreme)' }); continue; }
    return { provider, model, skipped };
  }
  return null;
}

/** Write the user-level file atomically, keeping the first version as `.bak-relaykit`. */
export function saveProviders(file, providers, { exists = existsSync } = {}) {
  const clean = normalizeProviders(providers, file);
  mkdirSync(dirname(file), { recursive: true });
  if (exists(file) && !exists(`${file}.bak-relaykit`)) copyFileSync(file, `${file}.bak-relaykit`);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, providers: clean }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  return clean;
}

/** The list as plain lines for `relayrace providers`. */
export function formatProviders({ source, file, providers }) {
  const lines = [`Providers, in priority order (${source === 'default' ? 'built-in default' : `${source}: ${file}`})`, ''];
  providers.forEach((provider, index) => {
    const models = provider.models.map(item => `${item.id}${item.restricted ? ' (extreme only)' : ''}`).join(', ') || 'default model';
    lines.push(`  ${String(index + 1).padStart(2)}. ${provider.enabled ? 'on ' : 'off'} ${provider.label.padEnd(26)} ${provider.family.padEnd(9)} ${provider.plan || '-'}`);
    lines.push(`        models: ${models}`);
    lines.push(`        can: ${provider.can.join(', ') || '-'}`);
  });
  lines.push('', 'Edit with `relayrace providers ui`, or by hand; `relayrace providers pick <capability>` shows who takes a task.');
  return lines;
}
