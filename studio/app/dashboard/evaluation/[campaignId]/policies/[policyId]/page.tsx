import { requireAppContext } from "@/app/lib/db/app-context";
import { PolicyDetailClient } from "./PolicyDetailClient";

export default async function EvalPolicyDetailPage({
  params,
}: {
  params: Promise<{ campaignId: string; policyId: string }>;
}) {
  const { campaignId, policyId } = await params;
  await requireAppContext(`/dashboard/evaluation/${campaignId}/policies/${policyId}`);
  return <PolicyDetailClient campaignId={campaignId} policyId={policyId} />;
}
