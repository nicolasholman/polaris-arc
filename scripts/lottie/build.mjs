// Builds the three onboarding Lottie animations for the consumer app:
//
//   apps/app/public/lottie/onboarding-1.json   Get paid in dollars. Instantly.
//   apps/app/public/lottie/onboarding-2.json   Split it in four. Pay as you go.
//   apps/app/public/lottie/onboarding-3.json   Send money anywhere. By link.
//
//   node scripts/lottie/build.mjs
//
// Plain Node, no dependencies. The glass renders in
// apps/app/public/assets/onboarding/ are cropped, downscaled (at most 384px),
// quantised to palette PNGs and embedded; the rest is vector shape layers.
// Each file is a 4-second, 60 fps, 390x520 loop on a transparent background,
// checked here for its seam (value and slope match at frame 0 and 240) and
// for its size (under 400 KB).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare } from './lib/images.mjs';
import { LOOP, FPS, W, H, fitWarnings } from './lib/lottie.mjs';
import { coinsScene } from './scenes/coins.mjs';
import { splitScene } from './scenes/split.mjs';
import { linkScene } from './scenes/link.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const art = (f) => path.join(root, 'apps/app/public/assets/onboarding', f);
const outDir = path.join(root, 'apps/app/public/lottie');
const MAX_BYTES = 400 * 1024;
const MAX_ASSET = 384;

function log(...a) {
  console.log(...a);
}

// ---------------------------------------------------------------------------
// Art

