# Polaris app (`@polaris/app`)

The consumer side of Polaris on **Arc**, Circle's stablecoin-native chain: a
mobile-first, installable PWA where a buyer creates an account with Face ID
(a passkey), pays merchant links in full, in four or on a subscription, sends
dollars or euros anywhere with a link, and adds money from another chain with
Circle's CCTP. Money is USDC (and EURC); every payment is final in under a
second; there is no gas to buy, because Arc's gas is USDC and Polaris's
relayer pays it. The visual design is built entirely from the shared library
[`@polaris/ui`](../../packages/ui) (open `/gallery` under `next dev`; a
production build answers 404 there).

## Run it

Node 22.6+ and pnpm 10, from the repository root:

```bash
pnpm install
pnpm --filter @polaris/app dev          # http://localhost:3000
```

It needs Polaris for Business (`NEXT_PUBLIC_POLARIS_API_URL`): without it
every route shows "Polaris isn't configured on this build", and nothing can be
signed. Open it at **`http://localhost`**, not `127.0.0.1`: WebAuthn only
accepts a domain name as the relying party.

| Command (with `pnpm --filter @polaris/app`) | What it does |
|---|---|
| `dev` | Next dev server |
| `build` / `start` | Production build and server |
| `typecheck` | `tsc --noEmit` (strict) |
| `lint` | ESLint with `eslint-config-next` |
| `test` | `node --test` over `test/` (env, the credit guard and keeper report, links and currencies, reads against the contracts' ABIs, receipts, splits, Boost) |
| `check:signatures` | Every EIP-712 struct and nonce against the contracts' Solidity sources (57 checks, no chain needed) |

## Environment

Copy [`.env.example`](.env.example) to `.env.local`; every variable is
documented there. Everything is `NEXT_PUBLIC_*` (inlined at build time, public)
except the server-only `FX_RPC_*`. The ones that matter:

| Variable | Default | What it is |
|---|---|---|
| `NEXT_PUBLIC_POLARIS_API_URL` | **required** | Polaris for Business: the relayer, checkout sessions, and the network's contracts and EIP-712 domains (`/api/public/network`) |
| `NEXT_PUBLIC_CHAIN_ID` | `5042002` | Arc testnet; `5042` Arc mainnet; `31337` a local Hardhat node |
| `NEXT_PUBLIC_RPC_URL` | `https://rpc.testnet.arc.io` (by chain) | Read-only RPC |
| `NEXT_PUBLIC_EXPLORER_URL` | `https://explorer.testnet.arc.io` (by chain; none on 31337) | Where "View receipt" goes |
| `NEXT_PUBLIC_RP_ID` | the page's hostname | The WebAuthn relying party; accounts are tied to it for good |
| `NEXT_PUBLIC_USDC_ADDRESS`, `_EURC_ADDRESS`, `_PAYMENTS_ADDRESS`, `_CHECKOUT_ADDRESS`, `_SEND_ADDRESS`, `_SEND_EURC_ADDRESS`, `_SPLIT_ADDRESS`, `_LOAN_ENGINE_ADDRESS` | unset | Pins. Unset, each comes from the API; set, it must match the API or the app refuses to sign |

`GET /api/health` reports what a build was compiled with (API, chain, relying
party, and that the dev signer and local switches are off).

## How it talks to Arc

- **Signing.** Every money action is an EIP-712 signature the relayer
  (`POST /api/relay`) carries to the chain (`src/lib/actions.ts`,
  `src/lib/relayer.ts`). Every domain comes from `/api/public/network`
  (`src/lib/network.ts`, `src/lib/domains.ts`). USDC is
  `{ name: "USDC", version: "2" }` and EURC `{ name: "EURC", version: "2" }`;
  neither implements ERC-5267, so the app never calls `eip712Domain()` on
  them (`readTokenDomain` in `src/lib/sign/domain.ts` rebuilds a token domain
  from `name()`/`version()` and checks it against `DOMAIN_SEPARATOR()`). Polaris
  contracts do implement ERC-5267 (the vault's domain for *Take out of Boost*
  is read that way).
- **Reads.** Balances are the ERC-20 `balanceOf` of USDC (and EURC), 6
  decimals. Arc's native balance is the same dollars in 18 decimals; the app
  never reads it. Plans, activity and the credit line come from the API's
  records of chain events (`src/lib/data/live.ts`).
- **Accounts.** Face ID derives an ordinary secp256k1 key from the passkey's
  PRF output (the chain-agnostic `@category-labs/mera` library;
  `src/lib/account/derive.ts` fixes the derivation, so the same passkey always
  gives the same account). "Continue with email" uses a Privy embedded wallet.
  Either way the account is a plain EOA on Arc that never needs gas.
- **Receipts only you can read.** The same PRF output derives the keys that
  seal the buyer's receipts ([`packages/receipts`](../../packages/receipts/README.md)).

## Arc features in the app

- **Add money from another chain** (`src/sheets/add-money.tsx`,
  `src/components/cross-chain-deposit.tsx`, `src/lib/cctp.ts`). For each
  source chain in `/api/public/network` `cctp.sources`, the buyer connects
  the browser wallet that holds USDC there; the app switches (or adds) the
  chain, approves `TokenMessengerV2`, and calls
  `depositForBurn(amount, 26, bytes32(account), usdc, 0x0, 0, 2000)` (a
  standard transfer). It then polls `POST /api/public/cctp/mint
  {sourceDomain, txHash}` until Polaris's relayer has minted it on Arc and
  shows **Arrived on Arc** with the mint transaction. Standard transfers wait
  for the source chain's finality (minutes on testnet), and the sheet says
  so; the burn is kept on the device so the wait survives a reload. No
  browser wallet, the wrong network, too little USDC, no gas on the source
  chain and a failed mint each have their own message.
- **Faucets.** On Arc testnet Add money links to Circle's faucet
  (https://faucet.circle.com); on a local chain (31337) it offers the local
  faucet (`NEXT_PUBLIC_LOCAL_FAUCET_URL`).
- **Send in euros.** Where the deployment has `contracts.sendEurc`, Send
  offers Dollars or Euros for a link. Euros sign EURC's
  `ReceiveWithAuthorization` to the PolarisSend on EURC (under
  `domains.eurc`) and the link key's `Open` under `domains.sendEurc`; the
  relay actions carry `currency: "EUR"`. The link says so (`/claim#…&c=EUR`),
  so claiming and cancelling go to the same contract (`src/lib/links.ts`).
  The EURC balance shows beside the dollar balance.
- **Credit guard.** CreditGuard on Arc reads the credit pool live and pauses
  new Pay in 4 plans for low pool cash, bad debt, or the owner's pause; the
  checkout and the credit line say so and Pay now carries on
  (`src/lib/credit-guard.ts`, `src/components/credit-guard-note.tsx`).
- **Reviewed by the Polaris keeper.** A credit line opened by the keeper's
  underwriting report shows "Reviewed by the Polaris keeper" with the report
  transaction on the Arc explorer (`src/lib/provenance.ts`,
  `src/components/credit-provenance.tsx`).

## Local currency

Under a dollar amount the app can print the viewer's currency at a Chainlink
FX rate read from Ethereum, Polygon or Base by the server (`/api/fx`,
`@polaris/fx`); it is display only, and nothing here claims Chainlink runs on
Arc. No rate, no line.

## Code map

| Path | What it is |
|---|---|
| `src/lib/account/` | Face ID (passkey), Privy (email) and the dev signer, behind one interface |
| `src/lib/sign/` | EIP-712 builders, token and contract domain readers, nonce derivations |
| `src/lib/actions.ts`, `src/lib/relayer.ts` | Each money action (build, sign, relay) and the relayer client |
| `src/lib/network.ts`, `src/lib/domains.ts`, `src/lib/env.ts`, `src/lib/chain.ts` | The network from Polaris for Business; Arc's chain config |
| `src/lib/cctp.ts` | CCTP V2 from another chain: wallet, approve, burn, mint polling |
| `src/lib/data/` | Every read the screens make (`live.ts`) |
| `src/screens/`, `src/sheets/`, `src/desktop/` | Tabs, route sheets, and the layouts from 1024px |
| `src/components/` | App pieces composed from `@polaris/ui` |
