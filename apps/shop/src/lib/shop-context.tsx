"use client";

import { MotionConfig } from "motion/react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { getOption, getProduct, type Product, type ProductOption } from "@/lib/catalog";
import type { BrowserPolarisConfig } from "@/lib/polaris-config";
import { makePolaris, type Polaris } from "@/lib/polaris-client";

export interface BagItem {
  productId: string;
  optionId: string;
  quantity: number;
}

export interface BagLine extends BagItem {
  product: Product;
  option: ProductOption;
  lineTotal: number;
}

interface ShopState {
  items: BagItem[];
  lines: BagLine[];
  count: number;
  subtotal: number;
  ready: boolean;
  add: (productId: string, optionId: string, quantity?: number) => void;
  setQuantity: (productId: string, optionId: string, quantity: number) => void;
  remove: (productId: string, optionId: string) => void;
  clear: () => void;
  drawerOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
  /** The phone menu, shared so floating controls can step out of its way. */
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
  /** A product page's sticky buy bar is showing (phones), so floating controls sit above it. */
  buyBar: boolean;
  setBuyBar: (shown: boolean) => void;
  polarisConfig: BrowserPolarisConfig;
  polaris: Polaris | null;
  /** The order the "Built with Polaris" drawer follows. */
  currentOrderId: string | null;
  setCurrentOrderId: (id: string | null) => void;
}

const ShopContext = createContext<ShopState | null>(null);

const BAG_KEY = "halcyon.bag.v1";
const ORDER_KEY = "halcyon.currentOrder.v1";
export const MAX_QUANTITY = 10;

function readBag(): BagItem[] {
  try {
    const raw = window.localStorage.getItem(BAG_KEY);
    const parsed = raw ? (JSON.parse(raw) as BagItem[]) : [];
    return Array.isArray(parsed)
      ? parsed.filter((i) => {
          const product = getProduct(i.productId);
          return product && getOption(product, i.optionId) && Number.isInteger(i.quantity) && i.quantity > 0;
        })
      : [];
  } catch {
    return [];
  }
}

export function ShopProvider({ polarisConfig, children }: { polarisConfig: BrowserPolarisConfig; children: ReactNode }) {
  const [items, setItems] = useState<BagItem[]>([]);
  const [ready, setReady] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [buyBar, setBuyBar] = useState(false);
  const [polaris, setPolaris] = useState<Polaris | null>(null);
  const [currentOrderId, setCurrentOrder] = useState<string | null>(null);

  useEffect(() => {
    // The bag lives in this browser only; read it after hydration so server and client agree.
    /* eslint-disable react-hooks/set-state-in-effect */
    setItems(readBag());
    try {
      setCurrentOrder(window.sessionStorage.getItem(ORDER_KEY));
    } catch {
      // Private mode: the drawer just starts empty.
    }
    setPolaris(makePolaris(polarisConfig));
    setReady(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [polarisConfig]);

  useEffect(() => {
    if (!ready) return;
    try {
      window.localStorage.setItem(BAG_KEY, JSON.stringify(items));
    } catch {
      // Storage is a convenience; the bag still works for this visit.
    }
  }, [items, ready]);

  const add = useCallback((productId: string, optionId: string, quantity = 1) => {
    setItems((prev) => {
      const product = getProduct(productId);
      if (product?.recurring) return prev; // Subscriptions check out on their own.
      const existing = prev.find((i) => i.productId === productId && i.optionId === optionId);
      if (existing) {
        return prev.map((i) => (i === existing ? { ...i, quantity: Math.min(MAX_QUANTITY, i.quantity + quantity) } : i));
      }
      return [...prev, { productId, optionId, quantity: Math.min(MAX_QUANTITY, quantity) }];
    });
  }, []);

  const setQuantity = useCallback((productId: string, optionId: string, quantity: number) => {
    setItems((prev) =>
      quantity <= 0
        ? prev.filter((i) => !(i.productId === productId && i.optionId === optionId))
        : prev.map((i) => (i.productId === productId && i.optionId === optionId ? { ...i, quantity: Math.min(MAX_QUANTITY, quantity) } : i)),
    );
  }, []);

  const remove = useCallback((productId: string, optionId: string) => {
    setItems((prev) => prev.filter((i) => !(i.productId === productId && i.optionId === optionId)));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  const setCurrentOrderId = useCallback((id: string | null) => {
    setCurrentOrder(id);
    try {
      if (id) window.sessionStorage.setItem(ORDER_KEY, id);
      else window.sessionStorage.removeItem(ORDER_KEY);
    } catch {
      // Fine without it.
    }
  }, []);

  const value = useMemo<ShopState>(() => {
    const lines: BagLine[] = items.flatMap((item) => {
      const product = getProduct(item.productId);
      const option = product ? getOption(product, item.optionId) : undefined;
      return product && option ? [{ ...item, product, option, lineTotal: product.price * item.quantity }] : [];
    });
    return {
      items,
      lines,
      count: lines.reduce((n, l) => n + l.quantity, 0),
      subtotal: lines.reduce((n, l) => n + l.lineTotal, 0),
      ready,
      add,
      setQuantity,
      remove,
      clear,
      drawerOpen,
      openDrawer: () => setDrawerOpen(true),
      closeDrawer: () => setDrawerOpen(false),
      menuOpen,
      setMenuOpen,
      buyBar,
      setBuyBar,
      polarisConfig,
      polaris,
      currentOrderId,
      setCurrentOrderId,
    };
  }, [items, ready, add, setQuantity, remove, clear, drawerOpen, menuOpen, buyBar, polarisConfig, polaris, currentOrderId, setCurrentOrderId]);

  return (
    <MotionConfig reducedMotion="user">
      <ShopContext.Provider value={value}>{children}</ShopContext.Provider>
    </MotionConfig>
  );
}

export function useShop(): ShopState {
  const ctx = useContext(ShopContext);
  if (!ctx) throw new Error("useShop must be used inside <ShopProvider>");
  return ctx;
}
