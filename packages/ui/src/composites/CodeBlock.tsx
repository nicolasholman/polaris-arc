"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "../lib/cn";
import { CopyButton } from "../primitives/CopyButton";
import { Tab, TabList, TabPanel, Tabs } from "../primitives/Segmented";

export type CodeSample = {
  /** Tab key and label ("React", "Node", "HTML"). */
  key: string;
  label: string;
  /** Shown on the right of the bar: "app/api/checkout/route.ts". */
  filename?: string;
  code: string;
  language?: "ts" | "tsx" | "js" | "html" | "bash" | "json";
};

export type CodeBlockProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  samples: CodeSample[];
  defaultKey?: string;
  /**
   * Offer a copy button. Leave it off for code that doesn't run yet (a
   * preview of an API that hasn't shipped): never hand out code that fails.
   */
  copyable?: boolean;
  /** A small note in the bar instead of the copy button ("Preview · SDK 0.3"). */
  note?: ReactNode;
  showLineNumbers?: boolean;
  /** Accessible name for the tab list. */
  "aria-label"?: string;
};

/* ── A small highlighter: enough for TS, TSX, JS and HTML snippets ───────── */

const KEYWORDS = new Set([
  "import", "from", "export", "const", "let", "var", "async", "await", "function", "return", "if", "else", "new",
  "type", "interface", "try", "catch", "throw", "default", "of", "in", "for", "while", "true", "false", "null", "undefined",
]);

type Token = { text: string; kind: "plain" | "keyword" | "string" | "comment" | "number" | "fn" | "tag" | "attr" | "punct" };

const TOKEN_RE =
  /(\/\/[^\n]*|<!--[\s\S]*?-->)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(<\/?[A-Za-z][\w.-]*)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$-]*)(?==)|([A-Za-z_$][\w$]*)|([{}()[\];,.<>/=+*!?:&|-])/g;

function tokenize(code: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  for (const m of code.matchAll(TOKEN_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: code.slice(last, at), kind: "plain" });
    const [text, comment, str, tag, num, fn, attr, word] = m;
    if (comment) out.push({ text, kind: "comment" });
    else if (str) out.push({ text, kind: "string" });
    else if (tag) out.push({ text, kind: "tag" });
    else if (num) out.push({ text, kind: "number" });
    else if (fn) out.push({ text, kind: KEYWORDS.has(fn) ? "keyword" : "fn" });
    else if (attr) out.push({ text, kind: "attr" });
    else if (word) out.push({ text, kind: KEYWORDS.has(word) ? "keyword" : "plain" });
    else out.push({ text, kind: "punct" });
    last = at + text.length;
  }
  if (last < code.length) out.push({ text: code.slice(last), kind: "plain" });
  return out;
}

const COLORS: Record<Token["kind"], string | undefined> = {
  plain: undefined,
  keyword: "text-[#c7a6ff]",
  string: "text-ui-lime",
  comment: "text-[#6f727b] italic",
  number: "text-ui-honey",
  fn: "text-ui-sky",
  tag: "text-ui-salmon",
  attr: "text-ui-cyan",
  punct: "text-[#9a9ca4]",
};

function Highlighted({ code, lineNumbers }: { code: string; lineNumbers: boolean }) {
  const lines = useMemo(() => {
    const tokens = tokenize(code);
    // Split tokens into lines so line numbers stay aligned.
    const rows: Token[][] = [[]];
    for (const t of tokens) {
      const parts = t.text.split("\n");
      parts.forEach((part, i) => {
        if (i > 0) rows.push([]);
        if (part) rows[rows.length - 1]!.push({ text: part, kind: t.kind });
      });
    }
    return rows;
  }, [code]);
  return (
    <code className="block min-w-max">
      {lines.map((row, i) => (
        <span key={i} className="flex">
          {lineNumbers ? (
            <span aria-hidden className="mr-5 inline-block w-6 shrink-0 text-right text-[#4d5058] select-none">
              {i + 1}
            </span>
          ) : null}
          <span className="whitespace-pre">
            {row.length === 0 ? " " : null}
            {row.map((t, j) => (
              <Fragment key={j}>{COLORS[t.kind] ? <span className={COLORS[t.kind]}>{t.text}</span> : t.text}</Fragment>
            ))}
          </span>
        </span>
      ))}
    </code>
  );
}

/**
 * The code's scroller: when a line runs past the edge, the right edge fades
 * out so it reads as "more this way", and the fade lifts at the end.
 */
function ScrollFade({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    el.addEventListener("scroll", check, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", check);
    };
  }, []);
  return (
    <pre
      ref={ref}
      className="overflow-x-auto px-4 py-5 font-mono text-[13px] leading-[1.75] sm:px-5"
      style={more ? { maskImage: "linear-gradient(to right, #000 calc(100% - 56px), transparent)" } : undefined}
    >
      {children}
    </pre>
  );
}

/**
 * A dark code panel with tabs (React, Node, HTML), a filename, line numbers
 * and quiet syntax colour in the brand's accents. The panel is ref C's candle
 * ground, so code sits in the same family as the charts.
 *
 * ```tsx
 * <CodeBlock samples={[{ key: "node", label: "Node", filename: "route.ts", code }]} copyable />
 * ```
 */
export function CodeBlock({
  samples,
  defaultKey,
  copyable = false,
  note,
  showLineNumbers = true,
  className,
  "aria-label": ariaLabel = "Code sample",
  ...props
}: CodeBlockProps) {
  const [key, setKey] = useState(defaultKey ?? samples[0]?.key ?? "");
  const current = samples.find((s) => s.key === key) ?? samples[0];
  return (
    <div
      data-theme="dark"
      className={cn("@container overflow-hidden rounded-ui-card bg-ui-candle-panel font-satoshi text-[#e9e9ee] ring-1 ring-white/6", className)}
      {...props}
    >
      <Tabs value={key} onValueChange={setKey} variant="pill" size="sm">
        {/* The tabs keep their width; the filename gives way first (it hides
            in a narrow panel), and the note wraps under the tabs on a phone. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-white/6 px-3 py-2.5 sm:px-4">
          {samples.length > 1 ? (
            <TabList aria-label={ariaLabel} className="max-w-full shrink-0">
              {samples.map((s) => (
                <Tab key={s.key} value={s.key}>
                  {s.label}
                </Tab>
              ))}
            </TabList>
          ) : (
            <span className="min-w-0 flex-1 truncate px-1 text-[13px] font-medium text-ui-muted">{current?.label}</span>
          )}
          {current?.filename ? (
            <span className="hidden min-w-0 flex-1 truncate text-right font-mono text-[12px] text-[#8b8c99] @xl:block">
              {current.filename}
            </span>
          ) : (
            <span aria-hidden className="hidden flex-1 @xl:block" />
          )}
          {/* The note only where it fits beside the tabs; the copy button always stays on the tab row. */}
          {note ? <span className="ml-auto hidden shrink-0 text-[12px] font-medium text-ui-muted @lg:inline @xl:ml-0">{note}</span> : null}
          {copyable && current ? (
            <CopyButton
              value={current.code}
              label={`${current.label} snippet`}
              tone="ghost"
              className={note ? "ml-auto @lg:ml-0" : "ml-auto @xl:ml-0"}
            />
          ) : null}
        </div>
        {samples.map((s) => (
          <TabPanel key={s.key} value={s.key} className="focus-visible:outline-offset-[-2px]">
            <ScrollFade>
              <Highlighted code={s.code} lineNumbers={showLineNumbers} />
            </ScrollFade>
          </TabPanel>
        ))}
      </Tabs>
    </div>
  );
}
