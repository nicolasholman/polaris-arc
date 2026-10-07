# @polaris/keeper

The Polaris keeper on Arc: one EOA, gas paid in USDC, that does the two jobs
the credit engine needs done on time. It replaces the Chainlink CRE workflows
of the Monad version (CRE does not run on Arc).

| Job | Trigger | Writes |
|---|---|---|
| **Collections** | every `KEEPER_COLLECTIONS_INTERVAL_SECONDS`, and within 5 s of a `PolarisCheckout.Reauthorized` (a buyer who re-signed a lost approval) | `CollectionsReceiver.submitReport(abi.encode(1, tasks))`: collect due instalments, charge renewed subscriptions, liquidate plans past grace |
| **Credit reviews** | `POST /underwrite`, signed by Polaris for Business when a buyer asks to raise their limit | `UnderwritingReceiver.submitReport(abi.encode(2, items))`: the facts; ScoreManager scores them on chain |

- Candidates come from the chain (`loanCount`, `subscriptionCount`, the newest
  ids and a rotating sweep of older ones), `checkTasks` says which are
  actionable, and a dunning ladder (6 h, 1 day, 3 days, weekly) holds back a
  buyer who just failed. Every action is permissionless on its target: if the
  keeper stops, anyone can collect; only the keeper writes the record.
- Reviews check the buyer's EIP-191 consent (and the history wallet's link
  proof), refuse what the chain would refuse, read the evidence with
  `@polarispay/underwriting` (the account on Arc via RPC and Blockscout; a
  linked wallet on other chains), and submit only the facts. Thin files and
  missing provider keys are reported back, never guessed.
- Callbacks to `POST /api/keeper/callback` are HMAC-signed like merchant
  webhooks (`Polaris-Signature: t=…,v1=…`), and so are the business's review
  requests to the keeper (one shared secret).

```bash
pnpm --filter @polaris/keeper start     # the loop and the review server
pnpm --filter @polaris/keeper once      # one collections run, then exit
pnpm --filter @polaris/keeper test
```

Configuration: [`.env.example`](.env.example). On mainnet the keeper is a
long-running service (Railway/Fly worker, or a VM) with a few USDC for gas;
see [`MAINNET.md`](../../MAINNET.md).
