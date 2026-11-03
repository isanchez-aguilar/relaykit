import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  DEFAULT_QWEN_HEALTH_URL, DEFAULT_QWEN_LOCK_NAME, childEnv, configFilePath, envNames, expandPath, flattenConfig,
  legacyConfigFilePaths, legacyNames, loadConfig, readEnv, readSetting,
} from './config.mjs';

const none = () => false;
const w = (...parts) => parts.join(String.fromCharCode(92));

test('the config file lives in APPDATA on Windows and in ~/.config elsewhere', () => {
  assert.equal(configFilePath({ env: { APPDATA: w('C:', 'Users', 'Me', 'AppData', 'Roaming') }, platform: 'win32', home: w('C:', 'Users', 'Me') }),
    w('C:', 'Users', 'Me', 'AppData', 'Roaming', 'relayrace', 'config.json'));
  assert.equal(configFilePath({ env: {}, platform: 'win32', home: w('C:', 'Users', 'Me') }),
    w('C:', 'Users', 'Me', 'AppData', 'Roaming', 'relayrace', 'config.json'));
  assert.equal(configFilePath({ env: {}, platform: 'darwin', home: '/Users/me' }), '/Users/me/.config/relayrace/config.json');
  assert.equal(configFilePath({ env: { XDG_CONFIG_HOME: '/cfg' }, platform: 'linux', home: '/home/me' }), '/cfg/relayrace/config.json');
  assert.equal(configFilePath({ env: { RELAYRACE_CONFIG: 'x.json' }, platform: 'linux', home: '/home/me' }), resolve('x.json'));
  // The older spellings of RELAYRACE_CONFIG still choose the file, newest first.
  assert.equal(configFilePath({ env: { RELAYKIT_CONFIG: 'mid.json' }, platform: 'linux', home: '/home/me' }), resolve('mid.json'));
  assert.equal(configFilePath({ env: { AI_KIT_CONFIG: 'old.json' }, platform: 'linux', home: '/home/me' }), resolve('old.json'));
  assert.equal(configFilePath({ env: { RELAYRACE_CONFIG: 'new.json', RELAYKIT_CONFIG: 'mid.json', AI_KIT_CONFIG: 'old.json' }, platform: 'linux', home: '/h' }), resolve('new.json'));
  assert.equal(configFilePath({ env: { RELAYKIT_CONFIG: 'mid.json', AI_KIT_CONFIG: 'old.json' }, platform: 'linux', home: '/h' }), resolve('mid.json'));
});

test('the pre-rename config folders are known (relaykit, then ai-kit), unless a file was chosen explicitly', () => {
  assert.deepEqual(legacyConfigFilePaths({ env: {}, platform: 'darwin', home: '/Users/me' }),
    ['/Users/me/.config/relaykit/config.json', '/Users/me/.config/ai-kit/config.json']);
  assert.deepEqual(legacyConfigFilePaths({ env: { APPDATA: 'A' }, platform: 'win32', home: 'H' }), [w('A', 'relaykit', 'config.json'), w('A', 'ai-kit', 'config.json')]);
  for (const name of ['RELAYRACE_CONFIG', 'RELAYKIT_CONFIG', 'AI_KIT_CONFIG']) {
    assert.deepEqual(legacyConfigFilePaths({ env: { [name]: 'x.json' }, platform: 'linux', home: '/h' }), []);
  }
});

test('environment names: RELAYRACE_* first, then RELAYKIT_*, then the oldest AI_KIT_*', () => {
  assert.deepEqual(legacyNames('RELAYRACE_QWEN_URL'), ['RELAYKIT_QWEN_URL', 'AI_KIT_QWEN_URL']);
  assert.deepEqual(envNames('RELAYRACE_QWEN_URL'), ['RELAYRACE_QWEN_URL', 'RELAYKIT_QWEN_URL', 'AI_KIT_QWEN_URL']);
  assert.deepEqual(readEnv({ RELAYKIT_A: ' x ', AI_KIT_A: 'y' }, 'RELAYKIT_A', 'AI_KIT_A'), { name: 'RELAYKIT_A', value: 'x' });
  assert.deepEqual(readEnv({ RELAYKIT_A: ' ', AI_KIT_A: 'y' }, 'RELAYKIT_A', 'AI_KIT_A'), { name: 'AI_KIT_A', value: 'y' });
  assert.equal(readEnv({}, 'RELAYKIT_A'), undefined);
  assert.deepEqual(readSetting({ RELAYRACE_X: 'new', RELAYKIT_X: 'mid', AI_KIT_X: 'old' }, 'RELAYRACE_X'), { name: 'RELAYRACE_X', value: 'new' });
  assert.deepEqual(readSetting({ RELAYKIT_X: 'mid', AI_KIT_X: 'old' }, 'RELAYRACE_X'), { name: 'RELAYKIT_X', value: 'mid' });
  assert.deepEqual(readSetting({ RELAYRACE_X: ' ', RELAYKIT_X: 'mid' }, 'RELAYRACE_X'), { name: 'RELAYKIT_X', value: 'mid' });
  assert.deepEqual(readSetting({ AI_KIT_X: 'old' }, 'RELAYRACE_X'), { name: 'AI_KIT_X', value: 'old' });
  assert.equal(readSetting({}, 'RELAYRACE_X'), undefined);
});

