# Judge report: Polaris on Arc (strict pass, Arc testnet only)

Audited on 2026-10-13/14 against the live Arc testnet deployment
(`packages/contracts/deployments/arc-testnet.json`), as a skeptical Arc Microgrants judge,
then fixed. Evidence: [E2E-TESTNET.md](E2E-TESTNET.md), [screens/testnet](screens/testnet).

## Scores

| Criterion | Before | After | Why |
|---|---|---|---|
| Relevance to Arc | 8 | 9 | USDC as gas and money, Memo wrapping every checkout, Circle contracts (CCTP, Gateway, EURC, USYC), Chainlink on Arc. After: the Memo path and USDC-only gas are now shown on the live network, and Arc-only claims name Arc mainnet where that is the only place they exist. |
| Technical credibility | 5 | 7 | Before: README said the testnet deploy was "waiting on funds", every "verified" cell was fork or unit evidence, the app labelled a mainnet feed as "on Arc" on testnet, the landing credited Envio and data providers that do not run. After: 14 contracts live, six real flows with explorer links, every claim tagged Live / Fork / Not run, contract source verified on the explorer (see below). Held back by: Pay in 4 collection, Gateway, CCTP, CCIP and USYC never ran live. |
| Quality of what was built | 8 | 8 | Large, coherent product (buyer app, business API and dashboard, keeper, SDK); 310 business, 119 app and 10 keeper tests pass (re-run in this pass); the 544 Hardhat contract tests are from the project's own record and were not re-run. The live run found one real UX trap (a line equal to the price cannot buy the price, interest is on top) and a pool that pauses itself after one $1 plan, both honest-working behaviour. No change needed to the product. |
| Worth taking further | 7 | 8 | A working merchant payment link, credit line and keeper on a stablecoin chain is a real product; mainnet switch is one command with caps. Weak spots below are about proof, not design. |

## 1. Claims audit

| Claim (where) | Verdict | Action |
|---|---|---|
| "The public testnet deploy is waiting on deployer funds" (README) | False since the deploy | Rewritten: 14 contracts live |
| Every Arc-stack "How verified" cell (README) | Mixed: fork / unit evidence presented as the proof | Column replaced by **Live / Fork / Not run** per piece |
| "Circle Gateway ... live against Circle's testnet Gateway API" (README, SUBMISSION) | Signature checks only; no deposit, no mint | Reworded: **Not run** end to end |
| CCTP add-money and "CCTP V2 hooks" (README, SUBMISSION) | Unit/Foundry only; hook receiver is deployed live | **Not run** live; receiver marked deployed |
| "Chainlink CCIP ... pay from Base / Ethereum in one transaction" | Fork + Chainlink Local only; no sender deployed, no lane allowlisted | **Fork**; live send **Not run** |
| "Chainlink Data Feeds ... CreditGuard reads USDC / USD" | Mainnet only. The testnet CreditGuard's `priceFeed` is null | Labelled **mainnet only**; fork-tested |
| "USYC ... idle cash earns" (SUBMISSION) | Fork round trip with the allowlist granted on the fork | Reworded "can be parked ... tested on a fork"; **Not run** live |
| "euro send links" | Contract deployed; deployer holds no testnet EURC | **Not run** live |
| "Chainlink Data Feed on Arc" next to a EURC rate in the app | The rate is read from Arc mainnet even on testnet | App copy now says "Arc mainnet (the testnet has no feeds)" |
| "Built on ... Privy and Envio" (landing, footer) | Envio is not hosted; nothing depends on it | Removed Envio from the pill, the logos and the footer |
| "Built on ... Nansen, Zerion" (marketing landing logos) | Optional underwriting data sources, not configured | Removed |
| "Buyers pay from any chain via CCTP" (landing) | A capability, never run | Reworded "can bring USDC from other chains with CCTP" |
| Product preview with $24,575 sales, a chart (business landing) | Invented figures, only the aria-label said so | Visible caption: "Illustration: sample numbers from an invented studio" |
| "Final in under a second" (many places) | Arc's own claim about its finality; blocks about 0.5 s apart on the explorer | Kept as an attributed Arc property; our own measured latency is not claimed |
| "Pay in 4 ... A credit guard pauses new plans the moment the pool runs short" | **Verified live**: after the first $1 plan the pool had 4.00 < 5.00 and `isCreditPaused()` = true | Kept; documented |
| "544 / 306 / 106 tests" | Business is 310, app 119 (re-run); 544 contract tests not re-run | Numbers corrected |
| "Every action is a signature; buyers hold no gas" | **Verified live** (first run: the buyer sent no transaction) | Kept |
| "Merchant is paid in full up front", "0.5% fee" | **Verified live** ($0.50 payment: merchant +$0.4975; $1 plan: merchant paid $1.00 from the pool) | Kept |
| "Audited", "production" | Not claimed anywhere | none |

