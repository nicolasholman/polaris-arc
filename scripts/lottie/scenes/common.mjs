// Building blocks shared by the three onboarding scenes.

import {
  LOOP, map, combine,
  imageLayer, shapeLayer, layerTransform, group, ellipse, radialFill, fill, sparklePath,
} from '../lib/lottie.mjs';

// Brand tokens from docs/design/system.md.
export const COLORS = {
  lime: '#9CEF5E',
  limeLogo: '#BFFA62',
  purple: '#8E5CF0',
  crimson: '#DE2F53',
  white: '#FFFFFF',
};

const mod = (a, n) => ((a % n) + n) % n;

/** A smooth 0 -> 1 -> 0 bump centred on `tc`, `w` frames each side (wraps). */
export function bump(tc, w, shape = 2) {
  const f = (t) => {
    let d = mod(t - tc, LOOP);
    if (d > LOOP / 2) d -= LOOP;
    if (Math.abs(d) >= w) return 0;
    return Math.pow(Math.cos((Math.PI * d) / (2 * w)), shape);
  };
  f.breaks = [mod(tc - w, LOOP), mod(tc + w, LOOP)];
  return f;
}

/**
 * A glass render as an image layer, placed by its centre.
 * x, y: canvas tracks; width: displayed width of the asset in px;
 * k: uniform scale multiplier track; sx, sy: extra per-axis multipliers
 * (a coin "turning" narrows along x); r: degrees; o: opacity 0..100.
 * `anchor` overrides the pivot (asset pixels; default the asset centre).
 */
export function sprite({ nm, asset, x, y, width, k = 1, sx = 1, sy = 1, r = 0, o = 100, anchor, ip, op, key, parentKey, masks }) {
  const base = (width / asset.w) * 100;
  const a = anchor ?? [asset.w / 2, asset.h / 2];
  return imageLayer({
    nm,
    key,
    parentKey,
    ip,
    op,
    masks,
    refId: asset.id,
    ks: layerTransform({
      name: nm,
      p: [x, y],
      a,
      s: [combine([k, sx], (kk, s) => base * kk * s), combine([k, sy], (kk, s) => base * kk * s)],
      r,
      o,
    }),
  });
}

/**
 * A soft glow: a circle filled with a radial gradient that fades to nothing.
 * `strength` is the centre alpha; `o` an opacity track (0..100).
 */
export function glow({ nm, color, radius, x, y, strength = 0.5, o = 100, k = 1, squash = 1, ip, op, parentKey }) {
  const stops = [
    [0, color, strength],
    [0.22, color, strength * 0.78],
    [0.45, color, strength * 0.42],
    [0.68, color, strength * 0.15],
    [0.85, color, strength * 0.04],
    [1, color, 0],
  ];
  return shapeLayer({
    nm,
    ip,
    op,
    parentKey,
    ks: layerTransform({
      name: nm,
      p: [x, y],
      s: [map(k, (v) => v * 100), map(k, (v) => v * 100 * squash)],
      o,
    }),
    shapes: [
      group(nm, [
        ellipse({ size: [radius * 2, radius * 2], name: `${nm} disc` }),
        radialFill({ stops, radius, nm: `${nm} gradient` }),
      ]),
    ],
  });
}

/**
 * A four-point sparkle that twinkles: it grows from nothing, turns a little
 * and shrinks away. `at` is the frame of its peak, `w` the half-duration.
 */
export function sparkle({ nm, x, y, R = 7, color = COLORS.white, at, w = 18, turn = 45, halo = true, peak = 1, parentKey }) {
  const b = bump(at, w, 2);
  const s = map(b, (v) => v * 100 * peak);
  const items = [
    group('star', [sparklePath(R, 0.8, 'star'), fill(color, 100, 'star fill')]),
  ];
  if (halo) {
    items.unshift(
      group('halo', [
        ellipse({ size: [R * 4.6, R * 4.6], name: 'halo disc' }),
        radialFill({
          stops: [[0, color, 0.55], [0.35, color, 0.22], [1, color, 0]],
          radius: R * 2.3,
          nm: 'halo gradient',
        }),
      ]),
    );
  }
  // Turn by `turn` degrees through the twinkle and unwind slowly while
  // hidden, so the rotation is smooth and periodic wherever the peak falls.
  const spin = (t) => {
    const x = mod(t - at - LOOP / 2, LOOP); // the peak sits at x = LOOP / 2
    const u = x - LOOP / 2;
    const G = u <= -w ? 0 : u >= w ? 1 : (u + w) / (2 * w) + Math.sin((Math.PI * u) / w) / (2 * Math.PI);
    return turn * (G - x / LOOP);
  };
  spin.breaks = [...b.breaks, mod(at + LOOP / 2, LOOP)];
  return shapeLayer({
    nm,
    parentKey,
    ks: layerTransform({
      name: nm,
      p: [x, y],
      s: [s, s],
      r: spin,
      o: map(b, (v) => Math.min(100, v * 160)),
    }),
    shapes: items,
  });
}
