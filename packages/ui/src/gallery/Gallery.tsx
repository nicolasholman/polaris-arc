"use client";

import { Moon, Sparkles, Sun } from "lucide-react";
import { useState } from "react";

import { IconProvider } from "../lib/icon";
import { ThemeScope, type Theme } from "../primitives/Card";
import { Logo } from "../primitives/Logo";
import { SegmentedControl } from "../primitives/Segmented";
import { Toaster } from "../primitives/Toast";
import { SheetStage } from "../overlays/BottomSheet";
import { SectionA, SectionB, SectionC, SectionD } from "./sections-refs";
import { SectionControls, SectionFoundations, SectionPresentation } from "./sections-kit";
import { SectionShell } from "./sections-shell";
import { SectionTrade } from "./sections-trade";
import { SectionWeb } from "./sections-web";

const NAV = [
  { href: "#ref-e", label: "E · LumaTrade" },
  { href: "#foundations", label: "Foundations" },
  { href: "#ref-a", label: "A · Aheadly" },
  { href: "#ref-b", label: "B · Findex" },
  { href: "#ref-c", label: "C · Trading" },
  { href: "#ref-d", label: "D · Sales" },
  { href: "#shell", label: "Web shell" },
  { href: "#web", label: "Web dashboard" },
  { href: "#controls", label: "Primitives" },
  { href: "#presentation", label: "Presentation" },
];

export type GalleryProps = {
  /** Which app hosts it. The web app opens in ref E's theme, the app in dark. */
  app?: "business" | "app";
};

/**
 * Every @polaris/ui component in every variant, with Polaris sample data,
 * in sections named after the four references. Mounted at /gallery in both
 * apps; it needs no session and no data.
 */
export function Gallery({ app = "business" }: GalleryProps) {
  const web = app === "business";
  const [shell, setShell] = useState<Theme>(web ? "ref-e" : "dark");

  const sections = web
    ? [
        <SectionTrade key="trade" />,
        <SectionShell key="shell" />,
        <SectionWeb key="web" />,
        <SectionD key="d" />,
        <SectionC key="c" />,
        <SectionA key="a" />,
        <SectionB key="b" />,
        <SectionControls key="controls" />,
        <SectionPresentation key="presentation" />,
        <SectionFoundations key="foundations" />,
      ]
    : [
        <SectionA key="a" />,
        <SectionB key="b" />,
        <SectionC key="c" />,
        <SectionD key="d" />,
        <SectionPresentation key="presentation" />,
        <SectionControls key="controls" />,
        <SectionWeb key="web" />,
        <SectionShell key="shell" />,
        <SectionTrade key="trade" />,
        <SectionFoundations key="foundations" />,
      ];

  return (
    <IconProvider>
      <ThemeScope theme={shell} root className="min-h-dvh">
        <SheetStage className="min-h-dvh">
          <header className="sticky top-0 z-30 border-b border-ui-hairline bg-ui-canvas/85 backdrop-blur-xl">
            <div className="mx-auto flex h-16 max-w-[1360px] items-center gap-4 px-4 md:px-8">
              <Logo height={28} />
              <span className="hidden text-[15px] font-medium text-ui-muted sm:inline">Components</span>
              <nav aria-label="Gallery sections" className="ui-no-scrollbar ml-4 hidden flex-1 gap-1 overflow-x-auto xl:flex">
                {NAV.map((n) => (
                  <a
                    key={n.href}
                    href={n.href}
                    className="rounded-full px-3 py-1.5 text-[14px] whitespace-nowrap text-ui-muted transition-colors hover:bg-ui-surface-2 hover:text-ui-text"
                  >
                    {n.label}
                  </a>
                ))}
              </nav>
              <div className="ml-auto">
                <SegmentedControl
                  aria-label="Page theme"
                  size="sm"
                  value={shell}
                  onValueChange={setShell}
                  options={[
                    { value: "light", label: <span className="sr-only sm:not-sr-only">Light</span>, icon: <Sun /> },
                    { value: "dark", label: <span className="sr-only sm:not-sr-only">Dark</span>, icon: <Moon /> },
                    { value: "ref-e", label: <span className="sr-only sm:not-sr-only">Ref E</span>, icon: <Sparkles /> },
                  ]}
                />
              </div>
            </div>
          </header>

          <main className="mx-auto max-w-[1360px] px-4 pb-24 md:px-8">
            <div className="pt-10 md:pt-14">
              <p className="text-[13px] font-medium tracking-[0.06em] text-ui-muted uppercase">@polaris/ui</p>
              <h1 className="mt-2 max-w-[18ch] text-[40px] leading-[1.02] font-medium tracking-[-0.04em] md:text-[56px]">
                The Polaris component gallery
              </h1>
              <p className="mt-4 max-w-[62ch] text-[16px] leading-[1.5] text-ui-muted">
                Every component in every variant, set out beside the reference it reproduces. The web app is ref E: a dark panel on a
                lime canvas. The app is dark; the light theme stays for ref C&apos;s light screens. Sheets, drawers and dialogs are live.
              </p>
            </div>
            {sections}
          </main>
        </SheetStage>
        <Toaster />
      </ThemeScope>
    </IconProvider>
  );
}

export default Gallery;
