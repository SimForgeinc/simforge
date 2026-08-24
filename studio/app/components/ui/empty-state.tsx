import type { ReactNode } from "react";
import { cn } from "@/app/lib/utils";

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-64 flex-col items-center justify-center px-6 py-10 text-center", className)}>
      {icon ? <div className="mb-4 text-muted-foreground">{icon}</div> : null}
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {description ? <p className="mt-1 max-w-md text-sm leading-6 text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
