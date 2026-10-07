import React from "react";

import { VERSION } from "../version.js";

/**
 * The components' stylesheet, rendered by the components themselves: nothing
 * to import, nothing to configure.
 *
 * On React 19 the `href` + `precedence` pair hoists it into <head> once, no
 * matter how many components render it, during SSR and on the client. On
 * React 18 it renders inline next to each component (the same bytes, so the
 * duplicates are harmless).
 *
 * Every colour, radius and size reads a `--polaris-*` custom property with a
 * default, so a merchant themes it with plain CSS on any ancestor:
 *
 *   .checkout { --polaris-button-bg: #111; --polaris-radius: 12px; --polaris-font: "Inter", sans-serif; }
 */

// No quotes, angle brackets or ampersands anywhere in this CSS: React 18 escapes
// them in <style> text during SSR, which would corrupt the rule and fail hydration.
const FONT = "var(--polaris-font,Satoshi,ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif)";
const MUTED = "var(--polaris-muted,color-mix(in srgb,currentColor 64%,transparent))";
const FOCUS = "var(--polaris-focus,#9CEF5E)";

export const CSS = `
.plrs-root{font-family:${FONT};-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;box-sizing:border-box;text-align:left}
.plrs-root *,.plrs-root *::before,.plrs-root *::after{box-sizing:border-box}
.plrs-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}

.plrs-checkout{display:grid;gap:10px;width:100%}
.plrs-checkout[data-block=false]{display:inline-grid;width:auto}
.plrs-btn{--_bg:var(--polaris-button-bg,#0F1011);--_fg:var(--polaris-button-fg,#F5F5F5);--_hover:var(--polaris-button-hover,#1F2023);--_border:var(--polaris-button-border,rgba(255,255,255,.04));
appearance:none;-webkit-appearance:none;position:relative;display:inline-flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:var(--polaris-button-height,54px);margin:0;padding:0 26px;
border:1px solid var(--_border);border-radius:var(--polaris-radius,999px);background:var(--_bg);color:var(--_fg);
font:inherit;font-size:16px;font-weight:600;letter-spacing:-.01em;line-height:1;white-space:nowrap;cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent;
box-shadow:inset 0 1px 0 rgba(255,255,255,.07),0 10px 28px -14px rgba(15,16,17,.6);
transition:transform .18s cubic-bezier(.2,.8,.2,1),background-color .18s ease,box-shadow .18s ease,opacity .18s ease}
.plrs-root[data-theme=lime] .plrs-btn{--_bg:var(--polaris-button-bg,#9CEF5E);--_fg:var(--polaris-button-fg,#0F1011);--_hover:var(--polaris-button-hover,#ADF475);--_border:var(--polaris-button-border,transparent);box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 10px 28px -14px rgba(84,150,20,.7)}
.plrs-root[data-theme=light] .plrs-btn{--_bg:var(--polaris-button-bg,#FFFFFF);--_fg:var(--polaris-button-fg,#13141F);--_hover:var(--polaris-button-hover,#F6F5F9);--_border:var(--polaris-button-border,#D9DBDE);box-shadow:0 1px 2px rgba(19,20,31,.06)}
.plrs-btn:hover:not(:disabled){background:var(--_hover)}
.plrs-btn:active:not(:disabled){transform:scale(.97)}
.plrs-btn:focus-visible{outline:2px solid ${FOCUS};outline-offset:3px}
.plrs-btn:disabled{cursor:not-allowed;opacity:.55}
.plrs-btn[aria-busy=true]{cursor:progress;opacity:1}
.plrs-btn[data-state=done]{--_bg:var(--polaris-success-bg,#9CEF5E);--_fg:var(--polaris-success-fg,#0F1011);--_hover:var(--_bg);opacity:1}
.plrs-btn[data-size=sm]{min-height:44px;padding:0 18px;font-size:15px}
.plrs-btn[data-size=lg]{min-height:60px;padding:0 30px;font-size:17px}
.plrs-btn__label{display:inline-flex;align-items:baseline;gap:.3em;overflow:hidden;text-overflow:ellipsis}
.plrs-btn__word{font-weight:700;letter-spacing:-.02em}
.plrs-mark{display:block;width:1.4em;height:1.4em;flex:none;filter:drop-shadow(0 1px 1px rgba(0,0,0,.25))}
.plrs-root[data-theme=lime] .plrs-mark,.plrs-btn[data-state=done] .plrs-mark{filter:none}
.plrs-icon{width:1.15em;height:1.15em;flex:none}
.plrs-spinner{width:18px;height:18px;flex:none;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:plrs-spin .7s linear infinite}
.plrs-caption{margin:0;text-align:center;font-size:13.5px;line-height:1.45;color:inherit}
.plrs-dim{color:inherit;color:${MUTED}}
.plrs-caption strong,.plrs-msg strong{font-weight:650;font-variant-numeric:tabular-nums;color:var(--polaris-text,inherit)}
.plrs-error{margin:0;text-align:center;font-size:13px;line-height:1.45;color:var(--polaris-danger,#D83B3B)}
.plrs-note{margin:0;text-align:center;font-size:13px;line-height:1.45;color:inherit;color:${MUTED}}
.plrs-note a{color:inherit;text-underline-offset:3px}

.plrs-msg{position:relative;display:block;font-size:var(--polaris-message-size,14px);line-height:1.55;color:inherit}
.plrs-brand{display:inline-flex;align-items:center;gap:.25em;font-weight:700;letter-spacing:-.01em;white-space:nowrap;vertical-align:bottom;color:var(--polaris-text,inherit)}
.plrs-brand .plrs-mark{width:1.15em;height:1.15em;filter:none}
.plrs-link{appearance:none;-webkit-appearance:none;margin:0 0 0 .4em;padding:0;border:0;border-radius:4px;background:none;font:inherit;color:inherit;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px;cursor:pointer}
.plrs-link:hover{text-decoration-thickness:2px}
.plrs-link:focus-visible{outline:2px solid ${FOCUS};outline-offset:2px}

.plrs-pop{position:absolute;z-index:2147482000;top:calc(100% + 10px);left:0;width:min(372px,calc(100vw - 32px));padding:20px 20px 18px;border-radius:var(--polaris-card-radius,28px);
background:var(--polaris-surface,#FFFFFF);color:var(--polaris-surface-text,#13141F);font-size:14px;line-height:1.5;text-align:left;
box-shadow:0 0 0 1px var(--polaris-hairline,rgba(19,20,31,.08)),0 28px 64px -28px rgba(15,16,17,.5);animation:plrs-pop .2s cubic-bezier(.2,.8,.2,1)}
.plrs-pop:focus{outline:none}
.plrs-pop[data-align=end]{left:auto;right:0}
.plrs-root[data-theme=dark] .plrs-pop{background:var(--polaris-surface,#1A1B1D);color:var(--polaris-surface-text,#F5F5F5);box-shadow:0 0 0 1px var(--polaris-hairline,rgba(255,255,255,.07)),0 28px 64px -28px rgba(0,0,0,.8)}
@media (max-width:480px){.plrs-pop{position:fixed;top:auto;left:12px;right:12px;bottom:12px;width:auto;max-height:calc(100vh - 24px);overflow:auto}}
.plrs-pop__head{display:flex;align-items:center;gap:10px;margin:0 0 16px}
.plrs-pop__head .plrs-mark{width:28px;height:28px}
.plrs-pop__title{margin:0;font-size:15px;font-weight:700;letter-spacing:-.01em;color:inherit}
.plrs-close{appearance:none;-webkit-appearance:none;margin-left:auto;display:grid;place-items:center;width:34px;height:34px;padding:0;border:0;border-radius:999px;background:var(--polaris-surface-2,rgba(19,20,31,.06));color:inherit;cursor:pointer}
.plrs-root[data-theme=dark] .plrs-close{background:var(--polaris-surface-2,#2C2D30)}
.plrs-close:focus-visible{outline:2px solid ${FOCUS};outline-offset:2px}
.plrs-hero{margin:0;font-size:28px;font-weight:700;letter-spacing:-.03em;line-height:1.15;font-variant-numeric:tabular-nums}
.plrs-hero__dim{opacity:.45}
.plrs-sub{margin:4px 0 18px;font-size:13px;color:var(--polaris-surface-muted,#6E7080)}
.plrs-root[data-theme=dark] .plrs-sub,.plrs-root[data-theme=dark] .plrs-when,.plrs-root[data-theme=dark] .plrs-fine{color:var(--polaris-surface-muted,#8A8D93)}
.plrs-sched{display:grid;grid-template-columns:repeat(var(--plrs-n,4),minmax(0,1fr));gap:8px;margin:0 0 18px;padding:0;list-style:none}
.plrs-sched li{display:grid;gap:7px;min-width:0}
.plrs-tick{height:6px;border-radius:999px;background:var(--polaris-surface-2,rgba(19,20,31,.08))}
.plrs-root[data-theme=dark] .plrs-tick{background:var(--polaris-surface-2,#2C2D30)}
.plrs-sched li:first-child .plrs-tick{background:var(--polaris-accent,#9CEF5E)}
.plrs-when{font-size:11.5px;color:var(--polaris-surface-muted,#6E7080);white-space:nowrap}
.plrs-amt{font-size:13.5px;font-weight:650;font-variant-numeric:tabular-nums}
.plrs-steps{display:grid;gap:10px;margin:0 0 16px;padding:14px 0 0;list-style:none;border-top:1px solid var(--polaris-hairline,rgba(19,20,31,.08));counter-reset:plrs}
.plrs-root[data-theme=dark] .plrs-steps{border-top-color:var(--polaris-hairline,rgba(255,255,255,.07))}
.plrs-steps li{display:grid;grid-template-columns:24px 1fr;gap:10px;align-items:start;font-size:13.5px;line-height:1.45}
.plrs-steps li::before{counter-increment:plrs;content:counter(plrs);display:grid;place-items:center;width:24px;height:24px;border-radius:999px;background:var(--polaris-accent,#9CEF5E);color:#0F1011;font-size:12px;font-weight:700}
.plrs-fine{margin:0;font-size:11.5px;line-height:1.5;color:var(--polaris-surface-muted,#6E7080)}

@keyframes plrs-spin{to{transform:rotate(360deg)}}
@keyframes plrs-pop{from{opacity:0;transform:translateY(-6px) scale(.98)}}
@media (prefers-reduced-motion:reduce){.plrs-root *,.plrs-root *::before{animation:none!important;transition:none!important}}
`.trim();

const STYLE_ID = `polarispay-sdk-${VERSION}`;

/** Render once per component tree; React 19 dedupes by `href`. */
export function PolarisStyles() {
  // Typed loosely: React 18's types don't know `precedence` yet.
  const props = { href: STYLE_ID, precedence: "polarispay-sdk" } as Record<string, string>;
  return <style {...props}>{CSS}</style>;
}
