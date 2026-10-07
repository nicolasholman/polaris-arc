// Lottie authoring helpers for the onboarding animations, in plain Node.
//
// Every animated value is written as a JavaScript function of the frame
// (a "track"), then compiled into Lottie keyframes. The compiler fits each
// stretch of the function with a cubic Hermite segment (the keyframe's
// bezier handles sit at x = 1/3 and 2/3, so time runs linearly and the
// handle heights carry the slopes), and splits a stretch until the fit is
// within tolerance. That keeps motion smooth (C1 across keys) and the JSON
// small, and it lets the scenes use real easing, springs and sine waves.

export const FPS = 60;
export const LOOP = 240; // 4 seconds
export const W = 390;
export const H = 520;

// ---------------------------------------------------------------------------
// Easing

/** CSS-style cubic-bezier(x1, y1, x2, y2) as a function of progress. */
export function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (s) => ((ax * s + bx) * s + cx) * s;
  const sy = (s) => ((ay * s + by) * s + cy) * s;
  const dx = (s) => (3 * ax * s + 2 * bx) * s + cx;
  return (p) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let s = p;
    for (let i = 0; i < 8; i++) {
      const e = sx(s) - p;
      const d = dx(s);
      if (Math.abs(e) < 1e-9) return sy(s);
      if (Math.abs(d) < 1e-7) break;
      s -= e / d;
    }
    let lo = 0, hi = 1;
    s = p;
    for (let i = 0; i < 40; i++) {
      const v = sx(s);
      if (Math.abs(v - p) < 1e-9) break;
      if (v < p) lo = s; else hi = s;
      s = (lo + hi) / 2;
    }
    return sy(s);
  };
}

export const ease = {
  linear: (p) => p,
  inOut: cubicBezier(0.65, 0, 0.35, 1), // easeInOutCubic
  sine: cubicBezier(0.37, 0, 0.63, 1), // easeInOutSine
  out: cubicBezier(0.22, 1, 0.36, 1), // easeOutQuint
  outSoft: cubicBezier(0.33, 1, 0.68, 1), // easeOutCubic
  expo: cubicBezier(0.16, 1, 0.3, 1), // easeOutExpo
  in: cubicBezier(0.55, 0, 1, 0.45), // easeInCirc-ish
  inSoft: cubicBezier(0.32, 0, 0.67, 0), // easeInCubic
  back: cubicBezier(0.34, 1.56, 0.64, 1), // easeOutBack
  glide: cubicBezier(0.45, 0, 0.2, 1), // slow start, long gentle landing
};

// ---------------------------------------------------------------------------
// Tracks: functions of the frame t in [0, LOOP], with optional .breaks
// (frames where the slope may jump, so the compiler keeps a key there).

const mod = (a, n) => ((a % n) + n) % n;

function withBreaks(fn, breaks) {
  fn.breaks = [...new Set(breaks.map((b) => Math.round(b * 1000) / 1000))];
  return fn;
}

/** Any function of the frame as a track, with the frames where its slope may jump. */
export function track(fn, breaks = []) {
  return withBreaks(fn, breaks.map((b) => mod(b, LOOP)));
}

export function lift(v) {
  if (typeof v === 'function') return v;
  return withBreaks(() => v, []);
}

function breaksOf(...fs) {
  return fs.flatMap((f) => (typeof f === 'function' && f.breaks ? f.breaks : []));
}

/**
 * Keyed tween: tween([t0, v0], [t1, v1, ease], [t2, v2, ease], ...).
 * The ease on a key shapes the move that arrives at it. Before the first key
 * and after the last the value holds.
 */
export function tween(...keys) {
  const ks = keys.map(([t, v, e]) => ({ t, v, e: typeof e === 'function' ? e : ease[e ?? 'inOut'] }));
  for (let i = 1; i < ks.length; i++) if (!(ks[i].t > ks[i - 1].t)) throw new Error(`tween keys out of order at ${ks[i].t}`);
  const fn = (t) => {
    if (t <= ks[0].t) return ks[0].v;
    const last = ks[ks.length - 1];
    if (t >= last.t) return last.v;
    let i = 1;
    while (ks[i].t < t) i++;
    const a = ks[i - 1], b = ks[i];
    const p = (t - a.t) / (b.t - a.t);
    return a.v + (b.v - a.v) * b.e(p);
  };
  return withBreaks(fn, ks.map((k) => k.t));
}

/**
 * Wrap a track authored in its own "story time" onto the loop: story time
 * 0 falls at loop frame `start`, so a move can run across the seam. The
 * story must end where it starts (story(0) === story(LOOP)).
 */
