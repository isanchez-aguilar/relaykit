// The `relayrace` command line: argument parsing and dispatch. bin/relayrace.mjs
// is a thin wrapper around main(). The old name `ai-kit` runs the same file.
//
// Dependency-free: Node 18+ built-ins only.

import { launch } from './exe.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, parseArgs as parseInitArgs } from '../install.mjs';
import { runSync } from '../sync.mjs';
import { childEnv, loadConfig } from './config.mjs';
import { formatDoctor, runDoctor } from './doctor.mjs';
import { PROFILE_NAMES } from './profiles.mjs';
import { PROVIDERS_USAGE, runProviders } from './providers-cli.mjs';
import { manageHook, parseCiArgs, runCiLocal } from './ci-local.mjs';
import { runUpdate } from './self-update.mjs';

export const KIT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The scripts the delegating subcommands hand the rest of the command line to. */
export const DELEGATES = {
  relay: 'relay.mjs',
  jules: 'jules-relay.mjs',
  qwen: 'qwen.mjs',
};

export const COMMANDS = ['doctor', 'init', 'sync', 'update', 'providers', 'ci-local', ...Object.keys(DELEGATES)];

export const USAGE = `Relayrace: make your AI coding agents work as one relay team.

Usage: relayrace <command> [options]

Commands:
  doctor              see what is ready (read-only). Example: relayrace doctor
  init [repo] [--profile ${PROFILE_NAMES.join('|')}]
                      set up a repo; never overwrites. Example: relayrace init .
                      Options: --name N, --check "cmd" (repeat), --jules owner/name:branch,
                      --claude-model M, --desk-path P, --qwen-allow "cmd", --dry-run, --verbose
  init --update [repo] [--apply]
                      compare an installed repo with the kit; --apply writes only the
                      missing files and the ones never edited since install
  sync                preview global updates, then ask to apply. Example: relayrace sync
                      --check: read-only; --yes: apply without asking
  update              update this checkout (git pull --ff-only)
  providers [list|init|pick|ui]
                      your providers, plans, models and the order to try them in;
                      "providers ui" edits them in a local page (providers --help)
  ci-local [--docker | --no-docker] [--no-checks] [--node 18,22]
                      run this repo's checks like CI: the checks in .ai/project.json here
                      (add --docker for Linux containers), or node --test here and in
                      Linux containers per Node version; says what it could not run
  ci-local --install-hook | --remove-hook
                      run it automatically before every git push of this repo
  relay <task.json>    hand work between providers when one runs out of quota
  jules <task.json>    one bounded Jules cloud task, then local review
  qwen [options]       delegate mechanical work to the local model (qwen --help)

Other: --help, --version.
Configuration: ~/.config/relayrace/config.json (Windows: %APPDATA%\\relayrace\\config.json),
overridden by RELAYRACE_* environment variables. Every path in it is optional.
The old relaykit and ai-kit folders and RELAYKIT_* / AI_KIT_* variables are still read.
`;

function version() {
  return JSON.parse(readFileSync(join(KIT_DIR, 'package.json'), 'utf8')).version;
}

/** Split argv into the subcommand and its arguments. Pure. */
export function parseCli(argv) {
  const [first, ...rest] = argv;
  if (first === undefined || first === '--help' || first === '-h' || first === 'help') return { command: 'help', args: rest };
  if (first === '--version' || first === '-v' || first === 'version') return { command: 'version', args: rest };
  if (!COMMANDS.includes(first)) throw new Error(`unknown command "${first}" (choose ${COMMANDS.join(', ')}; relayrace --help)`);
  return { command: first, args: rest };
}

/**
 * Run the CLI. Effects are injected so tests never spawn a real tool or touch
 * the machine's config. Returns the process exit code.
 */
export async function main(argv, {
  out = console.log, err = console.error, spawn = launch, kitDir = KIT_DIR, env = process.env,
  config, doctor = runDoctor, installer = install, syncer = runSync, updater = runUpdate, cwd = process.cwd(), providers = runProviders, ciLocal = runCiLocal,
} = {}) {
  let parsed;
  try { parsed = parseCli(argv); } catch (error) {
    err(`relayrace: ${error.message}`);
    return 2;
  }
  const { command, args } = parsed;
  if (command === 'help') { out(USAGE); return 0; }
  if (command === 'version') { out(version()); return 0; }
  try {
    const resolved = config ?? loadConfig({ env });
    if (command !== 'doctor') for (const note of resolved.notes ?? []) err(`relayrace: note: ${note}`);
    if (command === 'init') {
      installer(parseInitArgs(args), { log: out, agentDeskConfig: resolved.values.agentDesk, kitDir });
      return 0;
    }
    if (command === 'sync') return await syncer(args, { config: resolved, log: out, kitDir });
    if (command === 'update') return await updater(args, { kitDir, log: out });
    if (command === 'doctor') {
      const unknown = args.filter(a => a !== '--json');
      if (unknown.length) throw new Error(`unknown argument ${unknown[0]} (usage: doctor [--json])`);
      const report = await doctor({ cwd, config: resolved, kitDir, env });
      if (args.includes('--json')) out(JSON.stringify(report, null, 2));
      else for (const line of formatDoctor(report)) out(line);
      return report.critical ? 1 : 0;
    }
    if (command === 'ci-local') {
      const options = parseCiArgs(args);
      if (options.hook) return manageHook(options.hook, { cwd, cli: join(kitDir, 'bin', 'relayrace.mjs'), log: out });
      return ciLocal(options, { cwd, log: out }).code;
    }
    if (command === 'providers') {
      if (args.includes('--help') || args.includes('-h')) { out(PROVIDERS_USAGE); return 0; }
      return await providers(args, { cwd, env, out });
    }
    // relay, jules, qwen: the kit's own scripts, run in the caller's folder.
    const result = spawn(process.execPath, [join(kitDir, DELEGATES[command]), ...args], {
      cwd, env: childEnv(resolved, env), stdio: 'inherit',
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } catch (error) {
    err(`relayrace ${command}: ${error.message}`);
    return 2;
  }
}
