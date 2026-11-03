# Contributing

Thanks for helping.

- **DCO sign-off:** by contributing, you certify the [Developer Certificate of Origin](https://developercertificate.org/). Sign off each commit with `git commit -s`, which adds a `Signed-off-by: Name <email>` line.
- **License:** code contributions are accepted under Apache-2.0. Contributions to the templates (`agents/`, `skills/`, `templates/`, `prompts/`, `docs/playbooks/`) and to `qwen.mjs` with its installed helpers are accepted under MIT, as described in [README.md](README.md#licensing).
- **Branching:** work on a branch and open a PR to `main`.
- **Tests:** a change comes with its tests (`node --test`), and the suite stays green on Windows, macOS and Linux.
- **No dependencies:** Node 18+ built-ins only.
- **No secrets, no third-party code:** no API keys, tokens or code from other projects. Fixtures must be synthetic.

## Releasing (maintainers)

1. Update `CHANGELOG.md` and bump `version` in `package.json`.
2. Merge to `main` with CI green on all three systems.
3. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`. The `release` workflow checks the tag against `package.json`, runs the suite, publishes to npm with provenance (it needs the `NPM_TOKEN` secret; it skips the step when that version is already on npm, as after a manual first publish) and creates the GitHub release.
