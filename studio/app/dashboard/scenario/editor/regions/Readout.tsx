/**
 * A labelled, non-editable value. The inspector's placement figures and the
 * diagnostics counts are both this shape.
 *
 * A definition list rather than two divs: a screen reader then announces
 * "X, 12.40" as one pair instead of two unrelated strings.
 */
export function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border/70 bg-muted/30 p-2">
      <dt className="text-micro uppercase tracking-meta text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 truncate font-mono text-foreground/90">{value}</dd>
    </div>
  );
}
