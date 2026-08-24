export interface EditorHistoryKeyEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly target: EventTarget | null;
  preventDefault(): void;
  stopPropagation(): void;
}

interface HistoryActions {
  readonly enabled: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  undo(): void;
  redo(): void;
}

/** Keep application history shortcuts out of native text-editing surfaces. */
export function isTextEditingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element?.tagName) return false;
  const tag = element.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable) return true;
  return typeof element.closest === 'function' && element.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

/** Handle standard document undo/redo only when an available editor action owns it. */
export function handleEditorHistoryKey(event: EditorHistoryKeyEvent, actions: HistoryActions): boolean {
  if (!actions.enabled || event.altKey || isTextEditingTarget(event.target)) return false;
  const key = event.key.toLowerCase();
  const undo = (event.metaKey || event.ctrlKey) && key === 'z' && !event.shiftKey;
  const redo = ((event.metaKey || event.ctrlKey) && key === 'z' && event.shiftKey)
    || (event.ctrlKey && !event.metaKey && key === 'y' && !event.shiftKey);
  if ((!undo || !actions.canUndo) && (!redo || !actions.canRedo)) return false;
  event.preventDefault();
  event.stopPropagation();
  if (redo) actions.redo();
  else actions.undo();
  return true;
}
