import { readFileSync, realpathSync, statSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { inside } from './guardrails.mjs';

export const DEFAULT_DOC_MAX_BYTES = 32768;

/** Only absence is safe to ignore; permissions and broken links are unknown coverage. */
function optionalRead(file) {
  try { return readFileSync(file, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { lstatSync(file); } catch (statError) { if (statError.code === 'ENOENT') return undefined; throw statError; }
    throw error; // A dangling link exists but cannot be evaluated.
  }
}

export function effectiveInstructions(directory) {
  for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
    const text = optionalRead(join(directory, name));
    if (text?.trim()) return { path: join(directory, name), text };
  }
  return { text: '' };
}

/** Conservative, deliberately limited TOML reader; unsupported configuration is reported. */
export function configuredDocBudget(codexHome) {
  const incomplete = [];
  let limit = DEFAULT_DOC_MAX_BYTES;
  try {
    const text = optionalRead(join(codexHome, 'config.toml')) ?? '';
    let inTable = false, found = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      if (/^\s*\[/.test(line)) inTable = true;
      if (/project_doc_max_bytes/.test(line)) {
        const match = line.match(/^\s*(?:project_doc_max_bytes|"project_doc_max_bytes"|'project_doc_max_bytes')\s*=\s*(\d[\d_]*)\s*(?:#.*)?$/);
        if (inTable || found || !match || !Number.isSafeInteger(Number(match[1].replaceAll('_', '')))) {
          incomplete.push('project_doc_max_bytes configuration cannot be fully evaluated');
        } else { limit = Number(match[1].replaceAll('_', '')); found = true; }
      }
      // Recognize quoted keys as well as dotted/table/inline forms. We cannot
      // evaluate custom discovery with this reader, so never silently omit it.
      if (/\b(?:project_doc_fallback_filenames|project_root_markers|profiles?|model_instructions_file)\b/.test(line)) {
        incomplete.push('custom instruction discovery or profile configuration is not evaluated');
      }
      // A key written with an escape ("project_doc_max_bytes") can name any
      // of the keys above without matching them literally. This reader does not
      // decode escapes, so a quoted key that contains one is reported, not skipped.
      if (/^\s*"[^"\n]*\\[^"\n]*"\s*=/.test(line)) {
        incomplete.push('a configuration key uses an escape sequence and cannot be evaluated');
      }
    }
  } catch { incomplete.push('Codex config.toml is unreadable'); }
  return { limit, incomplete };
}

/** Git worktrees use a .git file; both files and directories mark a root. */
function projectRoot(cwd) {
  for (let directory = cwd; ; directory = dirname(directory)) {
    try {
      const marker = statSync(join(directory, '.git'));
      if (marker.isDirectory() || marker.isFile()) return directory;
      throw Error('invalid Git marker');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A dangling marker is not proof that this directory has no root.
      try { lstatSync(join(directory, '.git')); throw Error('broken Git marker'); }
      catch (linkError) { if (linkError.code !== 'ENOENT') throw linkError; }
    }
    if (dirname(directory) === directory) return undefined;
  }
}

export function measureProjects(agentDeskConfig, { cwd } = {}) {
  const sizes = [], incomplete = [], files = [];
  let projects = [];
  if (agentDeskConfig) {
    try {
      const data = JSON.parse(readFileSync(agentDeskConfig, 'utf8'));
      if (!Array.isArray(data.projects)) throw Error('projects');
      projects = data.projects;
    } catch { incomplete.push('Agent Desk project paths could not be evaluated'); }
  } else incomplete.push('no project registry configured');
  const registered = cwd && projects.find(p => typeof p?.path === 'string' && inside(resolve(p.path), resolve(cwd)));
  if (typeof registered?.cwd === 'string' && registered.cwd && resolve(registered.path, registered.cwd) !== resolve(cwd)) {
    projects = [...projects, { path: registered.path, cwd }];
  }
  if (cwd && !projects.some(p => typeof p?.path === 'string' && inside(resolve(p.path), resolve(cwd)))) {
    projects.push({ path: resolve(cwd), cwd: resolve(cwd) });
  }
  for (const project of projects) {
    try {
      if (typeof project.path !== 'string' || !project.path.trim()) throw Error('path');
      const registeredPath = realpathSync(resolve(project.path));
      if (!statSync(registeredPath).isDirectory()) throw Error('directory');
      let realCwd = cwd && resolve(cwd);
      try { if (realCwd) realCwd = realpathSync(realCwd); } catch { /* keep the given path */ }
      const knownCwd = project.cwd ?? (cwd && inside(registeredPath, realCwd) ? cwd : undefined);
      if (!knownCwd) incomplete.push(`nested working directory unknown for ${registeredPath}`);
      const end = knownCwd ? realpathSync(resolve(registeredPath, knownCwd)) : registeredPath;
      if (!inside(registeredPath, end) || !statSync(end).isDirectory()) throw Error('cwd');
      const discoveredRoot = projectRoot(end);
      if (!discoveredRoot) incomplete.push(`project root is unknown for ${end}`);
      const root = discoveredRoot ?? registeredPath;
      const directories = [end];
      while (directories[0] !== root) directories.unshift(dirname(directories[0]));
      let bytes = 0;
      for (const directory of directories) {
        const instruction = effectiveInstructions(directory);
        bytes += Buffer.byteLength(instruction.text);
        if (instruction.path) files.push(instruction.path);
        try {
          if (optionalRead(join(directory, '.codex/config.toml')) !== undefined) incomplete.push(`project-local Codex configuration is not evaluated: ${directory}`);
        } catch { incomplete.push(`project-local Codex configuration is unreadable: ${directory}`); }
      }
      sizes.push(bytes);
    } catch { incomplete.push('a registered project or working directory could not be evaluated'); }
  }
  return { sizes, files, incomplete };
}
