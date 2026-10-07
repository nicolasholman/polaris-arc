"use client";

import { MARK_INNER, MARK_OUTER, MARK_VIEWBOX } from "@polaris/brand";
import { cn } from "@polaris/ui";
import QRCode from "qrcode";
import { useMemo } from "react";

const [, , VB_W, VB_H] = MARK_VIEWBOX.split(" ").map(Number) as [number, number, number, number];

/**
 * A QR code drawn as one SVG path, ink on white (scanners want the
 * contrast), with the Polaris mark in a cleared zone at the centre. Error
 * correction "Q" leaves room for it.
 */
export function QrCode({
  value,
  size = 200,
  label,
  className,
}: {
  value: string;
  size?: number;
  /** What the code opens, for screen readers. */
  label: string;
  className?: string;
}) {
  const drawn = useMemo(() => {
    try {
      const qr = QRCode.create(value, { errorCorrectionLevel: "Q" });
      const n = qr.modules.size;
      const centre = Math.floor(n / 2);
      const clear = Math.max(2, Math.round(n * 0.1));
      let d = "";
      for (let row = 0; row < n; row++) {
        for (let col = 0; col < n; col++) {
          if (!qr.modules.get(row, col)) continue;
          if (Math.abs(row - centre) <= clear && Math.abs(col - centre) <= clear) continue;
          d += `M${col} ${row}h1v1h-1z`;
        }
      }
      return { d, n, clear };
    } catch {
      return null;
    }
  }, [value]);

  if (!drawn) return null;
  const { d, n, clear } = drawn;
  const pad = 1;
  const view = n + pad * 2;
  const c = n / 2;
  const box = (clear + 0.5) * 2;
  const markH = box * 0.9;
  const markW = (markH * (VB_W || 520)) / (VB_H || 580);
  return (
    <div className={cn("inline-block rounded-[24px] bg-white p-3.5", className)}>
      <svg viewBox={`${-pad} ${-pad} ${view} ${view}`} width={size} height={size} role="img" aria-label={label} shapeRendering="crispEdges">
        <path d={d} fill="#0f1011" />
        <svg
          x={c - markW / 2}
          y={c - markH / 2}
          width={markW}
          height={markH}
          viewBox={MARK_VIEWBOX}
          shapeRendering="geometricPrecision"
          aria-hidden
        >
          <path fill="#2E8C0A" d={MARK_OUTER} />
          <path fill="#BFFA62" d={MARK_INNER} />
        </svg>
      </svg>
    </div>
  );
}
