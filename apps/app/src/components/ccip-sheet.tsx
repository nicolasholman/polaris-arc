"use client";

import { AdaptiveSheet, Button, DetailsList, Notice, Select, Sheet, SuccessCheck, TxLink } from "@polaris/ui";
import { ExternalLink, Link2, Wallet } from "lucide-react";
import { useState } from "react";
import type { Address, Hex } from "viem";
import { receiptUrl } from "@/lib/chain";
import { type PendingBurn, pendingBurn } from "@/lib/cctp";
import { ccipMessageUrl } from "@/lib/cross-chain";
import { asSource, type CcipPayment, payOrderOverCcip } from "@/lib/cross-chain-wallet";
import type { PaymentLink } from "@/lib/data";
import { knownExplorer } from "@/lib/gateway";
import { usd } from "@/lib/money";
import type { Network } from "@/lib/network";
import { useMintWatch } from "./cross-chain-deposit";
import { useInjectedWallet } from "./use-injected-wallet";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

type Step = { kind: "form" } | { kind: "working"; label: string } | { kind: "sent"; payment: CcipPayment; burn: PendingBurn; sourceName: string; explorerUrl: string };

/**
 * Pay the order in one transaction on Base or Ethereum, with Chainlink CCIP:
 * PolarisCCIPSender takes the USDC there, CCTP moves the dollars to Arc and
 * CCIP carries the order to PolarisCCIPReceiver, which pays the merchant
 * once both land. Offered only where Polaris lists a deployed sender.
 */
export function CcipSheet({
  open,
  onOpenChange,
  network,
  link,
  refundTo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  network: Network;
  link: PaymentLink;
  /** Where the dollars go on Arc if the order can't take them: the buyer's Polaris account, or else the paying wallet. */
  refundTo: Address | null;
}) {
  const ccip = network.ccip!;
  const { wallet, hasWallet, error, setError, fail, connect, switchTo } = useInjectedWallet(open);
  const [chainId, setChainId] = useState(String(ccip.sources[0]?.chainId ?? ""));
  const source = ccip.sources.find((s) => String(s.chainId) === chainId);
  const [step, setStep] = useState<Step>({ kind: "form" });
  const explorerUrl = source ? (network.cctp?.sources.find((s) => s.chainId === source.chainId)?.explorerUrl ?? knownExplorer(source.chainId) ?? "") : "";
  const onSource = wallet && source ? wallet.chainId === source.chainId : false;
  const working = step.kind === "working";

  async function pay() {
    if (!wallet || !source) return;
    setError(null);
    try {
      const payment = await payOrderOverCcip({
        source,
        explorerUrl,
        from: wallet.address,
        merchant: link.merchant.address,
        amount: link.amount,
        orderId: link.orderId,
        arcRefundTo: refundTo ?? wallet.address,
        onStep: (s) =>
          setStep({
            kind: "working",
            label:
              s === "quote"
                ? "Asking Chainlink for the CCIP fee…"
                : s === "approve"
                  ? "Approve USDC in your wallet…"
                  : s === "approving"
                    ? `Waiting for ${source.name} to confirm the approval…`
                    : s === "pay"
                      ? "Confirm the payment in your wallet…"
                      : `Waiting for ${source.name} to confirm the payment…`,
          }),
      });
      // The CCTP half: Polaris mints the burn on Arc to PolarisCCIPReceiver once Circle attests it.
      const burn = pendingBurn(asSource({ ...source, domain: source.cctpDomain, explorerUrl }), payment.txHash, link.amount, ccip.receiver);
      setStep({ kind: "sent", payment, burn, sourceName: source.name, explorerUrl });
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
      title="Pay in one transaction"
      description="From another chain, with Chainlink CCIP"
      maxWidth={440}
      desktopSize="sm"
    >
      {step.kind === "sent" ? (
        <CcipSent step={step} explorer={ccip.explorer} merchant={link.merchant.name} amount={link.amount} onDone={close} />
      ) : !hasWallet ? (
        <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-4 pt-1">
          <Notice tone="neutral" icon={<Wallet />} title="No browser wallet here">
            Paying from another chain needs the wallet that holds your USDC there, such as a browser extension wallet.
          </Notice>
        </Sheet.Body>
      ) : (
        <>
          <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-4 pt-1">
            <Notice tone="info" icon={<Link2 />} title="One transaction, two networks">
              CCTP moves the dollars, CCIP carries your order to Polaris on Arc. {link.merchant.name} is paid when both land, usually within minutes.
            </Notice>
            <Select
              label="From"
              variant="filled"
              value={chainId}
              onValueChange={(v) => {
                setChainId(v);
                setError(null);
              }}
              options={ccip.sources.map((s) => ({ value: String(s.chainId), label: s.name, text: s.name }))}
            />
            <DetailsList
              size="sm"
              items={[
                { label: "Pays", value: `${usd(link.amount)} to ${link.merchant.name}` },
                { label: "Wallet", value: wallet ? `${short(wallet.address)}${onSource ? "" : " · another network"}` : "Not connected" },
                { label: "CCIP fee", value: `Paid in ${source?.name ?? "that chain"}'s gas coin, quoted before you confirm` },
                { label: "If it can't be paid", value: refundTo ? `Refunded to your Polaris account ${short(refundTo)}` : "Refunded to this wallet's address on Arc" },
              ]}
            />
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
              <Button variant="lime" size="lg" onClick={() => void switchTo(asSource({ ...source, domain: source.cctpDomain, explorerUrl }))}>
                Switch to {source.name}
              </Button>
            ) : (
              <Button variant="lime" size="lg" disabled={working || !source} onClick={() => void pay()}>
                {working ? "Working…" : `Pay ${usd(link.amount, { trim: true })} from ${source?.name ?? "there"}`}
              </Button>
            )}
          </Sheet.Footer>
        </>
      )}
    </AdaptiveSheet>
  );
}

