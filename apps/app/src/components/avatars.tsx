import { Avatar, type AvatarProps, LogoMark } from "@polaris/ui";
import {
  ArrowDownLeft,
  ArrowUpRight,
  CalendarCheck2,
  AudioLines,
  BookOpen,
  CarTaxiFront,
  Coffee,
  Dumbbell,
  Link2,
  Plus,
  Shapes,
  ShoppingBasket,
  Smartphone,
  Store,
  Sun,
  TrainFront,
  Undo2,
  UtensilsCrossed,
} from "lucide-react";
import type { ReactNode } from "react";
import type { ActivityItem } from "@/lib/data";

type Size = AvatarProps["size"];

/** Each merchant's brand circle (ref A's Walmart and McDonald's circles). */
type Brand = { color: string; fg?: string; icon: ReactNode };

const BRANDS: Record<string, Brand> = {
  "Studio Sol": { color: "#f26a1b", icon: <Sun /> },
  "Lumen Audio": { color: "#2f6bff", icon: <AudioLines /> },
  "Kora Rail": { color: "#0f9d74", icon: <TrainFront /> },
  "Nómada Coffee": { color: "#8a5a3c", icon: <Coffee /> },
  "Kinetik Gym": { color: "#e11d48", icon: <Dumbbell /> },
  Figura: { color: "#a855f7", icon: <Shapes /> },
  Frischmarkt: { color: "#15803d", icon: <ShoppingBasket /> },
  Rota: { color: "#d97706", icon: <CarTaxiFront /> },
  "Kiez Kitchen": { color: "#c2410c", icon: <UtensilsCrossed /> },
  "Kapitel Books": { color: "#0e7490", icon: <BookOpen /> },
  "Welle Mobile": { color: "#4f46e5", icon: <Smartphone /> },
};

export function merchantBrand(name: string): Brand {
  return BRANDS[name] ?? { color: "#2c2d30", icon: <Store /> };
}

export function MerchantAvatar({ name, size = "md", className }: { name: string; size?: Size; className?: string }) {
  const brand = merchantBrand(name);
  return <Avatar name={name} color={brand.color} fg={brand.fg ?? "#ffffff"} icon={brand.icon} size={size} className={className} />;
}

const PHOTOS = new Set(["marisol", "jonas", "ana", "tomas", "aisha", "lena"]);

/** The photo for a first name, if we have one ("Tomás García" → /assets/avatars/tomas.jpg). */
export function photoFor(name: string): string | undefined {
  const first = name
    .trim()
    .split(/\s+/)[0]!
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  return PHOTOS.has(first) ? `/assets/avatars/${first}.jpg` : undefined;
}

export function PersonAvatar({ name, size = "md", className, decorative }: { name: string; size?: Size; className?: string; decorative?: boolean }) {
  return <Avatar name={name} src={photoFor(name)} size={size} className={className} decorative={decorative} />;
}

/** Polaris itself: money added, links, refunds. */
function PolarisAvatar({ item, size }: { item: ActivityItem; size: Size }) {
  const icon =
    item.kind === "added" ? (
      <Plus />
    ) : item.kind === "refund" ? (
      <Undo2 />
    ) : item.kind === "sent-link" ? (
      <Link2 />
    ) : item.kind === "instalment" ? (
      <CalendarCheck2 />
    ) : item.direction === "out" ? (
      <ArrowUpRight />
    ) : (
      <ArrowDownLeft />
    );
  return <Avatar name={item.title} color="var(--ui-lime)" fg="#0f1011" icon={icon} size={size} />;
}

/** The circle at the start of a transaction row. */
export function ActivityAvatar({ item, size = "md" }: { item: ActivityItem; size?: Size }) {
  if (item.counterparty.kind === "merchant") return <MerchantAvatar name={item.counterparty.name} size={size} />;
  if (item.counterparty.kind === "person") return <PersonAvatar name={item.counterparty.name} size={size} />;
  return <PolarisAvatar item={item} size={size} />;
}

/** The Polaris star in a dark circle, for the Dollar account. */
export function AccountMark({ size = 20 }: { size?: number }) {
  return <LogoMark size={size} title="" />;
}
