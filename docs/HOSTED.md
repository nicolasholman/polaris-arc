# Vercel — Arc testnet

LEAD: RUN THESE
```sh
node scripts/e2e-browser-polaris.mjs
node scripts/check-hosted-storage.mjs
node scripts/check-shop-storage.mjs
```

| Surface | URL | Service class |
|---|---|---|
| Buyer | https://polaris-arc-lemon.vercel.app | Next.js frontend and FX API |
| Business | https://polaris-arc-business.vercel.app | Merchant UI and request/response API |
| Landing | https://polaris-arc-landing.vercel.app | Static marketing frontend |
| Shop | https://polaris-arc-shop.vercel.app | Demo store frontend and serverless order API; merchant credentials pending |

The hosted testnet backend does not read Arc mainnet price feeds; those rates are unavailable without a local mainnet fork.

The buyer's deployment name is `polaris-arc`; Vercel assigned the `-lemon` domain because the unsuffixed domain belongs to someone else.
Contracts are read from `packages/contracts/deployments/arc-testnet.json` (explicitly traced into the business function).
Existing Atlas is isolated as `arc_polaris_testnet` (merchant records) and `arc_polaris_shop_testnet` (demo orders).
No Railway, new database service, VM or paid resource was created.

**Workers:** Vercel cron calls authenticated `/api/cron/tick` daily at 04:00 UTC and `/api/cron/collections` at 04:10 UTC.
The latter is hard-restricted to Arc testnet. Both require `CRON_SECRET`; long-running loops are disabled on Vercel.
This is daily processing, not the former per-block cadence. For immediate demo collections use `pnpm --filter @polaris/keeper once` locally.
The optional signed underwriting provider/CCIP watcher is not hosted; use the existing keeper on demand for those demos.
No always-on service is needed for the basic buyer frontend or HTTP payment relay. No hosted payment or scheduled collection was sent in this pass.

**Verification:** database and business typechecks pass; existing storage/webhook tests 32/32, shop tests 96/96.
Real Atlas tests preserve eight simultaneous updates in both merchant and shop storage; merchant tests also check duplicates, null/range semantics and immutable IDs.
Business UI: 10/10 routes HTTP 200 with zero console errors. Public network endpoint returns chain 5042002.
Runtime readiness remains false: Atlas accepts this machine but Vercel gets TLS alert 80. Atlas Network Access must allow the intended Vercel deployment.
Buyer: 16/16 routes HTTP 200 with zero console errors, no mobile overflow, payment contract bytecode verified on live testnet.
The wallet-free first step created a browser account with a virtual WebAuthn authenticator (no hardware Face ID or transaction claimed).
Shop: 4/4 routes HTTP 200 with zero console errors and no mobile overflow. Landing evidence is also saved under `docs/screens/hosted/`.
Privy allowed origins must include the buyer and business URLs; real Privy authentication was not completed.
The shop clearly refuses checkout until an Arc merchant API key and webhook secret are configured; its product catalogue is demo merchandise.

**Env:** buyer `NEXT_PUBLIC_POLARIS_API_URL`, `NEXT_PUBLIC_CHAIN_ID=5042002`, `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_RP_ID`, `NEXT_PUBLIC_PRIVY_APP_ID`.
Business `POLARIS_DEPLOYMENT=arc-testnet`, `POLARIS_RPC_URL`, `POLARIS_DB_URL`, `POLARIS_MONGO_DB`, `POLARIS_WORKERS=0`, `POLARIS_KEY_PEPPER`, `CRON_SECRET`,
`POLARIS_CHECKOUT_ORIGIN`, `POLARIS_PUBLIC_URL`, `POLARIS_APP_ORIGINS`, `RELAYER_MODE=local`, `RELAYER_LOCAL_ALLOW_TESTNET=1`, `RELAYER_PRIVATE_KEY`,
`POLARIS_KEEPER_PRIVATE_KEY`, `REGISTRY_ACTIVATOR=off`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `NEXT_PUBLIC_PRIVY_APP_ID`, `NEXT_PUBLIC_CHAIN_ID`, `NEXT_PUBLIC_USDC_ADDRESS`.
Landing: `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_BUSINESS_URL`, `NEXT_PUBLIC_REPO_URL`.
Shop: `POLARIS_API_BASE`, `NEXT_PUBLIC_POLARIS_CHECKOUT_ORIGIN`, `SHOP_URL`, `MONGODB_URI`, `SHOP_MONGO_DB`, `SHOP_ORDER_STORE=mongodb`.
Missing shop payment variables: `POLARIS_SECRET_KEY`, `NEXT_PUBLIC_POLARIS_PUBLISHABLE_KEY`, `POLARIS_WEBHOOK_SECRET`, `POLARIS_MERCHANT_ADDRESS`.
Set values from gitignored files using `vercel env add NAME production` on stdin; never put secrets in a command argument.

Deploy from the repository root after linking the desired project. Set Vercel Root Directory to `apps/app`, `apps/business`, `apps/landing` or `apps/shop` respectively, then `vercel deploy --prod --yes`.
