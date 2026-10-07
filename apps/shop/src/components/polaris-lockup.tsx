import { PolarisMark } from "@/lib/polaris-client";

/**
 * The Polaris mark and name, as a store shows a payment provider beside its
 * payment choice. The SDK ships the mark; the word is set in the store's type.
 */
export function PolarisLockup({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-[0.3em] whitespace-nowrap font-semibold tracking-[-0.01em] ${className}`}>
      <PolarisMark className="!block !h-[1em] !w-[0.9em] shrink-0 ![filter:none]" />
      Polaris
    </span>
  );
}
