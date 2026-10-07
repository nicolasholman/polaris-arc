#!/usr/bin/env bash
# The indexer end to end on a live local chain, with no Docker and no token:
#
#   1. a Hardhat node on 127.0.0.1:3541 (POLARIS_FIXTURE_PORT), the contracts
#      deployed with the testnet script, the contracts' end-to-end flows and
#      scripts/fixture-scenarios.cjs run on it (scripts/record-fixture.mjs);
#   2. config.yaml regenerated for that chain (RPC, not HyperSync) in a
#      scratch copy of this package, so the committed files are untouched;
#   3. Envio's own runtime indexes the chain over RPC (test/live.test.ts), and
#      the indexed state must equal what the contracts report.
#
#   bash scripts/wsl.sh live        (Linux or WSL; needs packages/contracts installed on Linux)
#
# POLARIS_LIVE_RUNS=N indexes the same chain N times (default 1). Envio fetches
# each contract's events concurrently and their answers arrive in a different
# order every run, so an ordering bug shows up only now and then: CI runs it
# several times.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="$(cd "$HERE/../contracts" && pwd)"
PORT="${POLARIS_FIXTURE_PORT:-3541}"
export POLARIS_FIXTURE_PORT="$PORT"

if [ ! -d "$CONTRACTS/node_modules/hardhat" ]; then
  echo "packages/contracts is not installed. From the repo root (on Linux): pnpm install" >&2
  exit 1
fi
[ -d "$HERE/node_modules/envio" ] || (cd "$HERE" && pnpm install --ignore-workspace --frozen-lockfile)

WORK="$(mktemp -d)"
stop_node() { pkill -f "hardhat.*node.*--port $PORT" >/dev/null 2>&1 || true; }
cleanup() { stop_node; rm -rf "$WORK"; }
trap cleanup EXIT

mkdir -p "$WORK/packages"
rsync -a --exclude node_modules --exclude .envio --exclude envio-env.d.ts "$HERE/" "$WORK/packages/indexer/"
ln -s "$HERE/node_modules" "$WORK/packages/indexer/node_modules"
ln -s "$CONTRACTS" "$WORK/packages/contracts"
cd "$WORK/packages/indexer"

node scripts/record-fixture.mjs --keep-node --out "$WORK/live-chain.json"
node scripts/generate.mjs --deployment "$CONTRACTS/deployments/monad-local.json" --rpc "http://127.0.0.1:$PORT"
pnpm exec envio codegen
RUNS="${POLARIS_LIVE_RUNS:-1}"
for run in $(seq 1 "$RUNS"); do
  [ "$RUNS" -gt 1 ] && echo "Indexing the chain: run $run of $RUNS" >&2
  POLARIS_LIVE_FIXTURE="$WORK/live-chain.json" ENVIO_BLOCK_LAG=0 pnpm exec vitest run test/live.test.ts --test-timeout=300000
done
