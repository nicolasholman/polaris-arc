# Polaris on Arc testnet: live end to end

Chain 5042002, real USDC, real transactions, driven through the business API
(`apps/business`, the same `/api/relay` the app uses) by
[`scripts/e2e-testnet.mjs`](../scripts/e2e-testnet.mjs). 14 Polaris contracts:
[`arc-testnet.json`](../packages/contracts/deployments/arc-testnet.json). Run on
2026-10-13/14 against the deployed contracts; every hash below is on
[explorer.testnet.arc.io](https://explorer.testnet.arc.io).

How it ran: the business server and the keeper start locally on the testnet
record (RPC chain sync, **no Envio indexer**), a throwaway buyer holds USDC and
signs everything (EIP-3009, EIP-2612, EIP-712); the relayer wallet pays the gas,
so **the buyer sends no transaction**. The merchant is the seeded demo merchant
"Halcyon Studio" `0xF6b9…C85D`; the payment link is a database record the
dashboard would create (the dashboard needs a Privy login that this run does not have).

## Live, with transactions

| # | Flow | Result | Transactions |
|---|---|---|---|
| 0 | Fund keeper and relayer (0.3 USDC each, from the deployer, under the shared lock) | done | [keeper](https://explorer.testnet.arc.io/tx/0x33a05761f9a929f610c598e61bec47f972f709fc5085a01e6c6efe4903207f0f) [relayer](https://explorer.testnet.arc.io/tx/0xce0603c9a0143ef80d5df4f23f13db2456807422ce7bf3dcdb39329427328c7d) |
| 1 | **USDC send link**: created ($0.20, signed by the buyer, relayed), then claimed to the deployer address by a link signature | the claimed balance rose by exactly $0.20 | [send](https://explorer.testnet.arc.io/tx/0x272f91d0834f0632236dfc00dc1f568aed5d222ff102d04ef4a076314e66eb00) [claim](https://explorer.testnet.arc.io/tx/0x7477b45b14d624795e5a4591b9aa8b1809deba08a67b260597c4634ef1c1436e) |
| 2 | **Merchant payment link paid in full** ($0.50, `POST /api/public/links/{id}/checkout`, then a relayed `receiveWithAuthorization`) | the payment is a call to Arc's Memo contract carrying the order key; the merchant received $0.4975 (0.5% fee); the `payment.succeeded` webhook verified with `polarispay-sdk` | [0x140cbb95…5a7d3b](https://explorer.testnet.arc.io/tx/0x140cbb95a60a8a90d3b2965c6007b458dd3bcad386c7eb4ec094e2c9685a7d3b) |
| 3 | **Subscription** ($0.50 per day, plan #3 published on chain by the relayer, one permit covering 12 periods) | the first period charged at once | [0x2ad17083…9ef332](https://explorer.testnet.arc.io/tx/0x2ad170830a24bc70562c40848b761d0a42927a4028fce830a0a3a00c739ef332) |
| 4 | **Boost**: $1.10 locked as collateral with one relayed permit | credit line $1.10 | [0x883d30a6…5ba5b4](https://explorer.testnet.arc.io/tx/0x883d30a667a65de0b0dffd1ec9235599d63e9edb38f426eeb66530eff15ba5b4) |
| 5 | **Pay in 4**: a $1.00 plan (loan #1, 4 instalments an hour apart) | the merchant was paid $1.00 in full from the pool, nothing was due from the buyer; `plan.opened` webhook verified | [0x21d2db71…90c174](https://explorer.testnet.arc.io/tx/0x21d2db716eea80e88e8bdcd51e6e55b3596c6910a51a715c0b9235727b90c174) |
| 6 | **Credit guard, live** | the pool had 5.00 free cash, exactly the guard's floor; after the plan it holds 4.00 and `isCreditPaused()` returns `(true, LOW_CASH)`: new Pay in 4 plans are refused on chain until the pool is topped up | read from CreditGuard |
| 7 | **Keeper collects instalment 1** | **Pending**: instalment 1 of loan #1 falls due at 2026-10-13T20:10:25Z (the deployed minimum interval is one hour); collect with `pnpm e2e:testnet:collect` once it is due | not yet run |
| 8 | **Pool top-up** (deployer's own funds, so Pay in 4 reopens) | free cash 4.00 → 6.00, guard open again | [approve](https://explorer.testnet.arc.io/tx/0xdcfb890086a3f16f225a9f06606e0fcf163bcba03a96e399917269a2199b395d) [fund](https://explorer.testnet.arc.io/tx/0x6cc77798f3b5d1734ad84bb5b06dba37bee1f4419729177b8e1fb7bdd923b209) |

Merchant payout on this deployment is the seeded demo merchant, so those dollars
are spent; the plan's collateral and instalments belong to the deployer wallet.

## What did not go as planned (kept honest)

- **First attempt**: the first run used a fresh buyer with a $1.00 Boost for a
  $1.00 plan. Pay in 4 was refused by the contract's limit check
  (`over_limit`: the line must cover the principal plus interest). The script
  did not save that throwaway key, so its remaining 1.3 USDC and the 1.0 USDC it
  locked (Boost tx [0x897d…0225](https://explorer.testnet.arc.io/tx/0x897df75d5aedd4d53359f5df9fe44d988734c8ab021d057174799ad65c880225))
  are stranded: about 2.3 USDC of the budget. The script now writes the key to
  `.data/e2e-buyer.key` (git-ignored), sizes the Boost at 110% of the plan,
  can run chosen steps (`E2E_STEPS`) and can use the deployer as the buyer
  (`E2E_BUYER=deployer`), which is how the plan above was opened, so nothing more
  was stranded. The send link, payment link and subscription (rows 1-3) are from the
  first run; Boost and Pay in 4 (rows 4-5) are from the second, where the deployer wallet
  `0x0648…1FBd` is the buyer. The pool, the treasury and the owner are that same wallet.
- **Budget**: about 2.9 USDC left the deployer in total (0.6 to keeper/relayer, 2.5
  to the first buyer, 0.2 came back through the claim), over the 2.5 allowed
  because of the stranded buyer. The second run cost nothing net (own funds).
- A public-RPC "rate limit exceeded" aborted the very first start; the script now
  retries and polls every second.

## Not run live

| Flow | Why |
|---|---|
| Euro send link (EURC) | the deployer holds no testnet EURC (faucet.circle.com); `PolarisSendEURC` is deployed; the flow ran on the Arc fork |
| Gateway deposit and mint | needs a Gateway balance on another chain; only signature checks against Circle's API |
| CCTP add-money and CCTP hook payment | need source-chain testnet USDC and an attestation; `PolarisCctpHookReceiver` is deployed |
| Chainlink CCIP send | receiver deployed, no sender deployed, no lane allowlisted |
| USYC park / unpark | USYC is permissioned (Circle allowlist); ran on a fork with the allowlist granted there |
| Chainlink Data Feeds peg guard | **mainnet only**: Arc testnet has no feeds, the testnet CreditGuard has no feed set |
| Subscription renewal and plan #2 (hourly) | the API publishes day/week/month/year plans only; renewal is a day away. Plan #2 ($1 per hour) exists from the deploy seed but is only reachable by a direct contract call |

## Rerun

```bash
pnpm e2e:testnet                                   # all steps, new funded buyer (E2E_BUYER_USDC, default 5)
E2E_BUYER=deployer E2E_STEPS=plan pnpm e2e:testnet  # only Boost + Pay in 4, the deployer as buyer
pnpm e2e:testnet:collect                           # the keeper collects the plan once it is due
```
