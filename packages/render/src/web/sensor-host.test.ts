import { describe, expect, it } from 'vitest';

import { assertBrowserSensorHosts } from './sensor-host.js';

const source = {
  actorId: 'ego',
  sensorId: 'novel-camera',
  outputName: 'ego-novel-camera-rgb',
  modality: 'rgb',
};

describe('assertBrowserSensorHosts', () => {
  it('accepts the submitted host without comparing its catalog id to playback metadata', () => {
    expect(() => assertBrowserSensorHosts(
      { sources: [source] } as never,
      { actors: [{ id: 'ego', catalogId: 'authored.current-name' }] } as never,
      [{
        sourceId: source.outputName,
        actorId: source.actorId,
        vehicleAsset: { catalogAssetId: 'authored.previous-name' },
      }],
    )).not.toThrow();
  });
});
