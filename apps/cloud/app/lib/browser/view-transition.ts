export type ViewTransitionResult = {
  finished?: Promise<void>;
};

function isExpectedViewTransitionAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

/**
 * Observe a browser View Transition without turning an expected skipped
 * transition into an unhandled rejection. Browsers reject `finished` with an
 * AbortError when a newer transition supersedes the current one; the DOM
 * mutation has already completed and no recovery is required.
 */
export function observeViewTransitionCompletion(
  transition: ViewTransitionResult | undefined,
  label: string,
): void {
  if (!transition?.finished) return;

  void transition.finished.catch((error: unknown) => {
    if (isExpectedViewTransitionAbort(error)) return;
    console.error(`${label} view transition failed`, error);
  });
}
