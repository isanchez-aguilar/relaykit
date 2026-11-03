// Writes that stay inside the folder they were meant for.
//
// A repository you did not write can contain a symlink or a Windows junction
// (.claude, .ai, a file under .ai/runs). Writing through it would create or
// truncate files outside the checkout. These helpers refuse that.
//
// Dependency-free: Node 18+ built-ins only.

import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

/** True when anything, even a broken link, sits at `path` (existsSync follows links, so it misses those). */
const lexists = path => { try { lstatSync(path); return true; } catch { return false; } };

/**
 * Throw unless writing `path` stays inside `root`: no link or junction in the
 * existing part of the path may lead elsewhere, and the file itself must not
 * be a link.
 */
export function assertInside(root, path) {
  const base = realpathSync(root);
  let probe = resolve(path);
  while (!lexists(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const real = realpathSync(probe);
  // Windows paths are case-insensitive: compare them that way, still at component boundaries.
  const fold = value => (process.platform === 'win32' ? value.toLowerCase() : value);
  if (fold(real) !== fold(base) && !fold(real).startsWith(fold(base) + sep)) {
    throw new Error(`refusing to write outside the repository: ${relative(root, path)} goes through a link to ${real}`);
  }
  if (lexists(path) && lstatSync(path).isSymbolicLink()) throw new Error(`refusing to write through a link: ${relative(root, path)}`);
}

/** Create a file that does not exist yet, inside `root`. An existing file (or a link, even a broken one) is an error. */
export function writeNewInside(root, path, content) {
  assertInside(root, path);
  mkdirSync(dirname(path), { recursive: true });
  assertInside(root, path);
  writeFileSync(path, content, { flag: 'wx' });
}

/** Append to a file inside `root`; a symlink or a file with several hard links is refused (a second name may lead outside). */
export function appendInside(root, path, text) {
  assertInside(root, path);
  if (existsSync(path) && lstatSync(path).nlink > 1) throw new Error(`refusing to write a file with several hard links: ${relative(root, path)}`);
  appendFileSync(path, text);
}

/**
 * Replace `path` with `text` through a temporary file with an unpredictable name,
 * created exclusively (with `mode` when given). A link already sitting at `path` is replaced, never written through.
 */
export function writeTextAtomic(path, text, { mode } = {}) {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, text, { flag: 'wx', ...(mode === undefined ? {} : { mode }) });
  try { renameSync(temporary, path); } catch (error) {
    try { unlinkSync(temporary); } catch { /* already gone */ }
    throw error;
  }
}

export const writeJsonAtomic = (path, value) => writeTextAtomic(path, JSON.stringify(value, null, 2) + '\n');
