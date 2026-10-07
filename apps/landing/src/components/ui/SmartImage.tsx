"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export type SmartImageProps = {
  /** URL of the asset, or undefined when the file isn't there yet. */
  src?: string;
  alt: string;
  /** Painted underneath; it is all that shows while the file is missing. */
  fallback: string;
  className?: string;
  imgClassName?: string;
  style?: CSSProperties;
  /** Load eagerly (the hero). */
  priority?: boolean;
  /** Extra layers drawn over the fallback, under the photo. */
  children?: ReactNode;
};

/**
 * An image slot that always looks finished: a gradient in the section's
 * palette sits underneath, and the photo fades in over it once it has
 * loaded. A missing or broken file leaves just the gradient, never a
 * broken-image icon. A `priority` photo (the hero) is shown straight away
 * rather than waiting for a load handler, so it can paint before hydration.
 */
export function SmartImage({
  src,
  alt,
  fallback,
  className,
  imgClassName,
  style,
  priority,
  children,
}: SmartImageProps) {
  const ref = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setFailed(false);
    const img = ref.current;
    // Cached images can finish before React attaches onLoad.
    if (img?.complete) {
      if (img.naturalWidth > 0) setLoaded(true);
      else if (src) setFailed(true);
    }
  }, [src]);

  return (
    <div
      className={cn("overflow-hidden", !/\b(absolute|fixed)\b/.test(className ?? "") && "relative", className)}
      style={{ background: fallback, ...style }}
    >
      {children}
      {src && !failed ? (
        // A plain img: the assets are dropped in by hand at any size.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={ref}
          src={src}
          alt={alt}
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : "auto"}
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={cn(
            "absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ease-out",
            loaded || priority ? "opacity-100" : "opacity-0",
            imgClassName,
          )}
        />
      ) : alt ? (
        <span role="img" aria-label={alt} className="absolute inset-0" />
      ) : null}
    </div>
  );
}
