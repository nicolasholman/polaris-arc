import { PlanRoute } from "@/sheets/plan";

type Props = { params: Promise<{ id: string }> };

export default async function Page({ params }: Props) {
  const { id } = await params;
  return <PlanRoute id={id} />;
}
