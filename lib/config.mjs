// Where Relayrace finds the machine-specific things it needs. Nothing here is
// required: every value is optional, and a missing one only switches a feature
// off (no Agent Desk -> registration is skipped with a note).
//
// Layers, lowest to highest precedence:
//   1. defaults        (local model health URL, lock name and Codex config directory)
//   2. config file     ~/.config/relayrace/config.json   (Windows: %APPDATA%\relayrace\config.json)
//   3. environment     RELAYRACE_AGENT_DESK, RELAYRACE_NOTES, RELAYRACE_CONTRACT,
//                      RELAYRACE_QWEN_URL, RELAYRACE_QWEN_LOCK; Codex uses CODEX_HOME
//
// So the file holds the machine's standing values and an environment variable
// overrides them for one run. RELAYRACE_CONFIG points at another config file.
//
// The project used to be called relaykit and, before that, ai-kit: the old config
// folders (.../relaykit/, then .../ai-kit/) and the old RELAYKIT_* and AI_KIT_*
// variables are still read, after the new names and in that order, with a
// one-line note, so nothing breaks on a machine configured before a rename.
// Nothing is moved or copied for the owner.
//
// Dependency-free: Node 18+ built-ins only.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, resolve, win32 } from 'node:path';

export const DEFAULT_QWEN_HEALTH_URL = 'http://127.0.0.1:8080/health';
// Deliberately NOT renamed: qwen.mjs copies installed in other repos (older or newer)
// must keep sharing one single-slot lock folder, so the default stays `relaykit-qwen`.
export const DEFAULT_QWEN_LOCK_NAME = 'relaykit-qwen';

/** The documented keys, their environment variable and what they do. */
export const CONFIG_KEYS = {
  agentDesk: { env: 'RELAYRACE_AGENT_DESK', about: 'Agent Desk config.json that init registers repos in (optional)' },
  notes: { env: 'RELAYRACE_NOTES', about: 'your notes folder, for the setup docs (optional)' },
  contract: { env: 'RELAYRACE_CONTRACT', about: 'a contract file to sync instead of docs/contract.md (optional)' },
  qwenHealthUrl: { env: 'RELAYRACE_QWEN_URL', about: `local model health URL (default ${DEFAULT_QWEN_HEALTH_URL})` },
  qwenLockName: { env: 'RELAYRACE_QWEN_LOCK', about: `temp folder that holds the single-slot lock (default ${DEFAULT_QWEN_LOCK_NAME})` },
};

const PATH_KEYS = new Set(['agentDesk', 'notes', 'contract']);

/** The variable's pre-rename spellings, newest first: RELAYRACE_X was RELAYKIT_X, and before that AI_KIT_X. */
export const legacyNames = variable => ['RELAYKIT_', 'AI_KIT_'].map(prefix => variable.replace(/^RELAYRACE_/, prefix));

/** Every spelling of a variable in lookup order: RELAYRACE_X, RELAYKIT_X, AI_KIT_X. */
export const envNames = variable => [variable, ...legacyNames(variable)];

/** The first of `names` set to a nonblank value in `env`, with the name that held it. */
export function readEnv(env, ...names) {
  for (const name of names) {
    if (typeof env[name] === 'string' && env[name].trim()) return { name, value: env[name].trim() };
  }
  return undefined;
}

/** The value of a RELAYRACE_* variable under its current or any older spelling. */
export const readSetting = (env, variable) => readEnv(env, ...envNames(variable));

/** Config folder names, newest first; the legacy ones are read only when nothing newer exists. */
export const CONFIG_FOLDER = 'relayrace';
export const LEGACY_CONFIG_FOLDERS = ['relaykit', 'ai-kit'];

function folders(platform, env, home) {
  return platform === 'win32'
    ? (name => win32.join(env.APPDATA || win32.join(home, 'AppData', 'Roaming'), name, 'config.json'))
    : (name => posix.join(env.XDG_CONFIG_HOME || posix.join(home, '.config'), name, 'config.json'));
}

