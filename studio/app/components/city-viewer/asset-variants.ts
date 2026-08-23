/**
 * Minimal reader for the pipeline's `variants/manifest.json`
 * (`scripts/build-editor-map-derivatives.mjs`). The city-viewer consumes two
 * products:
 *
 *  - `variants.ktx2.files`  — per-source-GLB Basis-UASTC variants (smaller
 *    transfer, GPU-native compressed textures). Keyed by the authored file
 *    path; a record is present only when the variant passed the pipeline's
 *    structural + byte-size gates, so absence means "use the authored GLB".
 *  - `variants['vegetation-instances']` — the merged per-tile instance
 *    sidecar that replaces one JSON request per vegetation tile.
 *
 * The full manifest carries more products (roads-only, snow cover, static
 * colliders) consumed by other stacks; everything unknown is ignored.
 */

export interface Ktx2VariantRecord {
  file: string;
  bytes?: number;
}

export interface CityAssetVariants {
  ktx2Files: Map<string, Ktx2VariantRecord>;
  ktx2TranscoderPath: string | null;
  ktx2RuntimeAssets: string[];
  vegetationInstancesFile: string | null;
}

/** Parse leniently — any malformed section degrades to "no variant". */
export function parseCityAssetVariants(raw: unknown): CityAssetVariants | null {
  if (!raw || typeof raw !== 'object') return null;
  const doc = raw as {
    schemaVersion?: unknown;
    variants?: Record<string, unknown>;
  };
  if (doc.schemaVersion !== 1 || !doc.variants || typeof doc.variants !== 'object') {
    return null;
  }

  const ktx2Files = new Map<string, Ktx2VariantRecord>();
  let ktx2TranscoderPath: string | null = null;
  let ktx2RuntimeAssets: string[] = [];
  const ktx2 = doc.variants['ktx2'] as
    | {
        files?: Record<string, { file?: unknown; bytes?: unknown } | null>;
        runtime?: { ktx2TranscoderPath?: unknown; assets?: Array<{ file?: unknown }> };
      }
    | undefined;
  if (ktx2 && typeof ktx2 === 'object') {
    for (const [source, record] of Object.entries(ktx2.files ?? {})) {
      if (record && typeof record.file === 'string' && record.file.length > 0) {
        ktx2Files.set(source, {
          file: record.file,
          bytes: typeof record.bytes === 'number' ? record.bytes : undefined,
        });
      }
    }
    if (typeof ktx2.runtime?.ktx2TranscoderPath === 'string' && ktx2Files.size > 0) {
      ktx2TranscoderPath = ktx2.runtime.ktx2TranscoderPath;
      ktx2RuntimeAssets = (ktx2.runtime.assets ?? [])
        .map((asset) => (typeof asset?.file === 'string' ? asset.file : null))
        .filter((file): file is string => file !== null);
    }
  }

  let vegetationInstancesFile: string | null = null;
  const vegetation = doc.variants['vegetation-instances'] as
    | { file?: unknown }
    | undefined;
  if (vegetation && typeof vegetation.file === 'string' && vegetation.file.length > 0) {
    vegetationInstancesFile = vegetation.file;
  }

  if (ktx2Files.size === 0 && !vegetationInstancesFile) return null;
  return { ktx2Files, ktx2TranscoderPath, ktx2RuntimeAssets, vegetationInstancesFile };
}

/** Shape of the merged vegetation-instance sidecar file. */
export interface MergedVegetationInstances {
  schemaVersion: number;
  tiles: Record<string, unknown>;
}

export function parseMergedVegetationInstances(
  raw: unknown,
): Record<string, never> | null {
  if (!raw || typeof raw !== 'object') return null;
  const doc = raw as MergedVegetationInstances;
  if (doc.schemaVersion !== 1 || !doc.tiles || typeof doc.tiles !== 'object') {
    return null;
  }
  return doc.tiles as Record<string, never>;
}
