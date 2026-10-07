import type { Metadata } from "next";
import { Home } from "@/screens/home";
import { SplitNewRoute } from "@/sheets/split-new";

export const metadata: Metadata = { title: "Split a bill" };

/** Opened cold (a link from outside): the sheet over a blurred Home. */
export default function Page() {
  return (
    <>
      <Home />
      <SplitNewRoute cold />
    </>
  );
}
