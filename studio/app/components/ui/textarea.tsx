import * as React from "react";

import { cn } from "@/app/lib/utils";

/**
 * Multi-line sibling of `Input`, with the same border, ring-offset and
 * `focus-visible` treatment. It exists because the editor's route and JSON
 * fields were raw `<textarea>` elements, which meant no focus ring and no
 * shared disabled/placeholder behaviour.
 */
const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        "flex min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

export { Textarea };
