import { describe, expect, it } from 'vitest';
import { createCameraCompanion } from './companion';
import { preferredAuthoredCamera, parseCameraPresentation } from './model';

describe('camera presentation metadata', () => {
  it('parses bounded authored camera values and attachments', () => {
    const parsed = parseCameraPresentation({
      cameras: [{
        id: 'camera-1', name: 'Signal', position: [1, 2, 3], target: [4, 5, 6], fov: 500,
        attachment: { kind: 'traffic-signal', id: 'signal-a', approach: 'north' },
      }],
      activeCameraId: 'camera-1',
      policy: 'authored',
    });
    expect(parsed.activeCameraId).toBe('camera-1');
    expect(parsed.cameras[0]?.fov).toBe(120);
    expect(parsed.cameras[0]?.attachment).toEqual({ kind: 'traffic-signal', id: 'signal-a', approach: 'north' });
  });

  it('normalizes the persisted chase policy to the sensor-derived policy', () => {
    // `ego-chase` remains accepted only while reading already-persisted presentations.
    expect(parseCameraPresentation({ cameras: [], policy: 'ego-chase' }).policy).toBe('subject-chase');
  });

  it('labels camera export as companion metadata rather than ASAM support', () => {
    const presentation = parseCameraPresentation({ cameras: [], policy: 'free' });
    const companion = createCameraCompanion(presentation, 'input-hash');
    expect(companion.schema).toBe('uniscenarios-camera-companion/1');
    expect(companion.notice).toContain('not a native ASAM');
  });

  it('prefers the active authored camera without mutating template state', () => {
    const extension = {
      version: 1,
      policy: 'authored',
      activeCameraId: 'signal-view',
      cameras: [{ id: 'signal-view', name: 'Signal', position: [1, 2, 3], target: [4, 5, 6], fov: 45 }],
    };
    expect(preferredAuthoredCamera({ extensions: { 'studio.presentation.cameras.v1': extension } } as never)).toEqual({
      position: [1, 2, 3], target: [4, 5, 6], fov: 45,
    });
  });
});
