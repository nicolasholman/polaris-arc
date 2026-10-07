import type { Metadata } from "next";
import { Home } from "@/screens/home";
import { NotificationsRoute } from "@/sheets/notifications";

export const metadata: Metadata = { title: "Notifications" };

/** Opened cold (a link from outside): the sheet over a blurred Home. */
export default function Page() {
  return (
    <>
      <Home />
      <NotificationsRoute cold />
    </>
  );
}
