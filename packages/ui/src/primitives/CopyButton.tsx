"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button, IconButton, type ButtonSize, type ButtonVariant, type IconButtonTone } from "./Button";
import { toast } from "./Toast";

export type CopyButtonProps = {
  /** The text that goes on the clipboard. */
  value: string;
  /** What is being copied, for the button's name and the toast: "payout address". */
  label: string;
  /** `icon` is a round IconButton; `button` shows the label. */
  variant?: "icon" | "button";
  tone?: IconButtonTone;
  buttonVariant?: ButtonVariant;
  size?: "sm" | "md";
  disabled?: boolean;
  /** Shown instead of "Copy {label}" on the `button` variant. */
  children?: React.ReactNode;
  className?: string;
};

/**
 * Copy a value, confirm it with a check and a toast. A fixed square for the
 * icon variant (no padding games), a 1.75 stroke icon at 16 or 20px.
 *
 * ```tsx
 * <CopyButton value={address} label="payout address" />
 * <CopyButton value={key} label="publishable key" variant="button" />
 * ```
 */
export function CopyButton({
  value,
  label,
  variant = "icon",
  tone = "surface",
  buttonVariant = "outline",
  size = "sm",
  disabled,
  children,
  className,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
      toast({ title: `Copied the ${label}`, tone: "success", duration: 2200 });
    } catch {
      toast({ title: `We couldn't copy the ${label}`, description: "Select it and copy it by hand.", tone: "error" });
    }
  };

  const icon = copied ? <Check /> : <Copy />;
  if (variant === "icon") {
    return (
      <IconButton
        label={copied ? "Copied" : `Copy ${label}`}
        icon={icon}
        tone={tone}
        size={size}
        disabled={disabled}
        onClick={copy}
        className={className}
      />
    );
  }
  const btnSize: ButtonSize = size === "sm" ? "sm" : "md";
  return (
    <Button variant={buttonVariant} size={btnSize} icon={icon} disabled={disabled} onClick={copy} className={className}>
      {copied ? "Copied" : (children ?? `Copy ${label}`)}
    </Button>
  );
}
