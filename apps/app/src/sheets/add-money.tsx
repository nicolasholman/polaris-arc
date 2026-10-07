"use client";

import { DetailsList, ListGroup, ListRow, Sheet, TileButton, toast, useIsDesktop } from "@polaris/ui";
import { ArrowDownLeft, ArrowRightLeft, Droplets, ExternalLink, ScanLine, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAccounts } from "@/components/accounts";
import { CrossChainDeposit, IncomingTransfer, useIncomingTransfers } from "@/components/cross-chain-deposit";
import { useAccountState } from "@/lib/account/hooks";
import { useOrigin } from "@/lib/browser";
import { notifyDataChanged } from "@/lib/data/changes";
import { useData } from "@/lib/data/hooks";
import { ARC_TESTNET, env } from "@/lib/env";
import { receiveLink } from "@/lib/links";
import { eur, usd } from "@/lib/money";
import { getNetwork } from "@/lib/network";
import { usePrefs } from "@/lib/prefs";
import { RouteSheet } from "@/components/shell/sheet-host";

/**
 * `pnpm demo:local`'s faucet: test dollars (MockUSDC) on a local Hardhat
 * node only. Unset everywhere else, so no other build shows it.
 */
const LOCAL_FAUCET = env.localChain ? (process.env.NEXT_PUBLIC_LOCAL_FAUCET_URL?.trim() || "").replace(/\/+$/, "") : "";

/** Circle's faucet: testnet USDC and EURC, straight to an Arc testnet address. */
const CIRCLE_FAUCET = "https://faucet.circle.com";

/**
 * Add money: the ways dollars come in today, on ref C's Send / Receive /
 * Top Up tiles. Ask someone (a link to pay you), show your code, or claim a
 * link someone sent you; move USDC from another chain with Circle's CCTP
 * (where Polaris relays the mint); and, on a test network, a faucet.
 */
export function AddMoneySheet() {
  const router = useRouter();
  const state = useAccountState();
  const origin = useOrigin();
  const { name } = usePrefs();
  const { balance } = useAccounts();
  const desktop = useIsDesktop();
  const address = state.status === "ready" || state.status === "locked" ? state.address : null;
  const [minting, setMinting] = useState(false);
  const network = useData(async () => (await getNetwork()) ?? null, []);
  const cctp = network.value?.cctp ?? null;
  const incoming = useIncomingTransfers();
  const [bridging, setBridging] = useState(false);

  async function testDollars() {
    if (!address) {
      router.push("/onboard?next=/");
      return;
    }
    setMinting(true);
    try {
      const res = await fetch(`${LOCAL_FAUCET}/mint`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) });
      if (!res.ok) throw new Error(String(res.status));
      notifyDataChanged();
      toast({ title: "$500.00 test dollars added", description: "Local chain only.", tone: "success" });
    } catch {
      toast({ title: "The local faucet didn't answer", description: "Is pnpm demo:local still running?", tone: "error" });
    } finally {
      setMinting(false);
    }
  }

  async function ask() {
    if (!address || !origin) {
      router.push("/onboard?next=/");
      return;
    }
    const { url } = receiveLink(origin, address, name);
    const text = `Pay ${name || "me"} with Polaris. It takes a second, and there's no fee.`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "Pay me with Polaris", text, url });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: "Link copied", description: "Send it to whoever is paying you.", tone: "success" });
    } catch {
      toast({ title: "Couldn't copy the link", tone: "error" });
    }
  }

  return (
    <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-5 pt-1">
      {desktop ? (
        // Ref E's rows in its pill tints, not the phone's coloured tiles.
        <ListGroup>
          <ListRow icon={<Send />} tone="tint-lime" title="Ask someone" description="Share a link that pays you" onClick={() => void ask()} />
          <ListRow
            icon={<ArrowDownLeft />}
            tone="tint-purple"
            title="Show your code"
            description="For someone next to you"
            onClick={() => router.push("/receive", { scroll: false })}
          />
          <ListRow icon={<ScanLine />} tone="tint-teal" title="Claim a link" description="Open a link someone sent you" onClick={() => router.push("/pay", { scroll: false })} />
        </ListGroup>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2.5">
            <TileButton tone="ink" icon={<Send />} label="Ask" onClick={() => void ask()} />
            <TileButton tone="purple" icon={<ArrowDownLeft />} label="My code" onClick={() => router.push("/receive", { scroll: false })} />
            <TileButton tone="lime" icon={<ScanLine />} label="Claim" onClick={() => router.push("/pay", { scroll: false })} />
          </div>
          <p className="text-[14px] leading-[1.45] text-ui-muted">
            Ask sends a link to pay you. My code is for someone next to you. Claim opens a link someone sent you.
          </p>
        </>
      )}
      {incoming.burns.map((burn) => (
        <IncomingTransfer key={burn.txHash} burn={burn} onDismiss={() => incoming.dismiss(burn.txHash)} />
      ))}
      {cctp ? (
        <ListGroup label="From another chain">
          <ListRow
            icon={<ArrowRightLeft />}
            tone="tint-teal"
            title="Move USDC to Polaris"
            description={`From ${cctp.sources.map((s) => s.name).join(", ")}, with Circle's CCTP`}
            onClick={() => (address ? setBridging(true) : router.push("/onboard?next=/"))}
          />
        </ListGroup>
      ) : null}
      {env.chainId === ARC_TESTNET ? (
        <ListGroup label="Testnet">
          <ListRow
            icon={<Droplets />}
            tone="tint-lime"
            title="Circle's testnet faucet"
            description="Free test USDC and EURC on Arc testnet. Paste your account from My code."
            trailing={<ExternalLink aria-hidden size={16} className="text-ui-muted" />}
            chevron={false}
            onClick={() => window.open(CIRCLE_FAUCET, "_blank", "noopener,noreferrer")}
          />
        </ListGroup>
      ) : null}
      {LOCAL_FAUCET ? (
        <ListGroup label="Local demo">
          <ListRow
            icon={<Droplets />}
            tone="tint-lime"
            title={minting ? "Adding test dollars…" : "Get $500 test dollars"}
            description="From the local chain's faucet. Not real money."
            onClick={minting ? undefined : () => void testDollars()}
          />
        </ListGroup>
      ) : null}
      <DetailsList
        items={[
          { label: "Lands in", value: "Final in under a second on Arc" },
          { label: "Fee", value: "None. No gas to buy: Arc's gas is USDC, and Polaris pays it" },
          { label: "Balance", value: balance ? usd(balance.available) : "…" },
          ...(balance?.euros != null ? [{ label: "Euros", value: eur(balance.euros) }] : []),
        ]}
      />
      {cctp && address && network.value ? (
        <CrossChainDeposit open={bridging} onOpenChange={setBridging} network={network.value} recipient={address} onSent={incoming.add} />
      ) : null}
    </Sheet.Body>
  );
}

/** The route: the intercepting page in app/@sheet (over the current tab), or the page itself (cold, over its tab). */
export function AddMoneyRoute({ cold }: { cold?: boolean }) {
  return (
    <RouteSheet label="Add money" title="Add money" description="Dollars land in under a second, final on Arc" cold={cold}>
      <AddMoneySheet />
    </RouteSheet>
  );
}
