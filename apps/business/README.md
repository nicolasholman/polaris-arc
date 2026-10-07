# Polaris for Business

The merchant side of Polaris on Arc: the landing page, sign-in (Privy), the
dashboard, the public and merchant APIs, the relayer that carries every buyer
signature to Arc, signed webhooks, payouts, and the bridge between the app and
the keeper.

## What it does on Arc

- **Relayer** (`src/server/relayer`): `POST /api/relay` verifies each signed
  action (EIP-712 / ERC-2612 / ERC-3009 on USDC and EURC), checks it against
  the allow-list (`src/server/policy/relayer.ts`, the same list the Privy
  policy is generated from), simulates, and sends it with gas paid in USDC at
  or above Arc's 20 gwei floor. Checkout calls go through Arc's **Memo**
  contract with the order key as `memoId`; the response carries `memoId`.
- **Pay from any chain** (`src/server/cctp.ts`, `POST /api/public/cctp/mint`):
  finishes a buyer's CCTP V2 transfer into Arc from Circle's Iris attestation
  (`MessageTransmitterV2.receiveMessage`). `GET /api/public/network` lists the
  source chains.
- **Euros by link**: `send`, `claim` and `cancelSend` take `currency: "EUR"`
  and route to `PolarisSend` on EURC.
- **Keeper bridge**: credit reviews are queued and sent, signed, to the keeper
  (`KEEPER_UNDERWRITING_URL`); its signed callbacks land on
  `POST /api/keeper/callback`. The dashboard's **Automation** page shows the
  keeper's jobs, its USDC gas balance and the credit guard.
- **Chain sync** (`src/server/ingest`): reads the contracts' logs from Arc's RPC
  (2,000 blocks a request) and turns them into payments, plans, webhooks and
  the buyer's book (USDC and EURC moves, CCTP arrivals as "added").

## Run

```bash
cp .env.example .env.local     # every variable is documented there
pnpm dev                       # http://localhost:3100
pnpm test                      # 300 tests (vitest)
pnpm typecheck && pnpm lint
pnpm e2e:local                 # the backend end to end on a local node, 14 checks
```

`pnpm e2e:local` deploys with the Arc deploy script on a Hardhat node, starts
this server with the dev relayer, and checks with `polarispay-sdk`: Pay now,
the keeper's underwriting report, Pay in 4, the SDK's direct pay, a euro send
link sent and claimed, the real keeper (`services/keeper --once`) collecting
instalment 1, and every webhook verified.

For Arc testnet, set `POLARIS_DEPLOYMENT=arc-testnet`; for mainnet,
`arc-mainnet` with a Privy relayer ([MAINNET.md](../../MAINNET.md)).
