import { describe, expect, it } from 'vitest';
import {
  MaterializedTrafficRecorder,
  createDisabledMaterializedTrafficArtifact,
  decodeMaterializedTrafficArtifact,
  materializedTrafficArtifactEnvelope,
  parseMaterializedTrafficArtifact,
} from '../index.js';

const binding = {
  sourceInputDigest: 'a'.repeat(64),
  mapAssetId: 'map-asset',
  mapVersionId: 'map-version',
  durationSeconds: .1,
};

function recorder(): MaterializedTrafficRecorder {
  return new MaterializedTrafficRecorder({
    sourceInputDigest: binding.sourceInputDigest,
    map: { assetId: binding.mapAssetId, versionId: binding.mapVersionId },
    provider: { id: 'sumo', version: '1.27.1', seed: 'traffic-seed' },
    fixedStepSeconds: .05,
    durationSeconds: binding.durationSeconds,
  });
}

describe('materialized traffic artifact v1', () => {
  it('canonicalizes provider actor/signal ordering and fills complete presence tracks', () => {
    const capture = recorder();
    capture.record({ t: 0, actors: [
      { id: 'sumo:b', kind: 'vehicle', x: 2, z: 0, headingRad: 0, speedMps: 1, accelerationMps2: 0, signals: 1 },
      { id: 'sumo:a', kind: 'vehicle', x: 1, z: 0, headingRad: 0, speedMps: 1, accelerationMps2: 0, signals: 2 },
    ], signals: { z: 'red', a: 'green' } });
    capture.record({ t: .05, actors: [
      { id: 'sumo:a', kind: 'vehicle', x: 1.05, z: 0, headingRad: 0, speedMps: 1, accelerationMps2: 0, signals: 0 },
    ], signals: { a: 'yellow', z: 'red' } });
    capture.record({ t: .1, actors: [
      { id: 'sumo:b', kind: 'vehicle', x: 2.1, z: 0, headingRad: 0, speedMps: 1, accelerationMps2: 0, signals: 0 },
    ], signals: { z: 'green', a: 'red' } });
    const envelope = capture.finalize();

    expect(envelope.artifact.actors.map(({ id }) => id)).toEqual(['sumo:a', 'sumo:b']);
    expect(envelope.artifact.signals.map(({ id }) => id)).toEqual(['a', 'z']);
    expect(envelope.artifact.actors[1]!.states[1]).toEqual({
      t: .05, present: false, x: 0, z: 0, headingRad: 0, speedMps: 0, accelerationMps2: 0, signals: 0,
    });
    expect(decodeMaterializedTrafficArtifact(envelope.bytes, { ...binding, sha256: envelope.sha256 }).artifact).toEqual(envelope.artifact);
  });

  it('has one canonical disabled contract in the same versioned schema', () => {
    const first = createDisabledMaterializedTrafficArtifact({
      sourceInputDigest: binding.sourceInputDigest,
      map: { assetId: binding.mapAssetId, versionId: binding.mapVersionId },
      fixedStepSeconds: .05,
      durationSeconds: .1,
    });
    const second = createDisabledMaterializedTrafficArtifact({
      sourceInputDigest: binding.sourceInputDigest,
      map: { assetId: binding.mapAssetId, versionId: binding.mapVersionId },
      fixedStepSeconds: .05,
      durationSeconds: .1,
    });
    expect(first.sha256).toBe(second.sha256);
    expect(first.artifact).toMatchObject({
      schema: 'uniscenarios.materialized-traffic.v1',
      provider: { id: 'disabled', version: 'none', seed: '' },
      actors: [], signals: [],
    });
  });

  it('rejects incomplete finalization, tampering, stale bindings, and noncanonical ordering', () => {
    const capture = recorder();
    capture.record({ t: 0, actors: [], signals: {} });
    expect(() => capture.finalize()).toThrow('incomplete');

    capture.record({ t: .05, actors: [], signals: {} });
    capture.record({ t: .1, actors: [], signals: {} });
    const complete = capture.finalize();
    expect(() => decodeMaterializedTrafficArtifact(complete.bytes, { ...binding, sha256: 'f'.repeat(64) })).toThrow('sha256 mismatch');
    expect(() => decodeMaterializedTrafficArtifact(complete.bytes, { ...binding, mapAssetId: 'stale' })).toThrow('map asset');
    expect(() => decodeMaterializedTrafficArtifact(complete.bytes, { ...binding, durationSeconds: .2 })).toThrow('duration');

    const artifact = structuredClone(complete.artifact);
    artifact.actors = [
      { id: 'z', kind: 'vehicle', states: [{ t: 0, present: false, x: 0, z: 0, headingRad: 0, speedMps: 0, accelerationMps2: 0, signals: 0 }, { t: .05, present: false, x: 0, z: 0, headingRad: 0, speedMps: 0, accelerationMps2: 0, signals: 0 }, { t: .1, present: false, x: 0, z: 0, headingRad: 0, speedMps: 0, accelerationMps2: 0, signals: 0 }] },
      { id: 'a', kind: 'vehicle', states: [{ t: 0, present: false, x: 0, z: 0, headingRad: 0, speedMps: 0, accelerationMps2: 0, signals: 0 }, { t: .05, present: false, x: 0, z: 0, headingRad: 0, speedMps: 0, accelerationMps2: 0, signals: 0 }, { t: .1, present: false, x: 0, z: 0, headingRad: 0, speedMps: 0, accelerationMps2: 0, signals: 0 }] },
    ];
    expect(() => parseMaterializedTrafficArtifact(artifact)).toThrow();

    const canonical = materializedTrafficArtifactEnvelope(complete.artifact);
    const padded = new TextEncoder().encode(`${new TextDecoder().decode(canonical.bytes)}\n`);
    expect(() => decodeMaterializedTrafficArtifact(padded)).toThrow('canonical JSON');
  });
});
