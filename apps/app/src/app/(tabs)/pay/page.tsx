import type { Metadata } from "next";
import { Home } from "@/screens/home";
import { PayRoute } from "@/sheets/pay";

export const metadata: Metadata = { title: "Pay or claim" };

/** Opened cold (a link from outside): the sheet over a blurred Home. */
export default function Page() {
  return (
    <>
      <Home />
      <PayRoute cold />
    </>
  );
}
