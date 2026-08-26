import { describe, expect, it } from 'vitest';
import { TemplateDocument } from '@simforge-oss/scenario';
import { contentHash } from '@simforge-oss/engine';
import {
  ACCELERATED_SIGNAL_CYCLES_EXTENSION_KEY,
  AMBIENT_TRAFFIC_EXTENSION_KEY,
  AMBIENT_TRAFFIC_STORAGE_KEY,
  ambientTrafficProfileFromExtensions,
  canReuseVerifiedEvidenceForAmbient,
  defaultAmbientTrafficProfile,
  loadAmbientTrafficProfile,
  nextAmbientSeed,
  profileForPreset,
  saveAmbientTrafficProfile,
  ambientPromotionCapability,
  ambientSignalCycleSettingsFromExtensions,
} from './model';

describe('ambient traffic preference', () => {
  it('migrates missing and malformed signal-cycle settings to real map timing', () => {
    expect(ambientSignalCycleSettingsFromExtensions(undefined)).toEqual({ acceleratedSignalCycles: false });
    expect(ambientSignalCycleSettingsFromExtensions({ [ACCELERATED_SIGNAL_CYCLES_EXTENSION_KEY]: false }))
      .toEqual({ acceleratedSignalCycles: false });
    expect(ambientSignalCycleSettingsFromExtensions({ [ACCELERATED_SIGNAL_CYCLES_EXTENSION_KEY]: 'yes' }))
      .toEqual({ acceleratedSignalCycles: false });
    expect(ambientSignalCycleSettingsFromExtensions({ [ACCELERATED_SIGNAL_CYCLES_EXTENSION_KEY]: true }))
      .toEqual({ acceleratedSignalCycles: true });
  });
  it('uses a visible City population by default and recovers from corrupt session storage', () => {
    expect(defaultAmbientTrafficProfile()).toMatchObject({
      preset: 'city',
      densityVehiclesPerKm: 8,
      pedestrianShare: 0.06,
      cyclistShare: 0.02,
      maxActors: 32,
    });
    expect(loadAmbientTrafficProfile({ getItem: () => '{bad' })).toEqual(defaultAmbientTrafficProfile());
  });

  it('uses engine-owned preset defaults while retaining the seed', () => {
    const heavy = profileForPreset('heavy', { version: 1, preset: 'off', seed: 'same-seed' });
    expect(heavy.seed).toBe('same-seed');
    expect(heavy.densityVehiclesPerKm).toBe(16);
    expect(heavy.maxActors).toBe(40);
  });

  it('round trips independently from the authored scenario document', () => {
    let stored = '';
    const custom = {
      ...profileForPreset('custom'),
      densityVehiclesPerKm: 23,
      maxActors: 17,
      aggressiveness: 0.8,
      speedVariance: 0.3,
    };
    saveAmbientTrafficProfile(custom, {
      setItem: (key, value) => {
        expect(key).toBe(AMBIENT_TRAFFIC_STORAGE_KEY);
        stored = value;
      },
    });
    expect(loadAmbientTrafficProfile({ getItem: () => stored })).toEqual(custom);
  });

  it('round trips a custom profile through the scenario extension and fails malformed values closed', () => {
    const custom = {
      ...profileForPreset('custom'),
      seed: 'saved-seed',
      densityVehiclesPerKm: 21,
      maxActors: 14,
      cyclistShare: 0.12,
      pedestrianShare: 0.08,
    };
    expect(ambientTrafficProfileFromExtensions({ [AMBIENT_TRAFFIC_EXTENSION_KEY]: JSON.parse(JSON.stringify(custom)) })).toEqual(custom);
    expect(ambientTrafficProfileFromExtensions({ [AMBIENT_TRAFFIC_EXTENSION_KEY]: { preset: 'broken' } })).toEqual(defaultAmbientTrafficProfile());
    expect(ambientTrafficProfileFromExtensions(undefined)).toEqual(defaultAmbientTrafficProfile());
  });

  it('preserves a scenario-owned explicit Off choice', () => {
    const off = profileForPreset('off', defaultAmbientTrafficProfile());
    expect(ambientTrafficProfileFromExtensions({ [AMBIENT_TRAFFIC_EXTENSION_KEY]: off })).toEqual(off);
  });

  it('does not reuse canonical no-traffic evidence for an editable City copy', () => {
    const city = defaultAmbientTrafficProfile();
    expect(canReuseVerifiedEvidenceForAmbient(city, undefined)).toBe(false);
    expect(canReuseVerifiedEvidenceForAmbient(profileForPreset('off', city), undefined)).toBe(true);
    expect(canReuseVerifiedEvidenceForAmbient(city, {
      profileHash: contentHash(city),
    } as never)).toBe(true);
  });

  it('survives canonical scenario save and reopen byte-semantically', () => {
    const profile = { ...profileForPreset('light'), seed: 'persistent-seed' };
    const doc = TemplateDocument.create({
      name: 'Ambient persistence',
      sourceMap: { mapId: 'test-map', mapName: 'Test map' },
      anchor: { features: [], pin: { mapId: 'test-map' } },
      appVersion: 'test',
    });
    doc.setExtension(AMBIENT_TRAFFIC_EXTENSION_KEY, profile);
    const reopened = TemplateDocument.fromJSON(JSON.parse(doc.serialize()));
    expect(ambientTrafficProfileFromExtensions(reopened.data.extensions)).toEqual(profile);
    expect(reopened.serialize()).toBe(doc.serialize());
  });

  it('regenerates a readable deterministic seed', () => {
    expect(nextAmbientSeed('ambient-8', 0)).toBe('ambient-9');
    expect(nextAmbientSeed('my-run', 1234)).toBe('ambient-ya');
  });

  it('fails promotion closed while scene-absolute roles cannot preserve lane paths', () => {
    expect(ambientPromotionCapability(['12:0:-1', '13:0:-1'])).toEqual({
      safe: false,
      reason: expect.stringContaining('cannot yet preserve'),
    });
  });
});

