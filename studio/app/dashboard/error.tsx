"use client";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <h2 className="text-lg font-semibold mb-2">Something went wrong</h2>
      <p className="text-sm text-muted-foreground mb-4">
        {error.message || "An unexpected error occurred."}
      </p>
      <button
        onClick={reset}
        className="text-sm px-4 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
      >
        Try again
      </button>
    </div>
  );
}
