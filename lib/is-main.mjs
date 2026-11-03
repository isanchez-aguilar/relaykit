// Is this module the script node was started with?
//
// The check `import.meta.url === pathToFileURL(resolve(process.argv[1]))` is wrong
// whenever the path has a link in it: node resolves the main module to its real
// path, argv[1] keeps the link. On macOS the temp folder (/var -> /private/var)
// is such a link, so the script silently did nothing and exited 0. Resolve
// argv[1] the way node resolved the module.
//
// Dependency-free: Node 18+ built-ins only.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function isMain(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try { return moduleUrl === pathToFileURL(realpathSync(argv1)).href; } catch { return false; }
}
