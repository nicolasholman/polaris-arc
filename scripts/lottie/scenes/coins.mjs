// Onboarding 1 — "Get paid in dollars. Instantly."
// Three glass coins drift in from the edges, overlap in depth, and bob and
// turn slowly over soft lime and purple glows. Everything is periodic over
// the 4-second loop, so it plays forever without a seam.

import { wave, swell, add, map, composition } from '../lib/lottie.mjs';
import { COLORS, sprite, glow, sparkle } from './common.mjs';

const DEG = Math.PI / 180;

export function coinsScene({ assets }) {
  // A slow camera sway shared by everything, scaled by depth (parallax).
  const camX = wave(7, 1, 0.4);
  const camY = wave(4, 1, 2.1);

  const coins = [
    {
      nm: 'crimson coin (far)',
      asset: assets.coinCrimson,
      rest: [286, 404],
      width: 150,
      depth: 0.4,
      out: [0.88, 0.48],
      drift: 30,
      driftPeak: -18,
      bob: 4,
      bobPhase: 2.4,
      rot: 6,
      rotAmp: 5,
      rotPhase: 1.1,
      turn: 16,
      turnPhase: 2.2,
    },
    {
      nm: 'lime coin (middle)',
      asset: assets.coinLime,
      rest: [290, 150],
      width: 208,
      depth: 0.65,
      out: [0.5, -0.87],
      drift: 38,
      driftPeak: -9,
      bob: 6,
      bobPhase: 1.0,
      rot: -6,
      rotAmp: 6,
      rotPhase: 0.2,
      turn: 18,
      turnPhase: 0.9,
    },
    {
      nm: 'purple coin (near)',
      asset: assets.coinPurple,
      rest: [104, 312],
      width: 276,
      depth: 1,
      out: [-1, 0.12],
      drift: 48,
      driftPeak: 0,
      bob: 8,
      bobPhase: 0,
      rot: 2,
      rotAmp: 4,
      rotPhase: 2.6,
      turn: 14,
      turnPhase: 0,
    },
  ];

  const tracks = coins.map((c) => {
    const edge = swell(c.driftPeak); // 1 = out at the edge, 0 = settled in
    const x = add(c.rest[0], map(edge, (e) => e * c.out[0] * c.drift), map(camX, (v) => v * c.depth));
    const y = add(
      c.rest[1],
      map(edge, (e) => e * c.out[1] * c.drift),
      map(camY, (v) => v * c.depth),
      wave(c.bob, 2, c.bobPhase),
    );
    // Nearer when settled: a touch larger as it drifts in.
    const k = map(edge, (e) => 1 - 0.06 * e);
    // Turning about its vertical axis narrows the coin a little.
    const theta = wave(c.turn, 1, c.turnPhase);
    const sx = map(theta, (d) => Math.cos(d * DEG));
    const r = add(c.rot, wave(c.rotAmp, 1, c.rotPhase));
    return { ...c, x, y, k, sx, r };
  });

  const [crimson, lime, purple] = tracks;

  const layers = [
    // Glows sit behind everything and follow their coin at half its motion.
    glow({
      nm: 'purple glow',
      color: COLORS.purple,
      radius: 220,
      strength: 0.58,
      x: map(purple.x, (v) => 0.5 * v + 0.5 * purple.rest[0] + 10),
      y: map(purple.y, (v) => 0.5 * v + 0.5 * purple.rest[1] + 6),
      o: add(88, wave(12, 1, 1.4)),
    }),
    glow({
      nm: 'lime glow',
      color: COLORS.lime,
      radius: 180,
      strength: 0.5,
      x: map(lime.x, (v) => 0.5 * v + 0.5 * lime.rest[0] - 6),
      y: map(lime.y, (v) => 0.5 * v + 0.5 * lime.rest[1] + 10),
      o: add(86, wave(14, 1, 3.3)),
    }),
    glow({
      nm: 'crimson glow',
      color: COLORS.crimson,
      radius: 120,
      strength: 0.22,
      x: map(crimson.x, (v) => 0.5 * v + 0.5 * crimson.rest[0]),
      y: map(crimson.y, (v) => 0.5 * v + 0.5 * crimson.rest[1]),
      o: add(85, wave(15, 1, 0.3)),
    }),
    ...[crimson, lime, purple].map((c) =>
      sprite({
        nm: c.nm,
        key: c.nm,
        asset: c.asset,
        x: c.x,
        y: c.y,
        width: c.width,
        k: c.k,
        sx: c.sx,
        r: c.r,
      }),
    ),
    // Glints on the rims, parented to their coin (asset pixel space).
    sparkle({ nm: 'glint purple', parentKey: purple.nm, x: assets.coinPurple.w * 0.3, y: assets.coinPurple.h * 0.17, R: 14, at: 40, w: 22, peak: 1.7 }),
    sparkle({ nm: 'glint lime', parentKey: lime.nm, x: assets.coinLime.w * 0.2, y: assets.coinLime.h * 0.26, R: 16, at: 130, w: 20, peak: 1.7 }),
    sparkle({ nm: 'glint crimson', parentKey: crimson.nm, x: assets.coinCrimson.w * 0.72, y: assets.coinCrimson.h * 0.14, R: 18, at: 200, w: 18, peak: 1.6 }),
    sparkle({ nm: 'spark 1', x: 206, y: 64, R: 5, at: 90, w: 20, color: COLORS.limeLogo }),
    sparkle({ nm: 'spark 2', x: 48, y: 120, R: 4.5, at: 170, w: 22 }),
    sparkle({ nm: 'spark 3', x: 218, y: 478, R: 4.5, at: 20, w: 20, color: '#D8C4FF' }),
  ];

  return composition({
    nm: 'Polaris onboarding 1 — get paid in dollars',
    still: 120,
    layers,
    assets: [assets.coinCrimson, assets.coinLime, assets.coinPurple],
  });
}
