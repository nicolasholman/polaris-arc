"use client";

import { BottomSheet, Dialog, Drawer, type SnapPoint, useAdaptive, useIsDesktop } from "@polaris/ui";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { markIntroSeen } from "./first-run";

/**
 * Route sheets. Every screen you *do* (Send, Checkout, Credit…) is a route
 * that renders into the root layout's @sheet slot, through an intercepting
 * route when you open it from inside the app, and over a blurred Home when
 * it is opened cold from a link. The slot's page only renders a marker,
 * <RouteSheet>; the sheet itself lives here, in a host that outlives the
 * route, so it can spring in, and spring out again when the route goes away
 * (a swipe down, the close button, or the browser's Back).
 *
 * From 1024px the same routes present the desktop way (`desktop` on
 * <RouteSheet>): a right-hand Drawer, a centred Dialog, or a page inside the
 * frame (Credit, Settings, a checkout), which the desktop shell shows in
 * place of the page underneath.
 */

/** How a route sheet presents from 1024px. */
export type DesktopPresentation = {
  as: "drawer" | "dialog" | "page";
  size?: "sm" | "md" | "lg";
  /** The Drawer's or Dialog's title (it names the layer and gives it a close button). */
  title?: ReactNode;
  description?: ReactNode;
  /** The desktop content, when it isn't the phone sheet's. */
  content?: ReactNode;
  /** A page that stands alone (a checkout): the frame drops the app's nav for the wordmark. */
  focus?: boolean;
  /** Classes for the Drawer or Dialog (e.g. the app panel's ground under ref E's cards). */
  className?: string;
};

type SheetSpec = {
  snapPoints: SnapPoint[];
  defaultSnap?: SnapPoint;
  title?: ReactNode;
  description?: ReactNode;
  label: string;
  content: ReactNode;
  desktop: DesktopPresentation;
  desktopContent: ReactNode;
  onClose: () => void;
};

type Entry = SheetSpec & { key: string; open: boolean };

type HostApi = {
  upsert: (key: string, spec: SheetSpec) => void;
  release: (key: string) => void;
};

const HostContext = createContext<HostApi | null>(null);

/** The route page showing in the desktop frame right now, if any. */
export type DesktopPage = { key: string; label: string; content: ReactNode; focus: boolean };

const PagesContext = createContext<{ page: DesktopPage | null; overlays: number }>({ page: null, overlays: 0 });

