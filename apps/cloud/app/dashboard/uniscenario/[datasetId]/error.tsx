"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/app/components/ui/button";
import { CopyableErrorMessage } from "../list/CopyableErrorMessage";

/**
 * The dataset list's own error boundary.
 *
 * Without one, a throw in the server read escapes to `dashboard/error.tsx`, which knows nothing about
 * this route and offers no way back to the dataset index. The `digest` is the only handle a bug report
 * can use to find the server-side trace, so it is copyable.
 */
export default function UniScenarioDatasetError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[uniscenario] dataset list failed", error);
  }, [error]);

  return (
    <section className="flex h-full min-h-0 flex-col items-center justify-center gap-4 bg-background p-6 text-foreground">
      <div className="w-full max-w-lg space-y-3">
        <h1 className="font-display text-lg font-semibold">This dataset could not be loaded.</h1>
        <CopyableErrorMessage
          message={error.message || "The scenario list failed to load."}
          copyText={error.digest ? `${error.message}\ndigest: ${error.digest}` : error.message}
        />
        <div className="flex gap-2">
          <Button type="button" onClick={reset}>
            Try again
          </Button>
          <Button asChild variant="outline">
            <Link href="/dashboard/uniscenario">Back to datasets</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
