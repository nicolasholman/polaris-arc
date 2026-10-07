// Onboarding 2 — "Split it in four. Pay as you go."
// The lime glass card floats in, catches a sheen, cracks into four
// segments that part and fan out, then each segment settles into one of a
// row of four ticks (the app's Pay in 4 progress), which fill in lime one
// by one. The row fades as the next card floats in across the loop seam.

import {
  LOOP, tween, cyc, wave, add, map, combine, track, composition,
  shapeLayer, imageLayer, layerTransform, group, rect, fill, stroke, gradientStroke, trim, linePath, linearFill, mask,
} from '../lib/lottie.mjs';
import { principalAxis } from '../lib/images.mjs';
import { COLORS, glow, sparkle, bump } from './common.mjs';

const DEG = Math.PI / 180;
const mod = (a, n) => ((a % n) + n) % n;
const lerp = (a, b, p) => a + (b - a) * p;
const rot = ([x, y], deg) => {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
  return [x * c - y * s, x * s + y * c];
};

// Timeline (loop frames).
const T_IN = 228; // the card starts floating in (runs across the seam)
const T_SPLIT = 72; // the whole card gives way to its four segments
const T_FILL = 158; // the first tick starts filling
const FILL_STEP = 10;
const FILL_LEN = 14;
const T_SHINE = 197; // a shimmer runs along the finished row
const T_OUT = 210; // the row starts to fade
const C_SPLIT = mod(T_SPLIT - T_IN, LOOP); // the split in the card's own time

// Layout.
const CARD_C = [195, 214];
const CARD_W = 300;
const CARD_ROT = -9; // the render leans ~19°; this brings it to ~10°
const FAN_C = [212, 222]; // where the fanned segments gather
const FAN_R = 360; // radius of the fan (its pivot sits this far below)
const FAN_STEP = 13.5; // degrees between segments
const TICK_Y = 268;
const TICK_W = 78;
const TICK_H = 18;
const TICK_GAP = 10;
const TICK_X = [0, 1, 2, 3].map((k) => (390 - (4 * TICK_W + 3 * TICK_GAP)) / 2 + TICK_W / 2 + k * (TICK_W + TICK_GAP));

