import type { Metadata } from "next";
import { Home } from "@/screens/home";
import { ClaimRoute } from "@/sheets/claim";

export const metadata: Metadata = {
  title: "You've got dollars",
  // A claim link is a bearer secret in its fragment. Keep it out of indexes and previews.
  robots: { index: false, follow: false },
};

/** Opened cold (a link from outside): the sheet over a blurred Home. */
export default function Page() {
  return (
    <>
      <Home />
      <ClaimRoute cold />
    </>
  );
}
