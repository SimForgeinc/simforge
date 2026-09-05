import type { Buffer } from "node:buffer";

export const STATIC_COLLIDER_SCHEMA: "simforge.static-map-colliders/v1";

export type StaticColliderClass =
  | "building"
  | "wall"
  | "barrier"
  | "prop"
  | "road-boundary";

export interface StaticColliderObb {
  center: { x: number; z: number };
  lengthM: number;
  widthM: number;
  headingRad: number;
}

export interface StaticCollider {
  id: string;
  class: StaticColliderClass;
  obb: StaticColliderObb;
}

export interface StaticColliderArtifact {
  schema: typeof STATIC_COLLIDER_SCHEMA;
  mapId: string;
  sourceManifestSha256: string;
  sources: Array<{
    id: string;
    file: string;
    declaredBytes: number | null;
  }>;
  colliders: StaticCollider[];
  statistics: {
    sourceTiles: number;
    accepted: number;
    rejectedRoadOverlap: number;
    ignored: number;
    classes: Record<StaticColliderClass, number>;
  };
  digest: string;
}

export function extractGlbColliders(
  buffer: Buffer,
  tileId: string,
): { colliders: StaticCollider[]; ignored: number };

export function buildStaticColliderArtifact(input: {
  mapId: string;
  sourceManifestSha256: string;
  manifest: {
    tiles: Array<{
      id?: string;
      lods?: Array<{ level: number; file: string; fileSize?: number }>;
    }>;
    staticLayers?: Array<{ id?: string; file: string; fileSize?: number }>;
  };
  topology: {
    lanes?: Record<string, {
      laneType?: string;
      representativeWidthM?: number | null;
      polyline?: Array<[number, number] | { x: number; y: number }>;
    }>;
  };
} & (
  | { readSource(file: string): Buffer; canonicalGltf?: never }
  | { canonicalGltf: { file: string; bytes: Buffer }; readSource?: never }
)): StaticColliderArtifact;

export function serializeStaticColliderArtifact(
  artifact: StaticColliderArtifact,
): string;
