# Onboarding Lottie animations

The three onboarding animations for the consumer app are generated, not
hand-exported. This folder holds the generator and a renderer to check it.

| File | Page | What happens |
|---|---|---|
| `apps/app/public/lottie/onboarding-1.json` | Get paid in dollars. Instantly. | Three glass coins (purple near, lime middle, crimson far) drift in from the edges, overlap in depth, and bob and turn slowly over soft purple and lime glows, with rim glints. |
| `apps/app/public/lottie/onboarding-2.json` | Split it in four. Pay as you go. | The lime glass card floats in and catches a sheen, cracks into four segments that part and fan out, and each segment tips over into one of four ticks (the app's Pay in 4 progress), which fill in lime one by one. A shimmer runs along the finished row, and it fades as the next card floats in. |
| `apps/app/public/lottie/onboarding-3.json` | Send money anywhere. By link. | Two glass pins stand apart under a dotted arc. The near pin's light swells, a lime coin rises out of its head, flies along the arc with a light trail, and drops into the far pin, which lights up and throws a small burst of sparkles and a ring. |

Every file is a 4-second loop at 60 fps (240 frames), 390x520, on a
transparent background, under 400 KB (about 200, 160 and 140 KB). Review
frames at 0, 1, 2 and 3 seconds are in
[`docs/design/lottie-frames/`](../../docs/design/lottie-frames/).

## Build

```sh
node scripts/lottie/build.mjs
```

Plain Node 22, no dependencies. It rewrites the three JSON files from the
glass renders in `apps/app/public/assets/onboarding/` and the scene scripts,
so the output is reproducible: change a scene, run the build, commit the JSON.

The build checks each file and exits non-zero if any check fails:

- 60 fps, frames 0 to 240, 390x520, no solid (background) layer
- under 400 KB, every embedded image at most 384 px
- **the seam**: on every layer that is on screen at the loop point (and every
  layer it is parented to), each animated value ends where it starts, with
  the same speed, so frame 239 flows into frame 0. Marching dashes pass when
  they move by whole dash periods.

## Check the pictures

```sh
node scripts/lottie/render.mjs                     # frames at 0/1/2/3 s -> docs/design/lottie-frames/
node scripts/lottie/render.mjs --sheet /tmp/sheets # plus a contact sheet per file, every 12 frames
node scripts/lottie/render.mjs --renderer canvas   # lottie-web's canvas renderer instead of SVG
```

It renders each file with lottie-web in headless Chrome, on the app
background (`#0F1011`), at 2x, and writes palette PNGs (`--lossless` for full
colour). For each file it also reports:

- **seam**: frame 239.99 against frame 0, next to one ordinary frame step. A
  seamless loop differs by far less than one step (the last run: 0.010 vs
  0.886, 0.038 vs 1.790, 0.002 vs 0.233 mean difference per channel).
- **transparency**: the share of pixels left fully clear with no page
  background (the glows cover much of the canvas at low alpha).

No npm install needed: it drives Chrome over the DevTools protocol with
Node's built-in WebSocket. Chrome comes from `--chrome`, `CHROME_PATH`, the
Puppeteer or Playwright caches, or a standard install. lottie-web comes from
`--lottie`, `LOTTIE_WEB`, `node_modules`, or is fetched once (pinned 5.12.2)
from jsDelivr into the OS temp directory. `--port` picks the debugging port.

## How it works

```
build.mjs            art prep, the three scenes, checks, writes the JSON
render.mjs           verification renderer (lottie-web in headless Chrome)
lib/lottie.mjs       tracks, the keyframe compiler, shapes, layers, document
lib/images.mjs       crop, downscale, depth-of-field blur, quantise, embed
lib/png.mjs          PNG decode/encode, Lanczos resampling, palette quantiser
scenes/common.mjs    glass sprite, glow, twinkling sparkle, bump
scenes/coins.mjs     onboarding 1
scenes/split.mjs     onboarding 2
scenes/link.mjs      onboarding 3
```

**Art.** Each render is cropped to its alpha, downscaled with Lanczos in
premultiplied alpha (so edges never darken), quantised to a 256-colour
palette with light dithering, and embedded as a base64 PNG asset. The far
crimson coin gets a slight blur for depth of field, baked into its pixels.
Sizes: purple coin 384 px, lime coin 320, crimson 256, card 384, pin 320,
small lime coin 192. Positions inside a render (the pin's lime ball, the
card's long axis) are measured from the pixels, not typed in.

**Motion as functions.** Every animated value is a JavaScript function of
the frame (a *track*): `tween` for keyed moves with named easings, `wave` and
`swell` for periodic motion, `cyc` to run a keyed story across the loop seam,
and `track` for anything else (the segment fan, the arc-length flight, the
landing kick). Periodic tracks use whole cycles per loop, so they close
exactly.

**The compiler.** `anim()` turns tracks into Lottie keyframes. Each stretch
between keys is a cubic Hermite segment: the bezier handles sit at x = 1/3
and 2/3, so time runs linearly and the handle heights carry the slopes at
both ends. A stretch splits until it matches the function to within a
tolerance (0.12 px, 0.08°, 0.4% opacity...), checked twice a frame, then
neighbours merge back wherever one segment still fits. Motion stays smooth
across keys and the files stay small (roughly 300 to 900 keyframes each).
Multi-dimensional values use per-dimension handles; layer positions are
split into x and y.

**Layers.** Glass renders are image layers; everything else is vector:
radial-gradient glows, four-point sparkles, the dotted arc (a dashed stroke
with round caps), the light trail (four trimmed strokes of growing lag and
shrinking width, so it tapers), the card's segments (four masks over one
image, with light along the cut edges), the sheen and the row shimmer (alpha
track mattes), and the ticks (a gradient-stroked line under a trim).

## Using them in the app

- Play with lottie-web (`renderer: 'svg'`, `loop: true`, `autoplay: true`)
  or any player built on it; the canvas renderer draws them the same.
- The art fills a 390x520 box above the headline; the coins in page 1 bleed
  off the left and right edges on purpose, as in the reference.
- **Reduced motion:** each file has a `still` marker (frames 120, 120 and 96:
  the settled coins, the fanned card, the coin over the arc). With
  lottie-web, load with `autoplay: false` and call `anim.goToAndStop('still')`;
  other players can read `markers[0].tm` from the JSON.

## Changing a scene

Edit the numbers at the top of a scene file (timeline frames, layout), run
the build, then the renderer with `--sheet` and look at the contact sheet.
Keep anything that is on screen at frame 0 periodic (a `wave`, a `swell`, a
`cyc` story that ends where it starts); the build will name any value that
does not close.
