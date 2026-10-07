import { withPreflight, withPublic } from "@/server/auth";
import { requireChain } from "@/server/chain/client";
import { getConfig } from "@/server/env";
import { ok, methodNotAllowed } from "@/server/http";
import { polarisDomain } from "@/server/relayer/typed-data";

export const dynamic = "force-dynamic";

/**
 * The network the relayer carries: chain, contract addresses and the EIP-712
 * domains they sign under (from the deployment record, which the deploy
 * script read from the contracts themselves). The Polaris app builds every
 * typed-data payload from this, so a buyer never signs against a guessed
 * domain.
 */
export const GET = withPublic(async () => {
  const config = getConfig();
  const chain = requireChain();
  const c = chain.contracts;
  return ok({
    chainId: chain.id,
    name: chain.name,
    explorerUrl: chain.explorerUrl,
    // `split` is null on a deployment that predates PolarisSplit: the app then doesn't offer split links.
    contracts: { stablecoin: c.stablecoin, payments: c.payments, checkout: c.checkout, send: c.send, split: c.split, loanEngine: c.loanEngine, registry: c.registry, vault: c.vault },
    domains: {
      stablecoin: { ...chain.stablecoinDomain, chainId: chain.id, verifyingContract: c.stablecoin },
      checkout: polarisDomain("checkout", chain.id, c.checkout),
      payments: polarisDomain("payments", chain.id, c.payments),
      send: polarisDomain("send", chain.id, c.send),
      split: c.split ? polarisDomain("split", chain.id, c.split) : null,
      loanEngine: polarisDomain("loanEngine", chain.id, c.loanEngine),
    },
    payIn4: { ...config.payIn4, aprBps: 1000 },
    relayer: { available: config.relayer.mode !== "off" },
  });
});

export const OPTIONS = withPreflight("app");

/* Everything else answers a JSON 405 naming what the route accepts. */
const notAllowed = methodNotAllowed(["GET"]);
export const POST = withPublic(notAllowed);
export const PUT = withPublic(notAllowed);
export const PATCH = withPublic(notAllowed);
export const DELETE = withPublic(notAllowed);
