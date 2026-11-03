# Changelog

All notable changes. Format based on [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## [0.1.0] - 2026-11-03

First public release.

### Added

- `relaykit doctor`, `init` (profiles `generic`, `web-app`, `notes`), `sync`, `update`, `providers`, `ci-local`, `relay`, `jules` and `qwen`.
- One-time setup scripts for Windows, macOS and Linux that install a launcher without administrator rights and ask before touching the user PATH.
- A providers file with plans, models, capabilities and priority order, a local editor (`providers ui`), and a relay that follows it per phase and never accepts a review from the implementer's model family.
- `init --update`: compares an installed repo with the kit and only replaces files that were never edited.
- `ci-local` and a pre-push hook: the repository's checks on this machine and, with Docker, in Linux containers.
- A neutral default contract.

### Security

- `init`, `init --update`, the relay and the Jules bridge never write through a symlink or junction that leaves the repository, create new files exclusively, replace files through unpredictable temporary names, and refuse a file that has a second hard link.
- `init` prints `deny` rules for secret files down to eight folders deep (and says when the scan stopped early), and the secret-file pattern is generic (`*secrets*.env`).