/** The desktop shell's view of the host: the page to show in the frame, and how many layers are open. */
export function useDesktopPages() {
  return useContext(PagesContext);
}

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function SheetHost({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const desktop = useIsDesktop();

  const remove = useCallback((key: string) => {
    const timer = timers.current.get(key);
    if (timer) clearTimeout(timer);
    timers.current.delete(key);
    setEntries((list) => list.filter((e) => e.key !== key || e.open));
  }, []);

  const api = useMemo<HostApi>(
    () => ({
      upsert(key, spec) {
        const timer = timers.current.get(key);
        if (timer) clearTimeout(timer);
        timers.current.delete(key);
        setEntries((list) => {
          const i = list.findIndex((e) => e.key === key);
          if (i < 0) return [...list, { ...spec, key, open: true }];
          const next = list.slice();
          next[i] = { ...spec, key, open: true };
          return next;
        });
      },
      release(key) {
        setEntries((list) =>
          list.some((e) => e.key === key && e.open) ? list.map((e) => (e.key === key ? { ...e, open: false } : e)) : list,
        );
        // If the exit animation never reports back (closed before it measured), drop it anyway.
        if (!timers.current.has(key)) timers.current.set(key, setTimeout(() => remove(key), 1400));
      },
    }),
    [remove],
  );

  // From 1024px a "page" entry is shown by the desktop shell, not as a layer.
  const pages = useMemo(() => {
    if (!desktop) return { page: null, overlays: 0 };
    const top = [...entries].reverse().find((e) => e.open && e.desktop.as === "page");
    return {
      page: top ? { key: top.key, label: top.label, content: top.desktopContent, focus: Boolean(top.desktop.focus) } : null,
      overlays: entries.filter((e) => e.open && e.desktop.as !== "page").length,
    };
  }, [desktop, entries]);

  return (
    <HostContext.Provider value={api}>
      <PagesContext.Provider value={pages}>
        {children}
        {entries.map((e) => {
          const onOpenChange = (next: boolean) => {
            if (next) return;
            // Start the exit now; the route follows (Back, or the cold fallback).
            api.release(e.key);
            e.onClose();
          };
          if (!desktop) {
            return (
              <BottomSheet
                key={e.key}
                open={e.open}
                onOpenChange={onOpenChange}
                onClosed={() => remove(e.key)}
                snapPoints={e.snapPoints}
                defaultSnap={e.defaultSnap}
                title={e.title}
                description={e.description}
                aria-label={e.label}
                maxWidth={440}
              >
                {e.content}
              </BottomSheet>
            );
          }
          if (e.desktop.as === "page") return null;
          const Panel = e.desktop.as === "drawer" ? Drawer : Dialog;
          return (
            <Panel
              key={e.key}
              open={e.open}
              onOpenChange={onOpenChange}
              onClosed={() => remove(e.key)}
              size={e.desktop.size ?? (e.desktop.as === "drawer" ? "md" : "sm")}
              title={e.desktop.title}
              description={e.desktop.description}
              aria-label={e.label}
              className={e.desktop.className}
            >
              {e.desktopContent}
            </Panel>
          );
        })}
      </PagesContext.Provider>
    </HostContext.Provider>
  );
}

export type RouteSheetProps = {
  /** Screen readers' name for the sheet (and its visible title, with `title`). */
  label: string;
  title?: ReactNode;
  description?: ReactNode;
  snapPoints?: SnapPoint[];
  defaultSnap?: SnapPoint;
  /**
   * Opened cold (a link from outside): closing replaces the URL with
   * `fallback` instead of going back, since there is nothing to go back to.
   */
  cold?: boolean;
  /** Where a cold sheet lands when it closes. */
  fallback?: string;
  /**
   * Replaces the cold fallback: somewhere better to send someone who came
   * from outside (the merchant's window or page that sent them).
   */
  onColdClose?: () => void;
  /** From 1024px: a Drawer, a Dialog (the default, titled like the sheet) or a page in the frame. */
  desktop?: DesktopPresentation;
  children: ReactNode;
};

/** Close the route sheet you are in: Back when it was opened in the app, else to its fallback. */
const CloseContext = createContext<(() => void) | null>(null);

export function useCloseSheet(): () => void {
  const close = useContext(CloseContext);
  const router = useRouter();
  return close ?? (() => router.push("/"));
}

/**
 * Put this in a sheet route's page. It renders nothing where it stands;
 * the host shows the sheet while this is mounted.
 */
export function RouteSheet({
  label,
  title,
  description,
  snapPoints = ["half"],
  defaultSnap,
  cold = false,
  fallback = "/",
  onColdClose,
  desktop,
  children,
}: RouteSheetProps) {
  const host = useContext(HostContext);
  const router = useRouter();
  const key = useId();
  const closing = useRef(false);
  // A cold sheet is part of its page, which is in the page twice while the
  // phone and desktop layouts hydrate: only the one that stays registers.
  const { settled } = useAdaptive();
  // A cold sheet stays mounted in the page behind it, so it steps aside while
  // another sheet has the URL, and comes back if Back returns to it.
  const pathname = usePathname();
  const [home] = useState(pathname);
  const active = pathname === home && settled;

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    host?.release(key);
    if (!cold) {
      router.back();
      return;
    }
    // Someone who came from a link and backs out has seen enough of Polaris
    // not to be sent through the intro: they land where the fallback says.
    markIntroSeen();
    if (onColdClose) onColdClose();
    else router.replace(fallback, { scroll: false });
  }, [cold, fallback, onColdClose, router, host, key]);

  const content = <CloseContext.Provider value={close}>{children}</CloseContext.Provider>;
  const wide: DesktopPresentation = desktop ?? { as: "dialog", title: title ?? label, description };
  const desktopContent = wide.content ? <CloseContext.Provider value={close}>{wide.content}</CloseContext.Provider> : content;

  useIsoLayoutEffect(() => {
    // Once closing, stay closed until the route goes away.
    if (!active) host?.release(key);
    else if (!closing.current) {
      host?.upsert(key, { snapPoints, defaultSnap, title, description, label, content, desktop: wide, desktopContent, onClose: close });
    }
  });

  useEffect(() => {
    closing.current = false;
    return () => host?.release(key);
  }, [host, key]);

  return null;
}
