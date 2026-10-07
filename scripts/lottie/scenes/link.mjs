// Onboarding 3 — "Send money anywhere. By link."
// Two glass pins stand apart under a dotted arc. The near pin's light
// swells, a lime glass coin rises out of its head, flips along the arc
// leaving a light trail, and drops into the far pin, which flashes and
// throws a small burst of sparkles. Then all is calm until the loop turns.

import {
  LOOP, tween, wave, add, map, track, composition,
  shapeLayer, layerTransform, group, ellipse, fill, stroke, trim, bezierPath, sparklePath,
} from '../lib/lottie.mjs';
import { centroid } from '../lib/images.mjs';
import { COLORS, sprite, glow, sparkle, bump } from './common.mjs';

const DEG = Math.PI / 180;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Timeline (loop frames).
const T_GO = 16; // the coin leaves the near pin (its light swells up to this)
const T_LAND = 146; // it is inside the far pin

// Layout. The coin and its trail pass behind the pins' heads, so it rises
// out of one and drops into the other.
const NEAR = { c: [104, 346], h: 212, t0: T_GO };
const FAR = { c: [293, 300], h: 178, t0: T_LAND };
const COIN_W = 72;
const BOB = 3.5;

function bezierAt([p0, p1, p2, p3], s) {
  const u = 1 - s;
  const a = u * u * u, b = 3 * u * u * s, c = 3 * u * s * s, d = s * s * s;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

/** Arc-length parametrisation of a cubic: point and heading at a fraction of its length. */
function arcLength(curve) {
  const N = 800;
  const pts = [];
  const len = [0];
  for (let i = 0; i <= N; i++) pts.push(bezierAt(curve, i / N));
  for (let i = 1; i <= N; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = len[N];
  const paramAt = (f) => {
    const target = clamp01(f) * total;
    let lo = 0, hi = N;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (len[mid] < target) lo = mid; else hi = mid;
    }
    const span = len[hi] - len[lo] || 1;
    return (lo + (target - len[lo]) / span) / N;
  };
  return {
    total,
    at: (f) => bezierAt(curve, paramAt(f)),
    heading: (f) => {
      const s = paramAt(f);
      const a = bezierAt(curve, Math.max(0, s - 0.002));
      const b = bezierAt(curve, Math.min(1, s + 0.002));
      return Math.atan2(b[1] - a[1], b[0] - a[0]) / DEG;
    },
  };
}

export function linkScene({ assets, prepared }) {
  const pin = assets.pin;
  const coin = assets.coinSmall;

  // Where the lime ball sits inside the pin render (asset pixels).
  const ball = centroid(prepared.pin.img, (r, g, b, a) => a > 200 && g > 150 && g > r + 40 && g > b + 50);
  const at = (p, [ax, ay]) => [p.c[0] + (ax - pin.w / 2) * (p.h / pin.h), p.c[1] + (ay - pin.h / 2) * (p.h / pin.h)];
  const nearBall = at(NEAR, [ball.x, ball.y]);
  const farBall = at(FAR, [ball.x, ball.y]);
  const nearHeadTop = at(NEAR, [pin.w / 2, 4])[1];
  const farHeadTop = at(FAR, [pin.w / 2, 4])[1];

  const curve = [nearBall, [nearBall[0] + 28, nearBall[1] - 250], [farBall[0] - 44, farBall[1] - 226], farBall];
  const arc = arcLength(curve);

  // The stretch of the arc that shows between the pins' heads (the rest is
  // behind them; the heads have a clear ring around the ball, so anything
  // there would show through).
  let pOut = 0, pIn = 1;
  for (let f = 0; f <= 1; f += 0.0005) if (arc.at(f)[1] < nearHeadTop + 8) { pOut = f; break; }
  for (let f = 0.5; f <= 1; f += 0.0005) if (arc.at(f)[1] > farHeadTop + 8) { pIn = f; break; }

  // Travel like a thrown coin: quick out of the near pin, floating over the
  // top of the arc, quick again into the far pin (speed 1 - 0.6·sin(πτ)).
  const SLOW = 0.6;
  const norm = 1 - (2 * SLOW) / Math.PI;
  const travelEase = (u) => (u - (SLOW * (1 - Math.cos(Math.PI * u))) / Math.PI) / norm;
  const progress = (t) => travelEase(clamp01((t - T_GO) / (T_LAND - T_GO)));
  const travelBreaks = [T_GO, T_LAND];

  // The moment the coin's centre drops past the far pin's head: the burst.
  let tBurst = T_LAND;
  for (let t = T_GO; t < T_LAND; t += 0.25) {
    const [x, y] = arc.at(progress(t));
    if (x > (nearBall[0] + farBall[0]) / 2 && y >= farHeadTop + 6) { tBurst = Math.round(t); break; }
  }

  // --- the coin ---------------------------------------------------------------
  const coinX = track((t) => arc.at(progress(t))[0], travelBreaks);
  const coinY = track((t) => arc.at(progress(t))[1], travelBreaks);
  // Depth: grows toward the top of the arc, a touch smaller at the far pin.
  const coinK = track((t) => {
    const p = progress(t);
    return 1 + 0.14 * Math.sin(Math.PI * p) - 0.1 * p;
  }, travelBreaks);
  // Turning as it flies (never edge-on), leaning into the curve.
  const coinSx = track((t) => 0.76 + 0.24 * Math.cos(3 * Math.PI * progress(t)), travelBreaks);
  const coinR = track((t) => {
    const p = progress(t);
    return (arc.heading(p) - arc.heading(0.5)) * 0.3 * Math.sin(Math.PI * p);
  }, travelBreaks);
  const coinO = track((t) => {
    const p = progress(t);
    if (t <= T_GO || t >= T_LAND) return 0;
    // hidden behind the heads; fade across the ring so nothing shows through it
    return 100 * clamp01((p - pOut * 0.5) / (pOut * 0.5)) * clamp01((1 - p) / ((1 - pIn) * 0.6));
  }, travelBreaks);

  // --- the pins ---------------------------------------------------------------
  const bobOf = (p) => wave(BOB, 1, (-2 * Math.PI * p.t0) / LOOP); // still when the coin passes
  const kick = (t0, len, amount) =>
    track((t) => {
      const d = t - t0;
      if (d <= 0 || d >= len) return 0;
      return Math.sin((Math.PI * d) / (len / 3)) * Math.exp(-d / (len / 4)) * amount;
    }, [t0, t0 + len]);
  const nearReact = kick(T_GO + 4, 54, 0.7);
  const farReact = kick(T_LAND - 4, 66, 1);

  const pinLayer = (p, nm, react) => {
    // pivot on the point, so the pin squashes onto it
    const tip = at(p, [pin.w / 2, pin.h - 6]);
    return sprite({
      nm,
      asset: pin,
      x: add(tip[0], wave(1.2, 1, 1)),
      y: add(tip[1], bobOf(p)),
      width: (p.h / pin.h) * pin.w,
      r: wave(1.2, 1, (-2 * Math.PI * p.t0) / LOOP + 0.5),
      sx: map(react, (v) => 1 + 0.035 * v),
      sy: map(react, (v) => 1 - 0.045 * v),
      anchor: [pin.w / 2, pin.h - 6],
    });
  };

  // --- the dotted arc and the light trail ----------------------------------------
  const DOT = 0.6, GAP = 9.4;
  const dotted = shapeLayer({
    nm: 'dotted arc',
    ks: layerTransform({ name: 'dotted arc' }),
    shapes: [
      group('arc', [
        bezierPath(curve),
        trim({ s: pOut * 100, e: pIn * 100, nm: 'between the heads' }),
        stroke({
          color: '#FFFFFF',
          width: 2.6,
          o: 38,
          // the dots march toward the far pin, four dot-steps per loop
          dash: { dash: DOT, gap: GAP, offset: track((t) => (-4 * (DOT + GAP) * t) / LOOP) },
          nm: 'dots',
        }),
      ]),
    ],
  });

  const trail = (nm, width, color, opacity, lag) =>
    group(nm, [
      bezierPath(curve),
      trim({
        s: track((t) => 100 * Math.min(pIn, Math.max(pOut, progress(t - lag))), [T_GO + lag, T_LAND + lag]),
        e: track((t) => 100 * Math.min(pIn, Math.max(pOut, progress(t))), travelBreaks),
        nm: `${nm} trim`,
      }),
      stroke({ color, width, o: opacity, nm: `${nm} stroke` }),
    ]);
  const trailLayer = shapeLayer({
    nm: 'light trail',
    ip: T_GO + 1,
    op: T_LAND + 30,
    ks: layerTransform({ name: 'light trail' }),
    // stacked strokes with growing lag: wide and bright at the coin, a thin tail behind
    shapes: [
      trail('tail', 1.6, '#EAFFC9', 45, 30),
      trail('core', 3, '#EAFFC9', 85, 19),
      trail('mid', 8, COLORS.lime, 34, 12),
      trail('wide', 18, COLORS.lime, 14, 7),
    ],
  });

  // --- the landing burst ----------------------------------------------------------
  const out = tween([tBurst, 0], [tBurst + 36, 1, 'expo']);
  const pop = track((t) => {
    const d = t - tBurst;
    if (d <= 0 || d >= 42) return 0;
    return Math.min(1, d / 5) * Math.pow(1 - d / 42, 1.5);
  }, [tBurst, tBurst + 5, tBurst + 42]);
  const burstC = [farBall[0], farBall[1] - 8];
  const particles = [];
  const N = 9;
  for (let i = 0; i < N; i++) {
    // mostly upward and outward, out of the pin's head
    const ang = (-90 + (300 / (N - 1)) * i - 150 + (i % 2 ? 7 : -5)) * DEG;
    const reach = i % 3 === 0 ? 86 : i % 3 === 1 ? 72 : 60;
    const star = i % 2 === 0;
    const size = star ? (i % 4 === 0 ? 10 : 8) : 3.4;
    const color = i % 3 === 2 ? COLORS.white : i % 3 === 1 ? COLORS.limeLogo : '#F4FFE0';
    const pos = [
      map(out, (p) => burstC[0] + Math.cos(ang) * (26 + (reach - 26) * p)),
      map(out, (p) => burstC[1] + Math.sin(ang) * (26 + (reach - 26) * p)),
    ];
    const sc = map(pop, (v) => v * 100);
    particles.push(
      group(
        `particle ${i + 1}`,
        [star ? sparklePath(size, 0.8) : ellipse({ size: [size * 2, size * 2] }), fill(color, 100, 'particle fill')],
        { p: pos, s: [sc, sc], r: map(out, (p) => p * 70 * (i % 2 ? 1 : -1)) },
      ),
    );
  }
  const burst = shapeLayer({
    nm: 'landing sparkles',
    ip: tBurst,
    op: tBurst + 44,
    ks: layerTransform({ name: 'landing sparkles' }),
    shapes: particles,
  });
  const ringP = tween([tBurst, 0], [tBurst + 32, 1, 'expo']);
  const ring = shapeLayer({
    nm: 'landing ring',
    ip: tBurst,
    op: tBurst + 34,
    ks: layerTransform({ name: 'landing ring', p: farBall, o: map(ringP, (p) => 100 * (1 - p)) }),
    shapes: [
      group('ring', [
        ellipse({ size: [map(ringP, (p) => 40 + 120 * p), map(ringP, (p) => 40 + 120 * p)] }),
        stroke({ color: COLORS.limeLogo, width: map(ringP, (p) => 4.5 - 3.8 * p), nm: 'ring stroke' }),
      ]),
    ],
  });

  // --- assembly ------------------------------------------------------------------
  const nearBob = bobOf(NEAR);
  const farBob = bobOf(FAR);
  const layers = [
    glow({ nm: 'ambient purple', color: COLORS.purple, radius: 240, strength: 0.16, x: 198, y: add(250, wave(10, 1, 0.7)), o: add(88, wave(12, 1, 2)) }),
    glow({ nm: 'near pin glow', color: COLORS.purple, radius: 130, strength: 0.4, x: NEAR.c[0], y: add(NEAR.c[1] - 14, nearBob), o: add(88, wave(12, 2, 0.2)) }),
    glow({ nm: 'far pin glow', color: COLORS.purple, radius: 112, strength: 0.38, x: FAR.c[0], y: add(FAR.c[1] - 14, farBob), o: add(88, wave(12, 2, 2.4)) }),
    // soft pools of light under the points
    glow({ nm: 'near pin floor', color: COLORS.purple, radius: 78, strength: 0.5, x: NEAR.c[0], y: NEAR.c[1] + NEAR.h / 2 + 8, squash: 0.2 }),
    glow({ nm: 'far pin floor', color: COLORS.purple, radius: 66, strength: 0.45, x: FAR.c[0], y: FAR.c[1] + FAR.h / 2 + 8, squash: 0.2 }),
    dotted,
    trailLayer,
    glow({ nm: 'coin glow', color: COLORS.lime, radius: 70, strength: 0.45, x: coinX, y: coinY, o: map(coinO, (v) => v * 0.9), ip: T_GO, op: T_LAND + 1 }),
    sprite({ nm: 'coin', asset: coin, x: coinX, y: coinY, width: COIN_W, k: coinK, sx: coinSx, r: coinR, o: coinO, ip: T_GO, op: T_LAND + 1 }),
    pinLayer(NEAR, 'near pin', nearReact),
    pinLayer(FAR, 'far pin', farReact),
    // the near pin gathers light before each coin leaves
    glow({ nm: 'near ball light', color: COLORS.lime, radius: 64, strength: 0.7, x: nearBall[0], y: add(nearBall[1], nearBob), o: map(bump(T_GO + 4, 46, 1.6), (v) => v * 100) }),
    // the far pin lights up as the coin arrives, then settles slowly
    glow({ nm: 'far ball light', color: COLORS.lime, radius: 76, strength: 0.75, x: farBall[0], y: add(farBall[1], farBob), o: tween([tBurst - 6, 0], [tBurst + 8, 100, 'outSoft'], [tBurst + 74, 0, 'sine']), ip: tBurst - 6, op: tBurst + 75 }),
    ring,
    burst,
    sparkle({ nm: 'spark 1', x: 204, y: 52, R: 4.5, at: 214, w: 22, color: COLORS.limeLogo }),
    sparkle({ nm: 'spark 2', x: 40, y: 168, R: 3.5, at: 100, w: 22 }),
    sparkle({ nm: 'spark 3', x: 356, y: 142, R: 3.5, at: 60, w: 20, color: '#D8C4FF' }),
    sparkle({ nm: 'glint near pin', x: NEAR.c[0] - 34, y: NEAR.c[1] - 70, R: 8, at: 196, w: 18, peak: 1.2 }),
  ];

  return composition({
    nm: 'Polaris onboarding 3 — send money by link',
    still: 96,
    layers,
    assets: [pin, coin],
  });
}
