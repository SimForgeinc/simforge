"use client";

import { useId } from "react";
import { CloudActivityIndicator } from "@/app/components/CloudLoadingSurface";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { CopyableErrorMessage } from "./CopyableErrorMessage";

/**
 * The name + description editor, shared by datasets and documents.
 *
 * v1's raw `<input>`/`<textarea>` are an `<Input>` primitive and a token-styled textarea here, which
 * is what restores the `focus-visible` ring; the labels are `htmlFor`-bound rather than wrapping,
 * because the textarea has no primitive and a wrapping label around it announced nothing.
 */
export function MetadataDetailsDialog({
  open,
  title,
  intro,
  name,
  description,
  busy,
  error,
  nameLabel = "Name",
  namePlaceholder = "Name",
  descriptionLabel = "Description",
  descriptionPlaceholder = "Description",
  submitLabel = "Save details",
  busyLabel = "Saving...",
  onNameChange,
  onDescriptionChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  intro: string;
  name: string;
  description: string;
  busy: boolean;
  error: string | null;
  nameLabel?: string;
  namePlaceholder?: string;
  descriptionLabel?: string;
  descriptionPlaceholder?: string;
  submitLabel?: string;
  busyLabel?: string;
  onNameChange: (next: string) => void;
  onDescriptionChange: (next: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const titleId = useId();
  const nameId = useId();
  const descriptionId = useId();
  if (!open) return null;
  const canSubmit = Boolean(name.trim()) && !busy;

  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center px-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        aria-label={`Close ${title}`}
        onClick={() => {
          if (!busy) onClose();
        }}
      />
      <div
        className="relative z-10 w-full max-w-lg border border-border bg-background p-5 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId} className="text-base font-semibold text-foreground">
          {title}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">{intro}</p>
        <label
          htmlFor={nameId}
          className="mt-4 block font-meta text-micro uppercase tracking-meta-wide text-muted-foreground"
        >
          {nameLabel}
        </label>
        <Input
          id={nameId}
          type="text"
          autoFocus
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && canSubmit) {
              event.preventDefault();
              onSubmit();
            } else if (event.key === "Escape" && !busy) {
              event.preventDefault();
              onClose();
            }
          }}
          placeholder={namePlaceholder}
          className="mt-1.5"
          disabled={busy}
        />
        <label
          htmlFor={descriptionId}
          className="mt-4 block font-meta text-micro uppercase tracking-meta-wide text-muted-foreground"
        >
          {descriptionLabel}
        </label>
        <textarea
          id={descriptionId}
          value={description}
          onChange={(event) => onDescriptionChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) {
              event.preventDefault();
              onClose();
            }
          }}
          placeholder={descriptionPlaceholder}
          className="mt-1.5 min-h-28 w-full resize-y border border-input bg-background px-3 py-2 text-sm leading-5 text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy}
        />
        {error ? <CopyableErrorMessage message={error} className="mt-3 text-xs" /> : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={!canSubmit} onClick={onSubmit}>
            {busy ? (
              <CloudActivityIndicator label={busyLabel} />
            ) : (
              submitLabel
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
