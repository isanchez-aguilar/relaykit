import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launch } from './exe.mjs';
import { cleanGitEnv } from './git-env.mjs';

/** Update this checkout, never the repository in the caller's current folder. */
export function runUpdate(args, { kitDir, log = console.log, run = launch, exists = existsSync, realpath = realpathSync.native } = {}) {
  if (args.length) throw new Error('usage: relayrace update');
  if (!exists(join(kitDir, '.git'))) throw new Error('This installation is not a git checkout; clone Relayrace and run its setup script.');
  const git = (...argv) => {
    // A prompt for credentials cannot be answered here, and a stalled network must not hang the command.
    const result = run('git', ['-C', kitDir, ...argv], { encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...cleanGitEnv(), GIT_TERMINAL_PROMPT: '0' } });
    if (result.error || result.status !== 0) throw new Error(`git ${argv[0]} failed; check Git, repository access and upstream configuration.`);
    return String(result.stdout || '').trim();
  };
  if (realpath(resolve(git('rev-parse', '--show-toplevel'))) !== realpath(resolve(kitDir))) {
    throw new Error('This installation is not the root of a Relayrace git checkout.');
  }
  if (git('status', '--porcelain', '--untracked-files=normal')) throw new Error('The Relayrace checkout has local changes; commit or stash them before relayrace update.');
  try { git('symbolic-ref', '-q', 'HEAD'); } catch {
    throw new Error('The Relayrace checkout is on a detached HEAD; switch to a branch that tracks its remote before relayrace update.');
  }
  const before = git('rev-parse', 'HEAD');
  git('pull', '--ff-only');
  const changed = before !== git('rev-parse', 'HEAD');
  log(changed ? 'Relayrace updated. Run `relayrace sync` to preview and apply the updated global files.' : 'Relayrace is already up to date. No update requires another `relayrace sync`.');
  return 0;
}
