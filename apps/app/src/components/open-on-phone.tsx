"use client";

import { Button, IconDisc, toast } from "@polaris/ui";
import { Copy, Smartphone } from "lucide-react";
import { useHref } from "@/lib/browser";
import { QrCode } from "./qr";

export type OpenOnPhoneReason = "no-webauthn" | "no-prf" | "insecure" | "host" | "unsupported" | "in-app";

const COPY: Record<OpenOnPhoneReason, { title: string; body: string }> = {
  "no-webauthn": {
    title: "Open Polaris on your phone",
    body: "This browser can't hold a Face ID account. Scan the code with your phone's camera and carry on there.",
  },
  "no-prf": {
    title: "Open Polaris on your phone",
    body: "This browser can't hold a Face ID account. Scan the code with your phone's camera and carry on there.",
  },
  unsupported: {
    title: "Open Polaris on your phone",
    body: "Face ID worked, but this browser can't keep a Polaris account. Scan the code with your phone and carry on there.",
  },
  insecure: {
    title: "Open this page securely",
    body: "Face ID only works on a secure (https) page. Open the secure page, or scan the code with your phone.",
  },
  host: {
    title: "Open Polaris on your phone",
    body: "Polaris accounts don't work on this site. Scan the code, or open polarispay.app.",
  },
  "in-app": {
    title: "Open in Safari or Chrome",
    body: "This app's built-in browser can't use Face ID. Tap ··· and choose Open in browser, or copy the link.",
  },
};

/** The friendly dead end for Face ID: the same page, on a device that can hold an account. */
export function OpenOnPhone({ reason = "no-webauthn", compact = false }: { reason?: OpenOnPhoneReason; compact?: boolean }) {
  const href = useHref();
  const copy = COPY[reason];
  return (
    <div className="flex flex-col items-center gap-3 text-center font-satoshi">
      {!compact ? (
        <IconDisc size="md" icon={<Smartphone />} />
      ) : null}
      <h3 className="text-[19px] font-medium tracking-[-0.015em]">{copy.title}</h3>
      <p className="max-w-[34ch] text-[14px] leading-[1.45] text-ui-muted">{copy.body}</p>
      {href && reason !== "in-app" && !compact ? (
        <QrCode value={href} size={148} label="QR code that opens this page on your phone" className="mt-1" />
      ) : null}
      {href ? (
        <Button
          variant="outline"
          size="sm"
          icon={<Copy />}
          onClick={() => {
            void navigator.clipboard?.writeText(href).then(
              () => toast({ title: "Link copied", tone: "success" }),
              () => toast({ title: "Copy the link from the address bar", tone: "info" }),
            );
          }}
        >
          Copy link
        </Button>
      ) : null}
    </div>
  );
}
