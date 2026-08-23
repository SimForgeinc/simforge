import { describe, expect, it } from 'vitest';
import {
  AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY,
  LEGACY_AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY,
  BrowserMaterializedTrafficCapture,
  ambientTrafficProviderFromExtensions,
  bindAmbientProvenanceToMaterializedTraffic,
  consumeMaterializedTrafficEvidence,
  consumeMaterializedTrafficTraceEvidence,
  sumoOwnsPhysicalSignalStates,
} from './provider';

function packed(id: number, x: number, signals = 0): ArrayBuffer {
  const states = new ArrayBuffer(32);
  const view = new DataView(states);
  view.setUint32(0, id, true);
  view.setFloat32(4, x, true);
  view.setFloat32(8, 2, true);
  view.setFloat32(12, 90, true);
  view.setFloat32(16, 4, true);
  view.setFloat32(20, -0.5, true);
  view.setUint32(28, signals, true);
  return states;
}

describe('ambient traffic provider contract', () => {
  it('fails missing and unknown provider preferences closed', () => {
    expect(ambientTrafficProviderFromExtensions(undefined)).toBe('off');
    expect(ambientTrafficProviderFromExtensions({ [AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY]: 'broken' })).toBe('off');
    expect(ambientTrafficProviderFromExtensions({ [LEGACY_AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY]: 'native' })).toBe('native');
  });

  it('captures and binds complete SUMO materialized evidence', () => {
    const sourceInputDigest = 'a'.repeat(64);
    const capture = new BrowserMaterializedTrafficCapture({
      sourceInputDigest,
      mapAssetId: 'map-asset',
      mapVersionId: 'map-version',
      provider: { id: 'sumo', version: '1.27.1', seed: 'fixed' },
      fixedStepSeconds: 0.05,
      durationSeconds: 0.1,
    });
    capture.recordSumoFrame(0, { actorCount: 1, states: packed(2, 0, 1) }, { head_b: 'red', head_a: 'green' });
    capture.recordSumoFrame(0.05, { actorCount: 1, states: packed(2, 0.2, 2) }, { head_a: 'yellow', head_b: 'red' });
    expect(() => capture.finalize()).toThrow('incomplete');
    capture.recordSumoFrame(0.1, { actorCount: 1, states: packed(2, 0.4, 3) }, { head_b: 'green', head_a: 'red' });
    const result = capture.finalize();
    const binding = {
      sourceInputDigest,
      mapAssetId: 'map-asset',
      mapVersionId: 'map-version',
      durationSeconds: 0.1,
      sha256: result.sha256,
    };
    expect(consumeMaterializedTrafficEvidence(result.bytes, binding).sha256).toBe(result.sha256);
    expect(bindAmbientProvenanceToMaterializedTraffic({ mode: 'disabled', resultSha256: 'b'.repeat(64) }, result).resultSha256)
      .toBe(result.sha256);
    const evidence = consumeMaterializedTrafficTraceEvidence({
      header: { inputHash: sourceInputDigest, clipSeconds: 0.1, dt: 0.05, actorIds: [] },
      ticks: { t: [0, 0.05, 0.1], actors: {} }, events: [], metrics: {},
    } as never, result.bytes, binding);
    expect(evidence.trace.header.actorIds).toEqual(['sumo:00000002']);
    expect(evidence.trace.ticks.signals?.head_a?.phase).toEqual(['green', 'yellow', 'red']);
  });

  it('assigns signal ownership only to an active unopposed SUMO provider', () => {
    expect(sumoOwnsPhysicalSignalStates('sumo', false, false, false)).toBe(true);
    expect(sumoOwnsPhysicalSignalStates('sumo', false, true, false)).toBe(false);
    expect(sumoOwnsPhysicalSignalStates('sumo', false, false, true)).toBe(false);
    expect(sumoOwnsPhysicalSignalStates('sumo', true, false, false)).toBe(false);
    expect(sumoOwnsPhysicalSignalStates('native', false, false, false)).toBe(false);
  });
});
