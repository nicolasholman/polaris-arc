import type { Metadata } from "next";
import { Home } from "@/screens/home";
import { SendRoute } from "@/sheets/send";

export const metadata: Metadata = { title: "Send money" };

/** Opened cold (a link from outside): the sheet over a blurred Home. */
export default function Page() {
  return (
    <>
      <Home />
      <SendRoute cold />
    </>
  );
}
