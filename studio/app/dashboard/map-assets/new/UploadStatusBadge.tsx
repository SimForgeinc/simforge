import { Loader2, Check, AlertCircle } from "lucide-react";

export type UploadStatus = "hashing" | "uploading" | "done" | "error";
export type TrackedUpload = {
  status: UploadStatus;
  sha256: string | null;
  key: string | null;
  error: string | null;
};

/** Tiny upload status indicator shown inline next to each file name. */
export function UploadStatusBadge({ upload }: { upload: TrackedUpload | undefined }) {
  if (!upload) return null;
  switch (upload.status) {
    case "hashing":
      return (
        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Hashing…
        </span>
      );
    case "uploading":
      return (
        <span className="inline-flex items-center gap-1 text-[10px] text-blue-400">
          <Loader2 className="size-3 animate-spin" /> Uploading…
        </span>
      );
    case "done":
      return (
        <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400">
          <Check className="size-3" /> Uploaded
        </span>
      );
    case "error":
      return (
        <span className="inline-flex items-center gap-1 text-[10px] text-destructive" title={upload.error ?? undefined}>
          <AlertCircle className="size-3" /> Failed
        </span>
      );
  }
}
