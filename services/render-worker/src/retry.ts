import { abortableDelay, throwIfCanceled } from '@simforge/render';

import type { RenderWorkerConfig } from './config.js';

export async function withBoundedRetry<T>(
  operation: string,
  config: RenderWorkerConfig['retries'],
  signal: AbortSignal,
  invoke: () => Promise<T>,
): Promise<T> {
  let delayMs = config.initialDelayMs;
  let lastError: unknown;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    throwIfCanceled(signal);
    try {
      return await invoke();
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
      if (attempt < config.maxAttempts) {
        await abortableDelay(delayMs, signal);
        delayMs = Math.min(config.maxDelayMs, delayMs * 2);
      }
    }
  }
  throw new Error(`${operation} failed after ${config.maxAttempts} attempts`, { cause: lastError });
}
