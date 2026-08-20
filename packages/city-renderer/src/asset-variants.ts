export type CityAssetVariantPreference = 'auto' | 'original' | 'ktx2' | 'geometry-only' | 'roads-only';
export type CityAssetVariantId = Exclude<CityAssetVariantPreference, 'auto' | 'original'>;

export interface CityAssetVariantFile {
  file: string;
  /** Previous known-good derivative; never a textured source asset. */
  fallbackFile?: string;
  sourceSha256: string;
  outputSha256: string;
  bytes: number;
}

export interface CityAssetVariant {
  id: CityAssetVariantId;
  generatedAt: string;
  generator: { name: string; version: string; command: string };
  files: Record<string, CityAssetVariantFile>;
  runtime?: { ktx2TranscoderPath?: string; assets?: Array<{ file: string; sha256: string }> };
  /** Optional replacement for a monolithic static layer, only emitted after continuity validation. */
  staticLayers?: Array<{ id: string; files: string[]; bounds: { min: number[]; max: number[] }[] }>;
}

export interface CitySnowCoverVariantFile {
  file: string;
  sourceSha256: string;
  outputSha256: string;
  bytes: number;
  sourcePrimitives?: number;
  keptPrimitives?: number;
  excludedPrimitives?: number;
  sourceTriangles?: number;
  keptTriangles?: number;
  rejectedNonUpwardTriangles?: number;
  receiverKinds?: Record<string, { primitives: number; triangles: number }>;
  baseShellOffsetM?: number;
  elevationMode?: 'runtime-world-y';
  retainedAttributes?: string[];
}

/**
 * Optional, render-only snow receiver geometry. Unlike the selectable asset
 * variants above, this is composited with the authored asset rather than used
 * in its place.
 */
export interface CitySnowCoverVariant {
  id: 'snow-cover-v1';
  generatedAt: string;
  generator: { name: string; version: string; command: string };
  elevation: {
    mode: 'runtime-world-y';
    baseShellOffsetM: number;
    axis: [number, number, number];
    seamPolicy?: string;
  };
  files: Record<string, CitySnowCoverVariantFile>;
}

export interface CityAssetVariantManifest {
  schemaVersion: 1;
  sourceManifestSha256: string;
  variants: Partial<Record<CityAssetVariantId, CityAssetVariant>> & {
    snowCover?: CitySnowCoverVariant;
  };
}

export interface ResolvedSnowCoverVariant {
  file: string;
  bytes: number;
  /** Conservative decoded closed-shell estimate used before fetch/parse. */
  estimatedBytes?: number;
  baseShellOffsetM: number;
}

const MAX_SNOW_BASE_SHELL_OFFSET_M = 0.25;

/** Resolve only a validated, asset-root-relative snow derivative. */
export function resolveSnowCoverVariant(
  manifest: CityAssetVariantManifest | null,
  sourceFile: string,
): ResolvedSnowCoverVariant | null {
  const variantValue: unknown = manifest?.variants?.snowCover;
  if (!variantValue || typeof variantValue !== 'object') return null;
  const variant = variantValue as Partial<CitySnowCoverVariant>;
  const elevationValue: unknown = variant.elevation;
  if (variant.id !== 'snow-cover-v1' || !elevationValue || typeof elevationValue !== 'object') return null;
  const elevation = elevationValue as Partial<CitySnowCoverVariant['elevation']>;
  if (elevation.mode !== 'runtime-world-y' || !Array.isArray(elevation.axis) || elevation.axis.length !== 3) return null;
  const axis = elevation.axis;
  if (axis[0] !== 0 || axis[1] !== 1 || axis[2] !== 0) return null;
  if (!variant.files || typeof variant.files !== 'object') return null;
  const candidateValue: unknown = variant.files[sourceFile];
  if (!candidateValue || typeof candidateValue !== 'object') return null;
  const candidate = candidateValue as Partial<CitySnowCoverVariantFile>;
  if (!candidate || typeof candidate.file !== 'string' || !candidate.file
    || typeof candidate.bytes !== 'number' || !Number.isFinite(candidate.bytes) || candidate.bytes <= 0) return null;
  if (candidate.elevationMode !== undefined && candidate.elevationMode !== 'runtime-world-y') return null;
  const unsafePath = /^(?:[a-z]+:|\/)/i.test(candidate.file) || /(?:^|\/)\.\.(?:\/|$)/.test(candidate.file);
  if (unsafePath) return null;
  const baseShellOffsetM = candidate.baseShellOffsetM !== undefined && Number.isFinite(candidate.baseShellOffsetM)
    ? candidate.baseShellOffsetM
    : elevation.baseShellOffsetM;
  if (!Number.isFinite(baseShellOffsetM)
    || (baseShellOffsetM as number) < 0 || (baseShellOffsetM as number) > MAX_SNOW_BASE_SHELL_OFFSET_M) return null;
  const rawKeptTriangles = candidate.keptTriangles;
  const keptTriangles = Number.isFinite(rawKeptTriangles)
    ? Math.max(0, rawKeptTriangles as number)
    : 0;
  const decodedEstimate = keptTriangles * 128;
  if (!Number.isFinite(decodedEstimate)) return null;
  return {
    file: candidate.file,
    bytes: candidate.bytes as number,
    estimatedBytes: Math.max(
      candidate.bytes as number,
      decodedEstimate,
    ),
    baseShellOffsetM: baseShellOffsetM as number,
  };
}

export function allowsSourceAssetFallback(selected: CityAssetVariantId | 'original', ultraLow: boolean): boolean {
  return selected !== 'original' && !ultraLow;
}

export function isCityAssetVariantManifest(value: unknown): value is CityAssetVariantManifest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CityAssetVariantManifest>;
  return candidate.schemaVersion === 1
    && typeof candidate.sourceManifestSha256 === 'string'
    && Boolean(candidate.variants && typeof candidate.variants === 'object');
}

export function selectAssetVariant(
  manifest: CityAssetVariantManifest | null,
  sourceFile: string,
  preference: CityAssetVariantPreference,
  options: { ultraLow: boolean; roadsOnly?: boolean; ktx2Ready: boolean },
): { variant: CityAssetVariantId | 'original'; file: string; fallbackFile?: string; sha256?: string } {
  if (!manifest || preference === 'original') return { variant: 'original', file: sourceFile };
  const requested: CityAssetVariantId | null = preference === 'auto'
    ? (options.roadsOnly ? 'roads-only' : options.ultraLow ? 'geometry-only' : options.ktx2Ready ? 'ktx2' : null)
    : preference;
  if (!requested || (requested === 'ktx2' && !options.ktx2Ready)) {
    return { variant: 'original', file: sourceFile };
  }
  const candidate = manifest.variants[requested]?.files[sourceFile];
  const unsafePath = (file: string): boolean => /^(?:[a-z]+:|\/)/i.test(file) || /(?:^|\/)\.\.(?:\/|$)/.test(file);
  const unsafe = candidate && unsafePath(candidate.file);
  const fallbackFile = candidate?.fallbackFile && !unsafePath(candidate.fallbackFile) ? candidate.fallbackFile : undefined;
  return candidate && !unsafe
    ? { variant: requested, file: candidate.file, fallbackFile, sha256: candidate.outputSha256 }
    : { variant: 'original', file: sourceFile };
}
