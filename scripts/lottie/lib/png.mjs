// A small PNG toolkit for the Lottie build: decode, resample, quantise and
// encode, in plain Node (only node:zlib). It handles what the glass renders
// are (8-bit, non-interlaced) and writes the smallest PNG it can find.

import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** An image is { width, height, data: Uint8ClampedArray RGBA (straight alpha) }. */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let trns = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error('interlaced PNGs are not supported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    for (let x = 0; x < stride; x++) {
      const v = raw[rowStart + 1 + x];
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let r;
      switch (filter) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: r = v + paeth(a, b, c); break;
        default: throw new Error(`bad filter ${filter}`);
      }
      cur[x] = r & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * channels;
      if (colorType === 6) {
        out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = cur[s + 3];
      } else if (colorType === 2) {
        out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = 255;
      } else if (colorType === 0) {
        out[o] = out[o + 1] = out[o + 2] = cur[s]; out[o + 3] = 255;
      } else if (colorType === 4) {
        out[o] = out[o + 1] = out[o + 2] = cur[s]; out[o + 3] = cur[s + 1];
      } else {
        const i = cur[s];
        out[o] = palette[i * 3]; out[o + 1] = palette[i * 3 + 1]; out[o + 2] = palette[i * 3 + 2];
        out[o + 3] = trns && i < trns.length ? trns[i] : 255;
      }
    }
    [prev, cur] = [cur, prev];
  }
  return { width, height, data: out };
}

/** The tight box around every pixel whose alpha is above `threshold`. */
export function alphaBounds(img, threshold = 0) {
  const { width, height, data } = img;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { x0, y0, x1, y1 };
}

// Lanczos-3: sharp enough to keep the glass highlights crisp when downscaling.
function lanczos(x) {
  if (x === 0) return 1;
  if (x <= -3 || x >= 3) return 0;
  const px = Math.PI * x;
  return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
}

function weightsFor(srcSize, dstSize) {
  const scale = dstSize / srcSize;
  const support = scale < 1 ? 3 / scale : 3;
  const stretch = scale < 1 ? scale : 1;
  const table = [];
  for (let i = 0; i < dstSize; i++) {
    const center = (i + 0.5) / scale - 0.5;
    const start = Math.max(0, Math.floor(center - support));
    const end = Math.min(srcSize - 1, Math.ceil(center + support));
    const w = [];
    let sum = 0;
    for (let j = start; j <= end; j++) {
      const v = lanczos((j - center) * stretch);
      w.push(v);
      sum += v;
    }
    table.push({ start, w: w.map((v) => v / sum) });
  }
  return table;
}

/** Resample to width x height in premultiplied alpha, so edges never go dark. */
export function resize(img, width, height) {
  const { width: sw, height: sh, data } = img;
  const pre = new Float32Array(sw * sh * 4);
  for (let i = 0; i < sw * sh; i++) {
    const a = data[i * 4 + 3] / 255;
    pre[i * 4] = data[i * 4] * a;
    pre[i * 4 + 1] = data[i * 4 + 1] * a;
    pre[i * 4 + 2] = data[i * 4 + 2] * a;
    pre[i * 4 + 3] = data[i * 4 + 3];
  }
  const wx = weightsFor(sw, width);
  const wy = weightsFor(sh, height);
  const tmp = new Float32Array(width * sh * 4);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < width; x++) {
      const { start, w } = wx[x];
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < w.length; k++) {
        const s = (y * sw + start + k) * 4;
        r += pre[s] * w[k]; g += pre[s + 1] * w[k]; b += pre[s + 2] * w[k]; a += pre[s + 3] * w[k];
      }
      const o = (y * width + x) * 4;
      tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = a;
    }
  }
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const { start, w } = wy[y];
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < w.length; k++) {
        const s = ((start + k) * width + x) * 4;
        r += tmp[s] * w[k]; g += tmp[s + 1] * w[k]; b += tmp[s + 2] * w[k]; a += tmp[s + 3] * w[k];
      }
      const o = (y * width + x) * 4;
      const alpha = Math.min(255, Math.max(0, a));
      if (alpha < 0.5) {
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      } else {
        const k = 255 / alpha;
        out[o] = r * k;
        out[o + 1] = g * k;
        out[o + 2] = b * k;
        out[o + 3] = alpha;
      }
    }
  }
  return { width, height, data: out };
}

/** Clear colour under fully transparent pixels so they compress to nothing. */
export function cleanTransparent(img) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 0) d[i] = d[i + 1] = d[i + 2] = 0;
  return img;
}

