import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_CLIP_MS,
  archiveClipAt,
  archiveVideoUrl,
  clipStartupLagSeconds,
  MAX_CLIP_LEAD_MS,
  resolveArchiveClip,
  coverageTrackBackground,
  latestActivityMs,
  shouldCorrectVideoDrift,
} from './replay-helpers';

describe('archive replay helpers', () => {
  const template = 'https://twin.example/archive/get?path={channel}&start={start}&duration={duration}&format=mp4';

  it('anchors a clip on the whole second where playback starts', () => {
    const clock = Date.parse('2026-09-02T12:07:31.250Z');
    expect(archiveClipAt(clock)).toEqual({
      startMs: Date.parse('2026-09-02T12:07:31.000Z'),
      endMs: Date.parse('2026-09-02T12:12:31.000Z'),
      startIso: '2026-09-02T12:07:31.000Z',
      durationSeconds: 300,
    });
    expect(archiveVideoUrl(template, 'ch1', archiveClipAt(clock)))
      .toBe('https://twin.example/archive/get?path=ch1&start=2026-09-02T12%3A07%3A31.000Z&duration=300&format=mp4');
  });

  it('adds a fractional server offset to the archive clip request', () => {
    const clip = archiveClipAt(Date.parse('2026-09-02T12:02:31.250Z'));
    expect(archiveVideoUrl(template, 'ch1', clip, 2.6))
      .toBe('https://twin.example/archive/get?path=ch1&start=2026-09-02T12%3A02%3A33.600Z&duration=300&format=mp4');
  });

  it('keeps the clip while the clock plays through it and re-anchors on seeks', () => {
    const start = Date.parse('2026-09-02T12:00:00.000Z');
    const clip = archiveClipAt(start);
    expect(resolveArchiveClip(clip, start, start + 250, 1)).toBe(clip);
    expect(resolveArchiveClip(clip, start, start + 4 * 250, 4)).toBe(clip);
    expect(resolveArchiveClip(clip, start + 10_000, start + 10_000, 0)).toBe(clip);
    const seeked = resolveArchiveClip(clip, start + 10_000, start + 60_000, 1);
    expect(seeked.startMs).toBe(start + 60_000);
    expect(resolveArchiveClip(clip, start + 10_000, start - 5_000, 1).startMs).toBe(start - 5_000);
    expect(resolveArchiveClip(clip, start + ARCHIVE_CLIP_MS - 250, start + ARCHIVE_CLIP_MS, 1).startMs)
      .toBe(start + ARCHIVE_CLIP_MS);
    expect(resolveArchiveClip(null, Number.NaN, start, 1).startMs).toBe(start);
  });

  it('leads a clip request by the measured start-up latency, capped', () => {
    const start = Date.parse('2026-09-02T12:00:00.000Z');
    expect(archiveClipAt(start, 4_300).startMs).toBe(start + 4_000);
    expect(archiveClipAt(start, 60_000).startMs).toBe(start + MAX_CLIP_LEAD_MS);
    expect(archiveClipAt(start, -5).startMs).toBe(start);
    const led = archiveClipAt(start, 4_000);
    // The clock is briefly behind a led clip; that is not a reason to re-anchor.
    expect(resolveArchiveClip(led, start, start + 250, 1)).toBe(led);
    expect(clipStartupLagSeconds(archiveClipAt(start), start + 9_000, 1.2)).toBeCloseTo(7.8);
    expect(clipStartupLagSeconds(archiveClipAt(start), start + 1_000, 3)).toBe(0);
  });

  it('corrects only drift beyond half a second', () => {
    expect(shouldCorrectVideoDrift(31, 31.5)).toBe(false);
    expect(shouldCorrectVideoDrift(31, 31.501)).toBe(true);
    expect(shouldCorrectVideoDrift(Number.NaN, 31)).toBe(true);
  });
});

describe('coverage paint', () => {
  it('maps empty and active five-minute buckets onto the range track', () => {
    const start = Date.parse('2026-09-02T12:00:00Z');
    const buckets = [
      { start: new Date(start).toISOString(), detections: 0, objects: 0 },
      { start: new Date(start + ARCHIVE_CLIP_MS).toISOString(), detections: 5, objects: 3 },
    ];
    const paint = coverageTrackBackground(buckets, start, start + 2 * ARCHIVE_CLIP_MS);
    expect(paint).toContain('hsl(var(--muted)) 0.000%');
    expect(paint).toContain('hsl(var(--primary) / 1.000) 50.000%');
    expect(paint).toContain('100.000%');
    expect(latestActivityMs(buckets)).toBe(start + ARCHIVE_CLIP_MS);
  });
});
