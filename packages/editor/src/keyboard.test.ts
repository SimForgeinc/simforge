import { describe, expect, it, vi } from 'vitest';
import { handleEditorHistoryKey } from './keyboard';

function press(
  init: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; target: EventTarget | null }> = {},
  availability: Partial<{ enabled: boolean; canUndo: boolean; canRedo: boolean }> = {},
) {
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  const undo = vi.fn();
  const redo = vi.fn();
  const handled = handleEditorHistoryKey({
    key: init.key ?? 'z', metaKey: init.metaKey ?? false, ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false, altKey: init.altKey ?? false, target: init.target ?? null,
    preventDefault, stopPropagation,
  }, {
    enabled: availability.enabled ?? true, canUndo: availability.canUndo ?? true, canRedo: availability.canRedo ?? true,
    undo, redo,
  });
  return { handled, preventDefault, stopPropagation, undo, redo };
}

describe('editor document history shortcuts', () => {
  it.each([
    { name: 'Cmd+Z', metaKey: true, ctrlKey: false },
    { name: 'Ctrl+Z', metaKey: false, ctrlKey: true },
  ])('handles $name as undo', ({ metaKey, ctrlKey }) => {
    const result = press({ metaKey, ctrlKey });
    expect(result.handled).toBe(true);
    expect(result.undo).toHaveBeenCalledOnce();
    expect(result.redo).not.toHaveBeenCalled();
    expect(result.preventDefault).toHaveBeenCalledOnce();
    expect(result.stopPropagation).toHaveBeenCalledOnce();
  });

  it.each([
    { name: 'Cmd+Shift+Z', metaKey: true, ctrlKey: false, key: 'z', shiftKey: true },
    { name: 'Ctrl+Shift+Z', metaKey: false, ctrlKey: true, key: 'Z', shiftKey: true },
    { name: 'Ctrl+Y', metaKey: false, ctrlKey: true, key: 'y', shiftKey: false },
  ])('handles $name as redo', ({ metaKey, ctrlKey, key, shiftKey }) => {
    const result = press({ metaKey, ctrlKey, key, shiftKey });
    expect(result.handled).toBe(true);
    expect(result.redo).toHaveBeenCalledOnce();
    expect(result.undo).not.toHaveBeenCalled();
    expect(result.preventDefault).toHaveBeenCalledOnce();
  });

  it.each([
    { tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' },
    { tagName: 'SPAN', isContentEditable: true },
    { tagName: 'SPAN', closest: () => ({}) },
  ])('leaves native text history alone for editing target %#', (target) => {
    const result = press({ metaKey: true, target: target as unknown as EventTarget });
    expect(result.handled).toBe(false);
    expect(result.preventDefault).not.toHaveBeenCalled();
    expect(result.undo).not.toHaveBeenCalled();
  });

  it('does not consume shortcuts in read-only playback or when history is unavailable', () => {
    for (const result of [
      press({ metaKey: true }, { enabled: false }),
      press({ metaKey: true }, { canUndo: false }),
      press({ ctrlKey: true, key: 'y' }, { canRedo: false }),
    ]) {
      expect(result.handled).toBe(false);
      expect(result.preventDefault).not.toHaveBeenCalled();
      expect(result.undo).not.toHaveBeenCalled();
      expect(result.redo).not.toHaveBeenCalled();
    }
  });

  it('ignores Cmd+Y, Alt-modified chords, and unrelated shortcuts', () => {
    expect(press({ metaKey: true, key: 'y' }).handled).toBe(false);
    expect(press({ ctrlKey: true, key: 'z', altKey: true }).handled).toBe(false);
    expect(press({ metaKey: true, key: 'k' }).handled).toBe(false);
  });
});
