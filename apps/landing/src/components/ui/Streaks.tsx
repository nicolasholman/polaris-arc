"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * The green motion-blur background of the "Pay any way you like" card.
 *
 * Underneath is a drawn version: soft diagonal bands of lime, leaf green and
 * white that drift slowly, so the card looks right before any asset exists.
 * `/assets/streaks.jpg` covers it when present, and `/assets/streaks.mp4`
 * plays over that, muted, looped and inline, with the jpg as its poster.
 */
export function Streaks({
  image,
  video,
  className,
}: {
  image?: string;
  video?: string;
  className?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [imageReady, setImageReady] = useState(false);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      el.pause();
      return;
    }
    el.play().catch(() => {
      // Autoplay refused (e.g. data saver): the poster stays.
    });
  }, [video]);

  return (
    <div className={cn("absolute inset-0 overflow-hidden bg-[#9fd35a]", className)} aria-hidden="true">
      <div className="streaks-drawn absolute -inset-[30%]">
        <span className="streak" style={{ top: "6%", background: "linear-gradient(90deg, transparent, #d9f59a 30%, #f4fbe6 55%, transparent)" }} />
        <span className="streak" style={{ top: "22%", background: "linear-gradient(90deg, transparent, #6db53a 25%, #93cf4e 60%, transparent)" }} />
        <span className="streak" style={{ top: "36%", background: "linear-gradient(90deg, transparent, #eef8dc 35%, #c9ec8e 70%, transparent)" }} />
        <span className="streak" style={{ top: "50%", background: "linear-gradient(90deg, transparent, #58a52d 30%, #7cc243 65%, transparent)" }} />
        <span className="streak" style={{ top: "64%", background: "linear-gradient(90deg, transparent, #f6fbef 25%, #d6efae 60%, transparent)" }} />
        <span className="streak" style={{ top: "78%", background: "linear-gradient(90deg, transparent, #4f9a28 35%, #87c94a 70%, transparent)" }} />
      </div>
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setImageReady(true)}
          ref={(el) => {
            if (el?.complete && el.naturalWidth > 0) setImageReady(true);
          }}
          className={cn(
            "absolute inset-0 h-full w-full object-cover transition-opacity duration-700",
            imageReady ? "opacity-100" : "opacity-0",
          )}
        />
      ) : null}
      {video ? (
        <video
          ref={videoRef}
          src={video}
          poster={image}
          muted
          loop
          playsInline
          autoPlay
          preload="metadata"
          onPlaying={() => setVideoReady(true)}
          className={cn(
            "absolute inset-0 h-full w-full object-cover transition-opacity duration-700",
            videoReady ? "opacity-100" : "opacity-0",
          )}
        />
      ) : null}
    </div>
  );
}
