import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BLOCK_END, BLOCK_START, CODEX_BUDGET, CONTRACT_FILE, GENERATED, KIT_DIR,
  LEGACY_GENERATED, LEGACY_GENERATED_RELAYKIT, LEGACY_GENERATED_AI_KIT, extractContract, isGenerated, knownProjectSizes, plan, runSync, sync, toCodexToml, upsertBlock,
} from './sync.mjs';

const note = body => `---\ntags: [x]\n---\n\n# Contrato\n\nIntro.\n\n<!-- contrato:inicio -->\n${body}\n<!-- contrato:fin -->\n`;
const agent = (name, extra = '') => `---\nname: ${name}\ndescription: Role ${name} for tests\nmodel: sonnet\neffort: high\n${extra}---\nDo the ${name} work.\n`;

function snapshot(root) {
  const result = {};
  if (!existsSync(root)) return result;
  const walk = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const key = `${prefix}${entry.name}`;
      if (entry.isDirectory()) { result[`${key}/`] = null; walk(join(dir, entry.name), `${key}/`); }
      else result[key] = readFileSync(join(dir, entry.name)).toString('base64');
    }
  };
  walk(root);
  return result;
}

test('sync checks all conflicts before touching any target or creating backups', t => {
  const s = sandbox(t);
  mkdirSync(join(s.home, '.claude/skills/work'), { recursive: true });
  writeFileSync(join(s.home, '.claude/skills/work/SKILL.md'), 'manual role');
  const before = snapshot(s.root);
  for (const check of [false, true]) {
    assert.throws(() => sync({ ...s.options, check }), /not generated/);
    assert.deepEqual(snapshot(s.root), before);
  }
});

test('sync backs up the immediately previous bytes on every run, with unique ISO stamps', t => {
  const s = sandbox(t);
  sync(s.options);
  const file = join(s.home, '.codex/AGENTS.md');
  const first = readFileSync(file, 'utf8');
  writeFileSync(s.contractFile, note('second version'));
  const now = () => new Date('2026-01-01T00:00:00.000Z');
  sync({ ...s.options, now });
  const second = readFileSync(file, 'utf8');
  writeFileSync(s.contractFile, note('third version'));
  sync({ ...s.options, now });
  const backups = readdirSync(join(s.home, '.codex')).filter(n => n.startsWith('AGENTS.md.bak-relayrace-')).sort();
  assert.equal(backups.length, 2);
  for (const name of backups) assert.match(name, /\.bak-relayrace-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z$/);
  assert.deepEqual(backups.map(n => readFileSync(join(s.home, '.codex', n), 'utf8')), [first, second]);
});

test('a partial sync failure restores existing bytes and removes new files, temps and directories', t => {
  for (const failAt of [1, 3, 6]) {
    const s = sandbox(t);
    mkdirSync(join(s.home, '.claude'), { recursive: true });
    writeFileSync(join(s.home, '.claude/CLAUDE.md'), 'Keep exact CRLF\r\n');
    const before = snapshot(s.root);
    let attempts = 0;
    assert.throws(() => sync({ ...s.options, io: { rename: (from, to) => {
      assert.match(from, /\.tmp-relayrace-/);
      if (++attempts === failAt) throw new Error('injected replacement failure');
      renameSync(from, to);
    } } }), /injected replacement failure/);
    assert.deepEqual(snapshot(s.root), before, `failure at replacement ${failAt}`);
  }
});

test('a staging failure leaves no partial file, directory or backup behind', t => {
  const s = sandbox(t), before = snapshot(s.root);
  let attempts = 0;
  assert.throws(() => sync({ ...s.options, io: { write: (file, text, options) => {
    writeFileSync(file, text.slice(0, 5), options);
    if (++attempts === 2) throw Error('injected disk full');
  } } }), /injected disk full/);
  assert.deepEqual(snapshot(s.root), before);
});

