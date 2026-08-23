"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/app/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";

/**
 * The house's single-choice control.
 *
 * There is no `select` primitive, and a raw `<select>` cannot be styled to
 * match the rest of the surface without also losing the ring treatment every
 * other control has — which is exactly what happened across the editor's
 * eleven raw selects. This wraps `DropdownMenuRadioGroup` so a choice reads as
 * one radio group to assistive tech, keeps the shared `focus-visible` ring, and
 * takes its options as data.
 *
 * A trigger is a `<button>`, so `htmlFor` cannot name it. Use `SelectMenuField`
 * when a visible label is wanted: it renders the label, gives it an id, and
 * points the trigger at it with `aria-labelledby`.
 */
export type SelectMenuOption = {
  value: string;
  label?: string;
  disabled?: boolean;
};

export type SelectMenuProps = {
  value: string;
  options: readonly (SelectMenuOption | string)[];
  onChange: (value: string) => void;
  /** Accessible name. Omit only when `labelledBy` is supplied instead. */
  label?: string;
  labelledBy?: string;
  /** Rendered in the trigger. Defaults to the selected option's label. */
  display?: React.ReactNode;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  contentClassName?: string;
  align?: "start" | "center" | "end";
  id?: string;
};

function normalize(option: SelectMenuOption | string): SelectMenuOption {
  return typeof option === "string" ? { value: option } : option;
}

export function SelectMenu({
  value,
  options,
  onChange,
  label,
  labelledBy,
  display,
  placeholder = "Select…",
  disabled,
  className,
  contentClassName,
  align = "start",
  id,
}: SelectMenuProps) {
  const normalized = React.useMemo(() => options.map(normalize), [options]);
  const selected = normalized.find((option) => option.value === value);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          id={id}
          aria-label={labelledBy ? undefined : label}
          aria-labelledby={labelledBy}
          disabled={disabled}
          className={cn(
            "editor-motion inline-flex h-10 w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-left text-sm ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
        >
          <span className="min-w-0 flex-1 truncate">
            {display ?? selected?.label ?? selected?.value ?? placeholder}
          </span>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        className={cn("max-h-72 overflow-y-auto", contentClassName)}
      >
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {normalized.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              disabled={option.disabled}
            >
              {option.label ?? option.value}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** `SelectMenu` with a visible label wired to the trigger by `aria-labelledby`. */
export function SelectMenuField({
  label,
  labelClassName,
  fieldClassName,
  ...props
}: Omit<SelectMenuProps, "label" | "labelledBy"> & {
  label: string;
  labelClassName?: string;
  fieldClassName?: string;
}) {
  const labelId = React.useId();
  return (
    <div className={cn("min-w-0", fieldClassName)}>
      <span
        id={labelId}
        className={cn("block text-muted-foreground", labelClassName)}
      >
        {label}
      </span>
      <SelectMenu {...props} labelledBy={labelId} />
    </div>
  );
}
