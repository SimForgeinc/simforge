import { requireAppContext } from "@/app/lib/db/app-context";
import { CompareClient } from "./CompareClient";

export default async function EvalComparePage({
  params,
  searchParams,
}: {
  params: Promise<{ campaignId: string }>;
  searchParams: Promise<{ a?: string; b?: string }>;
}) {
  const { campaignId } = await params;
  const { a, b } = await searchParams;
  await requireAppContext(`/dashboard/evaluation/${campaignId}/compare`);
  return <CompareClient campaignId={campaignId} a={a ?? null} b={b ?? null} />;
}
