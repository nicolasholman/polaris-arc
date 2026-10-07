"use client";

import { AdaptiveSheet, Button, DetailsList, Input, ListGroup, ListRow, Notice, Select, Sheet, SuccessCheck, TxLink } from "@polaris/ui";
import { ArrowDownToLine, Check, Layers, RefreshCw, Wallet } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Address, Hex } from "viem";
import { publicClient, receiptUrl } from "@/lib/chain";
import {
  asSource,
  depositToGateway,
  type GatewayBalances,
  gatewayBalances,
  gatewayIntent,
  gatewayMint,
  type GatewayMintResult,
  signBurnIntent,
} from "@/lib/cross-chain-wallet";
import { notifyDataChanged } from "@/lib/data/changes";
import { ARC_MAINNET, env } from "@/lib/env";
import { checkBurnIntent, covers, type DepositChain, depositChains, finalityHint, gatewayFeeHint, pickGatewaySource, preciseUsd } from "@/lib/gateway";
import { sourceBalances } from "@/lib/cctp";
import { type Micros, parseAmount, usd } from "@/lib/money";
import { ARC_CCTP_DOMAIN, type Network } from "@/lib/network";
import { useInjectedWallet } from "./use-injected-wallet";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

type Step =
  | { kind: "form" }
  | { kind: "working"; label: string }
  | { kind: "minted"; result: GatewayMintResult; amount: Micros }
  | { kind: "deposited"; chain: DepositChain; txHash: Hex; amount: Micros };

/**
 * Circle Gateway: spend a unified USDC balance (deposited on Base, Ethereum,
 * Arbitrum…) on Arc in about a second. Connect the wallet that deposited,
 * see the balance per chain, sign one intent (no gas, no network switch), and
 * Polaris mints the USDC into the buyer's account on Arc. Or deposit into
 * Gateway first, on a chosen chain.
 *
 * With `amount`, the sheet moves exactly that (a checkout's shortfall) and
 * hands back once it has landed; without, the buyer types it (Add money).
 */
