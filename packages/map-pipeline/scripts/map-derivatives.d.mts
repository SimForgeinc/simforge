import type { BinaryLike } from 'node:crypto';

export type GlbJson = Record<string, any>;
export type Rgba = [number, number, number, number];

export function sha256(data: BinaryLike): string;
export function readGlb(buffer: Buffer): { json: GlbJson; bin: Buffer };
export function writeGlb(json: GlbJson, bin: Uint8Array): Buffer;
export function geometryIdentity(json: GlbJson): string;
export function semanticFallbackColor(name?: string): Rgba;
export function representativeImageColor(
  bytes: Uint8Array,
  cache?: Map<string, Rgba>,
  options?: { alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND'; alphaCutoff?: number },
): Promise<Rgba>;
export function makeGeometryOnlyGlb(
  sourceBuffer: Buffer,
  options?: { representativeColorCache?: Map<string, Rgba> },
): Promise<{ output: Buffer; report: { sourceBytes: number; outputBytes: number; removedBytes: number; geometryIdentity: string } }>;
export function subsetSceneRoots(sourceBuffer: Buffer, selectedNodeIndices: Iterable<number>): Buffer;
export function subsetSceneNodes(sourceBuffer: Buffer, selectedNodeIndices: Iterable<number>): Buffer;
export function makeMarkingFirstRoadsOnlyGlb(sourceBuffer: Buffer): {
  output: Buffer;
  report: {
    sourceMarkingPrimitives: number;
    keptMarkingPrimitives: number;
    keptSupportPrimitives: number;
    droppedPrimitives: number;
    markingInventory: Record<string, number>;
    supportInventory: Record<string, number>;
    signalRepresentation: string;
    retainedAttributes: string[];
  };
};
export function classifyRoadsOnlySceneRoots(sourceBuffer: Buffer): {
  selectedNodeIndices: number[];
  kept: Array<{ node: number; name: string; mesh: string; reason: string }>;
  dropped: Array<{ node: number; name: string; mesh: string; reason: string }>;
};
export function analyzeRoadTiling(
  sourceBuffer: Buffer,
  options?: { origin?: [number, number, number]; cellSize?: [number, number] },
): {
  safe: boolean;
  assignments: Record<string, number[]>;
  unsafe: Array<{ node: number; name?: string; reason: string }>;
  cellCount: number;
};
export function collectManifestGlbs(manifest: GlbJson): string[];
export function atomicWrite(file: string, contents: string | Uint8Array): void;
