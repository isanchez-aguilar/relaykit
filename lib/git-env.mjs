// Git exports repository-locating variables (GIT_DIR, GIT_WORK_TREE, ...) to
// hooks. A child that runs `git init` or any git command in ANOTHER folder
// would act on the hook's repository instead: a test that does `git init` in a
// temp folder once flipped a real checkout to core.bare=true that way. Every
// place that starts git, or a suite that does, uses an environment without them.

export const REPOSITORY_VARIABLES = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE', 'GIT_QUARANTINE_PATH', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
];

/** A copy of `env` without the variables that point git at a particular repository. Pure. */
export function cleanGitEnv(env = process.env) {
  const copy = { ...env };
  for (const name of REPOSITORY_VARIABLES) delete copy[name];
  return copy;
}
