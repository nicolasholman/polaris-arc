import type { Metadata } from "next";
import { Activity } from "@/screens/activity";
import { TransactionRoute } from "@/sheets/transaction";

type Props = { params: Promise<{ id: string }> };

export const metadata: Metadata = { title: "Payment details" };

export default async function Page({ params }: Props) {
  const { id } = await params;
  return (
    <>
      <Activity />
      <TransactionRoute id={id} cold />
    </>
  );
}
