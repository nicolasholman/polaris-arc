import type { Metadata } from "next";
import { Home } from "@/screens/home";
import { ReceiveRoute } from "@/sheets/receive";

export const metadata: Metadata = { title: "Receive" };

/** Opened cold (a link from outside): the sheet over a blurred Home. */
export default function Page() {
  return (
    <>
      <Home />
      <ReceiveRoute cold />
    </>
  );
}
