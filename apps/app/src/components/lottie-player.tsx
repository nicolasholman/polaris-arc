"use client";

import { type LottieHandle, LottieSvg } from "lottie-react";
import { useEffect, useRef } from "react";

export type LottieJson = { layers: unknown[]; markers?: { cm?: string; tm?: number }[] };

/**
 * One onboarding animation, drawn with lottie-react's svg build. Loaded only
 * in the browser (see onboarding-art.tsx). It plays from `startFrame` whenever
 * its page comes into view and rests while another page is showing. Reduced
 * motion holds it on the file's "still" marker instead of playing.
 * `onReady` fires once the first frame is drawn, so whatever stood in for it
 * can fade out without leaving a gap.
 */
export default function LottiePlayer({
  data,
  reduced,
  active = true,
  startFrame = 0,
  onReady,
  className,
}: {
  data: LottieJson;
  reduced: boolean;
  active?: boolean;
  /** Where each play starts: a frame where the scene is already composed. */
  startFrame?: number;
  onReady?: () => void;
  className?: string;
}) {
  const ref = useRef<LottieHandle>(null);
  const hasStill = data.markers?.some((m) => m.cm === "still") ?? false;
  const want = useRef({ active, reduced, startFrame });
  const played = useRef(false);
  const readyRef = useRef(onReady);
  useEffect(() => {
    readyRef.current = onReady;
  });

  const apply = () => {
    const handle = ref.current;
    if (!handle) return;
    if (want.current.reduced) {
      handle.pause();
      handle.seek(hasStill ? { marker: "still" } : want.current.startFrame);
    } else if (want.current.active) {
      played.current = true;
      handle.seek(want.current.startFrame);
      handle.play();
    } else {
      handle.pause();
      // Until it first plays, wait on a composed frame, so a swipe in never shows an empty one.
      if (!played.current) handle.seek(want.current.startFrame);
    }
  };

  useEffect(() => {
    want.current = { active, reduced, startFrame };
    apply();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, reduced, startFrame]);

  return (
    <LottieSvg
      src={data}
      autoplay={false}
      loop={!reduced}
      lottieRef={ref}
      rendererSettings={{ preserveAspectRatio: "xMidYMid meet" }}
      subscriptions={{
        ready: () => {
          apply();
          // Let the seeked frame paint before the stand-in starts to fade.
          requestAnimationFrame(() => readyRef.current?.());
        },
      }}
      className={className}
    />
  );
}