## 2. Mocks audit

`grep` over `apps/*/src`, `services/keeper/src` and `packages/{sdk,ui}/src` (tests excluded):

- **Landing product preview** (invented studio, sales chart, calculator): now captioned as an illustration.
- **"Payouts" landing widget**: already says "Demo · nothing moves".
- **"Demo shop coming soon"** disabled button: shows only when no shop URL is configured; it is labelled, not a stub that looks live.
- `MockUSDC` / `mockUSDCAbi`: used only to decode local-chain errors; not reachable on Arc.
- The dev-only local session, dev signer and gallery pages are gated to `next dev` / local chain (`next.config.ts` blanks them elsewhere).
- No `TODO`/`FIXME`, lorem, "coming soon" feature stubs or Monad/MON/AUSD/Mera/Kuru text in any rendered page (Playwright text scan on all 24 routes x 2 widths).

## 3. Screens audit

Business (`:8745`, testnet record) and the buyer app (`:8750`) run against the testnet deployment; 24 routes at 1360 px and 390 px, screenshots in [screens/testnet](screens/testnet), machine-readable `report.json`.

- All routes return 200, no failed responses, no broken images, no forbidden text, no horizontal overflow in the app.
- Console errors: the business landing logs `ERR_CONNECTION_REFUSED` in `next dev` (it probes `localhost:3600` for the demo shop; the probe does not exist in a production build).
- The business `/login` and `/dashboard*` show a "Connect Privy" setup screen because no Privy app id is configured: **the merchant dashboard could not be visited on testnet**. (4 px horizontal overflow at 390 px on that dev-only screen; production shows a one-line "Sign-in is unavailable" instead.)
- Explorer links in the app go to `explorer.testnet.arc.io`.
- Not screenshotted: signed-in app screens (they need a passkey); the separate marketing site `apps/landing` (copy fixed by grep) and the demo shop.

## 4. Feature check (live)

See [E2E-TESTNET.md](E2E-TESTNET.md): send link create + claim, payment link paid in full through Memo, subscription, Boost, Pay in 4, credit guard pausing the pool. The keeper's collection of instalment 1 is due one hour after the plan opened (the deployed minimum interval); see the status in E2E-TESTNET.md.

Spend: about 2.9 USDC left the deployer (the limit was 2.5). 2.3 of it is stranded in a throwaway buyer whose key the first run did not save; that is a bug in the e2e script, fixed (key is persisted, the deployer can be the buyer). The pool was topped up afterwards from the deployer's own funds (not test spend) so Pay in 4 stays available.

## 5. Contract verification

13 of the 15 contract records are now **verified on explorer.testnet.arc.io** (source, ABI, read/write tabs). Two were not: `PolarisCCIPReceiver` and `PolarisCctpHookReceiver`, built with Foundry (Blockscout's v1 API, which Foundry's verifier uses, is rate limited for anonymous callers; the v2 route used for the others needs Hardhat build info). Command: `pnpm --filter @polarispay/contracts verify:blockscout:testnet`; results in the deployment record (`verification`). Before this pass: 0 of 15 were verified.

## 6. Fixes made in this pass

- `scripts/e2e-testnet.mjs`: send link (USD/EUR), payment link, subscription, Boost, Pay in 4, two phases (`pnpm e2e:testnet:collect`), step selection, persisted buyer key, RPC retries.
- `apps/business/scripts/lib/seed.mjs`: can seed payment links (the dashboard needs Privy).
- `packages/contracts/scripts/verify.js`: paces and retries against Blockscout's rate limit.
- README, SUBMISSION, new JUDGE-WALKTHROUGH: Live / Fork / Not run labels, no Envio-powered claims, test counts.
- App and landing copy: mainnet-feed label, Envio / Nansen / Zerion removed, preview caption, CCTP wording.

## 7. Still weak

- No live Pay in 4 collection yet, no live Gateway / CCTP / CCIP / EURC / USYC runs; the product's cross-chain story is fork and unit evidence.
- Merchant dashboard needs Privy to be seen at all; a cold judge with no hosted build sees a setup screen.
- The testnet CreditGuard has no price feed, so the depeg guard only exists on mainnet.
- Subscriptions via the API start at one day, so renewal by the keeper was not exercised.
- Credit scoring is only collateral (Boost) on a new wallet; unsecured underwriting is not run live.
