import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export const QWEN_GIT_READS = ['git status', 'git diff', 'git diff --stat', 'git log --oneline -20'];
export const DENIED_TOOLS = ['question', 'task', 'skill', 'doom_loop', 'webfetch', 'websearch', 'external_directory'];

export function validateCommands(commands, label = 'checks') {
  if (!Array.isArray(commands) || commands.some(c => typeof c !== 'string' || !c.trim() || /[\x00-\x1f;&|<>`$()*?\[\]{}%!^]/.test(c))) {
    throw new Error(`${label} must be plain commands (plain exact commands), without shell operators, wildcards or control characters.`);
  }
  return commands;
}

export function opencodeConfig(allowed) {
  validateCommands(allowed);
  return { $schema: 'https://opencode.ai/config.json', share: 'disabled', permission: {
    ...Object.fromEntries(DENIED_TOOLS.map(tool => [tool, 'deny'])),
    bash: { '*': 'deny', ...Object.fromEntries([...QWEN_GIT_READS, ...allowed].map(c => [c, 'allow'])) },
  } };
}

export function validGuardrails(config, allowed = []) {
  try {
    validateCommands(allowed);
    const permission = config?.permission;
    if (config?.agent || config?.mode || config?.mcp || config?.plugin || config?.tools) return false;
    if (!permission || config.share !== 'disabled' || DENIED_TOOLS.some(tool => permission[tool] !== 'deny')) return false;
    const bash = permission.bash;
    if (!bash || typeof bash !== 'object' || Array.isArray(bash) || bash['*'] !== 'deny') return false;
    const expected = new Set([...QWEN_GIT_READS, ...allowed]);
    // Additional grants or permission objects could override the restrictions.
    if (Object.entries(permission).some(([key, value]) => key !== 'bash' && !DENIED_TOOLS.includes(key) && value !== 'deny')) return false;
    return Object.entries(bash).every(([command, value]) => command === '*' ? value === 'deny' :
      value === 'deny' || (value === 'allow' && expected.has(command)));
  } catch { return false; }
}

export function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel);
}

const sensitive = path => path.split(/[\\/]/).some(part => /^(?:\.env|\.dev\.vars)|\.(?:pem|key)$|secrets?.*[.]env$/i.test(part));

/** Validate both the spelled and resolved path before a caller reads any bytes. */
export function taskPath(root, task, realpath = realpathSync) {
  const candidate = resolve(root, task);
  const forbidden = path => sensitive(path) || (process.platform === 'win32' && /:/.test(path.replace(/^[A-Za-z]:/, '')));
  if (!inside(resolve(root), candidate) || forbidden(candidate)) throw new Error('Task path is outside the repo or names a secret file.');
  const actualRoot = realpath(root), actual = realpath(candidate);
  if (!inside(actualRoot, actual) || forbidden(actual)) throw new Error('Task path resolves outside the repo or to a secret file.');
  return actual;
}
