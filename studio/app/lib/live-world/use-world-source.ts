'use client';

import { useEffect, useRef, useState } from 'react';

import type { TruthFrame } from '@simforge/training-env';

import type { WorldSource, WorldSourceStatus } from './types';

const SNAPSHOT_INTERVAL_MS = 250;

export function useWorldSource(source: WorldSource | null): {
  status: WorldSourceStatus;
  error: string | null;
  latestFrame: TruthFrame | null;
} {
  const [status, setStatus] = useState<WorldSourceStatus>(() => source?.status ?? 'idle');
  const [error, setError] = useState<string | null>(() => source?.lastError ?? null);
  const [latestFrame, setLatestFrame] = useState<TruthFrame | null>(null);
  const pendingFrame = useRef<TruthFrame | null>(null);
  const lastPublishedAt = useRef(0);

  useEffect(() => {
    pendingFrame.current = null;
    lastPublishedAt.current = 0;
    setLatestFrame(null);
    setStatus(source?.status ?? 'idle');
    setError(source?.lastError ?? null);
    if (!source) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const publishPending = (): void => {
      timer = null;
      const frame = pendingFrame.current;
      if (!frame) return;
      pendingFrame.current = null;
      lastPublishedAt.current = performance.now();
      setLatestFrame(frame);
    };
    const onFrame = (frame: TruthFrame): void => {
      pendingFrame.current = frame;
      const remaining = SNAPSHOT_INTERVAL_MS - (performance.now() - lastPublishedAt.current);
      if (remaining <= 0) {
        if (timer) clearTimeout(timer);
        publishPending();
      } else if (!timer) {
        timer = setTimeout(publishPending, remaining);
      }
    };
    const onStatus = (nextStatus: WorldSourceStatus, nextError: string | null): void => {
      setStatus(nextStatus);
      setError(nextError);
    };

    const unsubscribeFrames = source.subscribeFrames(onFrame);
    const unsubscribeStatus = source.subscribeStatus(onStatus);
    return () => {
      unsubscribeFrames();
      unsubscribeStatus();
      if (timer) clearTimeout(timer);
      pendingFrame.current = null;
    };
  }, [source]);

  return { status, error, latestFrame };
}
