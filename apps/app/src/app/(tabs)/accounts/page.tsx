import type { Metadata } from "next";
import { Cards } from "@/screens/cards";
import { AccountsRoute } from "@/sheets/accounts";

export const metadata: Metadata = { title: "Select account" };

/** Opened cold (a link from outside): the sheet over the Cards tab. */
export default function Page() {
  return (
    <>
      <Cards />
      <AccountsRoute cold />
    </>
  );
}