export function GatewaySheet({
  open,
  onOpenChange,
  network,
  recipient,
  amount: fixed,
  onMinted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  network: Network;
  /** The buyer's Polaris account on Arc: where the USDC lands. */
  recipient: Address;
  /** A fixed amount to move (a checkout); otherwise the buyer types one. */
  amount?: Micros;
  /** Once the USDC is in the account on Arc. */
  onMinted?: (result: GatewayMintResult) => void;
}) {
  const gateway = network.gateway!;
  const { wallet, hasWallet, error, setError, fail, connect, switchTo } = useInjectedWallet(open);
  const [view, setView] = useState<"spend" | "deposit">("spend");
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [value, setValue] = useState("");
  const [loaded, setLoaded] = useState<{ key: string; balances: GatewayBalances } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [chosen, setChosen] = useState<number | null>(null);
  const amount = fixed ?? parseAmount(value);
  const arcDomain = network.cctp?.arcDomain ?? ARC_CCTP_DOMAIN;

  // The unified balance of the connected wallet, per chain.
  const key = wallet ? `${wallet.address}:${refresh}` : null;
  const balances = loaded && loaded.key === key ? loaded.balances : null;
  useEffect(() => {
    if (!open || !key || !wallet) return;
    let live = true;
    gatewayBalances(gateway.balancesPath, wallet.address)
      .then((b) => {
        if (live) {
          setLoaded({ key, balances: b });
          setLoadError(null);
        }
      })
      .catch((e: unknown) => {
        if (live) setLoadError(e instanceof Error ? e.message : "Couldn't read your Gateway balance.");
      });
    return () => {
      live = false;
    };
  }, [open, key, wallet, gateway.balancesPath]);

  const held = useMemo(() => (balances?.balances ?? []).filter((b) => b.balanceUnits > 0n).sort((a, b) => Number(b.balanceUnits - a.balanceUnits)), [balances]);
  const best = amount ? pickGatewaySource(held, amount) : null;
  const sourceDomain = chosen !== null && amount && held.some((b) => b.domain === chosen && covers(b.balanceUnits, b.domain, amount)) ? chosen : best;
  const source = held.find((b) => b.domain === sourceDomain) ?? null;
  const fee = amount && sourceDomain !== null ? gatewayFeeHint(sourceDomain, amount) : null;
  const working = step.kind === "working";

  async function spend() {
    if (!wallet || !amount || sourceDomain === null) return;
    setError(null);
    try {
      setStep({ kind: "working", label: "Preparing the transfer…" });
      const { typedData } = await gatewayIntent(gateway.intentPath, { depositor: wallet.address, sourceDomain, recipient, amount });
      const wrong = checkBurnIntent(typedData, { depositor: wallet.address, recipient, amount, sourceDomain });
      if (wrong) throw new Error(`${wrong} Nothing was signed.`);
      setStep({ kind: "working", label: "Sign in your wallet. No gas, nothing leaves until you do…" });
      const signature = await signBurnIntent(wallet.address, typedData);
      setStep({ kind: "working", label: "Circle is attesting, then it lands on Arc…" });
      const result = await gatewayMint(gateway.mintPath, typedData.message, signature);
      if (result.status === "submitted") {
        // Sent on Arc but not yet confirmed: Arc is final in under a second, so wait for it here.
        await publicClient()
          .waitForTransactionReceipt({ hash: result.mintTxHash, timeout: 30_000 })
          .catch(() => undefined);
      }
      notifyDataChanged();
      setRefresh((r) => r + 1);
      setStep({ kind: "minted", result, amount });
    } catch (e) {
      setStep({ kind: "form" });
      // Wallet, Polaris and the intent check all answer in the buyer's words.
      if (e instanceof Error && e.message) setError(e.message);
      else fail(e);
    }
  }

  const close = () => {
    onOpenChange(false);
    setStep({ kind: "form" });
    setView("spend");
    setError(null);
    setValue("");
    setChosen(null);
  };

  const title = view === "deposit" ? "Deposit to Gateway" : "Circle Gateway";
  const description = view === "deposit" ? "Put USDC into your Gateway balance on another chain" : "Your USDC on other chains, on Arc in about a second";

  return (
    <AdaptiveSheet open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())} snapPoints={["full"]} title={title} description={description} maxWidth={440} desktopSize="sm">
      {step.kind === "minted" ? (
        <Sheet.Body className="flex flex-col [&>*]:shrink-0 items-center gap-3 pt-4 text-center">
          <SuccessCheck label="Arrived" size={72} />
          <h2 className="mt-2 text-[28px] leading-none font-semibold tracking-[-0.03em]">On Arc.</h2>
          <p className="max-w-[34ch] text-[15px] leading-[1.45] text-ui-muted">
            {usd(step.amount)} is in your Polaris account, final in under a second. You only ever hold USDC: Arc&apos;s gas is USDC too, and Polaris pays
            it.
          </p>
          <DetailsList
            size="sm"
            className="mt-2 w-full text-left"
            items={[
              { label: "From", value: `Gateway · ${source?.name ?? "your balance"}` },
              { label: "To", value: `Your Polaris account ${short(recipient)}` },
              ...(step.result.feeUnits ? [{ label: "Circle's fee", value: preciseUsd(BigInt(step.result.feeUnits)) }] : []),
              { label: "Mint", value: <TxLink hash={step.result.mintTxHash} href={step.result.explorerUrl ?? receiptUrl(step.result.mintTxHash)} /> },
            ]}
          />
          <Button
            variant="lime"
            size="lg"
            block
            className="mt-2"
            onClick={() => {
              const result = step.result;
              close();
              onMinted?.(result);
            }}
          >
            {onMinted ? "Continue to pay" : "Done"}
          </Button>
        </Sheet.Body>
      ) : !hasWallet ? (
        <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-4 pt-1">
          <Notice tone="neutral" icon={<Wallet />} title="No browser wallet here">
            Circle Gateway needs the wallet that holds your USDC on the other chain, such as a browser extension wallet. Open Polaris in a browser with one.
          </Notice>
        </Sheet.Body>
      ) : view === "deposit" ? (
        <GatewayDeposit
          network={network}
          arcDomain={arcDomain}
          walletApi={{ wallet, connect, switchTo, error, setError, fail }}
          step={step}
          setStep={setStep}
          onBack={() => {
            setView("spend");
            setStep({ kind: "form" });
            setRefresh((r) => r + 1);
          }}
        />
      ) : (
        <>
          <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-4 pt-1">
            {!wallet ? (
              <Notice tone="info" icon={<Layers />} title="One balance, every chain">
                Deposit USDC into Circle Gateway once, on Base, Ethereum or another chain. Then spend it here with one signature: no gas, no network switch,
                on Arc in about a second.
              </Notice>
            ) : (
              <>
                <div className="flex items-baseline justify-between gap-3 px-1">
                  <span className="text-[15px] text-ui-muted">Gateway balance · {short(wallet.address)}</span>
                  <span className="ui-figure text-[20px] font-medium">{balances ? usd(balances.total) : "…"}</span>
                </div>
                {loadError ? (
                  <Notice
                    tone="down"
                    action={
                      <Button variant="ghost" size="sm" icon={<RefreshCw />} onClick={() => setRefresh((r) => r + 1)}>
                        Retry
                      </Button>
                    }
                  >
                    {loadError}
                  </Notice>
                ) : null}
                {balances && held.length === 0 ? (
                  <Notice tone="neutral" title="No Gateway balance yet">
                    Deposit USDC on a chain your wallet uses. It&apos;s spendable once that chain is final.
                  </Notice>
                ) : held.length ? (
                  <ListGroup label="By chain">
                    {held.map((b) => {
                      const enough = amount ? covers(b.balanceUnits, b.domain, amount) : true;
                      const selected = b.domain === sourceDomain;
                      return (
                        <ListRow
                          key={b.domain}
                          icon={selected ? <Check /> : <Layers />}
                          tone={selected ? "tint-lime" : "surface"}
                          title={b.name}
                          description={amount ? (enough ? `Circle's fee about ${preciseUsd(gatewayFeeHint(b.domain, amount))}` : "Not enough here with the fee") : undefined}
                          trailing={<span className="ui-figure text-[15px]">{usd(b.balanceUnits)}</span>}
                          chevron={false}
                          disabled={!enough}
                          onClick={enough ? () => setChosen(b.domain) : undefined}
                        />
                      );
                    })}
                  </ListGroup>
                ) : null}
              </>
            )}
            {fixed === undefined ? (
              <Input
                label="Amount"
                inputMode="decimal"
                placeholder="25.00"
                trailing="USDC"
                value={value}
                onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ""))}
                error={value && amount === null ? "Enter an amount, like 25 or 12.50" : undefined}
              />
            ) : null}
            <DetailsList
              size="sm"
              items={[
                ...(fixed !== undefined ? [{ label: "Moves", value: usd(fixed) }] : []),
                { label: "To", value: `Your Polaris account ${short(recipient)}` },
                { label: "Arrives", value: "In about a second, final on Arc" },
                { label: "Circle's fee", value: fee !== null ? `About ${preciseUsd(fee)}, from your Gateway balance` : "Base about $0.01, Ethereum about $1" },
                { label: "Gas", value: "None. You only sign" },
              ]}
            />
            {wallet && balances && amount && held.length > 0 && sourceDomain === null ? (
              <Notice tone="warn">No single chain holds {usd(amount)} plus Circle&apos;s fee. Deposit more, then come back.</Notice>
            ) : null}
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
          <Sheet.Footer className="flex-col items-stretch [&>*]:w-full [&>*]:flex-none">
            {!wallet ? (
              <Button variant="lime" size="lg" icon={<Wallet />} onClick={() => void connect()}>
                Connect wallet
              </Button>
            ) : (
              <Button variant="lime" size="lg" disabled={working || !amount || sourceDomain === null} onClick={() => void spend()}>
                {working ? "Working…" : fixed !== undefined ? "Pay with Gateway balance" : amount ? `Move ${usd(amount, { trim: true })} to Polaris` : "Move to Polaris"}
              </Button>
            )}
            <Button
              variant="ghost"
              size="md"
              icon={<ArrowDownToLine />}
              disabled={working}
              onClick={() => {
                setError(null);
                setView("deposit");
              }}
            >
              Deposit to Gateway
            </Button>
          </Sheet.Footer>
        </>
      )}
    </AdaptiveSheet>
  );
}