export function splitScene({ assets, prepared }) {
  const card = assets.card;
  const img = prepared.card.img;
  const ax = principalAxis(img, 128);
  // U runs along the card (left to right), V across it (downward).
  let U = [ax.ux, ax.uy];
  if (U[0] < 0) U = [-U[0], -U[1]];
  const V = [-U[1], U[0]];
  const theta = Math.atan2(U[1], U[0]) / DEG;
  const center = [ax.cx, ax.cy];
  const at = (u, v) => [center[0] + U[0] * u + V[0] * v, center[1] + U[1] * u + V[1] * v];
  const umin = Math.min(ax.umin, -ax.umax) - 2, umax = -umin; // symmetric about the centre
  const cuts = [0, 1, 2, 3, 4].map((k) => lerp(umin, umax, k / 4));
  const alphaAt = ([x, y]) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= img.width || yi >= img.height) return 0;
    return img.data[(yi * img.width + xi) * 4 + 3];
  };
  // The opaque stretch of a cut line, inset a little from the glass edge.
  const cutLine = (u, inset = 5) => {
    let v0 = null, v1 = null;
    for (let v = ax.vmin - 30; v <= ax.vmax + 30; v += 0.5) {
      if (alphaAt(at(u, v)) > 140) {
        if (v0 === null) v0 = v;
        v1 = v;
      }
    }
    return [at(u, v0 + inset), at(u, v1 - inset)];
  };

  const S = (CARD_W / card.w) * 100;

  // --- the whole card ------------------------------------------------------
  const cardY = cyc(tween([0, CARD_C[1] + 74], [52, CARD_C[1], 'expo'], [C_SPLIT, CARD_C[1] - 5, 'sine'], [150, CARD_C[1] - 5], [236, CARD_C[1] + 74, 'sine']), T_IN);
  const cardX = cyc(tween([0, CARD_C[0] + 14], [58, CARD_C[0], 'expo'], [150, CARD_C[0]], [236, CARD_C[0] + 14, 'sine']), T_IN);
  const cardR = cyc(tween([0, CARD_ROT - 9], [60, CARD_ROT, 'expo'], [C_SPLIT, CARD_ROT + 1, 'sine'], [150, CARD_ROT + 1], [236, CARD_ROT - 9, 'sine']), T_IN);
  const cardK = cyc(tween([0, 0.9], [58, 1, 'expo'], [150, 1], [236, 0.9, 'sine']), T_IN);
  const cardO = cyc(tween([0, 0], [26, 100, 'outSoft'], [150, 100], [200, 0]), T_IN);
  const cardScale = map(cardK, (k) => S * k);

  const cardKs = (name) =>
    layerTransform({ name, p: [cardX, cardY], a: center, s: [cardScale, cardScale], r: cardR, o: cardO });

  // Pose at the split (the hover has come to rest: no velocity here).
  const poseC = [cardX(T_SPLIT), cardY(T_SPLIT)];
  const poseR = cardR(T_SPLIT);
  const toCanvas = (p) => {
    const d = rot([(p[0] - center[0]) * (S / 100), (p[1] - center[1]) * (S / 100)], poseR);
    return [poseC[0] + d[0], poseC[1] + d[1]];
  };
  const Uc = rot(U, poseR);
  const Vc = rot(V, poseR);

  // --- the four segments ----------------------------------------------------
  const SEP = 16;
  const e1 = tween([T_SPLIT, 0], [T_SPLIT + 24, 1, 'expo']);
  const e2 = tween([T_SPLIT + 12, 0], [T_SPLIT + 50, 1, 'inOut']);
  const settleStart = (k) => T_SPLIT + 48 + k * 5;
  const settleLen = 34;
  const e3 = (k) => tween([settleStart(k), 0], [settleStart(k) + settleLen, 1, 'glide']);
  const upright = -theta; // the segment standing straight up
  const stripLength = ax.vmax - ax.vmin;
  const tickScale = ((TICK_W + 4) / stripLength) * 100;

  const segmentPose = (k) => {
    const mid = at((cuts[k] + cuts[k + 1]) / 2, (ax.vmin + ax.vmax) / 2);
    const home = toCanvas(mid);
    const E3 = e3(k);
    const spread = k - 1.5;
    // Fan pose: upright, spread on an arc like a hand of cards.
    const phi = spread * FAN_STEP;
    const fanPos = [FAN_C[0] + FAN_R * Math.sin(phi * DEG), FAN_C[1] + FAN_R * (1 - Math.cos(phi * DEG))];
    // Tick pose: tipped over sideways (outer ones away from the centre).
    const lay = spread < 0 ? upright - 90 : upright + 90;
    const pose = (t) => {
      const p1 = e1(t), p2 = e2(t), p3 = E3(t);
      // 1. part along the card's axis
      let pos = [home[0] + Uc[0] * spread * SEP * p1, home[1] + Uc[1] * spread * SEP * p1];
      let r = poseR;
      // 2. fan out
      pos = [lerp(pos[0], fanPos[0], p2), lerp(pos[1], fanPos[1], p2) - Math.sin(Math.PI * p2) * 10];
      r = lerp(r, upright + phi, p2);
      let s = S * (1 - 0.04 * p2);
      // 3. tip over and settle into the tick
      pos = [lerp(pos[0], TICK_X[k], p3), lerp(pos[1], TICK_Y, p3) - Math.sin(Math.PI * p3) * 18];
      r = lerp(r, lay, p3);
      s = lerp(s, tickScale, p3);
      const o = 100 * (1 - Math.min(1, Math.max(0, (p3 - 0.55) / 0.4)));
      return { x: pos[0], y: pos[1], r, s, o };
    };
    const breaks = [...e1.breaks, ...e2.breaks, ...E3.breaks];
    return {
      anchor: mid,
      x: track((t) => pose(t).x, breaks),
      y: track((t) => pose(t).y, breaks),
      r: track((t) => pose(t).r, breaks),
      s: track((t) => pose(t).s, breaks),
      o: track((t) => pose(t).o, [...breaks, settleStart(k) + settleLen * 0.55, settleStart(k) + settleLen * 0.95]),
    };
  };

  const segments = [0, 1, 2, 3].map((k) => {
    const pose = segmentPose(k);
    const a = k === 0 ? -1000 : cuts[k];
    const b = k === 3 ? 1000 : cuts[k + 1];
    const m = mask([at(a, -1000), at(b, -1000), at(b, 1000), at(a, 1000)].map((p) => [p[0], p[1]]), `segment ${k + 1}`);
    const nm = `card segment ${k + 1}`;
    const op = settleStart(k) + settleLen + 2;
    const layer = imageLayer({
      nm,
      key: nm,
      refId: card.id,
      ip: T_SPLIT,
      op,
      masks: [m],
      ks: layerTransform({ name: nm, p: [pose.x, pose.y], a: pose.anchor, s: [pose.s, pose.s], r: pose.r, o: pose.o }),
    });
    // Light catching the fresh cut edges.
    const edges = [];
    if (k > 0) edges.push(cutLine(cuts[k] + 1.2));
    if (k < 3) edges.push(cutLine(cuts[k + 1] - 1.2));
    const edgeLayer = shapeLayer({
      nm: `${nm} cut light`,
      parentKey: nm,
      ip: T_SPLIT,
      op,
      // (parenting carries the transform, not the opacity)
      ks: layerTransform({
        name: `${nm} cut light`,
        o: combine([tween([T_SPLIT, 100], [T_SPLIT + 26, 55, 'outSoft']), pose.o], (a, b) => (a * b) / 100),
      }),
      shapes: edges.map((e, i) =>
        group(`edge ${i + 1}`, [linePath(e[0], e[1]), stroke({ color: '#F6FFE9', width: 2.2, nm: 'edge stroke' })]),
      ),
    });
    return [layer, edgeLayer];
  });

  // --- the ticks --------------------------------------------------------------
  const ticks = [0, 1, 2, 3].map((k) => {
    const s0 = settleStart(k) + settleLen * 0.5;
    const s1 = settleStart(k) + settleLen;
    const f0 = T_FILL + k * FILL_STEP;
    const appear = tween([s0, 0], [s1, 1, 'back']);
    const outP = tween([T_OUT + k, 0], [T_OUT + 16 + k, 1, 'inSoft']);
    const nm = `tick ${k + 1}`;
    return shapeLayer({
      nm,
      ip: s0 - 1,
      op: T_OUT + 18 + k,
      ks: layerTransform({
        name: nm,
        p: [TICK_X[k], add(TICK_Y, map(outP, (p) => p * 8))],
        s: [map(appear, (p) => 100 * (0.35 + 0.65 * p)), map(appear, (p) => 100 * (0.6 + 0.4 * p))],
        o: track((t) => 100 * Math.min(1, Math.max(0, appear(t) * 1.4)) * (1 - outP(t)), [...appear.breaks, ...outP.breaks]),
      }),
      shapes: [
        // a glassy lime fill: light along the top, deeper along the bottom
        group('lime highlight', [
          linePath([-(TICK_W - TICK_H) / 2, -TICK_H / 2 + 4], [(TICK_W - TICK_H) / 2, -TICK_H / 2 + 4]),
          trim({ e: tween([f0 + 1, 0], [f0 + FILL_LEN + 1, 100, 'out']), nm: 'highlight progress' }),
          stroke({ color: '#F4FFE0', width: 2.2, o: tween([f0 + 1, 0], [f0 + 5, 55, 'linear']), nm: 'highlight' }),
        ]),
        group('lime', [
          linePath([-(TICK_W - TICK_H) / 2, 0], [(TICK_W - TICK_H) / 2, 0]),
          trim({ e: tween([f0, 0], [f0 + FILL_LEN, 100, 'out']), nm: 'fill progress' }),
          gradientStroke({
            stops: [[0, '#D9FF9C', 1], [0.5, COLORS.lime, 1], [1, '#6CC23A', 1]],
            from: [0, -TICK_H / 2],
            to: [0, TICK_H / 2],
            width: TICK_H,
            o: tween([f0, 0], [f0 + 3, 100, 'linear']),
            nm: 'lime fill',
          }),
        ]),
        group('track', [
          rect({ size: [TICK_W, TICK_H], r: TICK_H / 2 }),
          linearFill({ stops: [[0, '#FFFFFF', 0.13], [1, '#FFFFFF', 0.06]], from: [0, -TICK_H / 2], to: [0, TICK_H / 2], nm: 'track fill' }),
          stroke({ color: '#FFFFFF', width: 1, o: 9, nm: 'track edge' }),
        ]),
      ],
    });
  });

  const tickGlows = [0, 1, 2, 3].map((k) =>
    glow({
      nm: `tick ${k + 1} glow`,
      color: COLORS.lime,
      radius: 58,
      strength: 0.55,
      x: TICK_X[k],
      y: TICK_Y,
      squash: 0.55,
      o: map(bump(T_FILL + k * FILL_STEP + FILL_LEN - 2, 18), (v) => v * 100),
      ip: T_FILL + k * FILL_STEP - 6,
      op: T_FILL + k * FILL_STEP + FILL_LEN + 18,
    }),
  );

  // A shimmer along the finished row, clipped to the ticks.
  const rowMatte = shapeLayer({
    nm: 'row shimmer matte',
    td: 1,
    ip: T_SHINE - 2,
    op: T_OUT + 2,
    ks: layerTransform({ name: 'row shimmer matte' }),
    shapes: TICK_X.map((x, k) =>
      group(`tick ${k + 1}`, [rect({ size: [TICK_W, TICK_H], p: [x, TICK_Y], r: TICK_H / 2 }), fill('#FFFFFF', 100, 'matte fill')]),
    ),
  });
  const rowShimmer = shapeLayer({
    nm: 'row shimmer',
    tt: 1,
    ip: T_SHINE - 2,
    op: T_OUT + 2,
    ks: layerTransform({ name: 'row shimmer' }),
    shapes: [
      group(
        'band',
        [
          rect({ size: [46, 120] }),
          linearFill({ stops: [[0, '#FFFFFF', 0], [0.5, '#FFFFFF', 0.75], [1, '#FFFFFF', 0]], from: [-23, 0], to: [23, 0], nm: 'shimmer gradient' }),
        ],
        { p: [tween([T_SHINE, TICK_X[0] - TICK_W], [T_SHINE + 16, TICK_X[3] + TICK_W, 'inOut']), TICK_Y], r: 24 },
      ),
    ],
  });

  // --- sheen across the card, and the crack before it parts ------------------
  const sheenX = cyc(tween([0, -120], [30, -120], [C_SPLIT - 12, card.w + 120, 'inOut'], [150, card.w + 120], [236, -120, 'sine']), T_IN);
  const sheen = shapeLayer({
    nm: 'card sheen',
    parentKey: 'card',
    tt: 1,
    ip: 0,
    op: T_SPLIT,
    ks: layerTransform({ name: 'card sheen', o: 100 }),
    shapes: [
      group(
        'band',
        [
          rect({ size: [90, 900] }),
          linearFill({
            stops: [[0, '#FFFFFF', 0], [0.5, '#FFFFFF', 0.42], [1, '#FFFFFF', 0]],
            from: [-45, 0],
            to: [45, 0],
            nm: 'sheen gradient',
          }),
        ],
        { p: [sheenX, center[1]], r: 22 },
      ),
    ],
  });
  const matte = imageLayer({
    nm: 'card sheen matte',
    parentKey: 'card',
    td: 1,
    refId: card.id,
    ip: 0,
    op: T_SPLIT,
    ks: layerTransform({ name: 'card sheen matte' }),
  });
  const crack = shapeLayer({
    nm: 'card crack',
    parentKey: 'card',
    ip: T_SPLIT - 16,
    op: T_SPLIT,
    ks: layerTransform({ name: 'card crack', o: tween([T_SPLIT - 14, 0], [T_SPLIT, 100, 'inSoft']) }),
    shapes: [1, 2, 3].map((k) => {
      const [p, q] = cutLine(cuts[k]);
      return group(`crack ${k}`, [
        linePath(p, q),
        trim({ s: tween([T_SPLIT - 14, 50], [T_SPLIT - 2, 0, 'out']), e: tween([T_SPLIT - 14, 50], [T_SPLIT - 2, 100, 'out']), nm: 'crack draw' }),
        stroke({ color: '#F6FFE9', width: 2.6, nm: 'crack stroke' }),
      ]);
    }),
  });

  // --- glows ---------------------------------------------------------------
  const glowY = cyc(tween([0, TICK_Y - 4], [44, CARD_C[1] + 4, 'inOut'], [C_SPLIT + 50, CARD_C[1] + 4], [C_SPLIT + 94, TICK_Y - 4, 'inOut']), T_IN);
  const glowK = cyc(tween([0, 0.8], [44, 1, 'inOut'], [C_SPLIT + 50, 1], [C_SPLIT + 94, 0.8, 'inOut']), T_IN);
  const glowSquash = 0.75;

  const layers = [
    glow({ nm: 'purple glow', color: COLORS.purple, radius: 190, strength: 0.2, x: add(110, wave(10, 1, 0.5)), y: add(290, wave(8, 1, 2)), o: add(85, wave(15, 1, 1)) }),
    glow({ nm: 'lime glow', color: COLORS.lime, radius: 200, strength: 0.32, x: 205, y: glowY, k: glowK, squash: glowSquash, o: add(88, wave(12, 2, 0.4)) }),
    ...tickGlows,
    ...ticks,
    rowShimmer,
    rowMatte,
    imageLayer({ nm: 'card (floating in)', refId: card.id, ip: T_IN, op: LOOP, ks: cardKs('card tail') }),
    imageLayer({ nm: 'card', key: 'card', refId: card.id, ip: 0, op: T_SPLIT, ks: cardKs('card') }),
    sheen,
    matte,
    crack,
    ...segments.flat(),
    sparkle({ nm: 'card glint', parentKey: 'card', x: card.w * 0.9, y: card.h * 0.3, R: 13, at: 40, w: 20, peak: 1.5 }),
    sparkle({ nm: 'done spark', x: TICK_X[3] + TICK_W / 2 - 2, y: TICK_Y - 14, R: 7, at: T_SHINE + 14, w: 14, color: '#F4FFE0' }),
    sparkle({ nm: 'spark 1', x: 60, y: 96, R: 4, at: 120, w: 22 }),
    sparkle({ nm: 'spark 2', x: 338, y: 420, R: 3.5, at: 20, w: 20, color: '#D8C4FF' }),
  ];

  return composition({
    nm: 'Polaris onboarding 2 — split it in four',
    still: 120,
    layers,
    assets: [card],
  });
}
