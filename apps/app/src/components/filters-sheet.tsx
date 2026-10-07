"use client";

import { AdaptiveSheet, Button, Chip, Sheet } from "@polaris/ui";
import { useId } from "react";

export type FilterSection = {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
};

/** Filters (half): chips per question, applied as you tap them. */
export function FiltersSheet({
  open,
  onOpenChange,
  title = "Filters",
  sections,
  onReset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  sections: FilterSection[];
  onReset?: () => void;
}) {
  const id = useId();
  return (
    <AdaptiveSheet open={open} onOpenChange={onOpenChange} snapPoints={["fit"]} title={title} maxWidth={440}>
      <Sheet.Body className="flex flex-col [&>*]:shrink-0 gap-6 pt-1">
        {sections.map((s, i) => (
          <fieldset key={s.label} className="flex flex-col gap-3">
            <legend id={`${id}-${i}`} className="mb-3 text-[14px] font-medium text-ui-muted">
              {s.label}
            </legend>
            <div role="radiogroup" aria-labelledby={`${id}-${i}`} className="flex flex-wrap gap-2">
              {s.options.map((o) => (
                <Chip
                  key={o.value}
                  role="radio"
                  aria-checked={s.value === o.value}
                  selected={s.value === o.value}
                  variant="outline"
                  onClick={() => s.onChange(o.value)}
                >
                  {o.label}
                </Chip>
              ))}
            </div>
          </fieldset>
        ))}
      </Sheet.Body>
      <Sheet.Footer>
        {onReset ? (
          <Button variant="outline" size="lg" onClick={onReset}>
            Reset
          </Button>
        ) : null}
        <Button variant="lime" size="lg" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      </Sheet.Footer>
    </AdaptiveSheet>
  );
}
