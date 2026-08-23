"use client";

import { useId } from "react";
import { CloudActivityIndicator } from "@/app/components/CloudLoadingSurface";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { CopyableErrorMessage } from "./CopyableErrorMessage";

export function NewDatasetDialog({
  open,
  name,
  busy,
  error,
  title = "New dataset",
  description = "Give your dataset a short name. You can add scenarios after it's created.",
  placeholder = "Dataset name",
  submitLabel = "Create dataset",
  busyLabel = "Creating...",
  onNameChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  name: string;
  busy: boolean;
  error: string | null;
  title?: string;
  description?: string;
  placeholder?: string;
  submitLabel?: string;
  busyLabel?: string;
  onNameChange: (next: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const titleId = useId();
  const nameId = useId();
  if (!open) return null;
  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center px-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        aria-label="Close new dataset dialog"
        onClick={() => {
          if (!busy) onClose();
        }}
      />
      <div
        className="relative z-10 w-full max-w-sm border border-border bg-background p-5 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId} className="text-base font-semibold text-foreground">
          {title}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        <label htmlFor={nameId} className="sr-only">
          {placeholder}
        </label>
        <Input
          id={nameId}
          type="text"
          autoFocus
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && name.trim() && !busy) {
              onSubmit();
            } else if (event.key === "Escape" && !busy) {
              onClose();
            }
          }}
          placeholder={placeholder}
          className="mt-4"
          disabled={busy}
        />
        {/*
          The name collision is the one error worth showing in place rather than in the page banner:
          `UNIQUE (workspace_id, name)` is not partial, so a soft-deleted dataset still holds its
          name and the fix is to type a different one right here.
        */}
        {error ? <CopyableErrorMessage message={error} className="mt-3 text-xs" /> : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={busy || !name.trim()} onClick={onSubmit}>
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
