"use client";

import { AdaptiveSheet, Badge, Button, ListGroup, ListRow, Notice, Sheet } from "@polaris/ui";
import { ArrowRightLeft, Globe, Layers, Link2, Receipt, ScanFace } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Address } from "viem";
import type { PaymentLink } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { topUpAmount } from "@/lib/gateway";
import { type Micros, usd } from "@/lib/money";
import { getNetwork, type Network } from "@/lib/network";
import { CcipSheet } from "./ccip-sheet";
import { CctpOrderSheet } from "./cctp-order-sheet";
import { CrossChainDeposit, IncomingTransfer, useIncomingTransfers } from "./cross-chain-deposit";
import { GatewaySheet } from "./gateway-sheet";

type Open = "menu" | "gateway" | "cctp" | "cctp-order" | "ccip" | null;

/** Whether this order can be paid by a hooked CCTP burn: the network has the receiver, and the order names who, what and how much. */
export function hookPayable(network: Network, link: PaymentLink): boolean {
  return Boolean(network.cctp?.hookReceiver && link.merchant.address && link.orderId && link.amount > 0n);
}

const names = (list: { name: string }[]) => {
  const all = list.map((s) => s.name.replace(/ (Sepolia|Fuji|Amoy|Testnet)$/, ""));
  return all.length > 3 ? `${all.slice(0, 3).join(", ")} and more` : all.join(", ");
};

/** Whether this network offers any way in from another chain. */
export function offersAnyChain(network: Network | null | undefined): boolean {
  return Boolean(network && (network.gateway || network.cctp || network.ccip));
}

/**
 * "Pay from any chain", on the checkout (phone and desktop): a row that
 * opens the three ways in, in order of speed. Circle Gateway (a unified
 * balance, on Arc in about a second), CCTP (any chain Polaris lists, in
 * minutes), and Chainlink CCIP (the whole order in one transaction, where a
 * PolarisCCIPSender is deployed). Transfers on their way show under it.
 */
export function PayFromAnyChain({
  link,
  available,
  recipient,
  short,
  onFunded,
  className,
}: {
  link: PaymentLink;
  /** The Polaris balance, when known. */
  available: Micros | undefined;
  /** The buyer's Polaris account, or null before Face ID created one. */
  recipient: Address | null;
  /** Whether the balance falls short of this payment. */
  short: boolean;
  /** Dollars have landed for this payment: continue to the regular Pay now. */
  onFunded: () => void;
  className?: string;
}) {
  const network = useData(async () => (await getNetwork()) ?? null, []);
  const net = network.value ?? null;
  const incoming = useIncomingTransfers();
  const [open, setOpen] = useState<Open>(null);
  const router = useRouter();
  if (!offersAnyChain(net) || !net) return null;
  const need = topUpAmount(link.amount, available);

  return (
    <div className={className}>
      <ListGroup>
        <ListRow
          icon={<Globe />}
          tone={short ? "tint-lime" : "tint-teal"}
          title="Pay from any chain"
          description={short ? `Short? Bring ${usd(need)} of USDC from Base, Ethereum and more` : "USDC on Base, Ethereum and more"}
          onClick={() => setOpen("menu")}
        />
      </ListGroup>
      {incoming.burns.length ? (
        <div className="mt-3 grid gap-3">
          {incoming.burns.map((burn) => (
            <IncomingTransfer key={burn.txHash} burn={burn} onDismiss={() => incoming.dismiss(burn.txHash)} />
          ))}
        </div>
      ) : null}

      <AnyChainMenu open={open === "menu"} onOpenChange={(o) => setOpen(o ? "menu" : null)} network={net} link={link} need={need} recipient={recipient} onPick={setOpen} />
      {net.gateway && recipient ? (
        <GatewaySheet
          open={open === "gateway"}
          onOpenChange={(o) => setOpen(o ? "gateway" : null)}
          network={net}
          recipient={recipient}
          amount={need}
          onMinted={() => {
            setOpen(null);
            onFunded();
          }}
        />
      ) : null}
      {net.cctp && recipient ? (
        <CrossChainDeposit
          open={open === "cctp"}
          onOpenChange={(o) => setOpen(o ? "cctp" : null)}
          network={net}
          recipient={recipient}
          initialAmount={need}
          onSent={incoming.add}
        />
      ) : null}
      {recipient && hookPayable(net, link) ? (
        <CctpOrderSheet
          open={open === "cctp-order"}
          onOpenChange={(o) => setOpen(o ? "cctp-order" : null)}
          network={net}
          link={link}
          refundTo={recipient}
          onSent={incoming.add}
          // The order is paid on Arc: read the link again, which now shows it paid.
          onPaid={() => router.refresh()}
        />
      ) : null}
      {net.ccip?.sources.length ? (
        <CcipSheet open={open === "ccip"} onOpenChange={(o) => setOpen(o ? "ccip" : null)} network={net} link={link} refundTo={recipient} />
      ) : null}
    </div>
  );
}

