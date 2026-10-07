"use client";

import { Input } from "@polaris/ui";

/**
 * Asked once, where it is first needed (the confirm of a send link): the
 * name the link shows its claimer ("$50.00 from Maya"). Saved to this
 * device's preferences, which also give the account its initials.
 */
export function SenderNameField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <Input
      label="Your first name (shown on links you send)"
      autoComplete="given-name"
      autoCapitalize="words"
      placeholder="Maya"
      maxLength={40}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 40))}
      wrapperClassName="mt-4 w-full text-left"
    />
  );
}
