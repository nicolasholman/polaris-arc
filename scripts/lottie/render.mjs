// Renders the onboarding Lottie files with lottie-web in headless Chrome and
// writes PNG frames, so the art can be reviewed without the app.
//
//   node scripts/lottie/render.mjs                 # frames at 0/1/2/3 s -> docs/design/lottie-frames/
//   node scripts/lottie/render.mjs --sheet out/    # plus a contact sheet per file (every 12 frames)
//
// Options: --files a.json,b.json  --frames 0,60,120,180  --out <dir>  --scale 2
//          --renderer svg|canvas  --bg '#0F1011'|transparent  --sheet <dir> --every 12 --sheet-scale 1
//          --port 9222  --chrome <path to chrome>  --lottie <path to lottie.min.js>  --lossless
//
// No npm dependencies: it drives Chrome over the DevTools protocol with
// Node's built-in WebSocket (Node 22+). Chrome is found from --chrome,
// CHROME_PATH, the Puppeteer or Playwright caches, or a standard install.
// lottie-web comes from --lottie, LOTTIE_WEB, node_modules, or is fetched
// once (pinned) from jsDelivr into the OS temp directory.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { decodePng, quantize, encodeIndexed } from './lib/png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const LOTTIE_VERSION = '5.12.2';

// ---------------------------------------------------------------------------
// Arguments

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const files = (opt('files') ?? [1, 2, 3].map((n) => `apps/app/public/lottie/onboarding-${n}.json`).join(','))
  .split(',')
  .map((f) => path.resolve(root, f));
const frames = opt('frames', '0,60,120,180').split(',').map(Number);
const outDir = path.resolve(root, opt('out', 'docs/design/lottie-frames'));
const scale = Number(opt('scale', '2'));
const renderer = opt('renderer', 'svg');
const bg = opt('bg', '#0F1011');
const sheetDir = opt('sheet') ? path.resolve(root, opt('sheet')) : null;
const every = Number(opt('every', '12'));
const sheetScale = Number(opt('sheet-scale', '1'));
const port = Number(opt('port', '9222'));
// Review frames are written as palette PNGs (about a third of the size);
// --lossless keeps Chrome's full-colour capture.
const lossless = args.includes('--lossless');

// ---------------------------------------------------------------------------
// Chrome and lottie-web

function findChrome() {
  const explicit = opt('chrome') ?? process.env.CHROME_PATH;
  if (explicit) return explicit;
  const home = os.homedir();
  const candidates = [];
  const scan = (dir, rel) => {
    if (!fs.existsSync(dir)) return;
    for (const v of fs.readdirSync(dir).sort().reverse()) {
      for (const r of rel) candidates.push(path.join(dir, v, r));
    }
  };
  scan(path.join(home, '.cache/puppeteer/chrome-headless-shell'), [
    'chrome-headless-shell-win64/chrome-headless-shell.exe',
    'chrome-headless-shell-linux64/chrome-headless-shell',
    'chrome-headless-shell-mac-arm64/chrome-headless-shell',
    'chrome-headless-shell-mac-x64/chrome-headless-shell',
  ]);
  scan(path.join(home, '.cache/puppeteer/chrome'), [
    'chrome-win64/chrome.exe',
    'chrome-linux64/chrome',
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ]);
  const pw = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : path.join(home, '.cache/ms-playwright');
  if (fs.existsSync(pw)) {
    for (const d of fs.readdirSync(pw).sort().reverse()) {
      if (d.startsWith('chromium_headless_shell-')) {
        candidates.push(path.join(pw, d, 'chrome-headless-shell-win64/chrome-headless-shell.exe'));
        candidates.push(path.join(pw, d, 'chrome-linux/headless_shell'));
      }
      if (d.startsWith('chromium-')) {
        candidates.push(path.join(pw, d, 'chrome-win64/chrome.exe'), path.join(pw, d, 'chrome-win/chrome.exe'), path.join(pw, d, 'chrome-linux/chrome'));
      }
    }
  }
  candidates.push(
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  );
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Error('No Chrome found. Pass --chrome <path> or set CHROME_PATH.');
  return found;
}