// ---- quantisation (median cut, then k-means refinement, in premultiplied RGBA) ----

function buildHistogram(img) {
  // 5 bits per channel keeps the histogram small without visible loss for the seeds.
  const map = new Map();
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 0) continue;
    const key = ((d[i] >> 3) << 15) | ((d[i + 1] >> 3) << 10) | ((d[i + 2] >> 3) << 5) | (a >> 3);
    let e = map.get(key);
    if (!e) {
      e = { r: 0, g: 0, b: 0, a: 0, n: 0 };
      map.set(key, e);
    }
    e.r += d[i]; e.g += d[i + 1]; e.b += d[i + 2]; e.a += a; e.n++;
  }
  return [...map.values()].map((e) => ({ r: e.r / e.n, g: e.g / e.n, b: e.b / e.n, a: e.a / e.n, n: e.n }));
}

function medianCut(colors, count) {
  const boxes = [colors];
  const channelsOf = ['r', 'g', 'b', 'a'];
  while (boxes.length < count) {
    // Split the box with the largest weighted spread.
    let best = -1, bestScore = -1, bestChannel = 'r';
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      for (const ch of channelsOf) {
        let min = Infinity, max = -Infinity, n = 0;
        for (const c of box) { if (c[ch] < min) min = c[ch]; if (c[ch] > max) max = c[ch]; n += c.n; }
        const score = (max - min) * Math.sqrt(n);
        if (score > bestScore) { bestScore = score; best = i; bestChannel = ch; }
      }
    });
    if (best < 0) break;
    const box = boxes[best].sort((p, q) => p[bestChannel] - q[bestChannel]);
    const total = box.reduce((s, c) => s + c.n, 0);
    let acc = 0, cut = 1;
    for (let i = 0; i < box.length; i++) { acc += box[i].n; if (acc >= total / 2) { cut = Math.max(1, Math.min(box.length - 1, i + 1)); break; } }
    boxes.splice(best, 1, box.slice(0, cut), box.slice(cut));
  }
  return boxes.map((box) => {
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (const c of box) { r += c.r * c.n; g += c.g * c.n; b += c.b * c.n; a += c.a * c.n; n += c.n; }
    return { r: r / n, g: g / n, b: b / n, a: a / n };
  });
}

function nearest(palette, r, g, b, a) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    // Compare premultiplied, so transparent-ish colours don't fight over hue.
    const pa = p.a / 255, qa = a / 255;
    const dr = p.r * pa - r * qa, dg = p.g * pa - g * qa, db = p.b * pa - b * qa, da = p.a - a;
    const d = dr * dr + dg * dg + db * db + da * da * 1.5;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * Reduce to at most 256 colours (one reserved for full transparency), with
 * light Floyd-Steinberg dithering so the glass gradients don't band.
 */
export function quantize(img, { colors = 256, dither = 0.6, iterations = 4 } = {}) {
  const hist = buildHistogram(img);
  let palette = medianCut(hist, colors - 1);
  // k-means refinement over the histogram.
  for (let it = 0; it < iterations; it++) {
    const acc = palette.map(() => ({ r: 0, g: 0, b: 0, a: 0, n: 0 }));
    for (const c of hist) {
      const i = nearest(palette, c.r, c.g, c.b, c.a);
      const e = acc[i];
      e.r += c.r * c.n; e.g += c.g * c.n; e.b += c.b * c.n; e.a += c.a * c.n; e.n += c.n;
    }
    palette = palette.map((p, i) => (acc[i].n ? { r: acc[i].r / acc[i].n, g: acc[i].g / acc[i].n, b: acc[i].b / acc[i].n, a: acc[i].a / acc[i].n } : p));
  }
  palette = palette.map((p) => ({ r: Math.round(p.r), g: Math.round(p.g), b: Math.round(p.b), a: Math.round(p.a) }));
  palette.unshift({ r: 0, g: 0, b: 0, a: 0 });

  const { width, height, data } = img;
  const indices = new Uint8Array(width * height);
  const err = new Float32Array((width + 2) * 2 * 4);
  const cache = new Map();
  for (let y = 0; y < height; y++) {
    const curRow = (y & 1) * (width + 2);
    const nextRow = ((y + 1) & 1) * (width + 2);
    for (let x = 0; x < width + 2; x++) for (let c = 0; c < 4; c++) err[(nextRow + x) * 4 + c] = 0;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (data[o + 3] === 0) { indices[y * width + x] = 0; continue; }
      const e = (curRow + x + 1) * 4;
      const r = Math.max(0, Math.min(255, data[o] + err[e]));
      const g = Math.max(0, Math.min(255, data[o + 1] + err[e + 1]));
      const b = Math.max(0, Math.min(255, data[o + 2] + err[e + 2]));
      const a = Math.max(0, Math.min(255, data[o + 3] + err[e + 3]));
      const key = ((r >> 1) << 21) | ((g >> 1) << 14) | ((b >> 1) << 7) | (a >> 1);
      let i = cache.get(key);
      if (i === undefined) {
        i = nearest(palette, r, g, b, a);
        cache.set(key, i);
      }
      indices[y * width + x] = i;
      const p = palette[i];
      const diff = [(r - p.r) * dither, (g - p.g) * dither, (b - p.b) * dither, (a - p.a) * dither];
      for (let c = 0; c < 4; c++) {
        err[(curRow + x + 2) * 4 + c] += (diff[c] * 7) / 16;
        err[(nextRow + x) * 4 + c] += (diff[c] * 3) / 16;
        err[(nextRow + x + 1) * 4 + c] += (diff[c] * 5) / 16;
        err[(nextRow + x + 2) * 4 + c] += (diff[c] * 1) / 16;
      }
    }
  }
  return { width, height, palette, indices };
}

