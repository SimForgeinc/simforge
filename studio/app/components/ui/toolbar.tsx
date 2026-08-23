import type { HTMLAttributes } from "react";
import { cn } from "@/app/lib/utils";

export function Toolbar({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex min-h-11 flex-wrap items-center gap-2 border-b border-border bg-background px-5 py-2 sm:px-6", className)}
      {...props}
    />
  );
}

export function ToolbarGroup({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center gap-2", className)} {...props} />;
}
