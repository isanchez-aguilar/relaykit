import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  DEFAULT_QWEN_HEALTH_URL, DEFAULT_QWEN_LOCK_NAME, childEnv, configFilePath, expandPath, flattenConfig,
  legacyConfigFilePath, legacyName, loadConfig, readEnv,
} from './config.mjs';

const none = () => false;
const w = (...parts) => parts.join(String.fromCharCode(92));

test('the config file lives in APPDATA on Windows and in ~/.config elsewhere', () => {
  assert.equal(configFilePath({ env: { APPDATA: w('C:', 'Users', 'Me', 'AppData', 'Roaming') }, platform: 'win32', home: w('C:', 'Users', 'Me') }),
    w('C:', 'Users', 'Me', 'AppData', 'Roaming', 'relaykit', 'config.json'));
  assert.equal(configFilePath({ env: {}, platform: 'win32', home: w('C:', 'Users', 'Me') }),
    w('C:', 'Users', 'Me', 'AppData', 'Roaming', 'relaykit', 'config.json'));
  assert.equal(configFilePath({ env: {}, platform: 'darwin', home: '/Users/me' }), '/Users/me/.config/relaykit/config.json');
  assert.equal(configFilePath({ env: { XDG_CONFIG_HOME: '/cfg' }, platform: 'linux', home: '/home/me' }), '/cfg/relaykit/config.json');
  assert.equal(configFilePath({ env: { RELAYKIT_CONFIG: 'x.json' }, platform: 'linux', home: '/home/me' }), resolve('x.json'));
  assert.equal(configFilePath({ env: { AI_KIT_CONFIG: 'old.json' }, platform: 'linux', home: '/home/me' }), resolve('old.json'));
});

test('the pre-rename config folder is known, unless a file was chosen explicitly', () => {
  assert.equal(legacyConfigFilePath({ env: {}, platform: 'darwin', home: '/Users/me' }), '/Users/me/.config/ai-kit/config.json');
  assert.equal(legacyConfigFilePath({ env: { APPDATA: 'A' }, platform: 'win32', home: 'H' }), w('A', 'ai-kit', 'config.json'));
  assert.equal(legacyConfigFilePath({ env: { RELAYKIT_CONFIG: 'x.json' }, platform: 'linux', home: '/h' }), undefined);
});

test('environment names: RELAYKIT_* first, the old AI_KIT_* still read', () => {
  assert.equal(legacyName('RELAYKIT_QWEN_URL'), 'AI_KIT_QWEN_URL');
  assert.deepEqual(readEnv({ RELAYKIT_A: ' x ', AI_KIT_A: 'y' }, 'RELAYKIT_A', 'AI_KIT_A'), { name: 'RELAYKIT_A', value: 'x' });
  assert.deepEqual(readEnv({ RELAYKIT_A: ' ', AI_KIT_A: 'y' }, 'RELAYKIT_A', 'AI_KIT_A'), { name: 'AI_KIT_A', value: 'y' });
  assert.equal(readEnv({}, 'RELAYKIT_A'), undefined);
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
  const env = { RELAYKIT_AGENT_DESK: '/env/desk.json', RELAYKIT_QWEN_URL: 'http://127.0.0.1:9/health' };
  const overridden = loadConfig({ ...base, env });
  assert.equal(overridden.values.agentDesk, resolve('/env/desk.json'));
  assert.equal(overridden.sources.agentDesk, 'env');
  assert.equal(overridden.values.qwenHealthUrl, 'http://127.0.0.1:9/health');
  assert.equal(overridden.values.notes, resolve('/home/me', 'vault'));
  assert.deepEqual(overridden.notes, []);
});

test('an old AI_KIT_* variable still works and is reported once', () => {
  const config = loadConfig({ env: { AI_KIT_AGENT_DESK: '/old/desk.json', AI_KIT_NOTES: '/old/notes', RELAYKIT_NOTES: '/new/notes' }, platform: 'linux', home: '/h', exists: none });
  assert.equal(config.values.agentDesk, resolve('/old/desk.json'));
  assert.equal(config.values.notes, resolve('/new/notes'));
  assert.deepEqual(config.notes, ['AI_KIT_AGENT_DESK still works; rename it to RELAYKIT_*']);
});

test('the old config folder is read when the new one has no file, with a note', () => {
  const legacy = '/h/.config/ai-kit/config.json';
  const config = loadConfig({
    env: {}, platform: 'linux', home: '/h',
    exists: path => path === legacy,
    read: path => { assert.equal(path, legacy); return '{"notes": "/vault"}'; },
  });
  assert.equal(config.file, legacy);
  assert.equal(config.values.notes, resolve('/vault'));
  assert.match(config.notes[0], /reading the old config \/h\/\.config\/ai-kit\/config\.json; move it to \/h\/\.config\/relaykit\/config\.json/);
  // The new file wins when both exist.
  const both = loadConfig({ env: {}, platform: 'linux', home: '/h', exists: () => true, read: path => (path.includes('relaykit') ? '{"notes": "/new"}' : '{"notes": "/old"}') });
  assert.equal(both.values.notes, resolve('/new'));
  assert.deepEqual(both.notes, []);
});

test('a broken or wrongly shaped file is an error, never silently ignored', () => {
  const load = text => loadConfig({ env: {}, platform: 'linux', home: '/h', exists: () => true, read: () => text });
  assert.throws(() => load('{nope'), /not valid JSON/);
  assert.throws(() => load('[]'), /must be a JSON object/);
  assert.throws(() => load('{"agentDesk": 4}'), /agentDesk must be a nonempty string/);
  assert.throws(() => load('{"qwen": "x"}'), /qwen must be an object/);
  assert.throws(() => load('{"qwen": {"lockName": "../x"}}'), /plain folder name/);
  assert.throws(() => loadConfig({ env: { RELAYKIT_QWEN_LOCK: 'a/b' }, platform: 'linux', home: '/h', exists: none }), /plain folder name/);
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

test('children see the resolved values, but an explicit variable (either spelling) wins', () => {
  const config = loadConfig({ env: {}, platform: 'linux', home: '/h', exists: () => true, read: () => '{"qwen":{"healthUrl":"http://x/health"}}' });
  assert.equal(childEnv(config, {}).RELAYKIT_QWEN_URL, 'http://x/health');
  assert.equal(childEnv(config, { RELAYKIT_QWEN_URL: 'http://y/health' }).RELAYKIT_QWEN_URL, 'http://y/health');
  assert.equal('RELAYKIT_QWEN_URL' in childEnv(config, { AI_KIT_QWEN_URL: 'http://z/health' }), false);
  assert.equal('RELAYKIT_AGENT_DESK' in childEnv(config, {}), false);
});
