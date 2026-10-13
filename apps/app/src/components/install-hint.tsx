"use client";

import { Button, ListRow } from "@polaris/ui";
import { Download, Star } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useBrowserValue } from "@/lib/browser";
import { installStore, serverInstallState } from "@/lib/install";

const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** Capture before route navigation, so the profile can install later. */
export function InstallPromptCapture() {
  useEffect(() => installStore.capture(window), []);
  return null;
}

/** Install from the profile, with a manual guide when the browser has no prompt. */
export function InstallHint({ className }: { className?: string }) {
  const standalone = useBrowserValue(isStandalone, true);
  const ios = useBrowserValue(isIos, false);
  const { prompt, installed } = useSyncExternalStore(installStore.subscribe, installStore.snapshot, () => serverInstallState);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function install() {
    if (!prompt || busy) return;
    setBusy(true);
    setError(null);
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      setAccepted(choice.outcome === "accepted");
    } catch {
      setError("The install prompt didn't open. Use your browser's menu below.");
    } finally {
      installStore.consume();
      setBusy(false);
    }
  }

  if (standalone || installed || accepted) return null;
  return (
    <section className={className} aria-label="Install Polaris">
      <ListRow
        variant="card"
        icon={<Star />}
        tone="lime"
        title="Keep Polaris on your home screen"
        description={ios ? "Open in Safari, then tap Share and Add to Home Screen." : "Open Polaris like an app, straight from your home screen."}
        trailing={prompt ? (
          <Button size="sm" variant="white" icon={<Download />} disabled={busy} onClick={() => void install()}>
            {busy ? "Opening…" : "Add"}
          </Button>
        ) : undefined}
      />
      {error && <p role="alert" className="mt-2 text-sm">{error}</p>}
      <details className="mt-2 px-4 text-sm">
        <summary className="cursor-pointer">How to install</summary>
        <ol className="mt-2 list-decimal space-y-2 pl-5">
          {ios ? (
            <>
              <li>Open this page in Safari.</li>
              <li>Tap Share, then Add to Home Screen. You may need to scroll the share sheet.</li>
              <li>Tap Add, then open Polaris from its new home screen icon.</li>
            </>
          ) : (
            <>
              <li>Open this page in Chrome or Edge.</li>
              <li>Open the browser menu and choose Install Polaris or Add to Home screen. On desktop, look for the install icon in the address bar.</li>
              <li>Confirm, then open Polaris from the new icon. If the option is missing, keep using Polaris in this browser.</li>
            </>
          )}
        </ol>
        <p className="mt-2">Sign in with your existing Polaris passkey when asked.</p>
      </details>
    </section>
  );
}
