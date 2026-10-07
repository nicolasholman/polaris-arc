# Polaris app (`@polaris/app`)

The consumer side of Polaris: a mobile-first, installable PWA where a buyer
creates an account with Face ID, pays merchant links in full, in four or on a
subscription, and sends dollars anywhere with a link. The plan is in
[`docs/plan.md`](../../docs/plan.md) (§2, §3.1, §5.3, §5.5, §5.6) and the visual
design in [`docs/design/system.md`](../../docs/design/system.md): dark, built
entirely from the shared library [`@polaris/ui`](../../packages/ui) (open
`/gallery` under `next dev` to see every component beside its reference; a
production build answers 404 there).

## Run it

Node 22.6+ and pnpm 10, from the repository root:

```bash
pnpm install
pnpm --filter @polaris/app dev          # http://localhost:3000
```

It needs Polaris for Business (`NEXT_PUBLIC_POLARIS_API_URL`, below): without
it every route shows "Polaris isn't configured on this build". `pnpm
demo:local` from the root runs the app against a local Polaris for Business
and chain.

| Command (with `pnpm --filter @polaris/app`) | What it does |
|---|---|
| `dev` | Next dev server |
| `build` / `start` | Production build and server |
| `typecheck` | `tsc --noEmit` (strict) |
| `lint` | ESLint with `eslint-config-next` |
| `check:signatures` | Checks every EIP-712 struct and nonce against the contracts' definitions (28 checks, no chain needed) |

Open it at **`http://localhost`**, not `127.0.0.1` or a LAN IP: WebAuthn only
accepts a domain name as the relying party, and `localhost` is the one domain
browsers allow over plain http.

## Environment

Copy [`.env.example`](.env.example) to `.env.local`. Everything is `NEXT_PUBLIC_*`,
inlined at build time, and public, except the optional server-side `FX_RPC_*`
and `POLARIS_ANDROID_*`, which are read per request.

