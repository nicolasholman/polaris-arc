"use client";

import { useState } from "react";
import { useReveal } from "@/components/motion/hooks";
import { Rise } from "@/components/motion/Rise";
import { socialIcons } from "@/components/ui/icons";
import { PolarisLogo } from "@/components/ui/Logo";
import { footer } from "@/content";
import { cn } from "@/lib/cn";

/**
 * 10. Footer: an olive rounded card inset on the lime gradient. The card
 * rises in, then its contents brighten in, a few at a time.
 */
export function Footer() {
  const [ref, inView] = useReveal<HTMLDivElement>(0.25);
  const [lang, setLang] = useState(footer.languages[0]);
  const item = (i: number) => ({ play: inView, delay: 0.25 + i * 0.06, y: 10, blur: 6, duration: 0.7 });

  return (
    <footer className="px-[var(--gutter)] pb-6 pt-24 md:pb-10 md:pt-28 lg:pt-[120px]">
      <Rise
        y={50}
        duration={0.9}
        className="mx-auto max-w-[var(--content)] rounded-[24px] bg-olive text-white md:rounded-footer"
      >
        <div
          ref={ref}
          className="grid gap-12 px-6 py-10 md:px-10 md:py-12 lg:min-h-[541px] lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:grid-rows-[auto_1fr_auto] lg:gap-x-12 lg:gap-y-0 lg:px-12 lg:pb-[46px] lg:pt-[50px]"
        >
          {/* Top left: wordmark, blurb, more */}
          <div className="lg:col-start-1 lg:row-start-1">
            <Rise {...item(0)}>
              <a href="#top" aria-label="Polaris home" className="inline-flex text-[28px] lg:text-[32px]">
                <PolarisLogo size={30} />
              </a>
            </Rise>
            <Rise {...item(1)}>
              <p className="mt-8 max-w-[440px] text-[15px] leading-[1.4] tracking-[-0.015em] text-footer-muted lg:mt-[48px] lg:text-[16px]">
                {footer.blurb}
              </p>
            </Rise>
            <Rise {...item(2)}>
              <a
                href={footer.more.href}
                className="mt-6 inline-flex items-center gap-2.5 text-[14px] tracking-[-0.01em] text-white/85 transition-opacity hover:opacity-70 lg:mt-[26px]"
              >
                <span aria-hidden="true" className="h-[7px] w-[7px] rounded-full bg-white/60" />
                {footer.more.label}
              </a>
            </Rise>
          </div>

          {/* Top right: nav */}
          <nav aria-label="Footer" className="lg:col-start-2 lg:row-start-1">
            <ul className="flex flex-wrap gap-x-10 gap-y-3 text-[16px] tracking-[-0.02em] lg:gap-x-[40px] lg:pt-1">
              {footer.links.map((link, i) => (
                <Rise as="li" key={link.label} {...item(1 + i)}>
                  <a href={link.href} className="text-white/90 transition-opacity hover:opacity-70">
                    {link.label}
                  </a>
                </Rise>
              ))}
            </ul>
          </nav>

          {/* Middle right: contact */}
          <div className="lg:col-start-2 lg:row-start-2 lg:self-end lg:pb-[34px]">
            <Rise {...item(4)}>
              <h2 className="text-[20px] tracking-[-0.03em]">{footer.contact.title}</h2>
              <ul className="mt-3 space-y-1 text-[15px] tracking-[-0.01em] text-footer-muted">
                {footer.contact.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </Rise>
          </div>

          {/* Bottom left: socials + copyright */}
          <div className="order-last flex items-end justify-between gap-6 lg:order-none lg:col-start-1 lg:row-start-3 lg:pr-[14%]">
            <Rise {...item(6)} className="grid w-[90px] grid-cols-2 gap-2">
              {footer.socials.map((s, i) => {
                const Icon = socialIcons[s.icon];
                return (
                  <a
                    key={s.label}
                    href={s.href}
                    aria-label={s.label}
                    className={cn(
                      "grid h-[40px] w-[40px] place-items-center rounded-full bg-white text-olive transition-transform hover:scale-105",
                      i === 0 && "col-span-2",
                    )}
                  >
                    <Icon size={18} />
                  </a>
                );
              })}
            </Rise>
            <Rise {...item(7)}>
              <p className="text-[12px] leading-[1.45] text-white/80">
                {footer.copyright[0]}
                <br />
                {footer.copyright[1]}
              </p>
            </Rise>
          </div>

          {/* Bottom right: location + languages */}
          <div className="flex flex-wrap items-end justify-between gap-8 lg:col-start-2 lg:row-start-3">
            <Rise {...item(8)}>
              <h2 className="text-[20px] tracking-[-0.03em]">{footer.location.title}</h2>
              <ul className="mt-3 space-y-1 text-[15px] tracking-[-0.01em] text-footer-muted">
                {footer.location.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </Rise>
            <Rise {...item(9)} className="lg:pr-4">
              <p className="text-[12px] text-white/85 lg:text-right">{footer.languagesLabel}</p>
              <ul className="mt-3 flex gap-4 text-[13px]" aria-label="Language">
                {footer.languages.map((l) => (
                  <li key={l}>
                    <button
                      type="button"
                      aria-pressed={lang === l}
                      onClick={() => setLang(l)}
                      className={cn(
                        // A 24px target; the negative margin keeps the row where it was.
                        "-mx-1.5 -my-[5px] min-h-6 min-w-6 px-1.5 py-[5px] transition-colors",
                        lang === l ? "text-white" : "text-footer-muted hover:text-white/80",
                      )}
                    >
                      {l}
                    </button>
                  </li>
                ))}
              </ul>
            </Rise>
          </div>
        </div>
      </Rise>
    </footer>
  );
}
