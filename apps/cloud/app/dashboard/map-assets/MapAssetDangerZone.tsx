import { AlertTriangle, ChevronDown } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";

type MapAssetDangerZoneProps = {
  dangerOpen: boolean;
  deleteBusy: boolean;
  deleteConfirmEmail: string;
  deleteError: string | null;
  sessionEmail: string | null;
  sessionLoaded: boolean;
  submitting: boolean;
  onDeleteConfirmEmailChange: (next: string) => void;
  onDeleteMap: () => void;
  onToggleDangerOpen: () => void;
};

function emailsMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function MapAssetDangerZone({
  dangerOpen,
  deleteBusy,
  deleteConfirmEmail,
  deleteError,
  sessionEmail,
  sessionLoaded,
  submitting,
  onDeleteConfirmEmailChange,
  onDeleteMap,
  onToggleDangerOpen,
}: MapAssetDangerZoneProps) {
  return (
    <section className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
      <button
        type="button"
        onClick={onToggleDangerOpen}
        className="flex w-full items-center gap-2 text-left"
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
        <h3 className="flex-1 text-xs font-semibold uppercase tracking-wide text-destructive">
          Delete map (admin)
        </h3>
        <ChevronDown
          className={`size-3.5 shrink-0 text-destructive/70 transition-transform duration-150 ${dangerOpen ? "rotate-180" : ""}`}
        />
      </button>
      {dangerOpen && (
        <div className="mt-2">
          <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
            This permanently removes the map, all stored artifacts in S3 under this asset, and computed metadata
            (including stats). Existing scenarios that reference this map will point at a missing asset. This
            cannot be undone.
          </p>
          {sessionLoaded && !sessionEmail && (
            <p className="mb-2 text-[11px] text-destructive">
              Your account has no email address on file. Please update your account settings to enable map deletion.
            </p>
          )}
          {sessionEmail && (
            <>
              <p className="mb-1.5 text-[11px] text-muted-foreground">
                Type your signed-in email address below to confirm (case does not matter):
              </p>
              <p className="mb-2 break-all rounded border border-border bg-muted/40 px-2 py-1 font-mono text-[10px] text-foreground">
                {sessionEmail}
              </p>
              <label htmlFor="delete-confirm-email" className="sr-only">
                Type your email to confirm deletion
              </label>
              <Input
                id="delete-confirm-email"
                value={deleteConfirmEmail}
                onChange={(e) => onDeleteConfirmEmailChange(e.target.value)}
                placeholder="Type your email to confirm"
                autoComplete="off"
                className="mb-2 h-8 font-mono text-xs"
                disabled={deleteBusy}
              />
            </>
          )}
          {deleteError && <p className="mb-2 text-[11px] text-destructive">{deleteError}</p>}
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="w-full"
            disabled={
              deleteBusy ||
              !sessionEmail ||
              !emailsMatch(deleteConfirmEmail, sessionEmail) ||
              submitting
            }
            onClick={() => void onDeleteMap()}
          >
            {deleteBusy ? "Deleting…" : "Delete map permanently"}
          </Button>
        </div>
      )}
    </section>
  );
}
