"use client";

import { cn } from "@polaris/ui";
import dynamic from "next/dynamic";
import Image from "next/image";
import { type CSSProperties, useEffect, useState, useSyncExternalStore } from "react";
import type { LottieJson } from "./lottie-player";

// The Lottie engine touches `document` when it loads, so it only ever loads in the browser.
const loadPlayer = () => import("./lottie-player");
const LottiePlayer = dynamic(loadPlayer, { ssr: false });

/** Where each page's animation starts: page 1's coins drift in from off screen at frame 0. */
const START_FRAME: Record<1 | 2 | 3, number> = { 1: 90, 2: 40, 3: 0 };

const reducedQuery = "(prefers-reduced-motion: reduce)";
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(reducedQuery);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(reducedQuery).matches,
    () => false,
  );
}

/**
 * apps/app/public/lottie/onboarding-N.json, once it exists. The animations are
 * authored on their own branch; until a file lands this resolves to null and
 * the page shows the glass renders instead, with no code change needed.
 */
function useLottieFile(page: number): LottieJson | null {
  const [data, setData] = useState<LottieJson | null>(null);
  useEffect(() => {
    let live = true;
    // Fetch the engine alongside the file, so the player mounts as soon as the file lands.
    void loadPlayer().catch(() => undefined);
    fetch(`/lottie/onboarding-${page}.json`)
      .then((res) => (res.ok && (res.headers.get("content-type") ?? "").includes("json") ? res.json() : null))
      .then((json: unknown) => {
        if (live && json && typeof json === "object" && Array.isArray((json as LottieJson).layers)) setData(json as LottieJson);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [page]);
  return data;
}

type Piece = { src: string; className: string; style?: CSSProperties; alt?: string };

const float = (lift: number, turn: number, r: number, dur: number, delay: number, enter: number): CSSProperties =>
  ({
    "--lift": `${lift}px`,
    "--turn": `${turn}deg`,
    "--r": `${r}deg`,
    "--dur": `${dur}s`,
    "--delay": `${delay}s`,
    "--in": `${enter}s`,
  }) as CSSProperties;

/** The glass renders, placed like ref B's coins, drifting gently. */
const STILLS: Record<1 | 2 | 3, Piece[]> = {
  1: [
    { src: "/assets/onboarding/coin-purple.png", className: "left-[-22%] top-[20%] w-[78%]", style: float(-14, 5, -12, 7, 0, 0) },
    { src: "/assets/onboarding/coin-lime.png", className: "right-[-12%] top-[-2%] w-[46%]", style: float(-10, -7, 24, 6, 0.6, 0.12) },
    { src: "/assets/onboarding/coin-crimson.png", className: "right-[-10%] bottom-[4%] w-[44%]", style: float(-12, 8, -18, 6.5, 1.2, 0.24) },
  ],
  2: [
    { src: "/assets/onboarding/card-lime.png", className: "left-[6%] top-[16%] w-[88%]", style: float(-12, 3, -4, 7, 0, 0) },
    { src: "/assets/onboarding/coin-purple.png", className: "left-[-8%] bottom-[2%] w-[34%]", style: float(-10, -8, 16, 6, 0.8, 0.14) },
    { src: "/assets/onboarding/coin-crimson.png", className: "right-[-4%] top-[0%] w-[30%]", style: float(-8, 8, -22, 5.5, 0.3, 0.22) },
  ],
  3: [
    { src: "/assets/onboarding/pin.png", className: "left-[2%] bottom-[6%] w-[38%]", style: float(-8, -3, -6, 6.5, 0, 0) },
    { src: "/assets/onboarding/pin.png", className: "right-[4%] top-[4%] w-[32%]", style: float(-10, 4, 8, 7, 0.9, 0.12) },
    { src: "/assets/onboarding/coin-lime.png", className: "left-[38%] top-[30%] w-[26%]", style: float(-16, 12, 18, 4.5, 0.4, 0.26) },
  ],
};

/** Page 3's dotted flight path between the two pins. */
function Arc() {
  return (
    <svg aria-hidden viewBox="0 0 400 480" className="absolute inset-0 size-full">
      <path
        d="M96 330 C 90 170, 210 90, 300 110"
        fill="none"
        stroke="var(--ui-lime)"
        strokeOpacity="0.6"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="0.1 12"
      />
    </svg>
  );
}

/**
 * The full-bleed art over each onboarding page: the page's Lottie, with the
 * glass renders floating in its place until the animation has drawn its first
 * frame, then crossfading out. The Lottie plays while its page is `active`;
 * reduced motion holds it on its "still" marker and keeps the renders still.
 */
export function OnboardingArt({ page, active = true, className }: { page: 1 | 2 | 3; active?: boolean; className?: string }) {
  const json = useLottieFile(page);
  const reduced = useReducedMotion();
  const [ready, setReady] = useState(false);
  const [stillsGone, setStillsGone] = useState(false);

  return (
    <div aria-hidden className={cn("relative size-full overflow-visible", className)}>
      {json ? (
        <LottiePlayer
          data={json}
          reduced={reduced}
          active={active}
          startFrame={START_FRAME[page]}
          onReady={() => setReady(true)}
          // The comps are portrait (390x520); on a wider stage their own clip would cut the
          // coins off at the comp's edges, so they spill over into the stage instead.
          className={cn(
            "absolute inset-0 size-full transition-opacity duration-300 ease-out [&_svg]:!overflow-visible [&_svg>g]:![clip-path:none]",
            ready ? "opacity-100" : "opacity-0",
          )}
        />
      ) : null}
      {stillsGone ? null : (
        <div
          className={cn("absolute inset-0 transition-opacity duration-300 ease-out", ready ? "opacity-0" : "opacity-100")}
          onTransitionEnd={(e) => {
            if (ready && e.target === e.currentTarget) setStillsGone(true);
          }}
        >
          {page === 3 ? <Arc /> : null}
          {STILLS[page].map((piece, i) => (
            <div key={i} className={cn("glass-in absolute", piece.className)} style={piece.style}>
              <div className="glass-float" style={piece.style}>
                <Image
                  src={piece.src}
                  alt=""
                  width={640}
                  height={640}
                  sizes="(max-width: 440px) 80vw, 360px"
                  // Every page's renders are mounted at once (the pages slide), and the
                  // same coin appears on more than one page: one lazy copy would make Next
                  // take the first page's coin, the LCP, for a lazy image. All eager; the
                  // first page's first. (Next 16: `priority` is deprecated; the docs
                  // prefer `loading="eager"` / `fetchPriority` to `preload`.)
                  loading="eager"
                  fetchPriority={page === 1 ? "high" : "auto"}
                  className="h-auto w-full select-none drop-shadow-[0_24px_40px_rgba(0,0,0,0.45)]"
                  draggable={false}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
