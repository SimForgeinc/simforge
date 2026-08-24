import { Suspense } from "react";
import { connection } from "next/server";
import { requireAppContext } from "@/app/lib/db/app-context";
import ScenarioReviewLoading from "./loading";
import { ScenarioReviewQueue } from "./ScenarioReviewQueue";

/**
 * Gates for itself: the layout no longer wraps `{children}` in an authorization boundary, and
 * `test/unit/pages/dashboard-page-auth.test.ts` enforces that every page here does this.
 */
async function ReviewQueueContent() {
  await connection();
  await requireAppContext("/dashboard/scenario/review");
  return <ScenarioReviewQueue />;
}

export default function ScenarioReviewPage() {
  return (
    <Suspense fallback={<ScenarioReviewLoading />}>
      <ReviewQueueContent />
    </Suspense>
  );
}
