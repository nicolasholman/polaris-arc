// Prepares the glass renders for embedding: crop to the art, pad, downscale,
// optionally soften (depth of field), quantise to a palette PNG, and return
// a Lottie image asset with the data inline.

import fs from 'node:fs';
import { decodePng, alphaBounds, resize, cleanTransparent, quantize, encodeIndexed } from './png.mjs';

export function crop(img, x0, y0, w, h) {
  const out = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  for (let y = 0; y < h; y++) {
    const sy = y + y0;
    if (sy < 0 || sy >= img.height) continue;
    for (let x = 0; x < w; x++) {
      const sx = x + x0;
      if (sx < 0 || sx >= img.width) continue;
      const s = (sy * img.width + sx) * 4;
      const o = (y * w + x) * 4;
      out.data[o] = img.data[s];
      out.data[o + 1] = img.data[s + 1];
      out.data[o + 2] = img.data[s + 2];
      out.data[o + 3] = img.data[s + 3];
    }
  }
  return out;
}

/** Separable Gaussian blur in premultiplied alpha. */
export function blur(img, sigma) {
  if (sigma <= 0) return img;
  const radius = Math.ceil(sigma * 3);
  const kernel = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(v);
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const { width, height, data } = img;
  const pre = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const a = data[i * 4 + 3] / 255;
    pre[i * 4] = data[i * 4] * a;
    pre[i * 4 + 1] = data[i * 4 + 1] * a;
    pre[i * 4 + 2] = data[i * 4 + 2] * a;
    pre[i * 4 + 3] = data[i * 4 + 3];
  }
  const pass = (src, horizontal) => {
    const dst = new Float32Array(src.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let k = -radius; k <= radius; k++) {
          const xx = horizontal ? x + k : x;
          const yy = horizontal ? y : y + k;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          const s = (yy * width + xx) * 4;
          const w = kernel[k + radius];
          r += src[s] * w; g += src[s + 1] * w; b += src[s + 2] * w; a += src[s + 3] * w;
        }
        const o = (y * width + x) * 4;
        dst[o] = r; dst[o + 1] = g; dst[o + 2] = b; dst[o + 3] = a;
      }
    }
    return dst;
  };
  const out = pass(pass(pre, true), false);
  const res = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const a = out[i * 4 + 3];
    if (a < 0.5) continue;
    res[i * 4] = out[i * 4] / (a / 255);
    res[i * 4 + 1] = out[i * 4 + 1] / (a / 255);
    res[i * 4 + 2] = out[i * 4 + 2] / (a / 255);
    res[i * 4 + 3] = a;
  }
  return { width, height, data: res };
}

/** Principal axis of the opaque pixels: centre, unit axis, and extents. */
export function principalAxis(img, threshold = 128) {
  let n = 0, mx = 0, my = 0;
  const { width, height, data } = img;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3] > threshold) { n++; mx += x; my += y; }
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] <= threshold) continue;
    const dx = x - mx, dy = y - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(angle), uy = Math.sin(angle);
  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] <= threshold) continue;
    const dx = x - mx, dy = y - my;
    const u = dx * ux + dy * uy;
    const v = -dx * uy + dy * ux;
    if (u < umin) umin = u; if (u > umax) umax = u;
    if (v < vmin) vmin = v; if (v > vmax) vmax = v;
  }
  return { cx: mx, cy: my, ux, uy, angle: (angle * 180) / Math.PI, umin, umax, vmin, vmax };
}

/** Centroid of the pixels a predicate picks (e.g. the lime ball in the pin). */
export function centroid(img, pick) {
  let n = 0, sx = 0, sy = 0;
  const { width, height, data } = img;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = (y * width + x) * 4;
    if (pick(data[o], data[o + 1], data[o + 2], data[o + 3])) { n++; sx += x; sy += y; }
  }
  return { x: sx / n, y: sy / n, n };
}

/**
 * Load a render, crop it to its art with `pad` pixels (in output pixels) of
 * room, scale its longest side to `size`, blur by `sigma`, and quantise.
 * Returns { asset, img, scale, offset } where scale/offset map source pixels
 * to asset pixels: asset = (src - offset) * scale.
 */
export function prepare(file, { id, size, sigma = 0, pad = 2, colors = 256, dither = 0.55 }) {
  const src = decodePng(fs.readFileSync(file));
  const b = alphaBounds(src, 0);
  const w = b.x1 - b.x0 + 1;
  const h = b.y1 - b.y0 + 1;
  // `size` bounds the whole asset, padding included.
  const padOut = pad + Math.ceil(sigma * 3);
  const scale = (size - 2 * padOut) / Math.max(w, h);
  const padSrc = Math.ceil(padOut / scale);
  const x0 = b.x0 - padSrc;
  const y0 = b.y0 - padSrc;
  const cw = w + padSrc * 2;
  const ch = h + padSrc * 2;
  const ow = Math.min(size, Math.round(cw * scale));
  const oh = Math.min(size, Math.round(ch * scale));
  let img = resize(crop(src, x0, y0, cw, ch), ow, oh);
  if (sigma > 0) img = blur(img, sigma);
  cleanTransparent(img);
  const png = encodeIndexed(quantize(img, { colors, dither }));
  const sx = ow / cw;
  const sy = oh / ch;
  return {
    src,
    img,
    bytes: png.length,
    map: (x, y) => [(x - x0) * sx, (y - y0) * sy],
    asset: { id, w: ow, h: oh, u: '', p: `data:image/png;base64,${png.toString('base64')}`, e: 1 },
  };
}
