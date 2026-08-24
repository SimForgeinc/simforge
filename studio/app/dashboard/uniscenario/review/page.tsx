import { Suspense } from "react";
import { connection } from "next/server";
import { requireAppContext } from "@/app/lib/db/app-context";
import UniScenarioReviewLoading from "./loading";
import { UniScenarioReviewQueue } from "./UniScenarioReviewQueue";

/**
 * Gates for itself: the layout no longer wraps `{children}` in an authorization boundary, and
 * `test/unit/pages/dashboard-page-auth.test.ts` enforces that every page here does this.
 */
async function ReviewQueueContent() {
  await connection();
  await requireAppContext("/dashboard/uniscenario/review");
  return <UniScenarioReviewQueue />;
}

export default function UniScenarioReviewPage() {
  return (
    <Suspense fallback={<UniScenarioReviewLoading />}>
      <ReviewQueueContent />
    </Suspense>
  );
}