test('with no file and no environment only the local model has values', () => {
  const config = loadConfig({ env: {}, platform: 'linux', home: '/home/me', exists: none });
  assert.equal(config.found, false);
  assert.deepEqual(config.notes, []);
  assert.equal(config.values.agentDesk, undefined);
  assert.equal(config.values.notes, undefined);
  assert.equal(config.values.qwenHealthUrl, DEFAULT_QWEN_HEALTH_URL);
  assert.equal(config.values.qwenLockName, DEFAULT_QWEN_LOCK_NAME);
  assert.deepEqual(config.sources, { agentDesk: 'unset', notes: 'unset', contract: 'unset', codexHome: 'default', qwenHealthUrl: 'default', qwenLockName: 'default' });
});

test('the file overrides the defaults and the environment overrides the file', () => {
  const file = JSON.stringify({ agentDesk: '/desk/config.json', notes: '~/vault', qwen: { healthUrl: 'http://10.0.0.5:8080/health', lockName: 'project-qwen' } });
  const base = { platform: 'linux', home: '/home/me', exists: () => true, read: () => file };
  const fromFile = loadConfig({ ...base, env: {} });
  assert.equal(fromFile.values.agentDesk, resolve('/desk/config.json'));
  assert.equal(fromFile.values.notes, resolve('/home/me', 'vault'));
  assert.equal(fromFile.values.qwenHealthUrl, 'http://10.0.0.5:8080/health');
  assert.equal(fromFile.values.qwenLockName, 'project-qwen');
  assert.equal(fromFile.sources.agentDesk, 'config');
  const env = { RELAYRACE_AGENT_DESK: '/env/desk.json', RELAYRACE_QWEN_URL: 'http://127.0.0.1:9/health' };
  const overridden = loadConfig({ ...base, env });
  assert.equal(overridden.values.agentDesk, resolve('/env/desk.json'));
  assert.equal(overridden.sources.agentDesk, 'env');
  assert.equal(overridden.values.qwenHealthUrl, 'http://127.0.0.1:9/health');
  assert.equal(overridden.values.notes, resolve('/home/me', 'vault'));
  assert.deepEqual(overridden.notes, []);
});

test('an old RELAYKIT_* or AI_KIT_* variable still works and is reported once', () => {
  const config = loadConfig({ env: { AI_KIT_AGENT_DESK: '/old/desk.json', AI_KIT_NOTES: '/old/notes', RELAYKIT_NOTES: '/mid/notes', RELAYRACE_CONTRACT: '/new/contract.md' }, platform: 'linux', home: '/h', exists: none });
  assert.equal(config.values.agentDesk, resolve('/old/desk.json'));
  assert.equal(config.values.notes, resolve('/mid/notes'), 'RELAYKIT_ beats AI_KIT_');
  assert.equal(config.values.contract, resolve('/new/contract.md'));
  assert.deepEqual(config.notes, ['AI_KIT_AGENT_DESK, RELAYKIT_NOTES still work; rename them to RELAYRACE_*']);
  // The new name beats both older ones.
  const winner = loadConfig({ env: { RELAYRACE_NOTES: '/new', RELAYKIT_NOTES: '/mid', AI_KIT_NOTES: '/old' }, platform: 'linux', home: '/h', exists: none });
  assert.equal(winner.values.notes, resolve('/new'));
  assert.deepEqual(winner.notes, []);
  assert.deepEqual(loadConfig({ env: { RELAYKIT_QWEN_URL: 'http://old/health' }, platform: 'linux', home: '/h', exists: none }).notes,
    ['RELAYKIT_QWEN_URL still works; rename it to RELAYRACE_*']);
});

