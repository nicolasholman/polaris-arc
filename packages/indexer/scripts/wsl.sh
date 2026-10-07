#!/usr/bin/env bash
# Run an indexer command on Linux: in WSL from Windows, or in Linux CI.
#
#   bash scripts/wsl.sh setup        # install (standalone, not the workspace) + envio codegen
#   bash scripts/wsl.sh test         # generate --check, codegen, typecheck, vitest
#   bash scripts/wsl.sh live         # a local chain indexed end to end over RPC (scripts/live.sh)
#   bash scripts/wsl.sh local        # GraphQL for a running local chain: Postgres + Hasura in Docker, envio start (scripts/local.sh)
#   bash scripts/wsl.sh <pnpm args>  # anything else, e.g. `dev` (needs Docker) or `codegen`
#
# From Windows:  wsl -d <distro> -- bash packages/indexer/scripts/wsl.sh test
#
# The `envio` CLI has no Windows build, and a Windows `pnpm install` would
# skip its Linux binary, so this package is installed from Linux with its own
# lockfile (`--ignore-workspace`). WSL appends the Windows PATH, whose `node`
# and `pnpm` shims must not win: Linux entries go first.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Under WSL, the Windows drives (/mnt/c, /mnt/e) are slow enough that an
# install takes many minutes. Work in a copy on the Linux filesystem instead:
# this package plus the contract ABIs and deployment records it reads. Set
# POLARIS_INDEXER_IN_PLACE=1 to work where the files are.
if [[ "$PWD" == /mnt/* ]] && [ -z "${POLARIS_INDEXER_IN_PLACE:-}" ] && command -v rsync >/dev/null 2>&1; then
  SOURCE="$PWD"
  MIRROR="${POLARIS_INDEXER_MIRROR:-$HOME/.cache/polaris-indexer}"
  mkdir -p "$MIRROR/packages/contracts/abi" "$MIRROR/packages/contracts/deployments"
  rsync -a --delete --exclude node_modules --exclude .envio --exclude envio-env.d.ts "$SOURCE/" "$MIRROR/packages/indexer/"
  rsync -a --delete "$SOURCE/../contracts/abi/" "$MIRROR/packages/contracts/abi/"
  rsync -a --delete "$SOURCE/../contracts/deployments/" "$MIRROR/packages/contracts/deployments/"
  echo "Working in $MIRROR (a copy on the Linux filesystem; POLARIS_INDEXER_IN_PLACE=1 to work in place)." >&2
  cd "$MIRROR/packages/indexer"
fi

PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '^/mnt/' | paste -sd: -)"
for dir in "$HOME/.local/opt/node22/bin" "$HOME/.local/share/pnpm"; do
  [ -d "$dir" ] && PATH="$dir:$PATH"
done
export PATH

if ! command -v node >/dev/null 2>&1; then
  echo "No Linux Node.js on PATH. Install Node 22+ inside this distro (see README)." >&2
  exit 1
fi
major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 22 ]; then
  echo "Node $(node -v) is too old; envio needs 22+." >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "No pnpm on PATH: npm install -g pnpm@10" >&2
  exit 1
fi

install() {
  pnpm install --ignore-workspace --config.confirmModulesPurge=false "$@"
}

case "${1:-}" in
  setup)
    shift
    install "$@"
    pnpm codegen
    ;;
  test)
    shift
    [ -d node_modules/envio ] || install --frozen-lockfile
    node scripts/generate.mjs --check
    pnpm codegen
    pnpm typecheck
    pnpm exec vitest run --test-timeout=60000 "$@"
    ;;
  live)
    shift
    exec bash scripts/live.sh "$@"
    ;;
  local)
    shift
    exec bash scripts/local.sh "$@"
    ;;
  "")
    echo "usage: bash scripts/wsl.sh setup | test | live | local | <pnpm args>" >&2
    exit 2
    ;;
  *)
    pnpm "$@"
    ;;
esac
