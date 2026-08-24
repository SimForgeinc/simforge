"use client";

import { Button } from "@/app/components/ui/button";

import { ScenarioWorkspaceErrorState } from "./editor/status";

/**
 * Segment-root error boundary — manifest item 171.
 *
 * Two things happen here, and they are not redundant. The visible block is what a user reads and acts
 * on. `ScenarioWorkspaceErrorState` renders nothing: it publishes the same failure into the workspace
 * status stream as a blocking error, which is what the boot gate paints and what any other surface
 * listening to the stream can see.
 *
 * Publishing only became worth doing when the provider moved to `layout.tsx`. Before that, a status
 * published from this segment had no renderer mounted above it and went nowhere — which is precisely
 * the "publishes a status that looks like publishing nothing" trap the provider warns about.
 *
 * `statusKey` is stable per boundary rather than derived from the message, so a retry that fails again
 * replaces the entry instead of stacking a second one that says the same thing.
 */
export default function ScenarioError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const detail = error.message || "The scenario workspace is temporarily unavailable.";

  return (
    <div className="mx-auto flex min-h-64 max-w-3xl flex-col items-center justify-center px-6 text-center">
      <ScenarioWorkspaceErrorState
        statusKey="scenario:segment-error"
        label="Scenario workspace failed to load"
        detail={detail}
        actionHref={null}
      />
      <h2 className="text-lg font-semibold">Scenario workspace failed to load</h2>
      <p className="mt-2 text-sm text-muted-foreground">{detail}</p>
      {/*
        `error.digest` is the only handle on the server-side stack, and it is the one thing a user can
        usefully quote in a report. Rendered only when present — an empty "Reference:" line reads as
        something having gone wrong with the error page itself.
      */}
      {error.digest ? (
        <p className="mt-1 font-mono text-micro text-muted-foreground">Reference: {error.digest}</p>
      ) : null}
      <Button className="mt-5" type="button" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
