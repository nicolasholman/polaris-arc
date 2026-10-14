# Judge walkthrough (5 minutes, no setup)

Live: https://polaris-arc-lemon.vercel.app (Arc testnet)


1. **See it on chain.** [docs/E2E-TESTNET.md](E2E-TESTNET.md) lists the live Arc testnet
   transactions: a USDC send link created and claimed, a merchant payment link paid through
   Arc's Memo contract, a subscription, a collateral Boost and a Pay in 4 plan, with explorer
   links. The 14 contracts are in
   [`packages/contracts/deployments/arc-testnet.json`](../packages/contracts/deployments/arc-testnet.json).
2. **What is real and what is not.** The README's "Arc stack" table marks every piece
   **Live**, **Fork** or **Not run**; [docs/JUDGE-REPORT.md](JUDGE-REPORT.md) is the strict audit.
3. **Run it yourself.** `pnpm install && DEMO_FAST_PLANS=1 pnpm demo:local` runs the whole product
   on a local chain (shop, checkout, keeper, dashboard). Against testnet: `pnpm e2e:testnet`
   (needs a funded deployer key and funded relayer and keeper keys; see E2E-TESTNET.md).
4. **Screens.** [docs/screens/testnet](screens/testnet) holds a desktop and a 390 px screenshot of
   every public route, taken against the testnet deployment.
5. **Known limits.** The merchant dashboard needs a Privy login (not configured in the audit
   environment); the Envio indexer is not hosted (the server reads Arc itself); Gateway, CCTP, CCIP and
   USYC flows were not run live (see the table); Chainlink Data Feeds exist on Arc mainnet only.
