"use client";

import { AdaptiveSheet, Button, DetailsList, Input, Notice, Select, Sheet, SuccessCheck, TxLink } from "@polaris/ui";
import { ArrowRightLeft, Wallet } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Address, Hex } from "viem";
import { receiptUrl } from "@/lib/chain";
import {
  BridgeError,
  burnForArc,
  connectWallet,
  forgetBurn,
  injectedProvider,
  mintStatus,
  noBurns,
  type PendingBurn,
  pendingBurn,
  pendingBurns,
  rememberBurn,
  sourceBalances,
  subscribeBurns,
  switchToSource,
  walletChainId,
} from "@/lib/cctp";
import { notifyDataChanged } from "@/lib/data/changes";
import { type Micros, parseAmount, usd } from "@/lib/money";
import type { CctpSource, Network } from "@/lib/network";

/** How often the app asks Polaris whether Circle has attested a burn and the relayer minted it. */
const POLL_MS = 10_000;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

type Watch = { state: "pending" | "minted" | "failed"; mintTxHash?: Hex; amount?: Micros; error?: string };

/**
 * Polls `POST /api/public/cctp/mint` for one burn until Polaris has minted it
 * on Arc (or says it failed). Each answer is idempotent, so a reload or a
 * second tab just asks again.
 */
export function useMintWatch(burn: PendingBurn | null): Watch | null {
  const [watch, setWatch] = useState<Watch | null>(null);
  useEffect(() => {
    if (!burn) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      try {
        const s = await mintStatus(burn.sourceDomain, burn.txHash);
        if (stopped) return;
        if (s.status === "minted") {
          // Kept on the list until the buyer has read "Arrived" (Done drops it).
          setWatch({ state: "minted", mintTxHash: s.mintTxHash, amount: s.amountUnits ? BigInt(s.amountUnits) : BigInt(burn.amount) });
          notifyDataChanged();
          return;
        }
        if (s.status === "failed") {
          setWatch({ state: "failed", error: s.error ?? "Polaris couldn't finish this transfer." });
          return;
        }
        setWatch({ state: "pending" });
      } catch {
        // Polaris unreachable for a moment: keep waiting, the burn is safe on the source chain.
        if (!stopped) setWatch((w) => w ?? { state: "pending" });
      }
      if (!stopped) timer = setTimeout(() => void ask(), POLL_MS);
    };
    void ask();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [burn]);
  return burn ? watch : null;
}

/** One transfer on its way to Arc, as a row of the Add money sheet. */
export function IncomingTransfer({ burn, onDismiss }: { burn: PendingBurn; onDismiss: () => void }) {
  const watch = useMintWatch(burn);
  const mintUrl = watch?.mintTxHash ? receiptUrl(watch.mintTxHash) : null;
  if (watch?.state === "minted") {
    return (
      <Notice
        tone="lime"
        title={`Arrived on Arc: ${usd(watch.amount ?? BigInt(burn.amount))}`}
        action={
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Done
          </Button>
        }
      >
        From {burn.sourceName}. {watch.mintTxHash ? <TxLink hash={watch.mintTxHash} href={mintUrl} /> : null}
      </Notice>
    );
  }
  if (watch?.state === "failed") {
    return (
      <Notice
        tone="down"
        title={`${usd(BigInt(burn.amount))} from ${burn.sourceName} didn't arrive`}
        action={
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        }
      >
        {watch.error} The burn is <TxLink hash={burn.txHash} href={`${burn.explorerUrl}/tx/${burn.txHash}`} />; Polaris support can finish it from there.
      </Notice>
    );
  }
  return (
    <Notice tone="info" icon={<ArrowRightLeft />} title={`${usd(BigInt(burn.amount))} on its way from ${burn.sourceName}`}>
      Circle is attesting the transfer. A standard transfer waits for {burn.sourceName} to finalise, which takes a few minutes on testnet (up to
      about 20). Once it&apos;s attested, it lands on Arc and is final in under a second. You can close this; it keeps going.{" "}
      <TxLink hash={burn.txHash} href={`${burn.explorerUrl}/tx/${burn.txHash}`} />
    </Notice>
  );
}