// ---- encoding ----

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function filterRows(rows, stride, bpp, mode) {
  const out = Buffer.alloc(rows.length * (stride + 1));
  let prev = new Uint8Array(stride);
  const candidates = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  rows.forEach((row, y) => {
    const tryFilter = (f, dst) => {
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? row[x - bpp] : 0;
        const b = prev[x];
        const c = x >= bpp ? prev[x - bpp] : 0;
        let v;
        switch (f) {
          case 0: v = row[x]; break;
          case 1: v = row[x] - a; break;
          case 2: v = row[x] - b; break;
          case 3: v = row[x] - ((a + b) >> 1); break;
          default: v = row[x] - paeth(a, b, c);
        }
        dst[x] = v & 0xff;
        sum += dst[x] < 128 ? dst[x] : 256 - dst[x];
      }
      return sum;
    };
    let best = 0;
    if (mode === 'none') tryFilter(0, candidates[0]);
    else {
      let bestSum = Infinity;
      for (let f = 0; f < 5; f++) {
        const s = tryFilter(f, candidates[f]);
        if (s < bestSum) { bestSum = s; best = f; }
      }
    }
    out[y * (stride + 1)] = best;
    Buffer.from(candidates[best].buffer, 0, stride).copy(out, y * (stride + 1) + 1);
    prev = row;
  });
  return out;
}

function smallestDeflate(raw) {
  let best = null;
  for (const strategy of [zlib.constants.Z_DEFAULT_STRATEGY, zlib.constants.Z_FILTERED]) {
    const z = zlib.deflateSync(raw, { level: 9, memLevel: 9, strategy });
    if (!best || z.length < best.length) best = z;
  }
  return best;
}

function ihdr(width, height, colorType) {
  const h = Buffer.alloc(13);
  h.writeUInt32BE(width, 0);
  h.writeUInt32BE(height, 4);
  h[8] = 8;
  h[9] = colorType;
  return h;
}

/** Truecolour + alpha (colour type 6). */
export function encodeRgba(img) {
  const { width, height, data } = img;
  const stride = width * 4;
  const rows = [];
  for (let y = 0; y < height; y++) rows.push(new Uint8Array(data.buffer, data.byteOffset + y * stride, stride));
  const idat = smallestDeflate(filterRows(rows, stride, 4, 'adaptive'));
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr(width, height, 6)), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** Palette + tRNS (colour type 3), from quantize(). */
export function encodeIndexed(q) {
  const { width, height, palette, indices } = q;
  const plte = Buffer.alloc(palette.length * 3);
  const trns = Buffer.alloc(palette.length);
  palette.forEach((p, i) => {
    plte[i * 3] = p.r; plte[i * 3 + 1] = p.g; plte[i * 3 + 2] = p.b;
    trns[i] = p.a;
  });
  const rows = [];
  for (let y = 0; y < height; y++) rows.push(indices.subarray(y * width, (y + 1) * width));
  const candidates = ['none', 'adaptive'].map((mode) => smallestDeflate(filterRows(rows, width, 1, mode)));
  const idat = candidates[0].length <= candidates[1].length ? candidates[0] : candidates[1];
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr(width, height, 3)),
    chunk('PLTE', plte),
    chunk('tRNS', trns),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
