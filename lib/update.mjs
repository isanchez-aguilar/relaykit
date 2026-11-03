// `relayrace init --update`: bring a repo that already has Relayrace installed up
// to the kit's current files, without ever overwriting the owner's work.
//
// How it knows what is safe: at install time `init` records a hash of each
// file it WROTE in .ai/relayrace.lock.json (read from the old
// .ai/relaykit.lock.json when the new name is absent). A file whose content still equals
// that hash was never edited, so replacing it with the kit's newer version
// loses nothing. Anything else is only reported:
//
//   current    the file already has the kit's content
//   missing    the profile wants it and the repo has none (written on --apply)
//   updatable  unchanged since install and the kit has a newer version (replaced on --apply)
//   modified   the owner changed it, or there is no baseline; shown, never touched
//
// Rules files (AGENTS.md, CLAUDE.md, GEMINI.md) are the owner's: they are never
// replaced, only compared section by section.
//
// Dependency-free: Node 18+ built-ins only.

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describeAdditions } from './additions.mjs';
import { assertInside } from './safe-fs.mjs';

export { assertInside };
import { PROFILES, profileFiles } from './profiles.mjs';

export const LOCK_FILE = '.ai/relayrace.lock.json';
/** The name before the rename: still read when the new file is absent, removed once the new one is written. */
export const LEGACY_LOCK_FILE = '.ai/relaykit.lock.json';
/** Kinds the update may replace when they are provably unedited. */
const REPLACEABLE = new Set(['prompt', 'agent', 'skill', 'script']);

const lf = text => String(text).replace(/\r\n/g, '\n');
export const hashContent = text => createHash('sha256').update(lf(text)).digest('hex');

export function readLock(root) {
  let name = LOCK_FILE;
  let path = join(root, name);
  if (!existsSync(path)) {
    const old = join(root, LEGACY_LOCK_FILE);
    if (!existsSync(old)) return { version: 1, kit: null, files: {} };
    [name, path] = [LEGACY_LOCK_FILE, old];
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const files = raw && typeof raw.files === 'object' && raw.files && !Array.isArray(raw.files) ? raw.files : {};
    return { version: 1, kit: typeof raw.kit === 'string' ? raw.kit : null, files };
  } catch { return { version: 1, kit: null, files: {}, invalid: true, file: name }; }
}