function AnyChainMenu({
  open,
  onOpenChange,
  network,
  link,
  need,
  recipient,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  network: Network;
  link: PaymentLink;
  need: Micros;
  recipient: Address | null;
  onPick: (which: Open) => void;
}) {
  const router = useRouter();
  const ccipLive = Boolean(network.ccip?.sources.length);
  const onboard = () => router.push(`/onboard?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);

  return (
    <AdaptiveSheet
      open={open}
      onOpenChange={onOpenChange}
      snapPoints={["fit"]}
      title="Pay from any chain"
      description="You only ever hold USDC"
      maxWidth={440}
      desktopSize="sm"
    >
      <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-4 pt-1 pb-5">
        <p className="text-[15px] leading-[1.45] text-ui-muted">
          Bring {usd(need)} of USDC from another chain to pay {link.merchant.name}. On Arc, gas is USDC too and Polaris pays it: final in under a second.
        </p>
        {!recipient ? (
          <Notice
            tone="info"
            icon={<ScanFace />}
            title="Your Polaris account first"
            action={
              <Button variant="lime" size="sm" onClick={onboard}>
                Set up Face ID
              </Button>
            }
          >
            Gateway and CCTP move USDC into your Polaris account, so it needs to exist. It takes one Face ID.
          </Notice>
        ) : null}
        <ListGroup label="Instant">
          <ListRow
            icon={<Layers />}
            tone="tint-lime"
            title="Circle Gateway balance"
            description={network.gateway ? "One signature, no gas. On Arc in about a second" : "Not on this network"}
            trailing={network.gateway ? <Badge tone="lime">~1 s</Badge> : undefined}
            disabled={!network.gateway || !recipient}
            onClick={network.gateway && recipient ? () => onPick("gateway") : undefined}
          />
        </ListGroup>
        <ListGroup label="Any chain, minutes">
          <ListRow
            icon={<ArrowRightLeft />}
            tone="tint-teal"
            title="Move USDC with CCTP"
            description={network.cctp ? `From ${names(network.cctp.sources)}. Then pay here` : "Not on this network"}
            disabled={!network.cctp || !recipient}
            onClick={network.cctp && recipient ? () => onPick("cctp") : undefined}
          />
        </ListGroup>
        <ListGroup label="One transaction">
          <ListRow
            icon={<Receipt />}
            tone="tint-teal"
            title="Pay this order with CCTP"
            description={
              hookPayable(network, link)
                ? "One transaction on another chain, minutes. Pays the order on Arc, no second step"
                : network.cctp
                  ? "Coming to this network: one transaction, minutes"
                  : "Not on this network"
            }
            trailing={!hookPayable(network, link) && network.cctp ? <Badge tone="neutral">Soon</Badge> : undefined}
            chevron={hookPayable(network, link)}
            disabled={!hookPayable(network, link) || !recipient}
            onClick={hookPayable(network, link) && recipient ? () => onPick("cctp-order") : undefined}
          />
          <ListRow
            icon={<Link2 />}
            tone="tint-purple"
            title="Pay with Chainlink CCIP"
            description={
              ccipLive
                ? `From ${names(network.ccip!.sources)}. CCTP moves the dollars, CCIP carries your order to Polaris on Arc`
                : "Coming to this network: pay from Base or Ethereum in one transaction"
            }
            trailing={ccipLive ? undefined : <Badge tone="neutral">Soon</Badge>}
            chevron={ccipLive}
            disabled={!ccipLive}
            onClick={ccipLive ? () => onPick("ccip") : undefined}
          />
        </ListGroup>
      </Sheet.Body>
    </AdaptiveSheet>
  );
}
