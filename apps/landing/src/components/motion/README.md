# Motion primitives

The landing's reveal-on-scroll kit (BlurWords, BlurLines, Rise, Marquee,
CountUp, DrawLine, SmoothScroll, the tokens and hooks). The merchant web
keeps a copy in `apps/business/src/components/motion` so its landing moves
the same way: change one, change the other (or move both into
`packages/ui`). `hooks.ts` is identical in both, with the hydration-safe
`useMounted` (useSyncExternalStore). Import each primitive from its file;
there is no barrel here.
