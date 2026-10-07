import type { Metadata } from "next";
import { Profile } from "@/screens/profile";
import { SettingsRoute } from "@/sheets/settings";

export const metadata: Metadata = { title: "Settings" };

/** Opened cold (a link from outside): the sheet over the Profile tab. */
export default function Page() {
  return (
    <>
      <Profile />
      <SettingsRoute cold />
    </>
  );
}
