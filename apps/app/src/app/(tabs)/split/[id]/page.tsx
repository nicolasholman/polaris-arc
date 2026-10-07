import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { Hex } from "viem";
import { Home } from "@/screens/home";
import { SplitRoute } from "@/sheets/split";

type Props = { params: Promise<{ id: string }> };

export const metadata: Metadata = {
  title: "Your share",
  // A split's words travel in the link's fragment; keep its page out of indexes and previews.
  robots: { index: false, follow: false },
};

/** A split link opened cold (from a chat): the split over a blurred Home. */
export default async function Page({ params }: Props) {
  const { id } = await params;
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) notFound();
  return (
    <>
      <Home />
      <SplitRoute id={id.toLowerCase() as Hex} cold />
    </>
  );
}
