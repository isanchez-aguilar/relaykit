// `relaykit providers`: list the order, create the file, ask who takes a task,
// or open the local editor. Effects are injected so tests touch no real machine.

import { existsSync } from 'node:fs';
import { CAPABILITIES, DEFAULT_PROVIDERS, FAMILIES, formatProviders, loadProviders, loadUserProviders, pick, providersFilePath, repoProvidersPath, saveProviders } from './providers.mjs';
import { createProvidersUi } from './providers-ui.mjs';

export const PROVIDERS_USAGE = `Usage: relaykit providers [list] [--json]
       relaykit providers init                      write the default order to your providers file (never overwrites)
       relaykit providers pick <capability> [--exclude-family F]... [--extreme] [--json]
                                                    who takes this task (${CAPABILITIES.join(', ')})
       relaykit providers ui [--port N]             edit providers, plans, models and order in a local page`;

export function parseProvidersArgs(args) {
  const [first, ...rest] = args;
  const action = first === undefined || first.startsWith('--') ? 'list' : first;
  const flags = first === undefined || first.startsWith('--') ? args : rest;
  if (!['list', 'init', 'pick', 'ui'].includes(action)) throw new Error(`unknown action "${action}"\n${PROVIDERS_USAGE}`);
  const parsed = { action, json: false, extreme: false, excludeFamilies: [], capability: undefined, port: 4319 };
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (flag === '--json') parsed.json = true;
    else if (flag === '--extreme') parsed.extreme = true;
    else if (flag === '--exclude-family') {
      const value = flags[++index];
      if (!FAMILIES.includes(value)) throw new Error(`--exclude-family needs one of ${FAMILIES.join(', ')}`);
      parsed.excludeFamilies.push(value);
    } else if (flag === '--port') {
      const value = Number(flags[++index]);
      if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error('--port needs a number from 1024 to 65535');
      parsed.port = value;
    } else if (action === 'pick' && !flag.startsWith('--') && parsed.capability === undefined) parsed.capability = flag;
    else throw new Error(`unknown argument ${flag}\n${PROVIDERS_USAGE}`);
  }
  if (action === 'pick' && !CAPABILITIES.includes(parsed.capability)) throw new Error(`pick needs a capability: ${CAPABILITIES.join(', ')}`);
  return parsed;
}

/** Runs the subcommand and returns an exit code. `ui` resolves once the server listens. */
export async function runProviders(args, { cwd = process.cwd(), env = process.env, out = console.log, ...paths } = {}) {
  const options = parseProvidersArgs(args);
  const loadOptions = { cwd, env, ...paths };
  if (options.action === 'init') {
    const file = providersFilePath({ env, ...paths });
    if (existsSync(file)) { out(`kept     ${file} (exists; edit it or use \`relaykit providers ui\`)`); return 0; }
    saveProviders(file, DEFAULT_PROVIDERS);
    out(`created  ${file}`);
    return 0;
  }
  const loaded = loadProviders(loadOptions);
  if (options.action === 'list') {
    if (options.json) out(JSON.stringify(loaded, null, 2)); else for (const line of formatProviders(loaded)) out(line);
    return 0;
  }
  if (options.action === 'pick') {
    const result = pick(loaded.providers, options);
    if (options.json) out(JSON.stringify(result ? { id: result.provider.id, family: result.provider.family, model: result.model?.id ?? null, skipped: result.skipped } : null));
    else if (result) out(`${result.provider.id}${result.model ? ` ${result.model.id}` : ''}`);
    else out('none: no enabled provider can do this task; stop and ask the owner');
    return result ? 0 : 1;
  }
  // The editor works on the personal file only; a repo override is shown as a notice, never overwritten.
  const repoFile = repoProvidersPath(cwd);
  const ui = createProvidersUi({
    load: () => ({ ...loadUserProviders({ env, ...paths }), repoOverride: existsSync(repoFile) ? repoFile : null }),
    file: providersFilePath({ env, ...paths }),
    port: options.port,
  });
  await new Promise((resolve, reject) => {
    ui.server.once('error', reject);
    ui.server.listen(options.port, '127.0.0.1', resolve);
  });
  out(`Providers editor: ${ui.origin}   (Ctrl+C to stop)`);
  return 0;
}