const t0 = Date.now();
const prepared = {
  coinPurple: prepare(art('coin-purple.png'), { id: 'coin_purple', size: 384 }),
  coinLime: prepare(art('coin-lime.png'), { id: 'coin_lime', size: 320 }),
  // The far coin is softened a touch: depth of field, baked into the pixels.
  coinCrimson: prepare(art('coin-crimson.png'), { id: 'coin_crimson', size: 256, sigma: 1.1 }),
  card: prepare(art('card-lime.png'), { id: 'card_lime', size: 384 }),
  pin: prepare(art('pin.png'), { id: 'pin', size: 320 }),
  coinSmall: prepare(art('coin-lime.png'), { id: 'coin_lime_small', size: 192 }),
};
for (const [name, p] of Object.entries(prepared)) {
  if (p.asset.w > MAX_ASSET || p.asset.h > MAX_ASSET) throw new Error(`${name} is ${p.asset.w}x${p.asset.h}, over ${MAX_ASSET}px`);
  log(`art ${name.padEnd(12)} ${p.asset.w}x${p.asset.h}  ${(p.bytes / 1024).toFixed(1)} KB`);
}
log(`art prepared in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const assets = Object.fromEntries(Object.entries(prepared).map(([k, p]) => [k, p.asset]));

// ---------------------------------------------------------------------------
// Scenes

const scenes = [
  ['onboarding-1.json', () => coinsScene({ assets, prepared })],
  ['onboarding-2.json', () => splitScene({ assets, prepared })],
  ['onboarding-3.json', () => linkScene({ assets, prepared })],
];

// ---------------------------------------------------------------------------
// The seam check reads the finished JSON. Every layer on screen at the loop
// point (visible at frame 0 and just before frame 240), and every layer it is
// parented to, must have each animated value end where it starts (value and
// slope), so the last frame flows into the first.

function checkSeam(doc) {
  const problems = [];
  let checked = 0;
  const byInd = new Map(doc.layers.map((l) => [l.ind, l]));
  const live = new Set();
  for (const l of doc.layers) {
    if (l.ip <= 0 && l.op >= LOOP) {
      for (let p = l; p; p = p.parent ? byInd.get(p.parent) : null) live.add(p);
    }
  }
  const slope = (a, b, handle, which, i) => {
    const dv = b.s[i] - a.s[i];
    const span = b.t - a.t;
    const y = which === 'out' ? a.o.y[i] : 1 - a.i.y[i];
    return (3 * y * dv) / span;
  };
  const walk = (node, where) => {
    if (!node || typeof node !== 'object') return;
    if (node.a === 1 && Array.isArray(node.k) && node.k[0] && typeof node.k[0].t === 'number') {
      const k = node.k;
      const first = k[0], last = k[k.length - 1], prev = k[k.length - 2];
      for (let i = 0; i < first.s.length; i++) {
        checked++;
        if (first.t !== 0 || last.t !== LOOP) problems.push(`${where}: keys must span 0..${LOOP}`);
        const jump = Math.abs(first.s[i] - last.s[i]);
        const s0 = slope(first, k[1], null, 'out', i);
        const s1 = slope(prev, last, null, 'in', i);
        if (jump > 1e-3) problems.push(`${where}[${i}] jumps by ${jump.toFixed(4)} at the seam`);
        if (Math.abs(s0 - s1) > 0.05) problems.push(`${where}[${i}] changes speed at the seam (${s1.toFixed(3)} -> ${s0.toFixed(3)} per frame)`);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, `${where}/${n?.nm ?? i}`));
      return;
    }
    // Marching dashes loop when the offset moves by whole dash periods.
    if (node.ty === 'st' && Array.isArray(node.d)) {
      const get = (n) => node.d.find((d) => d.n === n)?.v;
      const offset = get('o');
      const period = (get('d')?.k ?? 0) + (get('g')?.k ?? 0);
      if (offset?.a === 1 && period > 0) {
        const k = offset.k;
        const jump = k[k.length - 1].s[0] - k[0].s[0];
        const cycles = jump / period;
        checked++;
        if (Math.abs(cycles - Math.round(cycles)) > 1e-3) problems.push(`${where} dash offset moves ${cycles.toFixed(3)} periods over the loop`);
      }
      for (const [key, v] of Object.entries(node)) if (key !== 'd' && v && typeof v === 'object') walk(v, `${where}.${key}`);
      return;
    }
    for (const [key, v] of Object.entries(node)) if (v && typeof v === 'object') walk(v, `${where}.${key}`);
  };
  for (const l of live) {
    walk(l.ks, `"${l.nm}" transform`);
    if (l.shapes) walk(l.shapes, `"${l.nm}" shapes`);
    if (l.masksProperties) walk(l.masksProperties, `"${l.nm}" masks`);
  }
  // Layers that hand over at the seam (one ends at 240, another starts at 0)
  // are checked by render.mjs, which compares the rendered frames.
  return { problems, checked };
}

fs.mkdirSync(outDir, { recursive: true });
let failed = false;
for (const [file, build] of scenes) {
  fitWarnings.length = 0;
  const doc = build();
  const json = JSON.stringify(doc);
  const bytes = Buffer.byteLength(json);

  // Checks.
  const problems = [];
  if (doc.fr !== FPS || doc.ip !== 0 || doc.op !== LOOP || doc.w !== W || doc.h !== H) problems.push('wrong frame rate, length or canvas');
  if (bytes >= MAX_BYTES) problems.push(`${(bytes / 1024).toFixed(1)} KB is over the 400 KB budget`);
  if (doc.layers.some((l) => l.ty === 1)) problems.push('has a solid layer (the background must stay transparent)');
  const seam = checkSeam(doc);
  problems.push(...seam.problems);

  const keys = JSON.stringify(doc.layers).match(/"t":/g)?.length ?? 0;
  const imageBytes = doc.assets.reduce((s, a) => s + (a.p?.length ?? 0), 0);
  log(
    `\n${file}: ${(bytes / 1024).toFixed(1)} KB (images ${(imageBytes / 1024).toFixed(1)} KB), ` +
      `${doc.layers.length} layers, ${keys} keyframes, ${seam.checked} animated values checked across the seam`,
  );
  if (fitWarnings.length) {
    const names = [...new Set(fitWarnings.map((w) => w.name))];
    log(`  note: ${fitWarnings.length} stretch(es) jump in ${names.join(', ')} (fine only where the layer is hidden)`);
  }
  if (problems.length) {
    failed = true;
    for (const p of problems) log(`  ✗ ${p}`);
  } else {
    log('  ✓ 390x520, 60 fps, 240 frames, transparent, seamless, under 400 KB');
  }
  fs.writeFileSync(path.join(outDir, file), json);
}

if (failed) {
  console.error('\nSome checks failed.');
  process.exit(1);
}
