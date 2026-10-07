import type { Metadata } from "next";
import { Home } from "@/screens/home";
import { ScoreRoute } from "@/sheets/score";

export const metadata: Metadata = { title: "Credit score" };

/** Opened cold (a link from outside): the sheet over a blurred Home. */
export default function Page() {
  return (
    <>
      <Home />
      <ScoreRoute cold />
    </>
  );
}
