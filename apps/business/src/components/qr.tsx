"use client";

import { Button } from "@polaris/ui";
import { Download } from "lucide-react";
import QRCode from "qrcode";
import { useMemo } from "react";


const QUIET = 4;

function qrPath(text: string): { size: number; path: string } {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = modules.size;
  let path = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (modules.data[y * n + x]) path += `M${x + QUIET} ${y + QUIET}h1v1h-1z`;
    }
  }
  return { size: n + QUIET * 2, path };
}

function svgMarkup(size: number, path: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#ffffff"/><path d="${path}" fill="#111111"/></svg>`;
}

/**
 * A QR code for a payment link, drawn as SVG from the module matrix. It is
 * always dark on white, in both themes: scanners need the contrast and the
 * quiet zone more than the page needs it to match.
 */
export function QrCode({ value, label, size = 184 }: { value: string; label: string; size?: number }) {
  const { size: modules, path } = useMemo(() => qrPath(value), [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${modules} ${modules}`}
      shapeRendering="crispEdges"
      className="rounded-[16px]"
    >
      <rect width={modules} height={modules} fill="#ffffff" />
      <path d={path} fill="#111111" />
    </svg>
  );
}

export function DownloadQrButton({ value, filename }: { value: string; filename: string }) {
  function download() {
    const { size, path } = qrPath(value);
    const blob = new Blob([svgMarkup(size, path)], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <Button variant="outline" size="sm" onClick={download} icon={<Download />}>
      QR as SVG
    </Button>
  );
}
