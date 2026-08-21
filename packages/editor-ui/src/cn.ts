/**
 * Join class names, skipping falsy values.
 *
 * The SimCloud original layered `tailwind-merge` over this; the portable
 * package ships plain co-styled CSS classes that never conflict, so a plain
 * join preserves the call sites without the dependency.
 */
export function cn(...inputs: Array<string | false | null | undefined>): string {
  return inputs.filter(Boolean).join(" ");
}