| Variable | Default | What it is |
|---|---|---|
| `NEXT_PUBLIC_RP_ID` | the page's hostname | The WebAuthn relying party. **Production: `polarispay.app`**, so `app.` and `pay.` share one account per person. A passkey, and the account derived from it, belongs to this id forever. |
| `NEXT_PUBLIC_PRIVY_APP_ID` | unset | The Privy app (the dashboard's) behind **Continue with email**. Unset hides the option; Face ID works either way. |
| `NEXT_PUBLIC_PRIVY_CLIENT_ID` | unset | Optional: a Privy *app client* made for the web origin. |
| `NEXT_PUBLIC_BUILD_TARGET` | unset | `android` for a bundle built for a native Android shell only. The Android app in [`apps/android`](../android/README.md) is a Trusted Web Activity: it opens this app's hosted **web** build in Chrome, so it never sets this. |
| `NEXT_PUBLIC_PRIVY_ANDROID_CLIENT_ID` | unset | The Privy app client for a native Android build (read only when `NEXT_PUBLIC_BUILD_TARGET=android`). It is locked to the Android package, so the web build, and with it the Trusted Web Activity, never passes it as its `clientId`. |
| `NEXT_PUBLIC_DEV_SIGNER` | unset | `1` replaces Face ID with a random key in the tab's `sessionStorage`, for headless runs. A "Dev signer" badge is always on screen while it is set. Never set it in a deployment. |
| `NEXT_PUBLIC_CHAIN_ID` | `10143` | Monad testnet; `143` for mainnet |
| `NEXT_PUBLIC_RPC_URL` | viem's default for the chain | Read-only RPC (EIP-712 domains, permit nonces) |
| `NEXT_PUBLIC_EXPLORER_URL` | `https://testnet.monadvision.com` | Where "View receipt" goes |
| `NEXT_PUBLIC_AUSD_ADDRESS` | the API's | The dollar token. Unset: the one Polaris for Business's deployment reports; set, it must match it |
| `NEXT_PUBLIC_POLARIS_API_URL` | **required** | Polaris for Business (e.g. `http://localhost:3100`): the relayer (`POST /api/relay`), checkout sessions and payment links (`/api/public/…`), and the network's contracts and EIP-712 domains (`/api/public/network`). Unset: every route shows "Polaris isn't configured on this build", with no data, and nothing can be signed. |
| `NEXT_PUBLIC_PAYMENTS_ADDRESS`, `_CHECKOUT_ADDRESS`, `_SEND_ADDRESS`, `_SPLIT_ADDRESS`, `_LOAN_ENGINE_ADDRESS` | unset | Polaris contracts (`_SPLIT_ADDRESS`: PolarisSplit, split-the-bill links; not on Monad testnet until `deploy-split:monad` runs, and Split a bill says so). They come from the API (and, if set here too, must match it, or the app refuses to sign). |
| `FX_RPC_MONAD`, `FX_RPC_ETHEREUM`, `FX_RPC_POLYGON`, `FX_RPC_BASE` | public RPCs (`packages/fx/src/feeds.ts`) | **Server only.** Comma-separated JSON-RPC URLs `/api/fx` reads the Chainlink FX feeds from (Monad mainnet, Ethereum, Polygon, Base). Read-only calls; no key needed |
| `POLARIS_ANDROID_SHA256_FINGERPRINTS` | unset | **Server only.** The SHA-256 fingerprints of the certificates the Android app is signed with, comma-separated (`AA:BB:…`, as `pnpm --filter @polaris/android fingerprint` prints). `/.well-known/assetlinks.json` serves them, which verifies the Android app. Unset: that route is 404 and the Android app shows an address bar |
| `POLARIS_ANDROID_PACKAGE` | `app.polarispay.twa` | **Server only.** The Android app's package name in `/.well-known/assetlinks.json` |

**Hosted** (Vercel, [`docs/deploy.md`](../../docs/deploy.md) step 2): every
`NEXT_PUBLIC_*` is compiled in, so set them in the project before it builds:
`NEXT_PUBLIC_POLARIS_API_URL`, `NEXT_PUBLIC_CHAIN_ID=10143`, and
`NEXT_PUBLIC_RP_ID` (the Face ID domain, which accounts are tied to for good).
`GET /api/health` reports what the build has (the API, chain, relying party,
and that the dev signer and local demo switches are off), for
`scripts/deploy-check.mjs`.

## With Polaris for Business (the real relayer)

Set `NEXT_PUBLIC_POLARIS_API_URL` to the business app (`http://localhost:3100`
locally) and every Confirm goes to its relayer, `POST /api/relay`; checkout
links (`/pay/cs_test_…` from a merchant's `polarispay-sdk` session,
`/pay/pl_…` from a dashboard payment link) load from its public API. Against
a local Hardhat node also set `NEXT_PUBLIC_CHAIN_ID=31337` and
`NEXT_PUBLIC_RPC_URL=http://127.0.0.1:<node port>`: the app refuses to sign
for a network other than the one it was built for.

Everything on screen is the account's own (`src/lib/data/live.ts`):
the balance is `AUSD.balanceOf` read from the chain; Boost is
`CollateralVault.lockedOf` (and the vault's `creditMultiplierBps`), read from
the chain at the vault `/api/public/network` reports (no vault, no Boost);
plans, subscriptions and
activity come from `/api/public/buyers/{address}` (the API's records of chain
events); the credit line, score and reasons from `/api/public/credit/{address}`
(ScoreManager and the CRE workflow's explained decision); a send link's state
from `PolarisSend`; a split's shares and who paid them from
`/api/public/splits/{id}` (PolarisSplit's own state, with when each share
landed). *Raise your limit* signs the account's consent (Face ID)
and the history wallet's link proof (its own prompt), and the API fires the
CRE underwriting workflow (`src/lib/underwriting.ts`).

*Add to Boost* (the Boost face in Select account, the Credit line sheet's
Boost row, and the desktop Credit page) is the way to raise the limit that
needs no data provider: the buyer picks an amount on the keypad (more than
zero, at least $0.10, no more than the dollar balance), and one Face ID
signs an ERC-2612 permit on the dollar (spender: the vault the deployment
record names, value: exactly the amount, under the domain the API reports).
The relayer carries it as `lockCollateral` to
`CollateralVault.lockWithPermit`, and ScoreManager's `creditLimitOf` counts
it at once (up to 1.5× by the vault's default multiplier, face value for an
account with no unsecured line yet). The success sheet shows Boost and the
Pay later limit read back from the chain afterwards (`src/lib/boost.ts`,
`src/components/boost-sheet.tsx`).

*Take out of Boost* is the same sheet's other side (and a row or button of
its own beside Add to Boost on the Credit line sheet and the desktop Credit
page). It offers what `CollateralVault.withdrawable(owner)` says is free:
everything in Boost, or nothing while a Pay in 4 plan is open, because the
vault releases no collateral while any debt is outstanding (the sheet then
says the Boost secures the plan). The amount is at least $0.10 and leaves
either nothing or at least $0.10 behind; the sheet names exactly what the
limit loses. One Face ID signs the vault's EIP-712 `Withdraw` (borrower,
amount, the vault's `nonces(borrower)`, a deadline 15 minutes out) under the
domain read from the vault itself (ERC-5267); the relayer carries it as
`withdrawCollateral` to `CollateralVault.withdrawWithSig`, which pays the
account and nobody else. "Taken out." shows Boost, the limit and the dollar
balance read back from the chain. A vault that predates signed withdrawal,
Monad testnet's today (the testnet contracts are frozen; the redeploy is in
[`docs/DEPLOY-LATER.md`](../../docs/DEPLOY-LATER.md)), has no domain to
read, and there the sheet says "Taking them out isn't available on this
network yet."

Without it there is no offline demo: every route shows one screen, "Polaris
isn't configured on this build" (`src/components/not-configured.tsx`, in the
phone layout and in ref E's frame from 1024px), with no balances, links or
activity, and nothing can be signed: every EIP-712 domain comes from the API
(`src/lib/domains.ts`), and there is no other relayer.

## Accounts

One interface (`AccountImplementation` in `src/lib/account/index.ts`), three
implementations; the rest of the app never asks which one is in use:

| Source | How you get in | What signs |
|---|---|---|
| `mera` | **Face ID**, the primary sign-up | A key derived from the passkey's PRF (below) |
| `privy` | **Continue with email**, beneath Face ID: an email code, and Privy creates an embedded wallet on login (`createOnLogin: "users-without-wallets"`; the Privy dashboard leaves it off, so the client asks) | The embedded wallet, through Privy's `useSignTypedData`, with no Privy UI. `src/lib/account/privy.ts` wraps it as a viem account, and every signature is checked to recover to the wallet before it is used |
| `dev` | `NEXT_PUBLIC_DEV_SIGNER=1` | A key in the tab's `sessionStorage` |

All three sign the same EIP-712 payloads (`src/lib/actions.ts` is unchanged by
which one is in use). Only email is offered: Google is off in the Privy app.
The email sheet is ours (`components/email-login-sheet.tsx`); it never says
wallet.

### Face ID (Mera)

[Mera](https://mera.category.xyz): no seed phrase, no extension, no custody
backend.

```
Face ID ─► passkey PRF (32 bytes) ─► BIP-39 entropy ─► m/44'/60'/0'/0/0 ─► Mera signing session ─► viem LocalAccount
```

- `src/lib/account` exposes `createAccount()`, `continueWithEmail()`,
  `signIn()`, `getAccount()`, `authorize()` (what every Confirm calls) and
  `signOut()`.
- Only public metadata is stored, in `localStorage`: the credential id, its
  transports, the rpId and the account's address. The PRF output and the key
  are never stored; every sign-in recomputes them.
- Ceremonies only ever start from a tap. Creating an account and paying is
  **one** Face ID.
- The derivation path is frozen. The same passkey gives the same account on
  every device it syncs to.

### Receipts only you can read

The same Face ID that derives the wallet key also derives the keys that seal
the buyer's receipts. Polaris for Business stores what was bought only as
ciphertext sealed to the buyer; the app opens it on Activity.

```
                       ┌─► BIP-39 ─► m/44'/60'/0'/0/0 ─► the wallet key (unchanged)
Face ID ─► PRF (32 B) ─┼─► HKDF "polaris/v1/receipts/aes-256-gcm"     ─► AES-256-GCM key
                       └─► HKDF "polaris/v1/receipts/hpke-x25519-ikm" ─► X25519 inbox key pair (RFC 9180 DeriveKeyPair)
```

- **No extra Face ID.** The keys come from the PRF output of the ceremony
  that opens the account (`src/lib/account/mera.ts`), before it is zeroed
  (option A of `docs/research/mera.md` §16.3). They live in memory with the
  signing session and go with it (sign-out, leaving the page). Nothing is
  stored.
- **Registering the inbox.** Opening a session sends the inbox public key to
  `POST /api/receipts/inbox`, signed by the account (EIP-191, `Polaris
  receipts key <key>`), with no prompt (`src/lib/receipts/inbox.ts`). The
  server takes the signature as proof, never the ceremony. A checkout waits
  up to 4 s for a registration still in flight, so a first payment is sealed
  as it settles; anything that settled before is sealed when the
  registration lands.
- **Sealing.** When a payment settles, the server seals what was bought (the
  description, line items, order reference, the plan's schedule) to the
  inbox key with HPKE (`DHKEM(X25519, HKDF-SHA256)`, `HKDF-SHA256`,
  `AES-256-GCM`; `@hpke/core` 1.9.0 and the pure-JS `@hpke/dhkem-x25519`
  1.8.0), then drops the plaintext. The AAD is
  `polaris.receipt.v1|<owner, lower case>|<receipt id>`, so a row can't be
  served as another row or another buyer's. The code is shared with the API:
  [`packages/receipts`](../../packages/receipts/README.md).
- **Opening.** With the account open, the transaction sheet signs a read
  request (`POST /api/receipts`, five minutes) and opens the receipt with no
  prompt. With the account locked it shows **Only your Face ID can open
  this**, and *Open with Face ID* runs the sign-in ceremony and then opens it
  (`src/lib/receipts/index.ts`, `components/sealed-receipt.tsx`). On the
  Activity list, sealed rows carry a small lock until they are opened.
- **Email accounts** have no PRF, so no keys: their receipts are kept as they
  always were, and Settings says so (*Receipts only you can read: Off*).
- **The dev signer** derives the same keys from a stand-in PRF output,
  HKDF(dev key, `polaris/dev/v1/prf-stand-in`)
  (`src/lib/account/dev-receipts.ts`), so headless runs seal and open receipts
  the way Face ID does.
- **The AES key** is derived, non-extractable, and tested, but nothing in the
  app writes with it yet: it is for records the device keeps for itself
  (private notes on a receipt are next).

### Supported devices

From Mera's authenticator table (see `docs/research/mera.md` §12):

| Works | Doesn't |
|---|---|
| iPhone, iOS 18+ (Safari or Chrome, iCloud Keychain) | Desktop Chrome's local profile (it creates a passkey, then can't use it) |
| Android, Chrome or Edge (Google Password Manager) | Bitwarden, Dashlane |
| Mac, macOS 15+ (Safari, Chrome 132+, Firefox 139+) | Windows before 11 25H2 |
| Desktop Chrome signed in to Google Password Manager | In-app browsers (Instagram, Facebook, TikTok): the app says "Open in Safari or Chrome" |
| Windows 11 25H2+ (Edge, Chrome 147+, Firefox 148+) | |
| 1Password, Proton Pass, YubiKey 5 | |

A browser that can't hold an account gets **"Open Polaris on your phone"**
with a QR code of the page. Passkeys sync within one provider only (iCloud
Keychain across Apple devices, Google across Android and Chrome), so an
iPhone account doesn't appear on an Android tablet; *I already use Polaris*
is always offered before creating a second account.

### Testing without a phone

- **Chrome's virtual authenticator** exercises the real Mera path: DevTools →
  More tools → WebAuthn → *Enable virtual authenticator environment*, add a
  `ctap2` / `internal` authenticator with resident keys, user verification
  and **PRF** on. Scripts can do the same over CDP
  (`WebAuthn.addVirtualAuthenticator` with `hasPrf: true`), which is how
  Mera's own end-to-end tests run.
- **The dev signer** (`NEXT_PUBLIC_DEV_SIGNER=1`) skips WebAuthn entirely.
  It exists in `next dev` only: `next build` blanks the flag (see
  `next.config.ts`) unless `POLARIS_ALLOW_DEV_SIGNER_BUILD=1` is set, so a
  deployed build never holds a key in browser storage.
- **A phone** needs a real https domain inside the rpId, for example
  `dev.polarispay.app` with `NEXT_PUBLIC_RP_ID=polarispay.app`.

### The Android app

[`apps/android`](../android/README.md) wraps this app, as hosted, in a
Trusted Web Activity: an Android app whose screen is Chrome showing
`https://app.polarispay.app`. Face ID is the same WebAuthn ceremony as in
Chrome (the same rpId, the same Google Password Manager passkey), so one
account works in the tab, the installed PWA and the Android app. The site
proves the app is its own with `/.well-known/assetlinks.json`
(`src/app/.well-known/assetlinks.json/route.ts`, from
`POLARIS_ANDROID_SHA256_FINGERPRINTS`); without it Chrome still opens the app,
with an address bar.

## Screens

Only the five tabs are full screens, under ref A's floating nav. Everything
you *do* slides up as a `BottomSheet`, routed through the root layout's
`@sheet` parallel route: from inside the app an intercepting route
(`app/@sheet/(.)send` and so on) presents it over the current tab, which
scales back behind it like iOS; a cold link (a checkout link from a merchant)
opens the page itself, the sheet over a blurred tab. Back, the close button
and a swipe down close it and restore the URL. The sheet lives in a host
(`components/shell/sheet-host.tsx`) that outlives the route, so it springs
out again even when the browser's Back removed it.

| Route | Presentation | What it is |
|---|---|---|
| `/` | tab | Home (ref A): the lime balance card, quick transfer, recent activity |
| `/insights` | tab | My spending, Expenses by category, and `?view=plans`: Pay in 4, subscriptions, paid off |
| `/cards` | tab | Ref D's balance card with side squares, the three accounts, details |
| `/activity` | tab | All activity, grouped by day, with filter chips and Filters |
| `/profile` | tab | Who you are, how you sign in, settings, log out |
| `/send` | full sheet | Ref A's transfer: who, from which account, the amount, the keypad; a link (`/claim#k=…`) or straight to a Polaris account |
| `/receive` | half sheet | Your code and link for getting paid |
| `/add` | half sheet | Ask, show your code, or claim a link |
| `/pay` | full sheet | Scan a code or paste a link |
| `/pay/[id]` | full sheet | Checkout (ref C): Pay now, Pay in 4 or Subscribe, the limit, Raise your limit |
| `/claim` | full sheet | Reads the link's fragment, which never reaches a server; claim with one Face ID |
| `/split/new` | full sheet | Split a bill: the bill on the keypad, then equally between some people (you in or out, names optional) or by named amounts; one Face ID opens it; the link, its QR, Share and Copy. `?amount=…&people=…&name=…` or `&share=Name:amount` fills it in (polarispay-sdk `splits.link()`) |
| `/split/[id]` | full sheet | The split link. A friend: who asked and what for, "2 of 4 paid", their share (they pick their name when the shares are named), and **Pay with Face ID**, which makes their account in the same step; short of dollars, it says how much to add first. The organiser: who paid and when, Remind (the link again), Close split |
| `/accounts` | half sheet | Select account (the card carousel); which one Home shows |
| `/activity/[id]` | half sheet | Payment details and *View receipt*; an unclaimed send link can be cancelled here |
| `/plans/[id]` | half, drags to full | Plan detail and *Pay early* |
| `/credit` | full sheet | Credit line (ref B): active plans, upcoming payments |
| `/credit/score` | full sheet | Credit score, line or candles, week by week |
| `/notifications` | half sheet | Payments due, money in, links claimed |
| `/settings` | half sheet | Name on links, local currency, log out, remove from this device |
| `/onboard?next=…` | page | Three pages (ref B), then Face ID with *Continue with email* beneath |
| `/gallery` | page | Every `@polaris/ui` component (`next dev` only; 404 in a production build) |

Inside those: Confirm with Face ID (compact: it fits its content), the success
receipt with its check-mark (half), Filters, and Continue with email. A sheet
opened over another stacks above it, with its own dimmed backdrop.

The buyer never reads *wallet, address, seed phrase, passkey, sign, approve,
transaction, gas, MON, AUSD, USDC, token, blockchain, on-chain* or *Monad*. The
exceptions are the optional *Raise your limit* step, which says "wallet"
because it is for people who already have one, and Home's small "USD · AUSD"
tag, which names what the dollars are held in (plan.md, "Words the buyer never
sees").

Pay in 4 charges nothing at checkout, as the contracts do: the merchant is paid
from the credit pool, and payment 1 is due one interval after the plan opens
(`PolarisLoanEngine.installmentDueAt(i) = startedAt + (i + 1) × interval`).
$200 at 10% a year over four weeks is 4 × $50.38, $1.53 of interest.

### From 1024px: the customer web

The same routes render ref E's desktop layout from 1024px (`<html
data-theme-lg="ref-e">`, `Adaptive` in the tabs layout, screens in
`src/desktop/`): the lime canvas, the dark panel and the top nav, like the
merchant web. Below 1024px nothing changes.

| Route | From 1024px |
|---|---|
| `/` | Home: Balance / USD chart (line or candles, 1h to 1m), recent activity, the SEND / RECEIVE widget and your credit |
| `/activity`, `/cards`, `/insights`, `/profile` | Pages in the frame |
| `/plans` | Pay in 4: every plan with its ticks, subscriptions (a phone goes to `/insights?view=plans`) |
| `/activity/[id]`, `/plans/[id]`, `/notifications` | Right Drawer |
| `/send`, `/receive`, `/add`, `/pay`, `/claim`, `/accounts`, `/split/new`, `/split/[id]` | Centred Dialog |
| `/credit`, `/credit/score`, `/settings` | Pages in the frame |
| `/pay/[id]` | The checkout card on its own, under the wordmark |
| `/onboard` | Sign-up beside the animated art |

The desktop shell is `src/components/shell/desktop-shell.tsx`; the route
sheets say how they present with `desktop` on `<RouteSheet>`.

With no account on this device, the nav's pill reads "Create your account"
and pressing it starts one.

## Local currency

Under a dollar amount the app prints what it is in the viewer's currency, at
the live Chainlink rate: **"≈ ARS 161.241 · Chainlink rate, 3 min ago ·
indicative"**. It shows on the claim screen, Send (phone keypad and the
desktop form), the "Link ready." sheet, the checkout total (so a Halcyon buyer
sees it too), and payment details. The currency is
the one the browser's language implies (es-AR → ARS), or the one picked in
Settings. Nothing is ever priced or paid in it.

- `GET /api/fx?currency=ARS` (`src/app/api/fx/route.ts`) reads the rate on the
  server with `@polaris/fx` ([its README](../../packages/fx/README.md) has the
  feed table, every address verified on chain): Chainlink's `latestRoundData`,
  normalised to local units per dollar, cached five minutes.
- `src/lib/fx.ts` fetches it once per currency per five minutes for the whole
  tab; `components/local-equivalent.tsx` prints the line and its age.
- **No rate, no line.** Currencies Chainlink has no feed for (CLP, PEN, NOK,
  PKR, VND, MYR, KES, GHS, EGP, AED), a rate older than 26 hours, or an RPC that
  can't be reached all hide the line. Settings offers only currencies with a
  rate, and says so when the automatic one has none.
- EUR, GBP, JPY, CHF and CAD come from Monad mainnet's feeds; the other 18
  from Ethereum, Polygon or Base. Some of those update once a day, which is
  why the age is always shown.

## Chainlink in the app

Three things a buyer sees come from Polaris's Chainlink CRE workflows (the
API serves them; see apps/business "Chainlink"). Captures of each state are
in [`docs/design/chainlink`](../../docs/design/chainlink).

- **The risk guard.** While the guardian has paused credit, the checkout
  (phone and from 1024px) keeps Pay in 4 on screen as unavailable, with
  *Pay in 4 is paused by our risk guard; pay now works as usual.* and a
  button to pay now; the credit line says the same. A guard that is late
  blocks nothing (it fails open), and the checkout's Pay in 4 and the credit
  line say *Risk guard last checked 72 min ago · Pay in 4 stays on*. From the
  session (`payIn4.guard`) and `GET /api/public/credit-guard`
  (`src/lib/credit-guard.ts`, `components/credit-guard-note.tsx`).
- **Sign again.** When a payment couldn't be collected because the approval
  to take it was reset, Home, the plan sheet and the plan drawer say *Sign
  again to pay your instalment*. One Face ID signs an ERC-2612 permit to the
  loan engine for everything owed (`reauthorizePayments` in
  `src/lib/actions.ts`), the relayer carries it to
  `PolarisCheckout.reauthorize`, and the plan polls the API every 2 s until
  the collection that follows lands: *Collected*, with its receipt
  (`components/sign-again.tsx`, `src/lib/collection.ts`). The amount carries
  the Chainlink FX line.
- **Where the line came from.** The credit line and score show the
  underwriting report's date and transaction (`components/credit-provenance.tsx`,
  `src/lib/provenance.ts`), only for a line a report opened; the reasons are
  the report's own. It says "Verified by Chainlink CRE" only for a report
  Chainlink's DON signed (the API's `delivery: "don"`, through Chainlink's
  KeystoneForwarder); a simulated run reads "Chainlink CRE (simulated)" and a
  local one "CRE workflow, local run", in a plain pill instead of the lime
  shield. A line no report opened shows none.

`pnpm --filter @polaris/app test` checks the guard and collection states
(node --test, `test/`).

## Code map

| Path | What it is |
|---|---|
| `src/lib/account/` | The account layer: one interface; Mera (Face ID), Privy (email) and the dev signer; capability check |
| `src/lib/sign/` | EIP-712 builders for `PlanIntent`, `SubscribeIntent`, ERC-3009, ERC-2612, `Claim`, `Cancel`, `CancelSubscription`, `CreateSplit`, `CloseSplit`; domain reading (ERC-5267); nonce derivations (a split's id, a share's nonce) |
| `src/lib/split.ts` | Split-the-bill links: the words in the link's fragment and their hash (what the organiser signs), equal shares to the micro-dollar, the create form's plan and its prefill, what this device knows (`polaris.splits.v1`) |
| `src/lib/actions.ts` | Each money action: build, sign, relay |
| `src/lib/receipts/` | Receipts only you can read: registering the inbox key (`inbox.ts`), reading and opening sealed receipts with the session (`index.ts`), pairing them with Activity rows (`pair.ts`) |
| `src/lib/relayer.ts` | The relayer client: `POST {NEXT_PUBLIC_POLARIS_API_URL}/api/relay`, errors mapped to `RelayError` with the server's message for the buyer. The only relayer |
| `src/lib/network.ts`, `src/lib/api.ts` | The network (contracts and EIP-712 domains) from Polaris for Business; the fetch helper |
| `src/lib/data/remote.ts` | Real checkout links: `cs_…` sessions and `pl_…` payment links, mapped to `PaymentLink` |
| `src/lib/checkout-return.ts` | The `polaris:checkout` postMessage protocol back to the merchant page (`announceReady`, `finishCheckout`, `cancelCheckout`) |
| `src/lib/data/` | The data interface every screen reads: `live.ts` (the chain and the API) |
| `src/components/not-configured.tsx` | The only screen of a build without `NEXT_PUBLIC_POLARIS_API_URL` (the Providers render it on every route) |
| `src/app/api/fx/route.ts`, `src/lib/fx.ts` | The Chainlink rate behind the local-currency line: the server route (`@polaris/fx`) and the tab's shared, cached fetch |
| `src/app/.well-known/assetlinks.json/route.ts`, `src/lib/assetlinks.ts` | Digital Asset Links for the Android app (`test/assetlinks.test.ts`) |
| `src/app/manifest.ts`, `src/app/icons/[name]/route.tsx` | The web app manifest, and its icons from `@polaris/brand` (the Android app's launcher, splash and shortcut icons come from the same URLs) |
| `src/lib/underwriting.ts` | Pay in 4 credit: consent and link-proof signatures, the CRE underwriting request, waiting for the decision |
| `src/lib/credit-guard.ts`, `src/lib/collection.ts` | The risk guard in the buyer's words; a plan's collection after a lost approval (sign again, collecting, collected) |
| `src/desktop/` | The desktop layouts (from 1024px): Home and its money widget, the pages, the checkout card, onboarding; `lib/series.ts` draws their charts |
| `src/screens/`, `src/sheets/` | The five tabs, and every sheet with its route wrapper (`SendRoute`, `CheckoutRoute`…), which the pages in `app/(tabs)` (cold) and `app/@sheet` (intercepted) render |
| `src/components/` | App pieces composed from `@polaris/ui`: the shell (stage, sheet host, nav), Confirm with Face ID, the success receipt, the email sheet, QR |
| `src/lib/view.ts` | Figures the screens derive from the data layer (spending by category, the score week by week) |
| `public/assets/` | Generated images, picked up as soon as they exist (see below) |

## Images

Two kinds of generated image are read from fixed paths, each with a drawn
stand-in, so dropping the files in needs no code change:

| Path | What it is | Until it exists |
|---|---|---|
| `public/assets/coin.png` | The 3D coin on the claim card | — |
| `public/lottie/onboarding-{1,2,3}.json` | The onboarding animations (played with lottie-react) | The glass renders in `public/assets/onboarding/`, floating |
| `public/assets/avatars/<first name>.jpg` | A person's portrait, e.g. `marisol.jpg`, `tomas.jpg` (lower case, no accents) | Tinted initials |

## Not built yet

- Contacts: there is no address book yet, so with the API set the contact
  list is empty.
- Send-by-link activity: the API doesn't record sends yet (the Envio
  indexer's `send(linkKey)` would); a link's own state is read from the chain.
- *Raise your limit* connects the history wallet through the browser's own
  provider (an extension, or a wallet app's browser); WalletConnect for a
  wallet on another device is not wired yet. On `pnpm demo:local` (chain
  31337, `NEXT_PUBLIC_LOCAL_DEMO=1`) a stand-in key signs when the browser
  has no wallet, and the screen says its history is a sample.
- The opt-in recovery key. (Receipts only you can read are built; see
  [above](#receipts-only-you-can-read). Opening one with a real Face ID on a
  phone is untested, like every Face ID path here, until the app is hosted.)

The hosted checkout (`/pay/[id]`) speaks polarispay-sdk's v1 postMessage
protocol (`src/lib/checkout-return.ts`): `ready` on load (`expired` for an
expired session), `completed` the moment the payment is final, `canceled`
when the buyer backs out; a popup closes itself, a redirect goes to the
session's `successUrl` or `cancelUrl`. It opens on the mode the merchant's
page chose (the session's first mode).
