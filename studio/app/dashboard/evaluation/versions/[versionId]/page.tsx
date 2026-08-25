import { requireAppContext } from "@/app/lib/db/app-context";
import { VersionDetailClient } from "./VersionDetailClient";

export default async function EvalVersionDetailPage({
  params,
}: {
  params: Promise<{ versionId: string }>;
}) {
  const { versionId } = await params;
  await requireAppContext(`/dashboard/evaluation/versions/${versionId}`);
  return <VersionDetailClient versionId={versionId} />;
}
