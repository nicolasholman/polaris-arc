# Hosted Arc testnet build

Railway project: `polaris-arc-testnet` (`205ff9b0-43d3-403c-bbef-2a79339f252a`).

| Service | URL | Storage |
|---|---|---|
| app | https://app-production-5010.up.railway.app | Stateless buyer app; passkeys |
| business | https://business-production-9696.up.railway.app | SQLite volume at `/data`; API, relayer, chain sync |
| keeper | https://keeper-production-24ff.up.railway.app/health | Collections and signed underwriting requests |

All three read Arc testnet (5042002). Contract addresses come from
`packages/contracts/deployments/arc-testnet.json`; the buyer reads `/api/public/network`.
The API allows the buyer origin. Only the business API holds the relayer key; only the
keeper holds the keeper key. Secrets are Railway runtime variables, excluded from uploads.

Redeploy from this repo root with `railway up --service business|app|keeper --detach`.
Each service sets `RAILWAY_DOCKERFILE_PATH` to its Dockerfile. Wait for the matching
release to reach SUCCESS, then check `/api/health/ready`, `/api/health`, and keeper `/health`.

The merchant dashboard requires Privy credentials (`PRIVY_APP_ID`, `PRIVY_APP_SECRET`,
`NEXT_PUBLIC_PRIVY_APP_ID`) and both hosted origins allowed in the Privy dashboard.
Those credentials were not present in this port's env file. Passkeys and the testnet
local-key relayer do not depend on Privy. Automatic payouts and merchant activation remain off.
Optional landing, demo shop, and Envio indexer are not hosted. Cross-chain flows remain
Not run live; prior fork evidence is unchanged.

Checks and screenshots: `docs/screens/hosted/`. The hosted action script sends 0.10 USDC
and claims it back through the public relayer; it requires the deployer key in the process
environment and must run under the shared deployer lock. No mainnet broadcasts.

Known runtime weakness: the optional CCIP history scanner can hit the public RPC's
rate limit. The keeper health check and ordinary collections scan remain healthy;
no live cross-chain lane is configured or claimed as verified.

Verified 2026-10-14: all three Railway releases reached SUCCESS; 17 buyer routes,
10 business routes, and all checked health/network/credit-guard endpoints returned 200.
Connected-browser Playwright checks captured no console errors. Dashboard routes show
an honest sign-in-unavailable state. CORS returns the exact buyer origin.
The initial action attempt returned a transient 503; a subsequent attempt confirmed:
- Send 0.10 USDC: `0x5f87f9bf1813d2da0c2249b047eaedf4c3939e35d8a1d3c153274af0521b7951`
- Claim back: `0x673ffaa0973bd99d9569316a7b98c090b43d6975d320f1d3cfaf52b890523f6d`
The general health response is `ok: true`; `productionReady: false` records the missing
Privy setup. Readiness separately confirms writable persistent SQLite and running workers.
