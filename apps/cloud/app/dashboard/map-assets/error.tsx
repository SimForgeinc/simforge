"use client";

export default function MapAssetsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="p-6">
      <h2 className="text-lg font-semibold mb-2">Failed to load map assets</h2>
      <p className="text-sm text-muted-foreground mb-4">
        {error.message || "Could not fetch map asset data."}
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
