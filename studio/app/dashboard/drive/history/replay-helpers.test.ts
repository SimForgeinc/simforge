import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_CLIP_MS,
  archiveClipWindow,
  archiveVideoUrl,
  coverageTrackBackground,
  latestActivityMs,
  shouldCorrectVideoDrift,
} from './replay-helpers';

describe('archive replay helpers', () => {
  it('aligns clips to five-minute UTC windows and fills the archive template', () => {
    const clock = Date.parse('2026-09-02T12:07:31.250Z');
    expect(archiveClipWindow(clock)).toEqual({
      startMs: Date.parse('2026-09-02T12:05:00.000Z'),
      endMs: Date.parse('2026-09-02T12:10:00.000Z'),
      startIso: '2026-09-02T12:05:00.000Z',
      durationSeconds: 300,
    });
    expect(archiveVideoUrl(
      'https://twin.example/archive/get?path={channel}&start={start}&duration={duration}&format=mp4',
      'ch1',
      clock,
    )).toBe('https://twin.example/archive/get?path=ch1&start=2026-09-02T12%3A05%3A00.000Z&duration=300&format=mp4');
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
