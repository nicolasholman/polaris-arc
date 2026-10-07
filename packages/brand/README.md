# @polaris/brand

The Polaris mark: a four-point star with a green rim and a lime face.

```tsx
import { PolarisMark } from "@polaris/brand";

<PolarisMark className="h-7 w-auto" />             // full colour
<PolarisMark mono className="text-[#111] h-5" />   // one colour
<PolarisMark title="" />                           // decorative, next to the word
```

Next.js apps add `transpilePackages: ["@polaris/brand"]` to `next.config`.

## Assets

| File | Use |
|---|---|
| `assets/mark.svg`, `assets/mark-mono.svg` | The vector mark (full colour, and `currentColor`) |
| `assets/mark-{16,32,48,256,512,1024}.png` | The mark on transparent |
| `assets/favicon.ico` | 16, 32 and 48 px |
| `assets/app-icon-{192,512}.png`, `assets/app-icon-maskable-512.png`, `assets/apple-touch-icon.png` | The lime star on ink, for PWA manifests and home screens |
| `assets/shortcut-{send,receive}.svg`, `.png` | App shortcut icons (long-press the app icon): a lime arrow (Lucide's `arrow-up-right` and `arrow-down-left`, ISC) on the app icon's ink, full bleed so a launcher can mask it. The PNGs are the SVGs rendered at 192 px in Chrome. Used by the web manifest's shortcuts and the Android app's Send and Receive |
| `assets/mark-source.png` | The original artwork the vector was fitted to |
| `assets/wordmark.png` | The "Polaris" logotype (raster, transparent) |

The vector is fitted to `mark-source.png`, one cubic Bezier per edge (99.1% outer
and 98.7% inner pixel overlap with the source).

## Wordmark

`assets/wordmark.png` is the team's "Polaris" logotype: glossy green italic
letters with a star riding the swoosh. It's 872x263 on transparent, from
`nickthelegend/polaris-merchant-app-fhenix/public/logo.png`. It is raster
artwork (gloss and glow), so use it as an image: about 32px tall in navs
(2x-sharp up to 131px) and larger for heroes. Use `PolarisMark` wherever
only the symbol fits.
