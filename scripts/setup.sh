#!/bin/sh
# Bootstrap without assuming that a version manager has initialized PATH.
set -eu
case "${1-}" in ''|--yes) ;; *) echo 'Usage: setup.sh [--yes]' >&2; exit 1 ;; esac
if [ "$#" -gt 1 ]; then echo 'Usage: setup.sh [--yes]' >&2; exit 1; fi
setup_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
relaykit_node=''
try_node() {
  [ -n "$1" ] && [ -x "$1" ] || return 0
  if "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' >/dev/null 2>&1; then
    relaykit_node=$1
  fi
}
try_node "$(command -v node || true)"
if [ -z "$relaykit_node" ]; then
  for candidate in "${VOLTA_HOME:-$HOME/.volta}/bin/node" \
    "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/node \
    "${FNM_DIR:-$HOME/.local/share/fnm}"/node-versions/*/installation/bin/node \
    "$HOME/Library/Application Support/fnm"/node-versions/*/installation/bin/node \
    "$HOME/.fnm"/node-versions/*/installation/bin/node \
    "${XDG_DATA_HOME:-$HOME/.local/share}/fnm"/node-versions/*/installation/bin/node \
    /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
    try_node "$candidate"
    [ -z "$relaykit_node" ] || break
  done
fi
if [ -z "$relaykit_node" ]; then
  echo 'Node 18+ not found. Install Node from https://nodejs.org/ and run setup again.' >&2
  exit 1
fi
# command -v may return a relative PATH entry; persist an absolute executable.
relaykit_node=$(CDPATH= cd -- "$(dirname -- "$relaykit_node")" && pwd)/$(basename -- "$relaykit_node")
exec "$relaykit_node" "$setup_dir/../lib/setup.mjs" "$@"