/** The config file for this machine. Pure: platform, env and home are injected. */
export function configFilePath({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  const explicit = readSetting(env, 'RELAYRACE_CONFIG');
  if (explicit) return resolve(explicit.value);
  return folders(platform, env, home)(CONFIG_FOLDER);
}

/** Where the same file lived before the renames (relaykit, then ai-kit); none when RELAYRACE_CONFIG chose a file. */
export function legacyConfigFilePaths({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (readSetting(env, 'RELAYRACE_CONFIG')) return [];
  return LEGACY_CONFIG_FOLDERS.map(folders(platform, env, home));
}

/** `~` and `~/x` mean the home folder; anything else is resolved as given. */
export function expandPath(value, home = homedir()) {
  if (value === '~') return home;
  if (/^~[\\/]/.test(value)) return resolve(home, value.slice(2));
  return resolve(value);
}

export function codexConfigDir({ env = process.env, home = homedir() } = {}) {
  return expandPath(readEnv(env, 'CODEX_HOME')?.value || resolve(home, '.codex'), home);
}

/** The file's flat view: `qwen: { healthUrl, lockName }` becomes qwenHealthUrl / qwenLockName. */
export function flattenConfig(raw, label = 'config') {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label} must be a JSON object.`);
  const flat = {};
  const take = (key, value) => {
    if (value === undefined) return;
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}: ${key} must be a nonempty string.`);
    flat[key] = value.trim();
  };
  take('agentDesk', raw.agentDesk);
  take('notes', raw.notes);
  take('contract', raw.contract);
  if (raw.qwen !== undefined) {
    if (raw.qwen === null || typeof raw.qwen !== 'object' || Array.isArray(raw.qwen)) throw new Error(`${label}: qwen must be an object.`);
    take('qwenHealthUrl', raw.qwen.healthUrl);
    take('qwenLockName', raw.qwen.lockName);
  }
  if (flat.qwenLockName && !/^[\w.-]+$/.test(flat.qwenLockName)) throw new Error(`${label}: qwen.lockName must be a plain folder name.`);
  return flat;
}

/**
 * Resolve the configuration. Returns the values, where each one came from
 * ('env' | 'config' | 'default' | 'unset'), the config file's state and `notes`
 * (one-line messages about legacy names in use). Throws on a config file that
 * exists but is not valid, so a typo is never silent.
 */
export function loadConfig({ env = process.env, platform = process.platform, home = homedir(),
  exists = existsSync, read = path => readFileSync(path, 'utf8') } = {}) {
  const notes = [];
  let file = configFilePath({ env, platform, home });
  let found = exists(file);
  if (!found) {
    const legacy = legacyConfigFilePaths({ env, platform, home }).find(candidate => exists(candidate));
    if (legacy) {
      notes.push(`reading the old config ${legacy}; move it to ${file} (the project is called Relayrace now)`);
      [file, found] = [legacy, true];
    }
  }
  let fromFile = {};
  if (found) {
    let raw;
    try { raw = JSON.parse(read(file).replace(/^﻿/, '')); } catch (error) {
      throw new Error(`${file} is not valid JSON: ${error.message}`);
    }
    fromFile = flattenConfig(raw, file);
  }
  const defaults = { qwenHealthUrl: DEFAULT_QWEN_HEALTH_URL, qwenLockName: DEFAULT_QWEN_LOCK_NAME };
  const values = {};
  const sources = {};
  const oldNames = [];
  for (const [key, { env: variable }] of Object.entries(CONFIG_KEYS)) {
    let value;
    let source = 'unset';
    if (defaults[key] !== undefined) [value, source] = [defaults[key], 'default'];
    if (fromFile[key] !== undefined) [value, source] = [fromFile[key], 'config'];
    const fromEnv = readSetting(env, variable);
    if (fromEnv) {
      [value, source] = [fromEnv.value, 'env'];
      if (fromEnv.name !== variable) oldNames.push(fromEnv.name);
    }
    if (value !== undefined && PATH_KEYS.has(key)) value = expandPath(value, home);
    values[key] = value;
    sources[key] = source;
  }
  if (oldNames.length) notes.push(`${oldNames.join(', ')} ${oldNames.length === 1 ? 'still works; rename it' : 'still work; rename them'} to RELAYRACE_*`);
  if (values.qwenLockName && !/^[\w.-]+$/.test(values.qwenLockName)) throw new Error('RELAYRACE_QWEN_LOCK must be a plain folder name.');
  values.codexHome = codexConfigDir({ env, home });
  sources.codexHome = readEnv(env, 'CODEX_HOME') ? 'env' : 'default';
  return { file, found, values, sources, notes };
}

/** Environment for a child process so the standalone scripts see the same values. */
export function childEnv(config, base = process.env) {
  const env = { ...base };
  if (config.values.codexHome !== undefined) env.CODEX_HOME = config.values.codexHome;
  for (const [key, { env: variable }] of Object.entries(CONFIG_KEYS)) {
    if (config.values[key] !== undefined && !readSetting(env, variable)) env[variable] = config.values[key];
  }
  return env;
}
