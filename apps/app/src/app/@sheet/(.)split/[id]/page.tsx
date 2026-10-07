import { notFound } from "next/navigation";
import type { Hex } from "viem";
import { SplitRoute } from "@/sheets/split";

type Props = { params: Promise<{ id: string }> };

/** A split opened from inside the app (Activity, a share's details): the sheet over the current tab. */
export default async function Page({ params }: Props) {
  const { id } = await params;
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) notFound();
  return <SplitRoute id={id.toLowerCase() as Hex} />;
}
