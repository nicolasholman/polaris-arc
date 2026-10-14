# Arc mainnet on Vercel

LEAD: RUN THESE
```sh
node scripts/e2e-browser-hosted-mainnet.mjs
```

Live: https://polaris-arc-lemon.vercel.app (Arc mainnet, chain 5042).
Production reads `packages/contracts/deployments/arc-mainnet.json` with RPC `https://rpc.mainnet.arc.io` and explorer `https://explorer.arc.io`.
Network configuration, contract bytecode, routes, rendered wording and explorer links are checked by the script. Detailed outcomes are in `docs/screens/mainnet/*/results.json`; failures remain failures.

The prepared Privy relayer is configured. Scheduled collection/payout jobs are not enabled by this migration; merchant and shop storage readiness remains separate.

Service credentials were supplied to Vercel via stdin from the ignored `.deployer/mainnet/` files. Read-only broker/executor/studio frontends do not receive signing keys. Mainnet databases have separate names from historical data. No new database, Railway or paid resource was provisioned.

The previous production artifacts were retained at `https://polaris-arc-testnet.vercel.app` (Vercel aliases, no extra build). These are frozen historical builds, not a freshly verified preview environment; shared backend URLs may now resolve to mainnet. Do not use them for transaction rehearsals without checking the displayed chain.

This migration performs reads only: no wallet connection, signature, deposit, payment, withdrawal or chain broadcast. Mainnet contract/deployment transaction evidence is recorded separately in the repository. Local executors remain an on-demand demo requirement, not an always-on hosting service provisioned here.


Production environment: POLARIS_DEPLOYMENT=arc-mainnet; POLARIS_RPC_URL=NEXT_PUBLIC_RPC_URL=https://rpc.mainnet.arc.io; NEXT_PUBLIC_CHAIN_ID=5042; NEXT_PUBLIC_EXPLORER_URL=https://explorer.arc.io; POLARIS_MONGO_DB=arc_polaris_mainnet; SHOP_MONGO_DB=arc_polaris_shop_mainnet; RELAYER_MODE=privy; prepared PRIVY_RELAYER_* credentials; POLARIS_KEEPER_PRIVATE_KEY from mainnet roles; POLARIS_WORKERS=0; cron schedules removed.

Verified: 31 routes returned HTTP 200 with no rendered testnet wording, wrong Arc explorer link or uncaught page exception. Network APIs and RPC reported chain 5042; expected mainnet contract bytecode was present. Screenshots and machine-readable results are saved beside this report.

## Final hosted polish — 2026-10-15

Atlas readiness passes. Restored the original video merchant, 5 payments, 2 plans, 1 subscription, 1 subscription plan and 13 wallet moves after verifying 19 mainnet receipts. Public merchant and buyer APIs read back the records. POLARIS_TRUSTED_PROXIES=1 fixes productionReady; workers, payouts and collection schedules remain off. Both consumer email sign-in and business Privy modal initialize without origin errors. No login completed.

Re-run: `node scripts/e2e-browser-hosted-mainnet.mjs`. Also run `node scripts/e2e-browser-hosted-proof.mjs` for artifact visibility and applicable sign-in checks.

No mainnet broadcasts or paid API calls. Live mainnet reads and DB writes only; fork transactions and complete wallet sign-ins: Not run.
