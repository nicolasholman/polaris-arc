#!/bin/sh
# Rehearse Polaris on a local fork of Arc testnet, with Circle's real USDC,
# EURC, Memo and CCTP contracts, without spending testnet USDC.
#
#   ARC_ANVIL=/path/to/arc-anvil sh scripts/arc-fork.sh            # fork, deploy, fund
#   E2E_FORK=1 E2E_RECORD=.fork/arc-fork.json ARC_TESTNET_RPC_URL=http://127.0.0.1:18745 \
#     DEPLOYER_ENV_FILE=.fork/deployer.env node scripts/e2e-testnet.mjs   # the testnet end to end, on the fork
#
# Needs Arc Foundry's anvil (https://github.com/circlefin/arc-foundry): plain
# anvil can fork Arc but can't move Arc's native USDC; `--network arc` can.
#  1. starts it forking Arc testnet on :18745 (ARC_FORK_PORT) with 1-second blocks;
#  2. deploys with the real deploy script (NETWORK=testnet against the fork's RPC),
#     anvil's dev account 0 as deployer, into .fork/arc-fork.json (git-ignored);
#  3. gives the keeper and relayer from .env.local USDC by setting their native
#     balance (on Arc it is the same USDC as the ERC-20 at 0x3600…0000).
set -e
cd "$(dirname "$0")/.."
ANVIL=${ARC_ANVIL:-arc-anvil}
PORT=${ARC_FORK_PORT:-18745}
RPC=http://127.0.0.1:$PORT
mkdir -p .fork
if ! cast chain-id --rpc-url $RPC >/dev/null 2>&1; then
  nohup "$ANVIL" --network arc --fork-url https://rpc.testnet.arc.io --port $PORT --block-time 1 --silent > .fork/arc-fork.log 2>&1 &
  echo $! > .fork/arc-fork.pid
  i=0; until cast chain-id --rpc-url $RPC >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 90 ] && { echo "the fork didn't start: .fork/arc-fork.log"; exit 1; }; sleep 1; done
fi
# anvil's public dev account 0 (the well-known "test … junk" mnemonic): only ever used on this local fork.
printf 'DEPLOYER_PRIVATE_KEY=%s\n' "$(cast wallet private-key --mnemonic "test test test test test test test test test test test junk")" > .fork/deployer.env
chmod 600 .fork/deployer.env
. ./.env.local
for a in "$POLARIS_KEEPER_ADDRESS" "$POLARIS_RELAYER_ADDRESS"; do
  cast rpc anvil_setBalance "$a" 0x56bc75e2d63100000 --rpc-url $RPC >/dev/null   # 100 USDC (18-decimal native view)
done
cd packages/contracts
set -a; . ../../.fork/deployer.env; set +a
ARC_TESTNET_RPC_URL=$RPC POLARIS_KEEPER_ADDRESS=$POLARIS_KEEPER_ADDRESS POLARIS_RELAYER_ADDRESS=$POLARIS_RELAYER_ADDRESS \
POLARIS_FAST_PLANS=1 POLARIS_POOL_SEED_USDC=500 POLARIS_DEPLOYMENT_OUT=../../.fork/arc-fork.json \
  npx hardhat run scripts/deploy.js --network arcTestnet
