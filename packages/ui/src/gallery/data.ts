/**
 * Sample data for the gallery: Polaris content in the shape of each
 * reference. Merchants and people are invented.
 */

import type { Candle } from "../charts/CandlestickChart";

/** A small seeded generator so the gallery renders the same every time. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export const people = [
  { name: "Ana Ruiz", tone: "salmon" as const },
  { name: "Kofi Mensah", tone: "yellow" as const },
  { name: "Priya Shah", tone: "pink" as const },
  { name: "Leo Park", tone: "sky" as const },
  { name: "Sofia Rossi", tone: "lilac" as const },
  { name: "Tomás Silva", tone: "mint" as const },
];

export const merchants = {
  oat: { name: "Oat & Ember", color: "#c2410c" },
  northwind: { name: "Northwind Books", color: "#1d4ed8" },
  luma: { name: "Luma Studio", color: "#7c3aed" },
  kiko: { name: "Kiko Ramen", color: "#dc2626" },
  field: { name: "Field Goods", color: "#15803d" },
  arc: { name: "Arc Cycles", color: "#0f766e" },
};

export const transactions = [
  { id: "t1", merchant: merchants.oat, time: "9:10 AM", amount: -59, sub: "Pay in 4 · $14.75" },
  { id: "t2", merchant: merchants.kiko, time: "8:30 AM", amount: -15, sub: "Paid in full" },
  { id: "t3", merchant: merchants.northwind, time: "Yesterday", amount: -42.8, sub: "2 of 4 · $10.70" },
  { id: "t4", merchant: { name: "Ana Ruiz", color: "" }, time: "Mon", amount: 120, sub: "Sent by link" },
];

/** Ref D's recent sales, as the merchant sees them. */
export const recentSales = [
  { id: "s1", name: "Ana Ruiz", when: "1 minute ago", amount: 54, mode: "Pay in 4" },
  { id: "s2", name: "Kofi Mensah", when: "2 minutes ago", amount: 52, mode: "Pay now" },
  { id: "s3", name: "Priya Shah", when: "19 Oct 15:58", amount: 2351, mode: "Subscription" },
  { id: "s4", name: "Leo Park", when: "14 Oct 12:25", amount: -3.5, mode: "Refund" },
];

export const salesSpark = [18, 21, 19.5, 20, 22.6, 17.8, 18.4, 21.2, 23.1, 17.6, 20.8, 22.2, 19.4, 18.3, 23.6];

export const weekCustomers = [
  { label: "Mon", value: 6400 },
  { label: "Tue", value: 25600 },
  { label: "Wed", value: 37847 },
  { label: "Thu", value: 21300 },
  { label: "Fri", value: 5200 },
  { label: "Sat", value: 23400 },
  { label: "Sun", value: 16800 },
];

export const salesByMode = [
  { label: "Pay now", value: 56685, color: "var(--ui-teal)" },
  { label: "Pay in 4", value: 19839, color: "var(--ui-pink)" },
  { label: "Subscriptions", value: 17950, color: "var(--ui-honey)" },
];

export const spendingByCategory = [
  { label: "Food", value: 35 },
  { label: "Shopping", value: 25 },
  { label: "Travel", value: 20 },
  { label: "Bills", value: 10 },
  { label: "Subscriptions", value: 8 },
  { label: "Other", value: 2 },
];

export const spendingWeek = [42, 88, 61, 102, 55, 71, 64, 98, 76, 110, 93, 126];

/** Credit score, week by week (ref B chart). */
export const scoreWeeks = (() => {
  const r = seeded(7);
  const out: { value: number; label: string }[] = [];
  let v = 598;
  for (let i = 0; i < 48; i++) {
    v += (r() - 0.42) * 9 + (i > 12 && i < 16 ? 6 : 0) - (i > 16 && i < 20 ? 5 : 0) + (i > 40 ? 3 : 0);
    out.push({ value: Math.round(v), label: `Week ${i + 1}` });
  }
  out[out.length - 1]!.value = 648;
  return out;
})();

/** Daily payment volume in $K, shaped like ref C's run-up. */
export const volumeCandles: Candle[] = (() => {
  const r = seeded(42);
  const out: Candle[] = [];
  const base = new Date(Date.UTC(2026, 7, 20));
  const path = [
    74, 70, 69, 71, 68, 79, 95, 101, 103, 104, 102, 105, 88, 77, 76, 99, 103, 106, 110, 116, 117, 115, 113, 112, 116, 124, 128.06,
  ];
  let prev = path[0]! + 2;
  path.forEach((close, i) => {
    const open = i === 12 ? 105 : i === 13 ? 86 : i === 15 ? 78 : prev + (r() - 0.5) * 2;
    const hi = Math.max(open, close) + r() * 6 + 0.5;
    const lo = Math.min(open, close) - r() * 5 - 0.5;
    out.push({
      t: new Date(base.getTime() + i * 86400000).toISOString(),
      o: Number(open.toFixed(2)),
      h: Number(hi.toFixed(2)),
      l: Number(lo.toFixed(2)),
      c: Number(close.toFixed(2)),
    });
    prev = close;
  });
  return out;
})();

export const scoreCandles: Candle[] = (() => {
  const r = seeded(11);
  const out: Candle[] = [];
  let prev = 612;
  for (let i = 0; i < 24; i++) {
    const close = prev + (r() - 0.4) * 8;
    const open = prev + (r() - 0.5) * 3;
    out.push({
      t: `W${i + 1}`,
      o: Math.round(open),
      h: Math.round(Math.max(open, close) + r() * 5),
      l: Math.round(Math.min(open, close) - r() * 5),
      c: Math.round(close),
    });
    prev = close;
  }
  return out;
})();

export const payments = [
  { id: "pl_8f2k1q", customer: "Ana Ruiz", email: "ana@ruiz.studio", amount: 120, mode: "Pay in 4", status: "paid", date: "Sep 26, 09:41" },
  { id: "pl_7d1m9x", customer: "Kofi Mensah", email: "kofi@mensah.co", amount: 48.5, mode: "Pay now", status: "paid", date: "Sep 26, 09:12" },
  { id: "pl_6a0z3c", customer: "Priya Shah", email: "priya@shah.dev", amount: 29, mode: "Subscription", status: "pending", date: "Sep 25, 18:03" },
  { id: "pl_5y8u2v", customer: "Leo Park", email: "leo@park.io", amount: 310, mode: "Pay in 4", status: "retrying", date: "Sep 25, 14:27" },
  { id: "pl_4t7r6b", customer: "Sofia Rossi", email: "sofia@rossi.it", amount: 64.2, mode: "Pay now", status: "refunded", date: "Sep 24, 11:50" },
];
