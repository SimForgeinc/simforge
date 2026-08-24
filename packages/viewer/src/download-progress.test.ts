import { describe, expect, it, vi } from 'vitest';
import { AssetDownloadTracker, readResponseBufferWithProgress } from './download-progress';

describe('asset download telemetry', () => {
  it('reports cumulative bytes, rolling speed, and stall duration', () => {
    const tracker = new AssetDownloadTracker();
    const transfer = tracker.begin(1_000);
    tracker.advance(transfer, 200, 100);
    tracker.advance(transfer, 300, 1_100);

    expect(tracker.snapshot(1_100)).toMatchObject({
      active: 1,
      transferredBytes: 500,
      totalBytes: 1_000,
      bytesPerSecond: 300,
      stalledForMs: 0,
    });
    expect(tracker.snapshot(4_200)).toMatchObject({
      bytesPerSecond: 0,
      stalledForMs: 3_100,
    });
  });

  it('keeps stale transfers from a previous map out of a reset session', () => {
    const tracker = new AssetDownloadTracker();
    const stale = tracker.begin(1_000);
    tracker.advance(stale, 300, 100);
    tracker.reset();
    tracker.advance(stale, 400, 200);
    tracker.finish(stale, 300);

    expect(tracker.snapshot(300)).toEqual({
      active: 0,
      transferredBytes: 0,
      totalBytes: 0,
      bytesPerSecond: null,
      stalledForMs: 0,
    });
  });

  it('counts streamed response chunks and uses the expected size when headers hide it', async () => {
    vi.stubGlobal('performance', { now: () => 1_000 });
    const tracker = new AssetDownloadTracker();
    const response = new Response(new Blob(['hello world']).stream());

    const buffer = await readResponseBufferWithProgress(response, tracker, 20);

    expect(new TextDecoder().decode(buffer)).toBe('hello world');
    expect(tracker.snapshot(1_000)).toMatchObject({
      active: 0,
      transferredBytes: 11,
      totalBytes: 11,
    });
    vi.unstubAllGlobals();
  });
});
