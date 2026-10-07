import type { Metadata } from "next";
import { Home } from "@/screens/home";
import { AddMoneyRoute } from "@/sheets/add-money";

export const metadata: Metadata = { title: "Add money" };

/** Opened cold (a link from outside): the sheet over a blurred Home. */
export default function Page() {
  return (
    <>
      <Home />
      <AddMoneyRoute cold />
    </>
  );
}
