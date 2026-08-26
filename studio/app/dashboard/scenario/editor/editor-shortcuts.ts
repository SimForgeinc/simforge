/**
 * The editor surface's one keyboard-shortcut registry.
 *
 * The editor core owns its canvas-level keys. Everything the surface binds —
 * clipboard copy/paste today, future surface-level keys tomorrow — goes through
 * this registry so bindings are declared, deduplicated, guarded against text
 * inputs in one place, and torn down together.
 */

import { isTextEditingTarget } from "@simforge-oss/editor";

export interface EditorShortcut {
  /** Normalised combo, e.g. `mod+c`, `mod+shift+v`. `mod` = Ctrl or Command. */
  readonly combo: string;
  /** Return true when consumed; the registry suppresses the native action. */
  readonly handler: (event: KeyboardEvent) => boolean;
  /** Bind even while an input, textarea, or contenteditable has focus. */
  readonly allowInTextEditing?: boolean;
}

export function shortcutComboFromEvent(event: KeyboardEvent): string | null {
  const key = event.key.toLowerCase();
  if (key === "control" || key === "meta" || key === "shift" || key === "alt") return null;
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push("mod");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

export class EditorShortcutRegistry {
  private readonly shortcuts = new Map<string, EditorShortcut>();
  private target: Window | null = null;

  register(shortcut: EditorShortcut): () => void {
    if (this.shortcuts.has(shortcut.combo)) {
      throw new Error(`editor shortcut already bound: ${shortcut.combo}`);
    }
    this.shortcuts.set(shortcut.combo, shortcut);
    return () => {
      this.shortcuts.delete(shortcut.combo);
    };
  }

  attach(target: Window): () => void {
    this.detach();
    this.target = target;
    target.addEventListener("keydown", this.onKeyDown, { capture: true });
    return () => this.detach();
  }

  detach(): void {
    this.target?.removeEventListener("keydown", this.onKeyDown, { capture: true });
    this.target = null;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const combo = shortcutComboFromEvent(event);
    if (!combo) return;
    const shortcut = this.shortcuts.get(combo);
    if (!shortcut) return;
    if (!shortcut.allowInTextEditing && isTextEditingTarget(event.target)) return;
    if (shortcut.handler(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
}
