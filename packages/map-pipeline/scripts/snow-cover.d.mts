export const SNOW_COVER_VARIANT_ID: 'snow-cover-v1';

export type SnowCoverReport = {
  sourcePrimitives: number;
  keptPrimitives: number;
  excludedPrimitives: number;
  sourceTriangles: number;
  keptTriangles: number;
  rejectedNonUpwardTriangles: number;
  receiverKinds: Record<'road' | 'terrain' | 'sidewalk' | 'curb', { primitives: number; triangles: number }>;
  baseShellOffsetM: number;
  elevationMode: 'runtime-world-y';
  retainedAttributes: ['POSITION'];
};

export function validateSnowCoverMemoryMiB(value?: number | string): number;
export function makeSnowCoverGlb(
  sourceBuffer: Buffer,
  options?: { baseShellOffsetM?: number; minimumUpwardNormalY?: number; maxMemoryMiB?: number },
): Promise<{ output: Buffer | null; report: SnowCoverReport }>;