test('sync uses the resolved Codex home for instructions and agents', async t => {
  const s = sandbox(t), codexHome = join(s.root, 'custom-codex');
  const files = plan({ ...s.options, codexHome });
  assert.ok(files.some(f => f.path === join(codexHome, 'AGENTS.md')));
  assert.ok(files.some(f => f.path === join(codexHome, 'agents/tester.toml')));
  assert.equal(files.some(f => f.path.startsWith(join(s.home, '.codex'))), false);
  const config = { values: { codexHome, contract: s.contractFile } };
  const lines = [];
  assert.equal(await runSync(['--check'], { ...s.options, config, log: line => lines.push(line) }), 1);
  assert.ok(lines.some(line => /coverage incomplete/.test(line)));
  assert.equal(existsSync(codexHome), false);
});

function sandbox(t, { body = '## Contrato\n\nResponde en español.', agents = { tester: agent('tester') } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kit-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const kitDir = join(root, 'kit');
  mkdirSync(join(kitDir, 'agents'), { recursive: true });
  mkdirSync(join(kitDir, 'skills', 'work'), { recursive: true });
  for (const [name, text] of Object.entries(agents)) writeFileSync(join(kitDir, 'agents', `${name}.md`), text);
  writeFileSync(join(kitDir, 'skills', 'work', 'SKILL.md'), '---\nname: work\ndescription: Generic work\n---\nSteps.\n');
  const contractFile = join(root, 'Contrato.md');
  writeFileSync(contractFile, note(body));
  const options = { home, kitDir, contractFile, agentDeskConfig: join(root, 'none.json'), log: () => {} };
  return { root, home, kitDir, contractFile, options };
}

test('the contract is only the text between the note markers', () => {
  assert.equal(extractContract(note('## Reglas\nUna.')), '## Reglas\nUna.');
  assert.throws(() => extractContract('# sin marcadores'), /contract:start/);
  assert.throws(() => extractContract(note('   ')), /contract:start/);
});

test('the managed block is appended once and then replaced in place, keeping the rest', () => {
  const first = upsertBlock('## CodeGraph\n\nUse it.\n', 'v1');
  assert.match(first, /^## CodeGraph\n\nUse it\.\n\n<!-- RELAYRACE_CONTRACT_START -->/);
  const second = upsertBlock(`${first}\n## Later section\n`, 'v2');
  assert.equal(second.split(BLOCK_START).length, 2);
  assert.match(second, /v2/);
  assert.doesNotMatch(second, /v1/);
  assert.match(second, /## Later section/);
  assert.throws(() => upsertBlock(`text ${BLOCK_END}`, 'x'), /only one contract marker/);
  assert.equal(upsertBlock('', 'x').startsWith(BLOCK_START), true);
});

test('a role becomes a Codex agent with the same text, read-only roles stay read-only', () => {
  const toml = toCodexToml(agent('reviewer', 'disallowedTools: Edit, Write, NotebookEdit\n'), 'reviewer');
  assert.match(toml, /^# GENERATED/);
  assert.match(toml, /name = "reviewer"/);
  assert.match(toml, /model_reasoning_effort = "high"/);
  assert.match(toml, /sandbox_mode = "read-only"/);
  assert.match(toml, /developer_instructions = """\nDo the reviewer work.\n"""/);
  assert.doesNotMatch(toCodexToml(agent('implementer'), 'implementer'), /sandbox_mode/);
  assert.throws(() => toCodexToml(agent('x').replace('Do the', 'Use C:\\path'), 'x'), /backslash/);
  assert.throws(() => toCodexToml(agent('x').replace('Do the', 'Say """'), 'x'), /"""/);
});

test('sync writes every target, is idempotent, and check reports drift', t => {
  const s = sandbox(t);
  mkdirSync(join(s.home, '.claude'), { recursive: true });
  writeFileSync(join(s.home, '.claude/CLAUDE.md'), '## CodeGraph\n\nKeep me.\n');
  const written = sync(s.options);
  assert.equal(written.length, 6);
  const claudeMd = readFileSync(join(s.home, '.claude/CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /Keep me\./);
  assert.match(claudeMd, /Responde en español\./);
  assert.equal(readdirSync(join(s.home, '.claude')).some(f => f.startsWith('CLAUDE.md.bak-relayrace-')), true);
  assert.match(readFileSync(join(s.home, '.codex/AGENTS.md'), 'utf8'), /Responde en español\./);
  assert.match(readFileSync(join(s.home, '.gemini/antigravity-cli/rules/relayrace-contract.md'), 'utf8'), /Responde en español\./);
  assert.ok(readFileSync(join(s.home, '.claude/agents/tester.md'), 'utf8').includes(GENERATED));
  assert.match(readFileSync(join(s.home, '.codex/agents/tester.toml'), 'utf8'), /name = "tester"/);
  assert.match(readFileSync(join(s.home, '.claude/skills/work/SKILL.md'), 'utf8'), /^---\nname: work/);
  assert.deepEqual(sync(s.options), []);
  assert.deepEqual(sync({ ...s.options, check: true }), []);
  writeFileSync(s.contractFile, note('## Contrato\n\nCambió.'));
  assert.equal(sync({ ...s.options, check: true }).length, 3);
  assert.doesNotMatch(readFileSync(join(s.home, '.codex/AGENTS.md'), 'utf8'), /Cambió/);
});

test('sync never overwrites a role, skill or rules file it did not generate', t => {
  const s = sandbox(t);
  mkdirSync(join(s.home, '.claude/agents'), { recursive: true });
  writeFileSync(join(s.home, '.claude/agents/tester.md'), '---\nname: tester\ndescription: mine\n---\nHand-written.\n');
  assert.throws(() => sync(s.options), /not generated by relayrace sync/);
  assert.equal(readFileSync(join(s.home, '.claude/agents/tester.md'), 'utf8').includes('Hand-written'), true);
});

test('roles must pin a real model: never inherit, never Fable', t => {
  for (const [model, error] of [['inherit', /never inherit/], ['fable', /Fable/], ['claude-fable-5-1', /Fable/]]) {
    const s = sandbox(t, { agents: { tester: agent('tester').replace('model: sonnet', `model: ${model}`) } });
    assert.throws(() => plan(s.options), error);
  }
  const unnamed = sandbox(t, { agents: { tester: agent('other') } });
  assert.throws(() => plan(unnamed.options), /match the file name/);
});

test('a contract that would push a known project past the Codex budget is refused', t => {
  const s = sandbox(t);
  const project = join(s.root, 'big-repo');
  mkdirSync(project);
  writeFileSync(join(project, 'AGENTS.md'), 'x'.repeat(CODEX_BUDGET - 100));
  const config = join(s.root, 'agent-desk.json');
  writeFileSync(config, JSON.stringify({ projects: [{ name: 'Big', path: project }] }));
  assert.throws(() => sync({ ...s.options, agentDeskConfig: config }), /shorten the contract/);
  assert.equal(existsSync(join(s.home, '.codex/AGENTS.md')), false);
});

test('the real kit sources plan cleanly and fit Codex next to the biggest project', t => {
  const root = mkdtempSync(join(tmpdir(), 'kit-real-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const files = plan({ home, kitDir: KIT_DIR, contractFile: CONTRACT_FILE });
  assert.ok(files.some(f => f.path.endsWith('reviewer.toml')));
  assert.ok(files.some(f => f.path.replaceAll('\\', '/').endsWith('skills/work/SKILL.md')));
  assert.deepEqual(sync({ home, check: true, log: () => {} }).length > 0, true);
});

test('files written by the kit\'s old home (IA local/kit) are still ours to replace', t => {
  const s = sandbox(t);
  mkdirSync(join(s.home, '.claude/agents'), { recursive: true });
  writeFileSync(join(s.home, '.claude/agents/tester.md'), `---\nname: tester\ndescription: old\n---\n<!-- ${LEGACY_GENERATED} — edit the source in the notes, not this copy -->\nOld text.\n`);
  sync(s.options);
  assert.match(readFileSync(join(s.home, '.claude/agents/tester.md'), 'utf8'), /Do the tester work\./);
  assert.equal(isGenerated('<!-- GENERATED by ai-kit sync — edit the source in the ai-kit repo -->'), true);
  assert.equal(isGenerated('<!-- GENERATED by some other tool -->'), false);
  assert.equal(isGenerated(`x ${GENERATED}`), false);
});

test('with no Agent Desk configured the Codex budget check just has nothing to measure', t => {
  const s = sandbox(t);
  assert.deepEqual(knownProjectSizes(undefined), []);
  assert.deepEqual(knownProjectSizes(join(s.root, 'missing.json')), []);
  assert.equal(sync({ ...s.options, agentDeskConfig: undefined, check: true }).length, 6);
});

test('runSync reads the contract override from config and exits 1 on drift', async t => {
  const s = sandbox(t);
  const config = { values: { agentDesk: undefined, contract: s.contractFile } };
  const options = { config, home: s.home, kitDir: s.kitDir, log: () => {} };
  await assert.rejects(runSync(['--force'], options), /unknown argument --force/);
  assert.equal(await runSync(['--check'], options), 1);
  assert.equal(await runSync(['--yes'], options), 0);
  assert.equal(await runSync(['--check'], options), 0);
});

test('sync previews before confirmation, declines safely and never prompts in non-interactive mode', async t => {
  const s = sandbox(t), lines = [], before = snapshot(s.root);
  const options = { ...s.options, config: { values: {} }, log: line => lines.push(line), interactive: true, prompt: async question => {
    assert.match(lines.at(-1), /^check:/);
    assert.equal(question, 'Apply these 6 changes? [y/N] ');
    return false;
  } };
  assert.equal(await runSync([], options), 1);
  assert.deepEqual(snapshot(s.root), before);
  const noPrompt = { ...options, prompt: () => assert.fail('unexpected prompt') };
  assert.equal(await runSync([], { ...noPrompt, interactive: false }), 1);
  assert.match(lines.at(-1), /Non-interactive.*--check/);
  assert.equal(await runSync(['--check', '--yes'], noPrompt), 1);
  assert.deepEqual(snapshot(s.root), before);
  assert.equal(await runSync([], { ...options, prompt: async () => true }), 0);
  assert.equal(await runSync([], noPrompt), 0);
});

test('sync --yes applies without a terminal and excludes preserved legacy files from its prompt count', async t => {
  const s = sandbox(t);
  const legacy = join(s.home, '.gemini/antigravity-cli/rules/isaac-contract.md');
  mkdirSync(join(legacy, '..'), { recursive: true });
  writeFileSync(legacy, 'manual rule');
  const options = { ...s.options, config: { values: {} }, interactive: true, prompt: async question => {
    assert.equal(question, 'Apply these 6 changes? [y/N] '); return false;
  } };
  assert.equal(await runSync([], options), 1);
  assert.equal(await runSync(['--yes'], { ...options, interactive: false, prompt: () => assert.fail('unexpected prompt') }), 0);
  assert.equal(readFileSync(legacy, 'utf8'), 'manual rule');
  assert.equal(await runSync([], { ...options, prompt: () => assert.fail('no applicable changes') }), 1);
});

test('sync migrates the owned legacy rule after writing its replacement, with a backup', t => {
  const s = sandbox(t);
  sync(s.options);
  const rules = join(s.home, '.gemini/antigravity-cli/rules');
  const legacy = join(rules, 'isaac-contract.md'), target = join(rules, 'relayrace-contract.md');
  const old = `<!-- ${GENERATED} -->\r\nPrevious contract.\r\n`;
  writeFileSync(legacy, old);
  rmSync(target);
  const before = snapshot(s.root);
  assert.deepEqual(sync({ ...s.options, check: true }), [target, legacy]);
  assert.deepEqual(snapshot(s.root), before);
  sync({ ...s.options, io: { rename: (from, to) => {
    if (from === legacy) assert.match(readFileSync(target, 'utf8'), /Responde en español/);
    renameSync(from, to);
  } } });
  assert.equal(existsSync(legacy), false);
  const backup = readdirSync(rules).find(n => n.startsWith('isaac-contract.md.bak-relayrace-'));
  assert.equal(readFileSync(join(rules, backup), 'utf8'), old);
  assert.deepEqual(sync({ ...s.options, check: true }), []);
});

test('unowned legacy rules are preserved and remain drift even after sync', t => {
  for (const text of ['My own rule.\n', `prefix <!-- ${GENERATED} -->\n`, `<!-- ${GENERATED} extra -->\n`]) {
    const s = sandbox(t);
    sync(s.options);
    const legacy = join(s.home, '.gemini/antigravity-cli/rules/isaac-contract.md');
    writeFileSync(legacy, text);
    const before = snapshot(s.root), lines = [];
    for (const check of [true, false, true]) {
      assert.deepEqual(sync({ ...s.options, check, log: line => lines.push(line) }), [legacy]);
      assert.deepEqual(snapshot(s.root), before);
    }
    assert.ok(lines.some(line => /preserved .*review and remove it manually/.test(line)));
  }
});

test('legacy migration rolls back failures before, during and after retirement', t => {
  for (const stage of ['write', 'retire', 'cleanup']) {
    const s = sandbox(t);
    sync(s.options);
    const rules = join(s.home, '.gemini/antigravity-cli/rules');
    const legacy = join(rules, 'isaac-contract.md'), target = join(rules, 'relayrace-contract.md');
    writeFileSync(legacy, `<!-- ${GENERATED} -->\nOld rule.\n`);
    rmSync(target);
    const before = snapshot(s.root);
    const fail = () => { throw new Error('injected migration failure'); };
    const io = stage === 'write' ? { write: fail } : stage === 'cleanup' ? { remove: fail } : {
      rename: (from, to) => { if (from === legacy) fail(); renameSync(from, to); },
    };
    assert.throws(() => sync({ ...s.options, io }), /injected migration failure/);
    assert.deepEqual(snapshot(s.root), before, stage);
  }
});

test('a conflicting new rule cannot retire the owned legacy rule', t => {
  const s = sandbox(t);
  const rules = join(s.home, '.gemini/antigravity-cli/rules');
  mkdirSync(rules, { recursive: true });
  writeFileSync(join(rules, 'isaac-contract.md'), `<!-- ${GENERATED} -->\nOld.\n`);
  writeFileSync(join(rules, 'relayrace-contract.md'), 'User rule.\n');
  const before = snapshot(s.root);
  for (const check of [true, false]) assert.throws(() => sync({ ...s.options, check }), /not generated/);
  assert.deepEqual(snapshot(s.root), before);
});

test('migration restores an existing replacement and all other updates if retirement fails', t => {
  for (const stage of ['retire', 'cleanup']) {
    const s = sandbox(t);
    sync(s.options);
    const rules = join(s.home, '.gemini/antigravity-cli/rules');
    const legacy = join(rules, 'isaac-contract.md'), target = join(rules, 'relayrace-contract.md');
    const oldTarget = readFileSync(target, 'utf8');
    const oldLegacy = `<!-- ${GENERATED} -->\r\nLegacy bytes.\r\n`;
    writeFileSync(legacy, oldLegacy);
    writeFileSync(s.contractFile, note('Replacement contract.'));
    const before = snapshot(s.root);
    const fail = () => { throw new Error('injected retirement failure'); };
    const io = stage === 'cleanup' ? { remove: fail } : {
      rename: (from, to) => {
        if (from === legacy) {
          assert.match(readFileSync(target, 'utf8'), /Replacement contract/);
          fail();
        }
        renameSync(from, to);
      },
    };
    assert.throws(() => sync({ ...s.options, io }), /injected retirement failure/);
    assert.deepEqual(snapshot(s.root), before, stage);
    // Recovery leaves a retryable migration with distinct backups of both rules.
    sync(s.options);
    assert.equal(existsSync(legacy), false);
    for (const [name, expected] of [['isaac-contract.md', oldLegacy], ['relayrace-contract.md', oldTarget]]) {
      const backups = readdirSync(rules).filter(file => file.startsWith(`${name}.bak-relayrace-`));
      assert.equal(backups.length, 1);
      assert.equal(readFileSync(join(rules, backups[0]), 'utf8'), expected);
    }
    assert.deepEqual(sync({ ...s.options, check: true }), []);
  }
});

test('a directory at the legacy rule path is preserved as unresolved drift', t => {
  const s = sandbox(t);
  sync(s.options);
  const legacy = join(s.home, '.gemini/antigravity-cli/rules/isaac-contract.md');
  mkdirSync(legacy);
  writeFileSync(join(legacy, 'keep.md'), `<!-- ${GENERATED} -->\nUser directory content.\n`);
  const before = snapshot(s.root);
  for (const check of [true, false, true]) {
    assert.deepEqual(sync({ ...s.options, check }), [legacy]);
    assert.deepEqual(snapshot(s.root), before);
  }
});

test('the default contract is the neutral one and works with the real sync plan', t => {
  const s = sandbox(t);
  assert.equal(CONTRACT_FILE, join(KIT_DIR, 'docs/contract.md'));
  const files = plan({ ...s.options, contractFile: CONTRACT_FILE });
  assert.match(files[0].content, /Shared working rules/);
  assert.doesNotMatch(extractContract(readFileSync(CONTRACT_FILE, 'utf8')), /Isaac|Cloudflare|C:\\/);
});

test('files written under the relaykit name are recognised as ours and rewritten as ordinary updates', t => {
  const s = sandbox(t);
  sync(s.options);
  // Rebuild what a relaykit-era sync left behind: the old header text, the old block markers, the old rule file.
  const swap = text => text.replaceAll(GENERATED, LEGACY_GENERATED_RELAYKIT)
    .replaceAll('RELAYRACE_CONTRACT_', 'RELAYKIT_CONTRACT_');
  for (const file of [join(s.home, '.claude/CLAUDE.md'), join(s.home, '.codex/AGENTS.md'), join(s.home, '.claude/agents/tester.md'),
    join(s.home, '.codex/agents/tester.toml'), join(s.home, '.claude/skills/work/SKILL.md'), join(s.home, '.gemini/antigravity-cli/rules/relayrace-contract.md')]) {
    writeFileSync(file, swap(readFileSync(file, 'utf8')));
  }
  const rules = join(s.home, '.gemini/antigravity-cli/rules');
  const oldRule = join(rules, 'relaykit-contract.md');
  renameSync(join(rules, 'relayrace-contract.md'), oldRule);
  assert.equal(isGenerated(readFileSync(oldRule, 'utf8')), true);
  assert.equal(isGenerated(readFileSync(join(s.home, '.codex/agents/tester.toml'), 'utf8')), true);
  // Everything is drift, nothing is a conflict, and a real sync converges.
  assert.ok(sync({ ...s.options, check: true }).includes(oldRule));
  sync(s.options);
  assert.equal(existsSync(oldRule), false, 'the generated relaykit rule file is retired');
  assert.ok(existsSync(join(rules, 'relayrace-contract.md')));
  const claude = readFileSync(join(s.home, '.claude/CLAUDE.md'), 'utf8');
  assert.ok(claude.includes(BLOCK_START) && !claude.includes('RELAYKIT_CONTRACT'));
  assert.equal(claude.includes(LEGACY_GENERATED_RELAYKIT), false);
  assert.deepEqual(sync({ ...s.options, check: true }), []);
});

test('a relaykit-named rule file we did not generate is preserved as unresolved drift', t => {
  const s = sandbox(t);
  sync(s.options);
  const legacy = join(s.home, '.gemini/antigravity-cli/rules/relaykit-contract.md');
  writeFileSync(legacy, 'My own rule.\n');
  const before = snapshot(s.root);
  for (const check of [true, false, true]) {
    assert.deepEqual(sync({ ...s.options, check }), [legacy]);
    assert.deepEqual(snapshot(s.root), before);
  }
});

test('every older generated header still counts as ours, in both comment styles', () => {
  const marks = [GENERATED, LEGACY_GENERATED_RELAYKIT, `${LEGACY_GENERATED_AI_KIT} — edit the source in the ai-kit repo`,
    `${LEGACY_GENERATED} — edit the source in the notes, not this copy`];
  for (const mark of marks) {
    assert.equal(isGenerated(`<!-- ${mark} -->\nbody\n`), true, mark);
    assert.equal(isGenerated(`# ${mark}\nname = "x"\n`), true, mark);
    assert.equal(isGenerated(`---\nname: x\n---\n<!-- ${mark} -->\nbody\n`), true, mark);
  }
  assert.equal(isGenerated(`Manual citation: ${LEGACY_GENERATED_RELAYKIT}`), false);
  assert.match(GENERATED, /^GENERATED by relayrace sync — edit the source in the Relayrace repo/);
});
