// Finding and running the agent CLIs on any machine. Windows installs some of
// them outside PATH (the native Claude, Antigravity and Codex installers), and
// npm-installed ones are `.cmd` shims that only a shell can start; macOS and
// Linux just use PATH.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';

/** Where a CLI's own installer puts it on Windows, or null (use PATH). */
export function knownLocation(name, { env = process.env, platform = process.platform, home = homedir() } = {}) {
  const local = env.LOCALAPPDATA;
  if (platform !== 'win32') return null;
  if (name === 'claude' && platform === 'win32') return join(home, '.local/bin/claude.exe');
  if (name === 'agy' && local) return join(local, 'agy/bin/agy.exe');
  if (name === 'codex' && local) return join(local, 'Programs/OpenAI/Codex/bin/codex.exe');
  return null;
}

/** The executable to run for `name`: an override, an installer location that exists, or the bare name. */
export function findExecutable(name, override, { exists = existsSync, env = process.env, platform = process.platform, cwd = process.cwd(), ...rest } = {}) {
  if (override) return override;
  const candidate = knownLocation(name, { ...rest, env, platform });
  if (candidate && exists(candidate)) return candidate;
  if (platform !== 'win32') return name;
  const path = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
  const directories = /[\\/]/.test(name) ? [''] : path.split(';').filter(Boolean);
  for (const directory of directories) {
    for (const suffix of extname(name) ? [''] : ['.exe', '.com', '.cmd', '.bat']) {
      const file = resolve(cwd, directory.replace(/^"|"$/g, ''), name + suffix);
      if (exists(file)) return file;
    }
  }
  return name;
}

const cmdMeta = /([()\][%!^"`<>&|;, *?])/g;

/** Quote for the native argv parser, then escape both cmd and the shim's %*. */
export function quoteCmdArgument(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('cmd arguments cannot contain line breaks or NUL; pass text on stdin or in a file.');
  const quoted = `"${String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  return quoted.replace(cmdMeta, '^$1').replace(cmdMeta, '^$1');
}

/** An environment variable by name, whatever its capitalisation (Windows keeps the case it was given). Pure. */
export function envValue(env, name) {
  const key = Object.keys(env).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

/**
 * The command interpreter for .cmd and .bat shims: ComSpec in any capitalisation, else cmd.exe by its
 * absolute path. A bare 'cmd.exe' is looked up on the PATH of the child, which may not contain System32.
 */
export function commandInterpreter(env) {
  return envValue(env, 'ComSpec') || (envValue(env, 'SystemRoot') || 'C:/Windows') + '/System32/cmd.exe';
}

/** All process launchers share this path. Prompt content belongs in options.input or a file. */
export function launch(exe, args, { run = spawnSync, platform = process.platform, ...options } = {}) {
  const env = options.env ?? process.env;
  const found = findExecutable(exe, undefined, { env, platform, cwd: options.cwd });
  const settings = { encoding: 'utf8', windowsHide: true, ...options, shell: false };
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(found)) {
    if (/[\r\n\0]/.test(found)) throw new Error('Invalid shim path.');
    const command = `"${found}"`.replace(cmdMeta, '^$1');
    const line = `"${[command, ...args.map(quoteCmdArgument)].join(' ')}"`;
    return run(commandInterpreter(env), ['/d', '/s', '/v:off', '/c', line], { ...settings, windowsVerbatimArguments: true });
  }
  return run(found, args, settings);
}

export function runTool(exe, args, { timeout = 15000, ...options } = {}) {
  const result = launch(exe, args, { timeout, ...options });
  return {
    status: result.status ?? (result.error ? 127 : 1),
    stdout: String(result.stdout || ''),
    timedOut: result.error?.code === 'ETIMEDOUT',
    missing: result.error?.code === 'ENOENT',
  };
}
