// The starter sets `relayrace init --profile <name>` installs. A profile is a
// list of files to put in a repo, built from the kit's own sources:
//
//   generic   the six generic roles, work / bugfix / cross-review, the review prompt,
//             an AGENTS.md template and a printed opencode.json proposal (manual application)
//   web-app   the six-role pipeline (program-manager, architect, ui-designer, developer,
//             qa, docs-writer), feature / fix / qwen / redesign-module / release-local /
//             cross-review, scripts/qwen.mjs, and an AGENTS.md with a «Project rules» section
//   notes     the writer role only, for an Obsidian or Markdown folder
//
// Files are copied as they are: no per-file license header. The notice for the
// copied templates is LICENSE-TEMPLATES in the Relayrace repo.

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const PROFILE_NAMES = ['generic', 'web-app', 'notes'];

export const PROFILES = {
  generic: {
    about: 'the six generic roles, work/bugfix/cross-review skills, review prompt, AGENTS.md template',
    template: 'generic',
    agents: ['agents/designer.md', 'agents/implementer.md', 'agents/planner.md', 'agents/reviewer.md', 'agents/tester.md', 'agents/writer.md'],
    skills: ['skills/bugfix', 'skills/cross-review', 'skills/work'],
    scripts: [],
    opencode: true,
  },
  'web-app': {
    about: 'the six-role pipeline, feature/fix/qwen/redesign/release skills, scripts/qwen.mjs, AGENTS.md with Project rules',
    template: 'web-app',
    agents: ['architect', 'developer', 'docs-writer', 'program-manager', 'qa', 'ui-designer'].map(n => `templates/web-app/agents/${n}.md`),
    skills: ['templates/web-app/skills/feature', 'templates/web-app/skills/fix', 'templates/web-app/skills/qwen',
      'templates/web-app/skills/redesign-module', 'templates/web-app/skills/release-local', 'skills/cross-review'],
    scripts: [{ from: 'qwen.mjs', to: 'scripts/qwen.mjs' },
      ...['exe', 'guardrails'].map(name => ({ from: `lib/${name}.mjs`, to: `scripts/lib/${name}.mjs` }))],
    opencode: true,
  },
  notes: {
    about: 'the writer role only, for a notes folder',
    template: 'notes',
    agents: ['agents/writer.md'],
    skills: [],
    scripts: [],
    opencode: false,
  },
};

const lf = text => text.replace(/\r\n/g, '\n');

/** The AGENTS.md for a profile: the template with the repo's name and scripts filled in. Pure given the kit. */
export function renderAgents(kitDir, template, name, scripts) {
  const commands = Object.entries(scripts || {}).map(([k, v]) => `- \`${k}\` — \`${v}\``).join('\n') || '- (no package.json scripts found)';
  return lf(readFileSync(join(kitDir, 'templates', template, 'AGENTS.md'), 'utf8'))
    .replaceAll('{{name}}', name)
    .replaceAll('{{commands}}', commands);
}

export const CLAUDE_POINTER = '@AGENTS.md\n';
export const GEMINI_POINTER = '# Antigravity\n\nRead AGENTS.md before acting; review requests are read-only and follow .ai/prompts/review.md.\n';

/**
 * Every file a profile installs, as { path, content, kind }. `path` is relative
 * to the repo with forward slashes. The caller builds `.ai/project.json` and
 * prints the `opencode.json` proposal; permission files are never installed.
 */
export function profileFiles(profileName, { kitDir, name, scripts }) {
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`unknown profile "${profileName}" (choose ${PROFILE_NAMES.join(', ')})`);
  const read = path => lf(readFileSync(join(kitDir, path), 'utf8'));
  const files = [];
  files.push({ path: '.ai/prompts/review.md', content: read('prompts/review.md'), kind: 'prompt' });
  files.push({ path: 'AGENTS.md', content: renderAgents(kitDir, profile.template, name, scripts), kind: 'rules' });
  files.push({ path: 'CLAUDE.md', content: CLAUDE_POINTER, kind: 'pointer' });
  files.push({ path: 'GEMINI.md', content: GEMINI_POINTER, kind: 'pointer' });
  for (const source of profile.agents) files.push({ path: `.claude/agents/${basename(source)}`, content: read(source), kind: 'agent' });
  for (const source of profile.skills) files.push({ path: `.claude/skills/${basename(source)}/SKILL.md`, content: read(`${source}/SKILL.md`), kind: 'skill' });
  for (const script of profile.scripts) files.push({ path: script.to, content: read(script.from), kind: 'script' });
  return files;
}
