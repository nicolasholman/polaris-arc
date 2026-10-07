import type { Metadata } from "next";
import { Cards } from "@/screens/cards";

export const metadata: Metadata = { title: "Cards" };

export default function CardsPage() {
  return <Cards />;
}