function CcipSent({
  step,
  explorer,
  merchant,
  amount,
  onDone,
}: {
  step: Extract<Step, { kind: "sent" }>;
  explorer: string;
  merchant: string;
  amount: bigint;
  onDone: () => void;
}) {
  const watch = useMintWatch(step.burn);
  const messageUrl = step.payment.messageId ? ccipMessageUrl(explorer, step.payment.messageId) : null;
  const mintHash: Hex | undefined = watch?.mintTxHash;
  return (
    <Sheet.Body className="flex flex-col [&>*]:shrink-0 items-center gap-3 pt-4 text-center">
      <SuccessCheck label="Sent" size={72} />
      <h2 className="mt-2 text-[28px] leading-none font-semibold tracking-[-0.03em]">On its way.</h2>
      <p className="max-w-[34ch] text-[15px] leading-[1.45] text-ui-muted">
        {usd(amount)} left {step.sourceName} for {merchant}. CCIP carries the order to Arc; CCTP moves the dollars once {step.sourceName} is final. You can
        close this; it keeps going.
      </p>
      <DetailsList
        size="sm"
        className="mt-2 w-full text-left"
        items={[
          { label: "Payment", value: <TxLink hash={step.payment.txHash} href={step.explorerUrl ? `${step.explorerUrl}/tx/${step.payment.txHash}` : null} /> },
          {
            label: "Order (CCIP)",
            value: messageUrl ? (
              <a href={messageUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline-offset-2 hover:underline">
                CCIP Explorer <ExternalLink aria-hidden size={14} />
              </a>
            ) : (
              "Sent"
            ),
          },
          {
            label: "Dollars (CCTP)",
            value:
              watch?.state === "minted" ? (
                mintHash ? (
                  <TxLink hash={mintHash} href={receiptUrl(mintHash)} />
                ) : (
                  "On Arc"
                )
              ) : watch?.state === "failed" ? (
                "Needs Polaris support"
              ) : (
                "Waiting for Circle"
              ),
          },
        ]}
      />
      <Button variant="lime" size="lg" block className="mt-2" onClick={onDone}>
        Done
      </Button>
    </Sheet.Body>
  );
}
