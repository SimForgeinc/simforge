import { describe, expect, it } from 'vitest';
import { allowsSourceAssetFallback, isCityAssetVariantManifest, selectAssetVariant, type CityAssetVariantManifest } from './asset-variants';

const manifest: CityAssetVariantManifest = {
  schemaVersion: 1,
  sourceManifestSha256: 'abc',
  variants: {
    'geometry-only': {
      id: 'geometry-only', generatedAt: '2026-01-01T00:00:00Z',
      generator: { name: 'test', version: '1', command: 'test' },
      files: { 'tiles/road.glb': { file: 'variants/geometry-only/road.glb', sourceSha256: 'a', outputSha256: 'b', bytes: 12 } },
    },
    'roads-only': {
      id: 'roads-only', generatedAt: '2026-01-01T00:00:00Z',
      generator: { name: 'test', version: '1', command: 'test' },
      files: { 'tiles/road.glb': { file: 'variants/roads-only-v2/road.glb', fallbackFile: 'variants/roads-only-v1/road.glb', sourceSha256: 'a', outputSha256: 'r', bytes: 6 } },
    },
    ktx2: {
      id: 'ktx2', generatedAt: '2026-01-01T00:00:00Z',
      generator: { name: 'test', version: '1', command: 'test' },
      files: { 'tiles/road.glb': { file: 'variants/ktx2/road.glb', sourceSha256: 'a', outputSha256: 'c', bytes: 9 } },
    },
  },
};

describe('city asset variants', () => {
  it('selects geometry-only for Ultra Low and otherwise fails back to originals', () => {
    expect(selectAssetVariant(manifest, 'tiles/road.glb', 'auto', { ultraLow: true, ktx2Ready: false }).variant).toBe('geometry-only');
    expect(selectAssetVariant(manifest, 'tiles/missing.glb', 'auto', { ultraLow: true, ktx2Ready: false })).toEqual({ variant: 'original', file: 'tiles/missing.glb' });
    expect(selectAssetVariant(null, 'tiles/road.glb', 'geometry-only', { ultraLow: true, ktx2Ready: false }).variant).toBe('original');
  });

  it('selects the dedicated fail-closed derivative for Roads Only', () => {
    expect(selectAssetVariant(manifest, 'tiles/road.glb', 'auto', { ultraLow: true, roadsOnly: true, ktx2Ready: false })).toEqual({
      variant: 'roads-only',
      file: 'variants/roads-only-v2/road.glb',
      fallbackFile: 'variants/roads-only-v1/road.glb',
      sha256: 'r',
    });
    expect(selectAssetVariant(manifest, 'tiles/missing.glb', 'auto', { ultraLow: true, roadsOnly: true, ktx2Ready: false }).variant).toBe('original');
    expect(allowsSourceAssetFallback('roads-only', true)).toBe(false);
  });

  it('never selects KTX2 without an initialized transcoder', () => {
    expect(selectAssetVariant(manifest, 'tiles/road.glb', 'ktx2', { ultraLow: false, ktx2Ready: false }).variant).toBe('original');
    expect(selectAssetVariant(manifest, 'tiles/road.glb', 'auto', { ultraLow: false, ktx2Ready: true }).variant).toBe('ktx2');
  });

  it('fails closed instead of fetching textured source in Ultra Low', () => {
    expect(allowsSourceAssetFallback('geometry-only', true)).toBe(false);
    expect(allowsSourceAssetFallback('geometry-only', false)).toBe(true);
    expect(allowsSourceAssetFallback('original', false)).toBe(false);
  });

  it('rejects derivative paths that escape the map asset root', () => {
    const unsafe = structuredClone(manifest);
    unsafe.variants['geometry-only']!.files['tiles/road.glb']!.file = '../source/road.glb';
    expect(selectAssetVariant(unsafe, 'tiles/road.glb', 'geometry-only', { ultraLow: true, ktx2Ready: false }).variant).toBe('original');
    const unsafeFallback = structuredClone(manifest);
    unsafeFallback.variants['roads-only']!.files['tiles/road.glb']!.fallbackFile = 'https://example.invalid/road.glb';
    expect(selectAssetVariant(unsafeFallback, 'tiles/road.glb', 'auto', { ultraLow: true, roadsOnly: true, ktx2Ready: false })).toEqual({
      variant: 'roads-only',
      file: 'variants/roads-only-v2/road.glb',
      fallbackFile: undefined,
      sha256: 'r',
    });
  });

  it('validates the versioned manifest envelope', () => {
    expect(isCityAssetVariantManifest(manifest)).toBe(true);
    expect(isCityAssetVariantManifest({ schemaVersion: 2, variants: {} })).toBe(false);
  });
});
