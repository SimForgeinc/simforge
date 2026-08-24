"use client";

import { useId, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Input } from "@/app/components/ui/input";
import { newTemplateId } from "@simforge/scenario";

/**
 * Shared controls for the authoring panel's six editors.
 *
 * They exist as one file because the panel's density is the constraint: every
 * field is a label plus a 2rem control in a 16rem rail, and drifting sizes
 * between the six sections is immediately visible.
 */

export function Heading({ children }: { children: ReactNode }) {
  return (
    <h3 className="font-semibold uppercase tracking-meta text-muted-foreground">
      {children}
    </h3>
  );
}

/**
 * Icon-only add button. It gets its accessible name from `label` — v2's version
 * had none at all, so five separate "Add" buttons announced as empty buttons in
 * one panel.
 */
export function MiniAdd({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="editor-motion ml-auto text-primary hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card disabled:opacity-30"
    >
      <Plus aria-hidden="true" className="size-3" />
    </button>
  );
}

/** Icon-only remove button, named after what it removes. */
export function DeleteButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="editor-motion ml-auto text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card"
    >
      <Trash2 aria-hidden="true" className="size-3" />
    </button>
  );
}

/** A labelled text field. `htmlFor`/`id` are generated, never assumed. */
export function TextField({
  label,
  value,
  onChange,
  placeholder,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const id = useId();
  return (
    <div className="min-w-0">
      <label className="block text-muted-foreground" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-1 h-8 ${className ?? ""}`}
      />
    </div>
  );
}

/** A labelled numeric field. */
export function NumberField({
  label,
  value,
  onChange,
  step = 0.1,
  min,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  step?: number;
  min?: number;
}) {
  const id = useId();
  return (
    <div className="min-w-0">
      <label className="block text-muted-foreground" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        type="number"
        step={step}
        min={min}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-1 h-8"
      />
    </div>
  );
}

/** A container that carries the id an added item is keyed by. */
export function uniqueId(prefix: string, used: readonly string[]) {
  let id = newTemplateId(prefix);
  while (used.includes(id)) id = newTemplateId(prefix);
  return id;
}

export function numberOr(value: unknown, fallback: number) {
  return typeof value === "number" ? value : fallback;
}
