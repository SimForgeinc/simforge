import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PlaybackState } from '@uniscenarios/playback';
import { VerifiedReplayBar, verifiedReplayKeyboardAction, verifiedReplayPresentation } from './VerifiedReplayBar';

function state(time: number, playing: boolean): PlaybackState {
  return {
    time,
    startTime: 0,
    endTime: 20,
    playing,
    actorCount: 2,
    visibleActorCount: 2,
    propCount: 0,
    signalCount: 0,
    signalHeadCount: 0,
    renderedSignalHeadCount: 0,
    signalPhases: {
      green: 0, yellow: 0, red: 0, flashing_yellow: 0, flashing_red: 0,
      green_arrow: 0, yellow_arrow: 0, red_x: 0, proceed: 0, stop: 0, off: 0,
      flashing_yellow_arrow: 0, flashing_red_arrow: 0,
    },
    signalTimingSources: [],
    instanceId: 'verified-instance',
    inputHash: 'verified-hash',
    cameraPolicy: 'all-actors',
    cameraSelectionId: 'all-actors',
    cameraReason: 'All actors overview: this scenario has no sensor-bearing camera vehicle.',
  };
}

describe('VerifiedReplayBar', () => {
  it('reports deterministic 0 to 20 second progress and exact completion', () => {
    expect(verifiedReplayPresentation(state(0, true), { startTime: 0, endTime: 20 })).toMatchObject({
      current: 0, percent: 0, status: 'Playing',
    });
    expect(verifiedReplayPresentation(state(10, true), { startTime: 0, endTime: 20 })).toMatchObject({
      current: 10, percent: 50, status: 'Playing',
    });
    expect(verifiedReplayPresentation(state(20.0000001, false), { startTime: 0, endTime: 20 })).toMatchObject({
      current: 20, percent: 100, status: 'Complete',
    });
  });

  it('exposes accessible time, completion, progress, replay, and stop controls', () => {
    const markup = renderToStaticMarkup(
      <VerifiedReplayBar
        title="Blind Chicane"
        state={state(20, false)}
        startTime={0}
        endTime={20}
        onToggle={vi.fn()}
        onStop={vi.fn()}
        cameraOptions={[
          { id: 'all-actors', label: 'All actors overview', policy: 'all-actors' },
          { id: 'auto-incident', label: 'Incident overview', policy: 'auto-incident' },
          { id: 'authored:signal', label: 'Signal view', policy: 'authored', view: { position: [0, 3, 4], target: [5, 1, 0], fov: 48 } },
        ]}
        onCameraChange={vi.fn()}
      />,
    );
    expect(markup).toContain('20.00 / 20.00 s');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('Complete');
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="20"');
    expect(markup).toContain('aria-valuetext="20.00 of 20.00 seconds, complete"');
    expect(markup).toContain('aria-label="Replay verified scenario"');
    expect(markup).toContain('Stop &amp; return to Gallery');
    expect(markup).toContain('aria-label="Playback camera"');
    expect(markup).toContain('All actors overview');
    expect(markup).toContain('Incident overview');
    expect(markup).toContain('Signal view');
    expect(markup.match(/<button/g)).toHaveLength(2);
  });

  it('keeps progress at the exact trace envelope while the controller mounts', () => {
    const pending = verifiedReplayPresentation(null, { startTime: 0, endTime: 20 });
    expect(pending).toEqual({ current: 0, start: 0, end: 20, percent: 0, status: 'Paused' });
  });

  it('maps Space and Escape to accessible replay actions without stealing editable input', () => {
    const input = { code: 'Space', key: ' ', repeat: false, modified: false, editable: false };
    expect(verifiedReplayKeyboardAction(input)).toBe('toggle');
    expect(verifiedReplayKeyboardAction({ ...input, code: 'Escape', key: 'Escape' })).toBe('stop');
    expect(verifiedReplayKeyboardAction({ ...input, editable: true })).toBeNull();
    expect(verifiedReplayKeyboardAction({ ...input, repeat: true })).toBeNull();
    expect(verifiedReplayKeyboardAction({ ...input, modified: true })).toBeNull();
  });
});
