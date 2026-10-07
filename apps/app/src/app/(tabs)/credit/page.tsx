import type { Metadata } from "next";
import { Home } from "@/screens/home";
import { CreditRoute } from "@/sheets/credit";

export const metadata: Metadata = { title: "Credit line" };

/** Opened cold (a link from outside): the sheet over a blurred Home. */
export default function Page() {
  return (
    <>
      <Home />
      <CreditRoute cold />
    </>
  );
}
