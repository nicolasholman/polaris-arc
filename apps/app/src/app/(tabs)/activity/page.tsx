import type { Metadata } from "next";
import { Activity } from "@/screens/activity";

export const metadata: Metadata = { title: "Activity" };

export default function ActivityPage() {
  return <Activity />;
}
