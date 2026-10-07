#!/usr/bin/env bash
# The indexer serving GraphQL for a local chain that is already running
# (demo:local's, `wsl.sh live`'s with --keep-node, or any Hardhat or anvil node
# with the contracts deployed by scripts/deploy-monad.js):
#
#   bash scripts/wsl.sh local          (from the repo root: pnpm indexer:local)
#
#   1. Postgres and Hasura in Docker, the images and settings `envio dev`
#      uses, under their own names and ports so they never meet another
#      project's `envio dev` (its containers are called envio-postgres and
#      envio-hasura, on 5433 and 8080);
#   2. config.yaml regenerated for that chain (RPC, not HyperSync) in a
#      scratch copy of this package, so the committed files are untouched;
#   3. `envio start` in the foreground. Ctrl+C stops it, removes the two
#      containers and the scratch copy; the index lives only as long as this.
#
# Then every reader points at http://127.0.0.1:$POLARIS_INDEXER_GRAPHQL_PORT/v1/graphql:
# POLARIS_INDEXER_URL (Polaris for Business), the webhook outbox
# (`activityAfter`), the CRE collections workflow (`candidates.indexerUrl`,
# or POLARIS_LOCAL_INDEXER_URL for workflows' collections:local).
#
# Environment:
#   POLARIS_LOCAL_RPC                the chain (default http://127.0.0.1:8545, demo:local's)
#   POLARIS_LOCAL_DEPLOYMENT         its record (default ../contracts/deployments/monad-local.json)
#   POLARIS_INDEXER_PG_PORT          Postgres on the host (default 15432)
#   POLARIS_INDEXER_GRAPHQL_PORT     Hasura on the host (default 18080; admin secret `testing`)
#   POLARIS_INDEXER_METRICS_PORT     the indexer's own HTTP port (default 19898)
#   POLARIS_INDEXER_DOCKER_PREFIX    container and network names (default polaris-envio)
#   ENVIO_BLOCK_LAG                  default 0 here: a local node mines only when it is sent something
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="$(cd "$HERE/../contracts" && pwd)"
RPC="${POLARIS_LOCAL_RPC:-http://127.0.0.1:8545}"
DEPLOYMENT="${POLARIS_LOCAL_DEPLOYMENT:-$CONTRACTS/deployments/monad-local.json}"
PG_PORT="${POLARIS_INDEXER_PG_PORT:-15432}"
GQL_PORT="${POLARIS_INDEXER_GRAPHQL_PORT:-18080}"
METRICS_PORT="${POLARIS_INDEXER_METRICS_PORT:-19898}"
PREFIX="${POLARIS_INDEXER_DOCKER_PREFIX:-polaris-envio}"
PG="$PREFIX-postgres"
HASURA="$PREFIX-hasura"
NET="$PREFIX-net"
# The images `envio dev` 3.12.1 runs.
PG_IMAGE="postgres:18.3"
HASURA_IMAGE="hasura/graphql-engine:v2.43.0"

die() { echo "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "Docker is needed for Postgres and Hasura (the GraphQL endpoint). For the indexer without them: bash scripts/wsl.sh live"
docker info >/dev/null 2>&1 || die "Docker is installed but not running."
[ -f "$DEPLOYMENT" ] || die "No deployment record at $DEPLOYMENT: deploy to the chain first (pnpm --filter @polarispay/contracts deploy:local), or set POLARIS_LOCAL_DEPLOYMENT."
chain_id="$(curl -s -m 5 -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC" || true)"
[[ "$chain_id" == *'"result"'* ]] || die "Nothing answers JSON-RPC on $RPC: start the chain first, or set POLARIS_LOCAL_RPC."
for port in "$PG_PORT" "$GQL_PORT" "$METRICS_PORT"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    die "Port $port is taken; set POLARIS_INDEXER_PG_PORT, POLARIS_INDEXER_GRAPHQL_PORT or POLARIS_INDEXER_METRICS_PORT."
  fi
done
[ -d "$HERE/node_modules/envio" ] || (cd "$HERE" && pnpm install --ignore-workspace --frozen-lockfile)

