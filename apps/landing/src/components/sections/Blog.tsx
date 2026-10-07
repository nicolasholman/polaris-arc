"use client";

import { BlurLines } from "@/components/motion/BlurLines";
import { BlurWords } from "@/components/motion/BlurWords";
import { Grow, GrowAnchor } from "@/components/motion/Grow";
import { Rise } from "@/components/motion/Rise";
import { CARD_STAGGER } from "@/components/motion/tokens";
import { fallbacks } from "@/components/ui/fallbacks";
import { SmartImage } from "@/components/ui/SmartImage";
import { blog } from "@/content";
import type { Assets } from "@/lib/assets";
import { cn } from "@/lib/cn";

const FILES = ["article-1.jpg", "article-2.jpg", "article-3.jpg"] as const;
/** Starting heights: the first card starts tallest, so they enter at different depths. */
const FROM = [0.78, 0.6, 0.4] as const;

/**
 * 8. "From the blog": the heading with an underlined "Show all", then three
 * image cards with white titles over a blurred, darkened bottom. The cards
 * grow up from different depths (the first higher) and settle into a row;
 * each photo rides up with its card's top edge while the title stays with
 * the bottom.
 */
export function Blog({ assets }: { assets: Assets }) {
  return (
    <section
      aria-labelledby="blog-heading"
      className="bg-[linear-gradient(180deg,#ffffff_55%,#fdfff2_100%)] pt-24 md:pt-28 lg:pt-[112px]"
    >
      <div className="shell">
        <div className="flex items-end justify-between gap-6">
          <BlurWords id="blog-heading" as="h2" text={blog.heading} lineClassName="" className="heading text-h2 text-olive" />
          <Rise y={10} delay={0.3} className="shrink-0 pb-2 lg:pb-3">
            <a
              href={blog.showAll.href}
              className="text-[16px] tracking-[-0.02em] text-olive underline decoration-1 underline-offset-[5px] transition-opacity hover:opacity-70 lg:text-[22px]"
            >
              {blog.showAll.label}
            </a>
          </Rise>
        </div>

        <div className="mt-10 grid gap-5 md:grid-cols-2 lg:mt-[62px] lg:grid-cols-3">
          {blog.articles.map((article, i) => (
            <Grow
              key={article.href + i}
              from={FROM[i] ?? 0.5}
              delay={i * CARD_STAGGER}
              duration={1.1}
              radius={20}
              className={cn(
                "relative h-[380px] overflow-hidden rounded-[20px] md:h-[clamp(300px,30.8vw,444px)]",
                // Two columns on tablets: the third card takes the full row.
                i === 2 && "md:col-span-2 lg:col-span-1",
              )}
            >
              <a href={article.href} className="group absolute inset-0 block">
                <GrowAnchor className="absolute inset-0">
                  <SmartImage
                    src={assets[FILES[i] ?? "article-1.jpg"]}
                    alt=""
                    fallback={fallbacks.articles[i] ?? fallbacks.articles[0]}
                    className="absolute inset-0 transition-transform duration-700 ease-out group-hover:scale-[1.03]"
                  />
                </GrowAnchor>
                {/* A progressive blur and a warm shade under the title */}
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-[52%] backdrop-blur-[12px] [mask-image:linear-gradient(0deg,#000_35%,transparent_100%)]"
                />
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-[62%] bg-[linear-gradient(0deg,rgba(58,46,32,0.62)_0%,rgba(58,46,32,0.28)_50%,rgba(58,46,32,0)_100%)]"
                />
                <BlurLines
                  as="h3"
                  text={article.title}
                  delay={0.45 + i * 0.1}
                  className="absolute bottom-[30px] left-[26px] right-[26px] text-balance text-[24px] font-medium leading-[1.15] tracking-[-0.035em] text-white lg:bottom-[34px] lg:text-[clamp(22px,2.1vw,30px)]"
                />
              </a>
            </Grow>
          ))}
        </div>
      </div>
    </section>
  );
}
