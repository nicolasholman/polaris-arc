import type { Metadata } from "next";
import { PlansBehind } from "@/screens/plans-page";
import { PlanRoute } from "@/sheets/plan";

type Props = { params: Promise<{ id: string }> };

export const metadata: Metadata = { title: "Plan" };

export default async function Page({ params }: Props) {
  const { id } = await params;
  return (
    <>
      <PlansBehind />
      <PlanRoute id={id} cold />
    </>
  );
}