WORK="$(mktemp -d)"
ENVIO_PID=""
cleanup() {
  # envio runs in its own process group (set -m below): stop all of it.
  [ -n "$ENVIO_PID" ] && kill -TERM -- "-$ENVIO_PID" >/dev/null 2>&1 && wait "$ENVIO_PID" 2>/dev/null || true
  docker rm -f "$HASURA" "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Containers left by a run that was killed: these names are this script's own.
docker rm -f "$HASURA" "$PG" >/dev/null 2>&1 || true
docker network rm "$NET" >/dev/null 2>&1 || true
docker network create "$NET" >/dev/null
docker run -d --rm --name "$PG" --network "$NET" -p "127.0.0.1:$PG_PORT:5432" \
  -e POSTGRES_PASSWORD=testing -e POSTGRES_USER=postgres -e POSTGRES_DB=envio-dev \
  "$PG_IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$PG" pg_isready -U postgres -d envio-dev >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$PG" pg_isready -U postgres -d envio-dev >/dev/null 2>&1 || die "Postgres did not start."
docker run -d --rm --name "$HASURA" --network "$NET" -p "127.0.0.1:$GQL_PORT:8080" \
  -e HASURA_GRAPHQL_DATABASE_URL="postgres://postgres:testing@$PG:5432/envio-dev" \
  -e HASURA_GRAPHQL_ADMIN_SECRET=testing \
  -e HASURA_GRAPHQL_ENABLE_CONSOLE=true \
  -e HASURA_GRAPHQL_UNAUTHORIZED_ROLE=public \
  -e HASURA_GRAPHQL_STRINGIFY_NUMERIC_TYPES=true \
  -e HASURA_GRAPHQL_NO_OF_RETRIES=10 \
  "$HASURA_IMAGE" >/dev/null
for _ in $(seq 1 90); do
  curl -sf -m 2 "http://127.0.0.1:$GQL_PORT/healthz" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf -m 2 "http://127.0.0.1:$GQL_PORT/healthz" >/dev/null || die "Hasura did not start: docker logs $HASURA"

mkdir -p "$WORK/packages"
rsync -a --exclude node_modules --exclude .envio --exclude envio-env.d.ts --exclude logs "$HERE/" "$WORK/packages/indexer/"
ln -s "$HERE/node_modules" "$WORK/packages/indexer/node_modules"
ln -s "$CONTRACTS" "$WORK/packages/contracts"
cd "$WORK/packages/indexer"
node scripts/generate.mjs --deployment "$DEPLOYMENT" --rpc "$RPC"

cat >&2 <<EOF

Indexing $RPC (chain $(printf '%d' "$(printf '%s' "$chain_id" | sed -E 's/.*"result":"([^"]+)".*/\1/')")) from $DEPLOYMENT.
GraphQL:  http://127.0.0.1:$GQL_PORT/v1/graphql   (Hasura console on the same port, admin secret testing)
Readers:  POLARIS_INDEXER_URL=http://127.0.0.1:$GQL_PORT/v1/graphql
Ctrl+C stops the indexer and removes $PG and $HASURA.

EOF

# In the background, in its own process group, so Ctrl+C or a TERM reaches
# the trap at once and the trap stops envio and every process it started.
set -m
ENVIO_PG_HOST=127.0.0.1 ENVIO_PG_PORT="$PG_PORT" ENVIO_PG_USER=postgres ENVIO_PG_PASSWORD=testing \
ENVIO_PG_DATABASE=envio-dev \
HASURA_GRAPHQL_ENDPOINT="http://127.0.0.1:$GQL_PORT/v1/metadata" HASURA_GRAPHQL_ADMIN_SECRET=testing \
ENVIO_INDEXER_PORT="$METRICS_PORT" ENVIO_TUI=false ENVIO_BLOCK_LAG="${ENVIO_BLOCK_LAG:-0}" \
  pnpm exec envio start &
ENVIO_PID=$!
set +m
wait "$ENVIO_PID"
