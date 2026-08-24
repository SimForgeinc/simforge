import { Suspense } from "react";
import { connection } from "next/server";
import { requireAppContext } from "@/app/lib/db/app-context";
import DashboardLoading from "../loading";
import { DatasetExportWorkspace } from "./DatasetExportWorkspace";

/**
 * Authenticate for ourselves instead of inheriting the gate in
 * `app/dashboard/layout.tsx`. The workspace below is a client component that
 * reads nothing server-side, so this is defence in depth rather than a fix — but
 * it means the page states its own access requirement rather than depending on
 * where it happens to sit in the tree.
 */
async function DatasetExportContent() {
  await connection();
  await requireAppContext("/dashboard/dataset-export");
  return <DatasetExportWorkspace />;
}

export default function DatasetExportPage() {
  return (
    <Suspense fallback={<DashboardLoading />}>
      <DatasetExportContent />
    </Suspense>
  );
}