function writeLock(root, lock) {
  const path = join(root, LOCK_FILE);
  assertInside(root, path);
  mkdirSync(dirname(path), { recursive: true });
  assertInside(root, path);
  // A unique name, created exclusively: an existing link at that name is never written through.
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, kit: lock.kit, files: Object.fromEntries(Object.entries(lock.files).sort()) }, null, 2)}\n`, { flag: 'wx' });
  renameSync(temporary, path);
  // Only now that the new file is in place does the old name go away; a failure here is harmless
  // (the new file already wins), so it never fails the write.
  try { unlinkSync(join(root, LEGACY_LOCK_FILE)); } catch { /* absent or not removable */ }
}

/**
 * Replace `path` with `content` only if it still has `expectedHash`, deciding
 * and writing through ONE file descriptor opened without following a link, so
 * the file that was checked is the file that is written. (Concurrent writers
 * are still out of scope: one writer per checkout.)
 */
export function replaceIfUnchanged(path, expectedHash, content) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const fd = openSync(path, fsConstants.O_RDWR | noFollow);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('not a regular file');
    // A second name for the same file may live outside the repository: writing would change both.
    if (stat.nlink > 1) throw new Error('file has several hard links');
    const current = readFileSync(fd, 'utf8');
    if (hashContent(current) !== expectedHash) throw new Error('changed since the comparison');
    ftruncateSync(fd, 0);
    writeSync(fd, content, 0, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/** Record the files init just wrote (path -> content) as the baseline for later updates. */
export function recordInstalled(root, written, kit) {
  const lock = readLock(root);
  for (const [path, content] of Object.entries(written)) lock.files[path] = hashContent(content);
  writeLock(root, { ...lock, kit });
}

export function kitVersion(kitDir) {
  try { return JSON.parse(readFileSync(join(kitDir, 'package.json'), 'utf8')).version ?? null; } catch { return null; }
}

/**
 * Compare a repo with the kit. Read-only. `profile` and `name` come from
 * .ai/project.json when the repo has one.
 */
export function planUpdate(root, { kitDir, profile, name, scripts = {} } = {}) {
  let declared = {};
  try { declared = JSON.parse(readFileSync(join(root, '.ai/project.json'), 'utf8')); } catch { /* not installed */ }
  const profileName = profile || declared.profile;
  if (!PROFILES[profileName]) {
    throw new Error('this repo does not say which profile it uses (.ai/project.json "profile"); pass --profile <generic|web-app|notes>.');
  }
  const lock = readLock(root);
  const files = profileFiles(profileName, { kitDir, name: name || declared.name || 'project', scripts });
  const entries = files.map(file => {
    const path = join(root, file.path);
    if (!existsSync(path)) return { path: file.path, kind: file.kind, state: 'missing', content: file.content };
    const existing = readFileSync(path, 'utf8');
    if (hashContent(existing) === hashContent(file.content)) return { path: file.path, kind: file.kind, state: 'current', content: file.content };
    const baseline = lock.files[file.path];
    if (REPLACEABLE.has(file.kind) && baseline && baseline === hashContent(existing)) {
      return { path: file.path, kind: file.kind, state: 'updatable', content: file.content };
    }
    return { path: file.path, kind: file.kind, state: 'modified', content: file.content, additions: describeAdditions(file.path, existing, file.content) };
  });
  return { root, profile: profileName, tracked: Object.keys(lock.files).length > 0, lockInvalid: Boolean(lock.invalid), lockFile: lock.file ?? LOCK_FILE, entries };
}

export function summarize(plan) {
  const count = state => plan.entries.filter(entry => entry.state === state).length;
  return { current: count('current'), missing: count('missing'), updatable: count('updatable'), modified: count('modified'), tracked: plan.tracked };
}

/** Write `missing` and `updatable` files and refresh the baseline for everything now matching the kit. */
export function applyUpdate(plan, { kit = null } = {}) {
  const written = [];
  const skipped = [];
  const baseline = {};
  const lock = readLock(plan.root);
  for (const entry of plan.entries) {
    let settled = entry.state === 'current';
    if (entry.state === 'missing' || entry.state === 'updatable') {
      const path = join(plan.root, entry.path);
      try {
        assertInside(plan.root, path);
        if (entry.state === 'missing') {
          mkdirSync(dirname(path), { recursive: true });
          assertInside(plan.root, path);
          // Exclusive create: a file that appeared since the comparison is the owner's.
          writeFileSync(path, entry.content, { flag: 'wx' });
        } else {
          // The comparison may be stale: replace only a file still equal to its install baseline.
          if (!lock.files[entry.path]) throw new Error('no install baseline');
          replaceIfUnchanged(path, lock.files[entry.path], entry.content);
        }
        written.push({ path: entry.path, state: entry.state });
        settled = true;
      } catch (error) {
        skipped.push({ path: entry.path, reason: error.message });
      }
    }
    if (settled && REPLACEABLE.has(entry.kind)) baseline[entry.path] = entry.content;
  }
  plan.skipped = skipped;
  recordInstalled(plan.root, baseline, kit);
  return written;
}

/** Plain lines for the report. */
export function formatPlan(plan, { applied = [] } = {}) {
  const lines = [`Relayrace update for ${plan.root} (profile ${plan.profile})`, ''];
  const label = { missing: 'missing  ', updatable: 'updatable', modified: 'modified ', current: 'current  ' };
  for (const entry of plan.entries) {
    if (entry.state === 'current') continue;
    lines.push(`  ${label[entry.state]} ${entry.path}${entry.state === 'modified' ? (plan.tracked ? '  (edited since install; not touched)' : '  (no install baseline; not touched)') : ''}`);
  }
  const summary = summarize(plan);
  lines.push('', `${summary.current} current, ${summary.missing} missing, ${summary.updatable} safe to update, ${summary.modified} modified or without baseline.`);
  if (plan.lockInvalid) lines.push(`! ${plan.lockFile ?? LOCK_FILE} is not valid JSON; fix or delete it to track updates again.`);
  for (const item of plan.skipped ?? []) lines.push(`  SKIPPED ${item.path}: ${item.reason}`);
  if (applied.length) {
    lines.push('', ...applied.map(item => `  wrote ${item.path} (${item.state})`));
  } else if (summary.missing || summary.updatable) {
    lines.push('Run again with --apply to write the missing and safe-to-update files.');
  }
  if (summary.modified) lines.push('Modified files are yours: merge what is useful by hand (`relayrace init --dry-run --verbose` shows the sections they lack).');
  return lines;
}
