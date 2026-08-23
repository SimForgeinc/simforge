export class RenderCanceledError extends Error {
  readonly code = 'render_canceled';

  constructor(readonly reason: string) {
    super(reason);
    this.name = 'RenderCanceledError';
  }
}

export function cancellationReason(signal: AbortSignal): string {
  const reason = signal.reason;
  if (reason instanceof Error) return reason.message;
  return typeof reason === 'string' && reason.length > 0 ? reason : 'render canceled';
}

export function throwIfCanceled(signal: AbortSignal): void {
  if (signal.aborted) throw new RenderCanceledError(cancellationReason(signal));
}

export function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  if (signals.length === 0) return new AbortController().signal;
  return AbortSignal.any([...signals]);
}

export async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new RangeError('milliseconds must be non-negative');
  throwIfCanceled(signal);
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      reject(new RenderCanceledError(cancellationReason(signal)));
    };
    signal.addEventListener('abort', abort, { once: true });
    timer.unref?.();
  });
}