export function cyc(fn, start) {
  const f = lift(fn);
  const g = (t) => f(mod(t - start, LOOP));
  return withBreaks(g, [...breaksOf(f).map((b) => mod(b + start, LOOP)), mod(start, LOOP)]);
}

/** amp * sin(2π·cycles·t/LOOP + phase). Whole cycles keep the loop seamless. */
export function wave(amp, cycles = 1, phase = 0) {
  if (!Number.isInteger(cycles)) throw new Error('wave cycles must be whole to loop');
  return withBreaks((t) => amp * Math.sin((2 * Math.PI * cycles * t) / LOOP + phase), []);
}

/** (1 + cos)/2 bell: 1 at `peak`, 0 half a loop away. */
export function swell(peak = 0, cycles = 1) {
  return withBreaks((t) => (1 + Math.cos((2 * Math.PI * cycles * (t - peak)) / LOOP)) / 2, []);
}

export function add(...fs) {
  const g = fs.map(lift);
  return withBreaks((t) => g.reduce((s, f) => s + f(t), 0), breaksOf(...fs));
}

export function mul(...fs) {
  const g = fs.map(lift);
  return withBreaks((t) => g.reduce((s, f) => s * f(t), 1), breaksOf(...fs));
}

/** map(f, (value, t) => ...) */
export function map(f, fn) {
  const g = lift(f);
  return withBreaks((t) => fn(g(t), t), breaksOf(f));
}

/** Combine several tracks with a function of their values. */
export function combine(fs, fn) {
  const g = fs.map(lift);
  return withBreaks((t) => fn(...g.map((f) => f(t)), t), breaksOf(...fs));
}

// ---------------------------------------------------------------------------
// Compiler