test('the old config folders are read when the new one has no file, relaykit before ai-kit, with a note', () => {
  const aiKit = '/h/.config/ai-kit/config.json';
  const relaykit = '/h/.config/relaykit/config.json';
  const config = loadConfig({
    env: {}, platform: 'linux', home: '/h',
    exists: path => path === aiKit,
    read: path => { assert.equal(path, aiKit); return '{"notes": "/vault"}'; },
  });
  assert.equal(config.file, aiKit);
  assert.equal(config.values.notes, resolve('/vault'));
  assert.match(config.notes[0], /reading the old config \/h\/\.config\/ai-kit\/config\.json; move it to \/h\/\.config\/relayrace\/config\.json/);
  const mid = loadConfig({
    env: {}, platform: 'linux', home: '/h',
    exists: path => path === relaykit || path === aiKit,
    read: path => (path === relaykit ? '{"notes": "/mid"}' : '{"notes": "/old"}'),
  });
  assert.equal(mid.file, relaykit);
  assert.equal(mid.values.notes, resolve('/mid'));
  assert.match(mid.notes[0], /reading the old config \/h\/\.config\/relaykit\/config\.json; move it to \/h\/\.config\/relayrace\/config\.json/);
  // The new file wins when several exist, and nothing is reported.
  const all = loadConfig({ env: {}, platform: 'linux', home: '/h', exists: () => true,
    read: path => (path.includes('relayrace') ? '{"notes": "/new"}' : '{"notes": "/old"}') });
  assert.equal(all.file, '/h/.config/relayrace/config.json');
  assert.equal(all.values.notes, resolve('/new'));
  assert.deepEqual(all.notes, []);
  // A file chosen with the old variable name is used as given, with no folder fallback.
  const chosen = loadConfig({ env: { RELAYKIT_CONFIG: '/x/c.json' }, platform: 'linux', home: '/h', exists: path => path === relaykit, read: () => '{}' });
  assert.equal(chosen.found, false);
});

test('a broken or wrongly shaped file is an error, never silently ignored', () => {
  const load = text => loadConfig({ env: {}, platform: 'linux', home: '/h', exists: () => true, read: () => text });
  assert.throws(() => load('{nope'), /not valid JSON/);
  assert.throws(() => load('[]'), /must be a JSON object/);
  assert.throws(() => load('{"agentDesk": 4}'), /agentDesk must be a nonempty string/);
  assert.throws(() => load('{"qwen": "x"}'), /qwen must be an object/);
  assert.throws(() => load('{"qwen": {"lockName": "../x"}}'), /plain folder name/);
  assert.throws(() => loadConfig({ env: { RELAYRACE_QWEN_LOCK: 'a/b' }, platform: 'linux', home: '/h', exists: none }), /plain folder name/);
  assert.equal(load('﻿{"notes": "/n"}').values.notes, resolve('/n'));
});

test('flattenConfig keeps only the documented keys', () => {
  assert.deepEqual(flattenConfig({ agentDesk: ' /a ', extra: 1, qwen: { healthUrl: 'u' } }), { agentDesk: '/a', qwenHealthUrl: 'u' });
});

test('~ expands to the home folder', () => {
  assert.equal(expandPath('~', '/home/me'), '/home/me');
  assert.equal(expandPath('~/notes', '/home/me'), resolve('/home/me', 'notes'));
  assert.equal(expandPath('/abs'), resolve('/abs'));
  assert.equal(typeof homedir(), 'string');
});

test('children see the resolved values, but an explicit variable (any spelling) wins', () => {
  const config = loadConfig({ env: {}, platform: 'linux', home: '/h', exists: () => true, read: () => '{"qwen":{"healthUrl":"http://x/health"}}' });
  assert.equal(childEnv(config, {}).RELAYRACE_QWEN_URL, 'http://x/health');
  assert.equal(childEnv(config, { RELAYRACE_QWEN_URL: 'http://y/health' }).RELAYRACE_QWEN_URL, 'http://y/health');
  assert.equal('RELAYRACE_QWEN_URL' in childEnv(config, { RELAYKIT_QWEN_URL: 'http://w/health' }), false);
  assert.equal('RELAYRACE_QWEN_URL' in childEnv(config, { AI_KIT_QWEN_URL: 'http://z/health' }), false);
  assert.equal('RELAYRACE_AGENT_DESK' in childEnv(config, {}), false);
});

test('the default qwen lock folder keeps its old name so old and new qwen.mjs copies share one lock', () => {
  assert.equal(DEFAULT_QWEN_LOCK_NAME, 'relaykit-qwen');
});