/** Deposit into Circle's GatewayWallet on a chosen chain, from the browser wallet: approve, then deposit. */
function GatewayDeposit({
  network,
  arcDomain,
  walletApi,
  step,
  setStep,
  onBack,
}: {
  network: Network;
  arcDomain: number;
  walletApi: Pick<ReturnType<typeof useInjectedWallet>, "wallet" | "connect" | "switchTo" | "error" | "setError" | "fail">;
  step: Step;
  setStep: (s: Step) => void;
  onBack: () => void;
}) {
  const gateway = network.gateway!;
  const { wallet, connect, switchTo, error, setError, fail } = walletApi;
  const chains = useMemo(
    () =>
      depositChains(gateway.sources, {
        arcDomain,
        testnet: env.chainId !== ARC_MAINNET,
        known: (network.cctp?.sources ?? []).map((s) => ({ domain: s.domain, chainId: s.chainId, rpcUrl: s.rpcUrl, explorerUrl: s.explorerUrl })),
      }),
    [gateway.sources, arcDomain, network.cctp],
  );
  const [domain, setDomain] = useState(String(chains[0]?.domain ?? ""));
  const chain = chains.find((c) => String(c.domain) === domain);
  const [value, setValue] = useState("");
  const amount = parseAmount(value);
  const onChain = wallet && chain ? wallet.chainId === chain.chainId : false;
  const [heldFor, setHeldFor] = useState<{ key: string; usdc: Micros } | null>(null);
  const heldKey = wallet && chain && onChain ? `${wallet.address}:${chain.chainId}` : null;
  const held = heldFor && heldFor.key === heldKey ? heldFor.usdc : null;
  useEffect(() => {
    if (!heldKey || !wallet || !chain) return;
    let live = true;
    sourceBalances(asSource(chain), wallet.address)
      .then((b) => {
        if (live) setHeldFor({ key: heldKey, usdc: b.usdc });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [heldKey, wallet, chain]);
  const tooMuch = held !== null && amount !== null && amount > held;
  const working = step.kind === "working";

  async function deposit() {
    if (!wallet || !chain || !amount) return;
    setError(null);
    try {
      const txHash = await depositToGateway({
        chain,
        gatewayWallet: gateway.wallet,
        from: wallet.address,
        amount,
        onStep: (s) =>
          setStep({
            kind: "working",
            label:
              s === "approve"
                ? "Approve USDC in your wallet…"
                : s === "approving"
                  ? `Waiting for ${chain.name} to confirm the approval…`
                  : s === "deposit"
                    ? "Confirm the deposit in your wallet…"
                    : `Waiting for ${chain.name} to confirm the deposit…`,
          }),
      });
      setStep({ kind: "deposited", chain, txHash, amount });
    } catch (e) {
      setStep({ kind: "form" });
      fail(e);
    }
  }

  if (step.kind === "deposited") {
    return (
      <Sheet.Body className="flex flex-col [&>*]:shrink-0 items-center gap-3 pt-4 text-center">
        <SuccessCheck label="Deposited" size={72} />
        <h2 className="mt-2 text-[28px] leading-none font-semibold tracking-[-0.03em]">Deposited.</h2>
        <p className="max-w-[34ch] text-[15px] leading-[1.45] text-ui-muted">
          {usd(step.amount)} is in Circle Gateway on {step.chain.name}. It&apos;s spendable once {step.chain.name} is final: {finalityHint(step.chain.domain)}.
          Then pay with your Gateway balance, on Arc in about a second.
        </p>
        <DetailsList
          size="sm"
          className="mt-2 w-full text-left"
          items={[
            { label: "Chain", value: step.chain.name },
            { label: "Spendable in", value: finalityHint(step.chain.domain) },
            { label: "Deposit", value: <TxLink hash={step.txHash} href={`${step.chain.explorerUrl}/tx/${step.txHash}`} /> },
          ]}
        />
        <Button variant="lime" size="lg" block className="mt-2" onClick={onBack}>
          Back to my Gateway balance
        </Button>
      </Sheet.Body>
    );
  }

  if (!chains.length) {
    return (
      <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-4 pt-1">
        <Notice tone="neutral">Polaris doesn&apos;t list a chain to deposit on for this network yet.</Notice>
        <Button variant="ghost" size="md" onClick={onBack}>
          Back
        </Button>
      </Sheet.Body>
    );
  }

  return (
    <>
      <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-4 pt-1">
        <Select
          label="On"
          variant="filled"
          value={domain}
          onValueChange={(v) => {
            setDomain(v);
            setError(null);
          }}
          options={chains.map((c) => ({ value: String(c.domain), label: c.name, text: c.name }))}
        />
        <Input
          label="Amount"
          inputMode="decimal"
          placeholder="25.00"
          trailing="USDC"
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ""))}
          error={value && amount === null ? "Enter an amount, like 25 or 12.50" : tooMuch ? `More than this wallet holds on ${chain?.name}` : undefined}
          hint={held !== null ? `This wallet holds ${usd(held)} on ${chain?.name}` : undefined}
        />
        {chain ? (
          <Notice tone="info" title={`Spendable in ${finalityHint(chain.domain)}`}>
            Gateway waits for {chain.name} to be final before the deposit can be spent. Deposit a little more than you need: Circle&apos;s fee comes out of
            the balance when you spend it (about {preciseUsd(gatewayFeeHint(chain.domain, amount ?? 0n))} from {chain.name}).
          </Notice>
        ) : null}
        <DetailsList
          size="sm"
          items={[
            { label: "Wallet", value: wallet ? `${short(wallet.address)}${onChain ? "" : " · another network"}` : "Not connected" },
            { label: "Into", value: `Circle's GatewayWallet ${short(gateway.wallet)}` },
            { label: "Gas", value: `Paid in your wallet, on ${chain?.name ?? "that chain"}` },
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
      <Sheet.Footer className="flex-col items-stretch [&>*]:w-full [&>*]:flex-none">
        {!wallet ? (
          <Button variant="lime" size="lg" icon={<Wallet />} onClick={() => void connect()}>
            Connect wallet
          </Button>
        ) : !onChain && chain ? (
          <Button variant="lime" size="lg" onClick={() => void switchTo(asSource(chain))}>
            Switch to {chain.name}
          </Button>
        ) : (
          <Button variant="lime" size="lg" disabled={working || !amount || tooMuch} onClick={() => void deposit()}>
            {working ? "Working…" : amount ? `Deposit ${usd(amount, { trim: true })}` : "Deposit"}
          </Button>
        )}
        <Button variant="ghost" size="md" disabled={working} onClick={onBack}>
          Back to my Gateway balance
        </Button>
      </Sheet.Footer>
    </>
  );
}
