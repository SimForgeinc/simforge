import { LoaderCircle } from "lucide-react";
import { cn } from "@/app/lib/utils";

export type WorkspacePaneLoadingProps = {
  message: string;
  hint?: string;
  className?: string;
};

export function WorkspacePaneLoading({
  message,
  hint,
  className,
}: WorkspacePaneLoadingProps) {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className={cn(
        "flex min-h-20 items-start gap-3 border-b border-white/10 px-3 py-4 text-foreground",
        className,
      )}
      data-testid="workspace-pane-loading"
      role="status"
    >
      <span
        aria-hidden="true"
        className="mt-0.5 grid size-3.5 shrink-0 animate-spin place-items-center text-primary motion-reduce:animate-none"
      >
        <LoaderCircle className="size-3.5" />
      </span>
      <div className="min-w-0">
        <p className="font-meta text-micro font-bold uppercase tracking-meta-wider text-foreground">
          {message}
        </p>
        {hint ? (
          <p className="mt-1 text-xs leading-4 text-white/60">{hint}</p>
        ) : null}
      </div>
    </div>
  );
}