const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * Stretches the compiler could not fit even at half a frame, off by more
 * than five times the tolerance: a jump in the track. That is fine where
 * the layer is hidden; build.mjs lists them so a visible one gets noticed.
 * (A sharp corner, like a clamp, fits to within a hair and isn't listed.)
 */
export const fitWarnings = [];
const r4 = (v) => Math.round(v * 10000) / 10000;

function derivative(f, t, side, span) {
  const h = Math.min(1e-3, span / 50);
  return side > 0 ? (f(t + h) - f(t)) / h : (f(t) - f(t - h)) / h;
}

function fitSegment(fs, a, b, tol) {
  const span = b - a;
  const dims = fs.map((f) => {
    const v0 = r3(f(a)), v1 = r3(f(b));
    const dv = v1 - v0;
    const d0 = derivative(f, a, +1, span);
    const d1 = derivative(f, b, -1, span);
    let yo, yi;
    if (Math.abs(dv) < 1e-9) {
      yo = 0; yi = 1; // constant stretch, the handles don't matter
    } else {
      yo = r4((d0 * span) / (3 * dv));
      yi = r4(1 - (d1 * span) / (3 * dv));
    }
    return { v0, v1, dv, yo, yi };
  });
  // Check the fit at least once a frame (and a dozen times per segment).
  const n = Math.max(12, Math.ceil(span * 2));
  for (const d of dims) if (Math.abs(d.yo) > 25 || Math.abs(d.yi - 1) > 25) return { ok: false, err: Infinity, dims };
  let err = 0;
  for (let k = 1; k < n; k++) {
    const s = k / n;
    const t = a + s * span;
    for (let i = 0; i < fs.length; i++) {
      const { v0, dv, yo, yi } = dims[i];
      const bz = 3 * (1 - s) * (1 - s) * s * yo + 3 * (1 - s) * s * s * yi + s * s * s;
      const approx = Math.abs(dv) < 1e-9 ? v0 : v0 + dv * bz;
      err = Math.max(err, Math.abs(approx - fs[i](t)));
    }
  }
  return { ok: err <= tol, err, dims };
}

/**
 * Compile tracks into a Lottie property. Returns {a:0,k} when constant.
 * `scalar` emits a bare number for a constant 1-D value (rotation, opacity).
 */
export function anim(tracks, { tol = 0.1, scalar = false, grid = 30, name = '' } = {}) {
  const fs = tracks.map(lift);
  // Constant?
  let constant = true;
  const first = fs.map((f) => f(0));
  for (let t = 0; t <= LOOP && constant; t += 0.5) {
    for (let i = 0; i < fs.length; i++) if (Math.abs(fs[i](t) - first[i]) > 1e-6) { constant = false; break; }
  }
  if (constant) {
    const v = first.map(r3);
    return { a: 0, k: scalar && v.length === 1 ? v[0] : v };
  }

  const knots = new Set([0, LOOP]);
  for (let t = grid; t < LOOP; t += grid) knots.add(t);
  for (const f of fs) for (const b of f.breaks ?? []) if (b > 0 && b < LOOP) knots.add(b);
  const sorted = [...knots].sort((p, q) => p - q);

  const segments = [];
  const refine = (a, b, depth) => {
    const fit = fitSegment(fs, a, b, tol);
    if (fit.ok || b - a <= 0.51 || depth > 14) {
      if (fit.err > tol * 5) fitWarnings.push({ name, at: r3(a), err: fit.err });
      segments.push({ a, b, dims: fit.dims });
      return;
    }
    let mid = (a + b) / 2;
    if (b - a >= 2) mid = Math.round(mid);
    refine(a, mid, depth + 1);
    refine(mid, b, depth + 1);
  };
  for (let i = 0; i < sorted.length - 1; i++) refine(sorted[i], sorted[i + 1], 0);

  // Merge neighbours whenever one segment still fits both (fewer keys).
  for (let i = 0; i < segments.length - 1; ) {
    const merged = fitSegment(fs, segments[i].a, segments[i + 1].b, tol);
    if (merged.ok) segments.splice(i, 2, { a: segments[i].a, b: segments[i + 1].b, dims: merged.dims });
    else i++;
  }

  const k = segments.map((seg) => ({
    i: { x: seg.dims.map(() => 0.6667), y: seg.dims.map((d) => d.yi) },
    o: { x: seg.dims.map(() => 0.3333), y: seg.dims.map((d) => d.yo) },
    t: r3(seg.a),
    s: seg.dims.map((d) => d.v0),
  }));
  k.push({ t: LOOP, s: fs.map((f) => r3(f(LOOP))) });
  return { a: 1, k };
}

export const anim1 = (f, opts = {}) => anim([f], { scalar: true, ...opts });

// Tolerances per kind of value.
export const TOL = { pos: 0.12, rot: 0.08, scale: 0.12, opacity: 0.4, trim: 0.06, size: 0.12, misc: 0.1 };

// ---------------------------------------------------------------------------
// Colour

export function hex(c, a = 1) {
  const n = parseInt(c.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a].map(r4);
}

// ---------------------------------------------------------------------------
// Transforms

/**
 * Layer transform. p: [x, y] tracks (split position), a: [x, y] anchor,
 * s: [sx, sy] percent tracks, r: degrees track, o: percent track.
 */
export function layerTransform({ p = [0, 0], a = [0, 0], s = [100, 100], r = 0, o = 100, name = '' } = {}) {
  const px = anim1(p[0], { tol: TOL.pos, name: `${name}.px` });
  const py = anim1(p[1], { tol: TOL.pos, name: `${name}.py` });
  const pos = px.a === 0 && py.a === 0 ? { a: 0, k: [px.k, py.k, 0] } : { s: true, x: px, y: py };
  return {
    o: anim1(o, { tol: TOL.opacity, name: `${name}.o` }),
    r: anim1(r, { tol: TOL.rot, name: `${name}.r` }),
    p: pos,
    a: { a: 0, k: [r3(a[0]), r3(a[1]), 0] },
    s: anim([s[0], s[1], 100], { tol: TOL.scale, name: `${name}.s` }),
  };
}

/** Shape-group transform (position is a plain 2-D value here). */
export function groupTransform({ p = [0, 0], a = [0, 0], s = [100, 100], r = 0, o = 100, name = '' } = {}) {
  return {
    ty: 'tr',
    p: anim(p, { tol: TOL.pos, name: `${name}.p` }),
    a: anim(a, { tol: TOL.pos, name: `${name}.a` }),
    s: anim(s, { tol: TOL.scale, name: `${name}.s` }),
    r: anim1(r, { tol: TOL.rot, name: `${name}.r` }),
    o: anim1(o, { tol: TOL.opacity, name: `${name}.o` }),
    sk: { a: 0, k: 0 },
    sa: { a: 0, k: 0 },
    nm: 'Transform',
  };
}

// ---------------------------------------------------------------------------
// Shapes

export function group(nm, items, tr = {}) {
  return { ty: 'gr', nm, np: items.length, cix: 2, bm: 0, it: [...items, groupTransform({ ...tr, name: nm })] };
}

export function ellipse({ size = [100, 100], p = [0, 0], name = 'ellipse' } = {}) {
  return { ty: 'el', d: 1, nm: name, s: anim(size, { tol: TOL.size, name: `${name}.s` }), p: anim(p, { tol: TOL.pos, name: `${name}.p` }) };
}

export function rect({ size = [100, 100], p = [0, 0], r = 0, name = 'rect' } = {}) {
  return {
    ty: 'rc', d: 1, nm: name,
    s: anim(size, { tol: TOL.size, name: `${name}.s` }),
    p: anim(p, { tol: TOL.pos, name: `${name}.p` }),
    r: anim1(r, { tol: TOL.size, name: `${name}.r` }),
  };
}

/**
 * A static path. `pts` is [[x, y, inX, inY, outX, outY], ...] with tangents
 * relative to the vertex (Lottie's convention); missing tangents are zero.
 */
export function path(pts, closed = false, nm = 'path') {
  return {
    ty: 'sh', d: 1, nm,
    ks: {
      a: 0,
      k: {
        i: pts.map((q) => [r3(q[2] ?? 0), r3(q[3] ?? 0)]),
        o: pts.map((q) => [r3(q[4] ?? 0), r3(q[5] ?? 0)]),
        v: pts.map((q) => [r3(q[0]), r3(q[1])]),
        c: closed,
      },
    },
  };
}

/** A straight line from a to b. */
export function linePath(a, b, nm = 'line') {
  return path([[a[0], a[1]], [b[0], b[1]]], false, nm);
}

/** A cubic bezier segment as a path: p0 -> p3 with controls p1, p2. */
export function bezierPath([p0, p1, p2, p3], nm = 'arc') {
  return path(
    [
      [p0[0], p0[1], 0, 0, p1[0] - p0[0], p1[1] - p0[1]],
      [p3[0], p3[1], p2[0] - p3[0], p2[1] - p3[1], 0, 0],
    ],
    false,
    nm,
  );
}

/** Four-point sparkle star of radius R (concave sides, `pinch` 0..1). */
export function sparklePath(R, pinch = 0.78, nm = 'sparkle') {
  const k = R * pinch;
  // Both tangents of each tip point back toward the centre.
  const tips = [
    [0, -R, 0, k],
    [R, 0, -k, 0],
    [0, R, 0, -k],
    [-R, 0, k, 0],
  ];
  return path(tips.map(([x, y, tx, ty]) => [x, y, tx, ty, tx, ty]), true, nm);
}

export function fill(color, o = 100, nm = 'fill') {
  return { ty: 'fl', nm, c: { a: 0, k: hex(color) }, o: anim1(o, { tol: TOL.opacity, name: `${nm}.o` }), r: 1, bm: 0 };
}

/**
 * Radial gradient fill. stops: [[offset, '#rrggbb', alpha], ...].
 * center/radius are in the group's space.
 */
export function radialFill({ stops, center = [0, 0], radius = 100, o = 100, nm = 'glow' }) {
  const colors = stops.flatMap(([off, c]) => [off, ...hex(c).slice(0, 3)]);
  const alphas = stops.flatMap(([off, , a]) => [off, a]);
  return {
    ty: 'gf', nm, t: 2, r: 1, bm: 0,
    o: anim1(o, { tol: TOL.opacity, name: `${nm}.o` }),
    s: { a: 0, k: [r3(center[0]), r3(center[1])] },
    e: { a: 0, k: [r3(center[0] + radius), r3(center[1])] },
    h: { a: 0, k: 0 },
    a: { a: 0, k: 0 },
    g: { p: stops.length, k: { a: 0, k: [...colors, ...alphas].map(r4) } },
  };
}

export function linearFill({ stops, from, to, o = 100, nm = 'gradient' }) {
  const colors = stops.flatMap(([off, c]) => [off, ...hex(c).slice(0, 3)]);
  const alphas = stops.flatMap(([off, , a]) => [off, a]);
  return {
    ty: 'gf', nm, t: 1, r: 1, bm: 0,
    o: anim1(o, { tol: TOL.opacity, name: `${nm}.o` }),
    s: anim(from, { tol: TOL.pos, name: `${nm}.s` }),
    e: anim(to, { tol: TOL.pos, name: `${nm}.e` }),
    g: { p: stops.length, k: { a: 0, k: [...colors, ...alphas].map(r4) } },
  };
}

export function stroke({ color, width = 2, o = 100, cap = 'round', dash = null, nm = 'stroke' }) {
  const s = {
    ty: 'st', nm, bm: 0,
    c: { a: 0, k: hex(color) },
    o: anim1(o, { tol: TOL.opacity, name: `${nm}.o` }),
    w: anim1(width, { tol: TOL.size, name: `${nm}.w` }),
    lc: cap === 'round' ? 2 : cap === 'square' ? 3 : 1,
    lj: 2,
    ml: 4,
  };
  if (dash) {
    s.d = [
      { n: 'd', nm: 'dash', v: anim1(dash.dash, { name: `${nm}.dash` }) },
      { n: 'g', nm: 'gap', v: anim1(dash.gap, { name: `${nm}.gap` }) },
      { n: 'o', nm: 'offset', v: anim1(dash.offset ?? 0, { name: `${nm}.offset` }) },
    ];
  }
  return s;
}

/** Linear gradient stroke; stops: [[offset, '#rrggbb', alpha], ...]. */
export function gradientStroke({ stops, from, to, width = 2, o = 100, cap = 'round', nm = 'gradient stroke' }) {
  const colors = stops.flatMap(([off, c]) => [off, ...hex(c).slice(0, 3)]);
  const alphas = stops.flatMap(([off, , a]) => [off, a]);
  return {
    ty: 'gs', nm, t: 1, bm: 0,
    o: anim1(o, { tol: TOL.opacity, name: `${nm}.o` }),
    w: anim1(width, { tol: TOL.size, name: `${nm}.w` }),
    s: anim(from, { tol: TOL.pos, name: `${nm}.s` }),
    e: anim(to, { tol: TOL.pos, name: `${nm}.e` }),
    g: { p: stops.length, k: { a: 0, k: [...colors, ...alphas].map(r4) } },
    lc: cap === 'round' ? 2 : cap === 'square' ? 3 : 1,
    lj: 2,
    ml: 4,
  };
}

export function trim({ s = 0, e = 100, o = 0, nm = 'trim' }) {
  return {
    ty: 'tm', nm, m: 1,
    s: anim1(s, { tol: TOL.trim, name: `${nm}.s` }),
    e: anim1(e, { tol: TOL.trim, name: `${nm}.e` }),
    o: anim1(o, { tol: TOL.rot, name: `${nm}.o` }),
  };
}

// ---------------------------------------------------------------------------
// Layers and the document

function baseLayer(ty, { nm, ks, ip = 0, op = LOOP, parent, bm = 0, key, parentKey, tt, td }) {
  const layer = { ddd: 0, ind: 0, ty, nm, sr: 1, ks, ao: 0, ip, op, st: 0, bm };
  if (parent !== undefined) layer.parent = parent;
  if (tt) layer.tt = tt; // 1: alpha matte from the layer above
  if (td) layer.td = td; // this layer is a matte
  if (key) layer.key = key;
  if (parentKey) layer.parentKey = parentKey;
  return layer;
}

export function imageLayer({ refId, masks, ...rest }) {
  return { ...baseLayer(2, rest), refId, ...(masks ? { hasMask: true, masksProperties: masks } : {}) };
}

export function shapeLayer({ shapes, ...rest }) {
  return { ...baseLayer(4, rest), shapes };
}

/** A mask (add mode) from a closed static path in layer space. */
export function mask(pts, nm = 'mask') {
  return {
    inv: false, mode: 'a', nm,
    pt: path(pts, true).ks,
    o: { a: 0, k: 100 },
    x: { a: 0, k: 0 },
  };
}

/**
 * Build the document. `layers` are listed bottom to top (painter's order);
 * Lottie wants them top first, so they are reversed and numbered here. A
 * layer may carry `key` (a string) and `parentKey` to parent by name.
 */
export function composition({ nm, layers, assets, still }) {
  const ordered = [...layers].reverse();
  const byKey = new Map();
  ordered.forEach((l, i) => {
    l.ind = i + 1;
    if (l.key) byKey.set(l.key, l.ind);
  });
  for (const l of ordered) {
    if (l.parentKey) {
      if (!byKey.has(l.parentKey)) throw new Error(`no layer keyed ${l.parentKey}`);
      l.parent = byKey.get(l.parentKey);
    }
    delete l.key;
    delete l.parentKey;
  }
  return {
    v: '5.7.4',
    fr: FPS,
    ip: 0,
    op: LOOP,
    w: W,
    h: H,
    nm,
    ddd: 0,
    assets,
    layers: ordered,
    // A 'still' marker names the frame to hold when motion is reduced.
    markers: still === undefined ? [] : [{ tm: still, cm: 'still', dr: 0 }],
  };
}
