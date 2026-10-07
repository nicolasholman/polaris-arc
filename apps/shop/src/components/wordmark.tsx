/** Halcyon's mark: a low sun on still water. */
export function HalcyonMark({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path d="M4.5 13.25a7.5 7.5 0 0 1 15 0z" fill="currentColor" />
      <path d="M2.5 16h19M6 19h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <HalcyonMark size={22} />
      <span className="display text-[1.6rem] leading-none tracking-[-0.025em]">Halcyon</span>
    </span>
  );
}
