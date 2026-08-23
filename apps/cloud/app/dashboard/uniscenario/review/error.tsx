"use client";

import { Button } from "@/app/components/ui/button";

export default function UniScenarioReviewError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto flex min-h-64 max-w-3xl flex-col items-center justify-center px-6 text-center">
      <h2 className="text-lg font-semibold">Failed to open the scenario review queue</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {error.message || "The review queue is temporarily unavailable."}
      </p>
      <Button className="mt-5" type="button" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
