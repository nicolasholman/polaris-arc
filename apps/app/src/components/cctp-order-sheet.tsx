"use client";

import { AdaptiveSheet, Button, DetailsList, Notice, Select, Sheet, SuccessCheck, TxLink } from "@polaris/ui";
import { ArrowRightLeft, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { receiptUrl } from "@/lib/chain";
import { burnToPayOrder, type PendingBurn, pendingBurn, sourceBalances } from "@/lib/cctp";
import type { PaymentLink } from "@/lib/data";
import { type Micros, usd } from "@/lib/money";
import type { CctpSource, Network } from "@/lib/network";
import { useMintWatch } from "./cross-chain-deposit";
import { useInjectedWallet } from "./use-injected-wallet";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

type Step = { kind: "form" } | { kind: "working"; label: string } | { kind: "sent"; burn: PendingBurn };

/**
 * Pay this order with CCTP in one source-chain transaction: the buyer's
 * wallet burns the order's USDC with depositForBurnWithHook to
 * PolarisCctpHookReceiver on Arc (mint recipient and only destination
 * caller), with the order in the hook data. Once Circle attests the burn,
 * Polaris relays it and the receiver pays the order on Arc; no separate
 * Pay now. An order that can't be paid is refunded to the buyer's account.
 */
export function CctpOrderSheet({
  open,
  onOpenChange,
  network,
  link,
  refundTo,
  onSent,
  onPaid,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  network: Network;
  link: PaymentLink;
  /** The buyer's Polaris account on Arc: any excess, or a refund, lands here. */
  refundTo: Address;
  /** The burn is on the source chain: keep it on this device so the wait survives closing the sheet. */
  onSent: (burn: PendingBurn) => void;
  /** Polaris reports the order paid on Arc. */
  onPaid: () => void;
}) {
  const cctp = network.cctp!;
  const hookReceiver = cctp.hookReceiver!;
  const { wallet, hasWallet, error, setError, fail, connect, switchTo } = useInjectedWallet(open);
  const [sourceId, setSourceId] = useState(String(cctp.sources[0]?.chainId ?? ""));
  const source: CctpSource | undefined = cctp.sources.find((s) => String(s.chainId) === sourceId);
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [heldFor, setHeldFor] = useState<{ key: string; usdc: Micros } | null>(null);
  const onSource = wallet && source ? wallet.chainId === source.chainId : false;
  const heldKey = wallet && source && onSource ? `${wallet.address}:${source.chainId}` : null;
  const held = heldFor && heldFor.key === heldKey ? heldFor.usdc : null;
  const tooLittle = held !== null && held < link.amount;
  const working = step.kind === "working";

  useEffect(() => {
    if (!heldKey || !wallet || !source) return;
    let live = true;
    sourceBalances(source, wallet.address)
      .then((b) => {
        if (live) setHeldFor({ key: heldKey, usdc: b.usdc });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [heldKey, wallet, source]);

  async function pay() {
    if (!wallet || !source) return;
    setError(null);
    try {
      const txHash = await burnToPayOrder({
        source,
        arcDomain: cctp.arcDomain,
        hookReceiver,
        from: wallet.address,
        merchant: link.merchant.address,
        orderId: link.orderId,
        orderAmount: link.amount,
        refundTo,
        onStep: (s) =>
          setStep({
            kind: "working",
            label:
              s === "approve"
                ? "Approve USDC in your wallet…"
                : s === "approving"
                  ? `Waiting for ${source.name} to confirm the approval…`
                  : s === "burn"
                    ? "Confirm the payment in your wallet…"
                    : `Waiting for ${source.name} to confirm the payment…`,
          }),
      });
      const burn: PendingBurn = { ...pendingBurn(source, txHash, link.amount, hookReceiver), order: { merchant: link.merchant.name, orderId: link.orderId } };
      onSent(burn);
      setStep({ kind: "sent", burn });
    } catch (e) {
      setStep({ kind: "form" });
      fail(e);
    }
  }

  const close = () => {
    onOpenChange(false);
    setStep({ kind: "form" });
    setError(null);
  };

  return (
    <AdaptiveSheet
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      snapPoints={["full"]}
      title="Pay this order with CCTP"
      description="One transaction on another chain"
      maxWidth={440}
      desktopSize="sm"
    >
      {step.kind === "sent" ? (
        <OrderSent burn={step.burn} merchant={link.merchant.name} onDone={close} onPaid={onPaid} />
      ) : !hasWallet ? (
        <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-4 pt-1">
          <Notice tone="neutral" icon={<Wallet />} title="No browser wallet here">
            Paying from another chain needs the wallet that holds your USDC there, such as a browser extension wallet.
          </Notice>
        </Sheet.Body>
      ) : (
        <>
          <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-4 pt-1">
            <Notice tone="info" icon={<ArrowRightLeft />} title="One transaction, paid on Arc">
              Your wallet sends {usd(link.amount)} with Circle&apos;s CCTP. When it lands on Arc, it pays {link.merchant.name} directly: no second step. If the
              order can&apos;t take it, the dollars go to your Polaris account.
            </Notice>
            <Select
              label="From"
              variant="filled"
              value={sourceId}
              onValueChange={(v) => {
                setSourceId(v);
                setError(null);
              }}
              options={cctp.sources.map((s) => ({ value: String(s.chainId), label: s.name, text: s.name }))}
            />
            <DetailsList
              size="sm"
              items={[
                { label: "Pays", value: `${usd(link.amount)} to ${link.merchant.name}` },
                { label: "Wallet", value: wallet ? `${short(wallet.address)}${onSource ? "" : " · another network"}${held !== null ? ` · ${usd(held)}` : ""}` : "Not connected" },
                { label: "Arrives", value: `Once ${source?.name ?? "that chain"} is final: a few minutes (Ethereum up to about 20)` },
                { label: "Refunds to", value: `Your Polaris account ${short(refundTo)}` },
                { label: "Gas", value: `Paid in your wallet, on ${source?.name ?? "that chain"}. Nothing on Arc` },
              ]}
            />
            {tooLittle ? <Notice tone="warn">This wallet holds {held !== null ? usd(held) : ""} on {source?.name}, less than the order.</Notice> : null}
            {error ? (
              <Notice tone="down" role="alert">
                {error}
              </Notice>
            ) : null}
            {working ? (
              <p role="status" className="text-center text-[14px] text-ui-muted">
                {step.label}
              </p>
            ) : null}
          </Sheet.Body>
          <Sheet.Footer className="[&>*]:flex-1">
            {!wallet ? (
              <Button variant="lime" size="lg" icon={<Wallet />} onClick={() => void connect()}>
                Connect wallet
              </Button>
            ) : !onSource && source ? (
              <Button variant="lime" size="lg" onClick={() => void switchTo(source)}>
                Switch to {source.name}
              </Button>
            ) : (
              <Button variant="lime" size="lg" disabled={working || !source || tooLittle} onClick={() => void pay()}>
                {working ? "Working…" : `Pay ${usd(link.amount, { trim: true })} from ${source?.name ?? "there"}`}
              </Button>
            )}
          </Sheet.Footer>
        </>
      )}
    </AdaptiveSheet>
  );
}

function OrderSent({ burn, merchant, onDone, onPaid }: { burn: PendingBurn; merchant: string; onDone: () => void; onPaid: () => void }) {
  const watch = useMintWatch(burn);
  const paid = watch?.state === "minted";
  return (
    <Sheet.Body className="flex flex-col [&>*]:shrink-0 items-center gap-3 pt-4 text-center">
      <SuccessCheck label={paid ? "Paid" : "Sent"} size={72} />
      <h2 className="mt-2 text-[28px] leading-none font-semibold tracking-[-0.03em]">{paid ? "Paid." : "On its way."}</h2>
      <p className="max-w-[34ch] text-[15px] leading-[1.45] text-ui-muted">
        {paid
          ? `${usd(BigInt(burn.amount))} to ${merchant}, paid on Arc.`
          : watch?.state === "failed"
            ? `${watch.error ?? "Polaris couldn't finish this transfer."} Polaris support can finish it from the transfer below.`
            : `${usd(BigInt(burn.amount))} left ${burn.sourceName}. Circle attests it once ${burn.sourceName} is final, then it pays ${merchant} on Arc. You can close this; it keeps going.`}
      </p>
      <DetailsList
        size="sm"
        className="mt-2 w-full text-left"
        items={[
          { label: "From", value: burn.sourceName },
          { label: "Transfer", value: <TxLink hash={burn.txHash} href={`${burn.explorerUrl}/tx/${burn.txHash}`} /> },
          {
            label: "On Arc",
            value: watch?.mintTxHash ? <TxLink hash={watch.mintTxHash} href={receiptUrl(watch.mintTxHash)} /> : watch?.state === "failed" ? "Not finished" : "Waiting for Circle",
          },
        ]}
      />
      <Button
        variant="lime"
        size="lg"
        block
        className="mt-2"
        onClick={() => {
          onDone();
          if (paid) onPaid();
        }}
      >
        Done
      </Button>
    </Sheet.Body>
  );
}
