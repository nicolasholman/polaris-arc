"use client";

import { Button, ListRow } from "@polaris/ui";
import { Download, Star } from "lucide-react";
import { useEffect, useState } from "react";
import { useBrowserValue } from "@/lib/browser";

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

/**
 * "Add to Home Screen" comes after the first payment, never before (plan
 * §5.6). Chrome gives us a real prompt; iOS Safari needs the Share sheet.
 */
export function InstallHint({ className }: { className?: string }) {
  const standalone = useBrowserValue(isStandalone, true);
  const ios = useBrowserValue(isIos, false);
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  if (standalone || dismissed || (!ios && !prompt)) return null;

  return (
    <ListRow
      variant="card"
      className={className}
      icon={<Star />}
      tone="lime"
      title="Keep Polaris on your home screen"
      description={ios ? "Tap Share, then Add to Home Screen." : "One tap, and it opens like an app."}
      trailing={
        prompt ? (
          <Button
            size="sm"
            variant="white"
            icon={<Download />}
            onClick={async () => {
              await prompt.prompt();
              setDismissed(true);
            }}
          >
            Add
          </Button>
        ) : undefined
      }
    />
  );
}
