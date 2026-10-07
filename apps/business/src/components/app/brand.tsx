import { Logo, LogoMark, StatusPill, cn } from "@polaris/ui";

/**
 * "Polaris for Business": the team's wordmark (packages/brand, an image, never
 * typeset) and a lime "Business" pill in ref E's style.
 */
export function BusinessLogo({ height = 30, className }: { height?: number; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <Logo height={height} alt="Polaris" />
      <StatusPill tone="lime" size="sm" className="font-semibold">
        Business
      </StatusPill>
    </span>
  );
}

/** The star alone, for tight spots. */
export function BusinessMark({ size = 30 }: { size?: number }) {
  return <LogoMark size={size} title="Polaris for Business" />;
}