async function findLottie() {
  const explicit = opt('lottie') ?? process.env.LOTTIE_WEB;
  if (explicit) return explicit;
  for (const base of [root, path.join(root, 'apps/app')]) {
    try {
      return createRequire(path.join(base, 'package.json')).resolve('lottie-web/build/player/lottie.min.js');
    } catch {}
  }
  const cached = path.join(os.tmpdir(), 'polaris-lottie', `lottie-web-${LOTTIE_VERSION}.min.js`);
  if (!fs.existsSync(cached)) {
    const url = `https://cdn.jsdelivr.net/npm/lottie-web@${LOTTIE_VERSION}/build/player/lottie.min.js`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not fetch ${url}: ${res.status}`);
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, Buffer.from(await res.arrayBuffer()));
  }
  return cached;
}

// ---------------------------------------------------------------------------
// A tiny DevTools protocol client

async function launch(chromePath) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-lottie-chrome-'));
  const headlessShell = /headless[-_]shell/i.test(chromePath);
  const proc = spawn(
    chromePath,
    [
      ...(headlessShell ? [] : ['--headless=new']),
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      '--allow-file-access-from-files',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let targets = null;
  for (let i = 0; i < 100 && !targets; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      if (list.some((t) => t.type === 'page')) targets = list;
    } catch {}
  }
  if (!targets) {
    proc.kill();
    throw new Error(`Chrome did not open its debugging port ${port}`);
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const close = async () => {
    try { ws.close(); } catch {}
    proc.kill();
    await new Promise((r) => setTimeout(r, 300));
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  };
  return { send, close, listeners };
}

// ---------------------------------------------------------------------------
// The page

const CELL_W = 390;
const CELL_H = 520;
const LABEL = 22;

function pageHtml(lottieFile, background) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:${background};}
    #grid{display:flex;flex-wrap:wrap;width:${CELL_W * 6}px;}
    .cell{width:${CELL_W}px;height:${CELL_H}px;position:relative;overflow:hidden;}
    .cell.labelled{height:${CELL_H + LABEL}px;}
    .art{width:${CELL_W}px;height:${CELL_H}px;}
    .label{position:absolute;left:0;right:0;bottom:0;height:${LABEL}px;font:12px/22px ui-monospace,monospace;color:#8A8D93;text-align:center;border-top:1px solid #232426;}
  </style></head><body><div id="grid"></div>
  <script src="${pathToFileURL(lottieFile).href}"></script>
  <script>
    window.renderCells = async (json, frames, renderer, labelled) => {
      const data = JSON.parse(json);
      await Promise.all((data.assets || []).filter((a) => a.p && a.p.startsWith('data:')).map((a) => {
        const img = new Image(); img.src = a.p; return img.decode();
      }));
      const grid = document.getElementById('grid');
      grid.innerHTML = '';
      const anims = [];
      for (const f of frames) {
        const cell = document.createElement('div');
        cell.className = 'cell' + (labelled ? ' labelled' : '');
        const art = document.createElement('div');
        art.className = 'art';
        cell.appendChild(art);
        if (labelled) {
          const l = document.createElement('div');
          l.className = 'label';
          l.textContent = 'frame ' + f + '  ·  ' + (f / 60).toFixed(2) + 's';
          cell.appendChild(l);
        }
        grid.appendChild(cell);
        const anim = lottie.loadAnimation({ container: art, renderer, loop: false, autoplay: false, animationData: JSON.parse(json),
          rendererSettings: { preserveAspectRatio: 'xMidYMid meet', clearCanvas: true } });
        await new Promise((r) => (anim.isLoaded ? r() : anim.addEventListener('DOMLoaded', r)));
        anim.goToAndStop(f, true);
        anims.push(anim);
      }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await new Promise((r) => setTimeout(r, 250));
      return anims.length;
    };
  </script></body></html>`;
}

async function renderFrames(cdp, json, list, { labelled = false, columns = 6, dpr = scale } = {}) {
  const cellH = CELL_H + (labelled ? LABEL : 0);
  const rows = Math.ceil(list.length / columns);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: CELL_W * columns,
    height: cellH * rows,
    deviceScaleFactor: dpr,
    mobile: false,
  });
  const res = await cdp.send('Runtime.evaluate', {
    expression: `renderCells(${JSON.stringify(json)}, ${JSON.stringify(list)}, ${JSON.stringify(renderer)}, ${labelled})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
  return { cellH, rows };
}

async function shot(cdp, clip) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: true });
  return Buffer.from(data, 'base64');
}

function diff(a, b) {
  const A = decodePng(a).data;
  const B = decodePng(b).data;
  let sum = 0, max = 0;
  for (let i = 0; i < A.length; i++) {
    const d = Math.abs(A[i] - B[i]);
    sum += d;
    if (d > max) max = d;
  }
  return { mean: sum / A.length, max };
}

// ---------------------------------------------------------------------------

const chrome = findChrome();
const lottieFile = await findLottie();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-lottie-page-'));
const htmlFile = path.join(tmp, 'index.html');
const cdp = await launch(chrome);
console.log(`chrome: ${chrome}\nlottie-web: ${lottieFile}\nrenderer: ${renderer}, scale ${scale}x, background ${bg}`);

try {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const load = async (background) => {
    fs.writeFileSync(htmlFile, pageHtml(lottieFile, background));
    const loaded = new Promise((r) => {
      const l = (m) => {
        if (m.method === 'Page.loadEventFired') {
          cdp.listeners.splice(cdp.listeners.indexOf(l), 1);
          r();
        }
      };
      cdp.listeners.push(l);
    });
    await cdp.send('Page.navigate', { url: pathToFileURL(htmlFile).href });
    await loaded;
  };

  fs.mkdirSync(outDir, { recursive: true });
  for (const file of files) {
    const json = fs.readFileSync(file, 'utf8');
    const base = path.basename(file, '.json');
    const doc = JSON.parse(json);
    const kb = (fs.statSync(file).size / 1024).toFixed(1);
    console.log(`\n${base}: ${kb} KB, ${doc.w}x${doc.h}, ${doc.fr} fps, frames ${doc.ip}-${doc.op}`);

    // Frames on the app background.
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', {});
    await load(bg === 'transparent' ? 'transparent' : bg);
    if (bg === 'transparent') await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await renderFrames(cdp, json, frames, { columns: frames.length });
    for (let i = 0; i < frames.length; i++) {
      const raw = await shot(cdp, { x: i * CELL_W, y: 0, width: CELL_W, height: CELL_H });
      const png = lossless ? raw : encodeIndexed(quantize(decodePng(raw), { dither: 0.7 }));
      const name = frames[i] % doc.fr === 0 ? `${base}-${frames[i] / doc.fr}s.png` : `${base}-f${frames[i]}.png`;
      fs.writeFileSync(path.join(outDir, name), png);
      console.log(`  wrote ${path.relative(root, path.join(outDir, name))} (${(png.length / 1024).toFixed(0)} KB)`);
    }

    // Seam: the last sub-frame against frame 0, next to one normal frame step.
    const last = doc.op - 0.01;
    await renderFrames(cdp, json, [0, last, 1], { columns: 3 });
    const f0 = await shot(cdp, { x: 0, y: 0, width: CELL_W, height: CELL_H });
    const fl = await shot(cdp, { x: CELL_W, y: 0, width: CELL_W, height: CELL_H });
    const f1 = await shot(cdp, { x: CELL_W * 2, y: 0, width: CELL_W, height: CELL_H });
    const seam = diff(f0, fl);
    const step = diff(f0, f1);
    console.log(`  seam: frame ${last} vs 0 differs by ${seam.mean.toFixed(3)} mean (max ${seam.max}); one frame step differs by ${step.mean.toFixed(3)} mean`);

    // Transparency: with no page background, the art must leave pixels clear.
    await load('transparent');
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await renderFrames(cdp, json, [frames[0]], { columns: 1 });
    const clear = decodePng(await shot(cdp, { x: 0, y: 0, width: CELL_W, height: CELL_H }));
    let transparent = 0;
    for (let i = 3; i < clear.data.length; i += 4) if (clear.data[i] === 0) transparent++;
    console.log(`  transparent background: ${((transparent / (clear.width * clear.height)) * 100).toFixed(1)}% of pixels fully clear`);
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', {});

    if (sheetDir) {
      fs.mkdirSync(sheetDir, { recursive: true });
      await load(bg === 'transparent' ? '#0F1011' : bg);
      const list = [];
      for (let f = 0; f < doc.op; f += every) list.push(f);
      const { cellH, rows } = await renderFrames(cdp, json, list, { labelled: true, columns: 6, dpr: sheetScale });
      const png = await shot(cdp, { x: 0, y: 0, width: CELL_W * 6, height: cellH * rows });
      const name = path.join(sheetDir, `${base}-sheet.png`);
      fs.writeFileSync(name, png);
      console.log(`  sheet: ${name}`);
    }
  }
} finally {
  await cdp.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
