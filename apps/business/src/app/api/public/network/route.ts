import { withPreflight, withPublic } from "@/server/auth";
import { requireChain } from "@/server/chain/client";
import { getConfig } from "@/server/env";
import { ok, methodNotAllowed } from "@/server/http";
import { cctpSourcesFor } from "@/server/cctp";
import { polarisDomain } from "@/server/relayer/typed-data";

export const dynamic = "force-dynamic";

/**
 * The network the relayer carries: chain, contract addresses and the EIP-712
 * domains they sign under (from the deployment record, which the deploy
 * script read from the contracts and from USDC/EURC themselves), Circle's
 * contracts on Arc, and the chains a buyer can pay from (CCTP V2). The
 * Polaris app builds every typed-data payload from this, so a buyer never
 * signs against a guessed domain.
 */
export const GET = withPublic(async () => {
  const config = getConfig();
  const chain = requireChain();
  const c = chain.contracts;
  const circle = chain.circle;
  const sources = cctpSourcesFor(chain);
  return ok({
    chainId: chain.id,
    name: chain.name,
    explorerUrl: chain.explorerUrl,
    // Arc's gas token is USDC (18 decimals natively; the ERC-20 is 6).
    nativeCurrency: { symbol: "USDC", decimals: 18 },
    // `split` is null on a deployment without PolarisSplit; `eurc`/`sendEurc` without euro links.
    contracts: {
      stablecoin: c.stablecoin,
      eurc: c.eurc,
      payments: c.payments,
      checkout: c.checkout,
      send: c.send,
      sendEurc: c.sendEurc,
      split: c.split,
      loanEngine: c.loanEngine,
      registry: c.registry,
      vault: c.vault,
      creditGuard: c.guardian,
    },
    domains: {
      stablecoin: { ...chain.stablecoinDomain, chainId: chain.id, verifyingContract: c.stablecoin },
      eurc: c.eurc && chain.eurcDomain ? { ...chain.eurcDomain, chainId: chain.id, verifyingContract: c.eurc } : null,
      checkout: polarisDomain("checkout", chain.id, c.checkout),
      payments: polarisDomain("payments", chain.id, c.payments),
      send: polarisDomain("send", chain.id, c.send),
      sendEurc: c.sendEurc ? polarisDomain("send", chain.id, c.sendEurc) : null,
      split: c.split ? polarisDomain("split", chain.id, c.split) : null,
      loanEngine: polarisDomain("loanEngine", chain.id, c.loanEngine),
    },
    circle: circle
      ? {
          cctpDomain: circle.cctpDomain,
          tokenMessengerV2: circle.tokenMessengerV2,
          messageTransmitterV2: circle.messageTransmitterV2,
          memo: circle.memo,
          usyc: circle.usyc ?? null,
          gatewayWallet: circle.gatewayWallet ?? null,
          gatewayMinter: circle.gatewayMinter ?? null,
        }
      : null,
    // Pay from any chain (CCTP V2): where a buyer can burn USDC to arrive on Arc. Null on a local node.
    cctp: sources ? { sources, fastTransfer: true, mintPath: "/api/public/cctp/mint" } : null,
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
