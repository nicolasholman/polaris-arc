# Privy, live on Monad testnet

Set up on 28 Sep 2026 in the Privy app behind Polaris for Business, with the
scripts in [`scripts/privy`](scripts/privy), exactly as the README's
"What only you can do", step 4, lists them. Everything below is an id, an
address, a hash or a public rule. The keys are in git-ignored files only:
`apps/business/.env.privy` and `.env.local` (the relayer's, the registry
admin's and the payout signer's authorization keys) and
`apps/business/.privy-admin.key` (the admin key quorum's private key: **move
it offline and delete the file**; the server never needs it).

Read back from Privy with `pnpm --filter @polaris/business privy:show`:
[`docs/demo/testnet/privy-live.json`](../../docs/demo/testnet/privy-live.json)
(every wallet's owner, policies and signers, and both policies rule by rule).

## What was created in Privy

| What | Privy id | Address (Monad testnet) |
|---|---|---|
| Admin key quorum `polaris-admin` (owns both wallets and both policies; threshold 1) | `gndg0n76esw2hv2lc0vo5ex9` | |
| **Relayer** server wallet `polaris-relayer` | `y8sa671n804anaxznbeneh2q` | [`0x8366916019bc5452e62A0D36418ABebB45396aE2`](https://testnet.monadscan.com/address/0x8366916019bc5452e62A0D36418ABebB45396aE2) |
| Relayer policy `polaris-relayer-10143` (17 rules) | `qqsjm4wxjn9pefv8v4njbmit` | |
| Relayer key quorum `polaris-relayer` (the server's signer, held to the same policy) | `fc0zdavaibws3si00wppqfde` | |
| **Registry admin** server wallet `polaris-registry-admin` (owns MerchantRegistry) | `jznn8nzfi7xuc2ywij67ktld` | [`0xa089EeEA5B1625C586380596bde502aB46F3e45F`](https://testnet.monadscan.com/address/0xa089EeEA5B1625C586380596bde502aB46F3e45F) |
| Registry admin policy `polaris-registry-admin-10143` (3 rules) | `jlkptd8dcc0sfv7exe2qmsf0` | |
| Registry admin key quorum `polaris-registry-admin` | `w0zj7b62z7iyxsbqmocios2q` | |
| Payout signer key quorum `polaris-payout-signer` (merchants add it for automatic payouts) | `i6y2ecc7s7l8ydf76fdddn2v` | |

The relayer policy: one `DENY` for any transaction carrying MON, then one
`ALLOW` per call the relayer carries (`eth_signTransaction`, chain 10143, the
contract's address, one function, function-only ABI fragment): PolarisCheckout
`pay`, `openPlan`, `subscribe`, `reauthorize`; PolarisPayments
`payWithAuthorization`, `cancelWithSignature`, `createPlanFor`, `quoteOrder`;
PolarisSend `send` (≥ $0.10), `claim`, `cancel`; PolarisLoanEngine
`repayWithSig`; CollateralVault `lockWithPermit` (≥ $0.10); MerchantRegistry
`registerFor`, `updatePayoutAddressWithSig`; AUSD `transferWithAuthorization`
(≥ $0.10). Anything else matches no rule and Privy denies it. The registry
admin policy: deny MON, allow `setActive`, and `setMaxOrderValue` up to
$1,000. The dry run prints both as JSON (`privy:setup-relayer`, no flag).

## On Monad testnet

| Step | Transaction |
|---|---|
| CollateralVault redeployed with `lockWithPermit` (`redeploy-vault:monad`), now [`0xC2F006aE9836a700CE8F1e457d11346cc42e23dc`](https://testnet.monadscan.com/address/0xC2F006aE9836a700CE8F1e457d11346cc42e23dc) | deploy [`0x4c71da11…`](https://testnet.monadscan.com/tx/0x4c71da11c22e6e1d10b418c9fb0e605be1ae091367740724008aa16ff5b44453), `setLoanEngine` [`0x81f886b5…`](https://testnet.monadscan.com/tx/0x81f886b51697d0715de787c7a89a7e9e98c654721bbe30306e9d7f056ea48bbe), `setSeizer` [`0x68b4daf6…`](https://testnet.monadscan.com/tx/0x68b4daf6fbda7455a13a7f7e3da2fd565812d62e54734c9f0e900c6c5f932513), ScoreManager [`0xa92056b7…`](https://testnet.monadscan.com/tx/0xa92056b74bd168240ee76a17b14d05b0638dab141c5dd212abc9dae50654d512), loan engine [`0x960c2699…`](https://testnet.monadscan.com/tx/0x960c26990a1420f01c4a196cbda530831e1359ca2faa5c69dca8bc11b850993f) |
| 1 MON from the deployer to the relayer, for gas (`privy:fund`) | [`0x3f3dabc8…`](https://testnet.monadscan.com/tx/0x3f3dabc8379079deb2a7f3ce8e0c55ed05378d02570eedf1e1d16fa6dd2e0715) |
| 0.2 MON from the deployer to the registry admin, for gas | [`0x1eed99be…`](https://testnet.monadscan.com/tx/0x1eed99be2d8272d6b27e5b2dd1cc5ff54c9b69c5359f54b5f3b7afef6de90bdb) |
| The relayer's roles (`grant-relayer:monad`): PolarisPayments operator, MerchantRegistry operator, BatchSettlement settler | [`0x7e333d47…`](https://testnet.monadscan.com/tx/0x7e333d47c39290011bfcacf60cc798c100c2bbcdac9a5bf3fa0821e46dbda763), [`0xe0625c76…`](https://testnet.monadscan.com/tx/0xe0625c7668e4d394b0fe95bd6f80812ead4b13612551f587fbae81800b22c528), [`0x81567152…`](https://testnet.monadscan.com/tx/0x815671523a70b9c2ac5e86031e3eb0e354a6421c115a73e61a5813c5d2e77a4e) |
| MerchantRegistry handed to the registry admin (`transfer-registry-owner.mjs --apply`) | [`0x34f00f29…`](https://testnet.monadscan.com/tx/0x34f00f294ef9da35f43c08bb1606e6dc10a9119cd8ab92632922cf1a60bef710) |

The deployment record names both (`roles.relayer`, `roles.registryAdmin`), and
`check:deployment:monad` reads them back (65 of 65). The dev relayer
`0x5e69…2c69` is kept in `roles.previousRelayers`: it still holds its roles
(PolarisPayments operator and BatchSettlement settler, which the deployer
can revoke with `setOperator(…, false)` and `setSettler(…, false)`; and
MerchantRegistry operator, which only lets it relay a merchant's own signed
`registerFor`, and which only the registry's new owner could revoke, after the
admin key quorum widened its policy). Nothing was revoked in this run.

## The evidence

- **`privy:prove-policy -- --run`**: Privy signed the three allowed calls
  (PolarisCheckout `pay`, AUSD `transferWithAuthorization` of $0.10,
  CollateralVault `lockWithPermit` of $0.10) and refused all seven others with
  `policy_violation`: `lockWithPermit` of 0, the vault's `seize`, a $0
  transfer, the same call carrying 1 wei of MON, the same call to another
  contract, `approve(attacker, max)`, and a plain MON transfer.
  [`docs/demo/testnet/privy-prove-policy.txt`](../../docs/demo/testnet/privy-prove-policy.txt)
- **`privy:smoke -- --run`** (through `privy:smoke:harness`, which starts the
  server with `RELAYER_MODE=privy` and gives it a merchant key and a
  throwaway buyer): a $0.50 Pay now,
  [`0x5ef22fce…`](https://testnet.monadscan.com/tx/0x5ef22fced32a6c4d2192a25691caddbf604700934bd505a35830e77922c4f983),
  sent by the Privy relayer to PolarisCheckout, session `complete / paid`,
  the buyer at 0 MON and nonce 0.
  [`docs/demo/testnet/privy-smoke.txt`](../../docs/demo/testnet/privy-smoke.txt)
- **`smoke:testnet -- --run`**: every buyer and merchant action, 14 of 14,
  15 transactions from the Privy relayer and 2 from the Privy registry
  admin; five fresh accounts at 0 MON and nonce 0 before and after.
  [`docs/demo/testnet/README.md`](../../docs/demo/testnet/README.md), read back
  independently by `smoke:testnet:verify`
  ([`verify-run.txt`](../../docs/demo/testnet/verify-run.txt)).

## The server's settings

`apps/business/.env.local` (git-ignored) now carries `RELAYER_MODE=privy`,
`PRIVY_RELAYER_WALLET_ID`, `PRIVY_RELAYER_ADDRESS`, `PRIVY_RELAYER_AUTH_KEY`,
`PRIVY_RELAYER_POLICY_ID`, `REGISTRY_ACTIVATOR=privy`,
`PRIVY_REGISTRY_WALLET_ID`, `PRIVY_REGISTRY_ADDRESS`,
`PRIVY_REGISTRY_AUTH_KEY`, `PRIVY_ADMIN_QUORUM_ID`, `PRIVY_PAYOUT_SIGNER_ID`,
`NEXT_PUBLIC_PRIVY_PAYOUT_SIGNER_ID`, `PRIVY_PAYOUT_SIGNER_KEY`,
`POLARIS_DEPLOYMENT=monad-testnet` and `POLARIS_RPC_URL`, so
`pnpm --filter @polaris/business dev` relays through the Privy server wallet
on Monad testnet. A hosted server needs the same lines, plus the production
ones in the README ("Hosting").

## What only you can do in the Privy dashboard

The API can't change these:

1. **Login methods**: turn on email and Google (Login methods), if you want
   Google on the business sign-in.
2. **Allowed domains**: add the hosted business and app origins.
3. **The admin key**: move `apps/business/.privy-admin.key` into a password
   manager and delete the file. It is the only key that can change the two
   policies or the wallets.
4. Optional, not needed for gasless (below): native gas sponsorship.

## Gas sponsorship: what Privy offers, and why Polaris doesn't need it

Read on docs.privy.io on 28 Sep 2026
([overview](https://docs.privy.io/wallets/gas-and-asset-management/gas/overview),
[setup](https://docs.privy.io/wallets/gas-and-asset-management/gas/setup),
[Ethereum](https://docs.privy.io/wallets/gas-and-asset-management/gas/ethereum)):

- Privy's **native gas sponsorship** lists **Monad Testnet** (and Monad) among
  its EVM networks. It upgrades the wallet with **EIP-7702** and pays through
  Privy's paymaster; a transaction is sponsored by passing `sponsor: true` to
  `sendTransaction` (React `useSendTransaction`, or the Node SDK's
  `wallets().ethereum().sendTransaction`). It only covers transactions the
  wallet itself sends (`eth_sendTransaction`).
- **It can't be turned on through the API.** It needs the dashboard, TEE
  execution for the app, and credits.

**Polaris doesn't use it, and doesn't need it.** No Polaris user or merchant
wallet ever sends a transaction:

- a buyer, a sender, a link's recipient and a borrower only sign EIP-712 /
  ERC-2612 / ERC-3009 messages;
- a merchant's Privy embedded wallet only signs typed data too: its
  `MerchantRegistry` Registration, its withdrawals
  (`TransferWithAuthorization`) and a payout address change;
- the relayer, a Privy server wallet held to its policy, sends every one of
  those as a transaction and pays the gas from its own MON (route B:
  `eth_signTransaction` in Privy's enclave, broadcast by us, with the gas limit
  set from `estimateGas` + 15%, because Monad bills the limit).

So "gasless" does not depend on a dashboard switch, and every action is
gasless on Monad testnet today. The plan also rules EIP-7702 out on purpose
(plan §5.3, research §8): Monad keeps a reserve balance on 7702-delegated
accounts, and Mera accounts are plain EOAs.

If you want Privy to pay the relayer's own gas as well (the one wallet that
holds MON), these are the dashboard steps, which only you can take:

1. Privy dashboard → **Fee sponsorship** → **Add credits** (prepaid), or turn
   on postpaid billing.
2. Turn on **Sponsor gas fees**.
3. Under **Supported chains**, select **Monad Testnet**.
4. Make sure the app uses **TEE execution** (a requirement of native
   sponsorship).

The relayer would then have to move from `eth_signTransaction` to Privy's
`eth_sendTransaction` with `sponsor: true` (route A), giving up setting its own
gas limit, and the relayer wallet would be 7702-upgraded. Not done here.
