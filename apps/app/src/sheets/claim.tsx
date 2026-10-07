"use client";

import {
  Button,
  DetailsList,
  EmptyState,
  GradientCard,
  ListGroup,
  ListRow,
  Money,
  PrimaryButton,
  ScreenHeader,
  SecondaryButton,
  Sheet,
  Skeleton,
  SuccessCheck,
  useIsDesktop,
} from "@polaris/ui";
import { ExternalLink, Globe, Link2Off, ScanFace, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { type Hex, isHex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { ConfirmSheet } from "@/components/confirm-sheet";
import { LocalEquivalent } from "@/components/local-equivalent";
import { RouteSheet, useCloseSheet } from "@/components/shell/sheet-host";
import { SuccessSheet } from "@/components/success-sheet";
import { EMAIL_LOGIN } from "@/lib/account";
import { claimLink } from "@/lib/actions";
import { getSendLink } from "@/lib/data";
import { useData } from "@/lib/data/hooks";
import { prefetchDomains } from "@/lib/domains";
import { type Micros, parseAmount, usd } from "@/lib/money";
import type { RelayReceipt } from "@/lib/relayer";
import { n } from "@/lib/view";

type Parsed = { key: Hex; amount: Micros; name: string } | { invalid: true };

/**
 * The link is `/claim#k=<key>&a=<amount>&n=<name>`. The fragment never leaves
 * the browser: it is not sent with the request, not logged, and not passed to
 * any API. Only the key's public address and a signature made with it are.
 */
function parseFragment(hash: string): Parsed {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const key = params.get("k") ?? "";
  const amount = parseAmount(params.get("a") ?? "");
  // Display text from a link: strip control characters, cap the length.
  const name = (params.get("n") ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
  if (!isHex(key) || key.length !== 66 || amount === null || amount <= 0n) return { invalid: true };
  return { key, amount, name: name || "Someone" };
}

const subscribeHash = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    window.removeEventListener("hashchange", onChange);
    window.removeEventListener("popstate", onChange);
  };
};

/** The one way out of a spent or broken link: the phone's white button, ref E's lime from 1024px. */
function GoToPolaris({ onClick }: { onClick: () => void }) {
  const desktop = useIsDesktop();
  return desktop ? (
    <PrimaryButton size="lg" onClick={onClick}>
      Go to Polaris
    </PrimaryButton>
  ) : (
    <Button variant="white" size="lg" onClick={onClick}>
      Go to Polaris
    </Button>
  );
}

/** Claim (full): dollars someone sent you by link, yours with one Face ID. */
export function ClaimSheet() {
  const close = useCloseSheet();
  const hash = useSyncExternalStore(
    subscribeHash,
    () => window.location.hash,
    () => null,
  );
  // Parsed once: after claiming, the key is taken out of the address bar.
  const [parsed, setParsed] = useState<Parsed | null>(null);
  if (hash !== null && parsed === null) setParsed(parseFragment(hash));
  useEffect(() => prefetchDomains("send"), []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScreenHeader title="Claim" onBack={close} className="-mt-2 shrink-0 px-5 lg:hidden" />
      {parsed === null ? (
        <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-3 pt-1">
          <Skeleton shape="card" height={200} />
          <Skeleton shape="tile" height={200} />
        </Sheet.Body>
      ) : "invalid" in parsed ? (
        <Sheet.Body className="pt-6">
          <EmptyState
            icon={<Link2Off />}
            title="This link isn't complete"
            description="Part of it went missing on the way. Ask the sender to share it again, and open it straight from the message."
            action={<GoToPolaris onClick={close} />}
          />
        </Sheet.Body>
      ) : (
        <ClaimReady parsed={parsed} onDone={close} />
      )}
    </div>
  );
}

function ClaimReady({ parsed, onDone }: { parsed: { key: Hex; amount: Micros; name: string }; onDone: () => void }) {
  const linkKey = privateKeyToAddress(parsed.key);
  const status = useData(() => getSendLink(linkKey), [linkKey]);
  const [confirming, setConfirming] = useState(false);
  // Set when this session claimed it: then the link reads "claimed" because
  // of us, and the buyer is never told someone else may have taken it.
  const [claimed, setClaimed] = useState<RelayReceipt | null>(null);
  const desktop = useIsDesktop();
  // What the index says was escrowed wins over what the link text says.
  const amount = status.value?.amount ?? parsed.amount;
  const state = status.value?.status;
  const rows = [
    { label: "From", value: parsed.name },
    { label: "Amount", value: usd(amount) },
    { label: "Network fee", value: "None" },
  ];

  // From 1024px the receipt takes the claim's place in its one Dialog.
  if (claimed && desktop) {
    return (
      <ClaimedHere
        subtitle={`${usd(amount, { trim: true })} from ${parsed.name} is in your account.`}
        rows={rows}
        receiptUrl={claimed.explorerUrl}
        onDone={onDone}
      />
    );
  }

  return (
    <>
      <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-4 pt-1">
        <GradientCard
          tone="lime"
          label="You've got dollars"
          value={<Money value={n(amount)} dim="symbol" dimOpacity={0.4} />}
          meta={<span className="text-[16px] font-medium">from {parsed.name}</span>}
          className="min-h-[190px] pr-36"
          // Ref E's olive from 1024px, not the phone's bright lime.
          style={desktop ? { background: "var(--ui-lime-button)" } : undefined}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/assets/coin.png"
            alt=""
            width={150}
            height={150}
            className="glass-float pointer-events-none absolute top-1/2 -right-3 size-[150px] -translate-y-1/2 object-contain lg:right-5 lg:size-[124px]"
            style={{ ["--lift" as string]: "-8px", ["--turn" as string]: "8deg", ["--r" as string]: "-8deg" }}
          />
        </GradientCard>
        <LocalEquivalent amount={amount} className="-mt-1 text-center text-[14px]" />

        <ListGroup>
          <ListRow icon={<ScanFace />} title="Face ID is your account" description={EMAIL_LOGIN ? "No password, no forms. Or use your email." : "No password, no forms."} />
          <ListRow icon={<Globe />} title="Dollars, wherever you are" description="Hold them, pay with them, send them on." />
          <ListRow icon={<Zap />} title="No network fee to claim" description="Polaris pays it. It lands in under a second." />
        </ListGroup>

        {state !== undefined && state !== "open" && !claimed ? (
          <p role="status" className="rounded-ui-tile bg-ui-surface-2 p-4 text-center text-[15px] leading-[1.45]">
            <span className="font-medium">
              {state === "claimed"
                ? "This link has already been claimed."
                : state === "cancelled"
                  ? `${parsed.name} cancelled this link.`
                  : "This link has expired."}
            </span>{" "}
            <span className="text-ui-muted">
              {state === "claimed"
                ? "Each link pays out once. If it wasn't you, ask the sender for a new one."
                : "The money went back to the sender. Ask them for a new link."}
            </span>
          </p>
        ) : null}
      </Sheet.Body>
      <Sheet.Footer className="lg:[&>*]:flex-1">
        {state === undefined ? (
          <Skeleton shape="pill" height={56} />
        ) : claimed ? (
          <Button variant="lime" size="lg" onClick={onDone}>
            Done
          </Button>
        ) : state === "open" ? (
          desktop ? (
            <PrimaryButton size="lg" icon={<ScanFace />} onClick={() => setConfirming(true)}>
              Claim {usd(amount, { trim: true })}
            </PrimaryButton>
          ) : (
            <Button variant="lime" size="lg" icon={<ScanFace />} onClick={() => setConfirming(true)}>
              Claim {usd(amount, { trim: true })}
            </Button>
          )
        ) : (
          <GoToPolaris onClick={onDone} />
        )}
      </Sheet.Footer>

      <ConfirmSheet
        open={confirming}
        onOpenChange={setConfirming}
        title={`Claim ${usd(amount, { trim: true })}`}
        summary={`From ${parsed.name}. It lands in your account in under a second.`}
        newLabel="Claim with Face ID"
        busyLabel="Claiming…"
        onAccount={async (signer) => {
          const receipt = await claimLink(signer.address, parsed.key, amount, parsed.name);
          // The key is spent: take it out of the address bar and history.
          window.history.replaceState(window.history.state, "", "/claim");
          setClaimed(receipt);
        }}
      />
      <SuccessSheet
        open={claimed !== null && !desktop}
        onOpenChange={() => onDone()}
        title="Arrived."
        subtitle={`${usd(amount, { trim: true })} from ${parsed.name} is in your account.`}
        receiptUrl={claimed?.explorerUrl}
        rows={rows}
        primary={{ label: "Done", onClick: onDone }}
      />
    </>
  );
}

/** The receipt in the claim's own Dialog (1024px and up): the tick, "Arrived.", what came in. */
function ClaimedHere({
  subtitle,
  rows,
  receiptUrl,
  onDone,
}: {
  subtitle: ReactNode;
  rows: { label: string; value: string }[];
  receiptUrl: string | null;
  onDone: () => void;
}) {
  return (
    <>
      <Sheet.Body className="flex flex-col [&>*]:shrink-0 items-center gap-2 pt-6 text-center">
        <SuccessCheck label="Arrived" size={80} />
        <h2 className="mt-3 text-[34px] leading-none font-semibold tracking-[-0.035em]">Arrived.</h2>
        <p role="status" className="max-w-[34ch] text-[15px] leading-[1.45] text-ui-muted">
          {subtitle}
        </p>
        <DetailsList size="sm" items={rows} className="mt-3 w-full text-left" />
      </Sheet.Body>
      <Sheet.Footer className="[&>*]:flex-1">
        {receiptUrl ? (
          <SecondaryButton asChild size="lg" iconRight={<ExternalLink />} className="bg-ui-surface-2 hover:bg-ui-surface-3">
            <a href={receiptUrl} target="_blank" rel="noopener noreferrer">
              View receipt
            </a>
          </SecondaryButton>
        ) : null}
        <PrimaryButton size="lg" onClick={onDone}>
          Done
        </PrimaryButton>
      </Sheet.Footer>
    </>
  );
}

/** The route: the intercepting page in app/@sheet (over the current tab), or the page itself (cold, over its tab). */
export function ClaimRoute({ cold }: { cold?: boolean }) {
  return (
    <RouteSheet label="Claim your dollars" snapPoints={["full"]} cold={cold} desktop={{ as: "dialog", size: "md", title: "Claim your dollars" }}>
      <ClaimSheet />
    </RouteSheet>
  );
}
