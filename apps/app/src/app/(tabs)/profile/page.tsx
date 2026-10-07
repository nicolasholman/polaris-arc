import type { Metadata } from "next";
import { Profile } from "@/screens/profile";

export const metadata: Metadata = { title: "Profile" };

export default function ProfilePage() {
  return <Profile />;
}
