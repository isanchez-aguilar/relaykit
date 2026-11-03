import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain } from './is-main.mjs';

test('isMain is false without an argv[1] and true for the very file given', () => {
  assert.equal(isMain('file:///x.mjs', undefined), false);
  assert.equal(isMain(import.meta.url, fileURLToPath(import.meta.url)), true);
  assert.equal(isMain('file:///other.mjs', fileURLToPath(import.meta.url)), false);
  assert.equal(isMain(import.meta.url, '/does/not/exist.mjs'), false);
});

test('a script reached through a link (macOS /var, a junction on Windows) still runs', t => {
  const base = mkdtempSync(join(tmpdir(), 'relaykit-ismain-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const real = join(base, 'real');
  mkdirSync(real);
  const guard = new URL('./is-main.mjs', import.meta.url).href;
  writeFileSync(join(real, 'script.mjs'), "import { isMain } from '" + guard + "';\nif (isMain(import.meta.url)) console.log('ran');\n");
  const link = join(base, 'link');
  try { symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) { t.skip('cannot create a link here: ' + error.code); return; }
  const result = spawnSync(process.execPath, [join(link, 'script.mjs')], { encoding: 'utf8' });
  assert.equal(result.stdout.trim(), 'ran', result.stderr);
});