/** The transfers this device started that haven't arrived yet, with a way to drop one once read. */
export function useIncomingTransfers(): { burns: PendingBurn[]; add: (b: PendingBurn) => void; dismiss: (txHash: Hex) => void } {
  const burns = useSyncExternalStore(subscribeBurns, pendingBurns, noBurns);
  return { burns, add: rememberBurn, dismiss: forgetBurn };
}

type Step =
  | { kind: "form" }
  | { kind: "working"; label: string }
  | { kind: "sent"; burn: PendingBurn };

/**
 * Add money from another chain (CCTP V2): pick the chain, the amount, connect
 * a browser wallet, and approve then burn there. Polaris mints it on Arc.
 */
export function CrossChainDeposit({
  open,
  onOpenChange,
  network,
  recipient,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  network: Network;
  /** The buyer's Polaris account on Arc: where the USDC is minted. */
  recipient: Address;
  onSent: (burn: PendingBurn) => void;
}) {
  const cctp = network.cctp!;
  const [sourceId, setSourceId] = useState(String(cctp.sources[0]?.chainId ?? ""));
  const source: CctpSource | undefined = cctp.sources.find((s) => String(s.chainId) === sourceId);
  const [value, setValue] = useState("");
  const [wallet, setWallet] = useState<{ address: Address; chainId: number } | null>(null);
  const [heldFor, setHeldFor] = useState<{ key: string; usdc: Micros } | null>(null);
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [error, setError] = useState<string | null>(null);
  const hasWallet = typeof window !== "undefined" && injectedProvider() !== null;
  const amount = parseAmount(value);
  const onSource = wallet && source ? wallet.chainId === source.chainId : false;

  // Follow the wallet's account and network while the sheet is open.
  useEffect(() => {
    const provider = injectedProvider();
    if (!open || !provider?.on) return;
    const onChain = (id: string) => setWallet((w) => (w ? { ...w, chainId: Number(id) } : w));
    const onAccounts = (accounts: string[]) => setWallet((w) => (accounts[0] && w ? { ...w, address: accounts[0] as Address } : null));
    provider.on("chainChanged", onChain);
    provider.on("accountsChanged", onAccounts);
    return () => {
      provider.removeListener?.("chainChanged", onChain);
      provider.removeListener?.("accountsChanged", onAccounts);
    };
  }, [open]);

  // What the wallet holds on the chosen chain, once it is on it.
  const heldKey = wallet && source && onSource ? `${wallet.address}:${source.chainId}` : null;
  const held = heldFor && heldFor.key === heldKey ? heldFor.usdc : null;
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

  const fail = (e: unknown) => {
    setStep({ kind: "form" });
    setError(e instanceof BridgeError ? e.message : "Something went wrong in the wallet. Nothing was moved.");
  };

  async function connect() {
    setError(null);
    try {
      setWallet(await connectWallet());
    } catch (e) {
      fail(e);
    }
  }

  async function switchChain() {
    if (!source) return;
    setError(null);
    try {
      await switchToSource(source);
      setWallet((w) => (w ? { ...w, chainId: source.chainId } : w));
      const id = await walletChainId().catch(() => source.chainId);
      setWallet((w) => (w ? { ...w, chainId: id } : w));
    } catch (e) {
      fail(e);
    }
  }

  async function send() {
    if (!wallet || !source || !amount) return;
    setError(null);
    try {
      const txHash = await burnForArc({
        source,
        arcDomain: cctp.arcDomain,
        from: wallet.address,
        recipient,
        amount,
        onStep: (s) =>
          setStep({
            kind: "working",
            label:
              s === "approve"
                ? "Approve USDC in your wallet…"
                : s === "approving"
                  ? `Waiting for ${source.name} to confirm the approval…`
                  : s === "burn"
                    ? "Confirm the transfer in your wallet…"
                    : `Waiting for ${source.name} to confirm the transfer…`,
          }),
      });
      const burn = pendingBurn(source, txHash, amount, recipient);
      onSent(burn);
      setStep({ kind: "sent", burn });
    } catch (e) {
      fail(e);
    }
  }

  const close = () => {
    onOpenChange(false);
    setStep({ kind: "form" });
    setError(null);
    setValue("");
  };

  const tooMuch = held !== null && amount !== null && amount > held;
  const working = step.kind === "working";

  return (
    <AdaptiveSheet
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      snapPoints={["full"]}
      title="From another chain"
      description="Move USDC to Polaris with Circle's CCTP"
      maxWidth={440}
      desktopSize="sm"
    >
      {step.kind === "sent" ? (
        <Sheet.Body className="flex flex-col [&>*]:shrink-0 items-center gap-3 pt-4 text-center">
          <SuccessCheck label="Sent" size={72} />
          <h2 className="mt-2 text-[28px] leading-none font-semibold tracking-[-0.03em]">On its way.</h2>
          <p className="max-w-[34ch] text-[15px] leading-[1.45] text-ui-muted">
            {usd(BigInt(step.burn.amount))} left {step.burn.sourceName}. Circle attests it once {step.burn.sourceName} finalises (a few minutes on
            testnet), then Polaris mints it on Arc and pays that gas. It shows on Add money until it arrives.
          </p>
          <DetailsList
            size="sm"
            className="mt-2 w-full text-left"
            items={[
              { label: "From", value: step.burn.sourceName },
              { label: "To", value: "Your Polaris account on Arc" },
              { label: "Transfer", value: <TxLink hash={step.burn.txHash} href={`${step.burn.explorerUrl}/tx/${step.burn.txHash}`} /> },
            ]}
          />
          <Button variant="lime" size="lg" block className="mt-2" onClick={close}>
            Done
          </Button>
        </Sheet.Body>
      ) : !hasWallet ? (
        <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-4 pt-1">
          <Notice tone="neutral" icon={<Wallet />} title="No browser wallet here">
            Moving USDC from another chain needs a wallet that holds it there, such as a browser extension wallet. Open Polaris in a browser with
            one, or ask someone to send you a link.
          </Notice>
        </Sheet.Body>
      ) : (
        <>
          <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-4 pt-1">
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
            <Input
              label="Amount"
              inputMode="decimal"
              placeholder="25.00"
              trailing="USDC"
              value={value}
              onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ""))}
              error={value && amount === null ? "Enter an amount, like 25 or 12.50" : tooMuch ? `More than this wallet holds on ${source?.name}` : undefined}
              hint={held !== null ? `This wallet holds ${usd(held)} on ${source?.name}` : undefined}
            />
            <DetailsList
              size="sm"
              items={[
                { label: "Wallet", value: wallet ? `${short(wallet.address)}${onSource ? "" : " · another network"}` : "Not connected" },
                { label: "To", value: `Your Polaris account ${short(recipient)}` },
                { label: "Arrives", value: "In a few minutes (standard transfer)" },
                { label: "Polaris fee", value: "None" },
                { label: "Source chain gas", value: "Paid in your wallet" },
              ]}
            />
            {error ? (
              <Notice tone="down" role="alert">
                {error}
              </Notice>
            ) : null}
            {step.kind === "working" ? (
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
            ) : !onSource ? (
              <Button variant="lime" size="lg" onClick={() => void switchChain()}>
                Switch to {source?.name}
              </Button>
            ) : (
              <Button variant="lime" size="lg" disabled={working || !amount || amount === 0n || tooMuch} onClick={() => void send()}>
                {working ? "Working…" : amount ? `Move ${usd(amount, { trim: true })} to Polaris` : "Move to Polaris"}
              </Button>
            )}
          </Sheet.Footer>
        </>
      )}
    </AdaptiveSheet>
  );
}
