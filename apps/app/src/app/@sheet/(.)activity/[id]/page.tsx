import { TransactionRoute } from "@/sheets/transaction";

type Props = { params: Promise<{ id: string }> };

export default async function Page({ params }: Props) {
  const { id } = await params;
  return <TransactionRoute id={id} />;
}
