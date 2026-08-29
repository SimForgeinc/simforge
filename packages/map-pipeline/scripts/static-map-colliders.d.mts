export const STATIC_COLLIDER_SCHEMA: 'simforge-oss.static-map-colliders/v1';

export type StaticCollider = {
  id: string;
  class: 'building' | 'wall' | 'barrier' | 'prop' | 'road-boundary';
  obb: {
    center: { x: number; z: number };
    lengthM: number;
    widthM: number;
    headingRad: number;
  };
};

export type StaticColliderArtifact = {
  schema: typeof STATIC_COLLIDER_SCHEMA;
  mapId: string;
  sourceManifestSha256: string;
  sources: Array<{ id: string; file: string; declaredBytes: number | null }>;
  colliders: StaticCollider[];
  statistics: {
    sourceTiles: number;
    accepted: number;
    rejectedRoadOverlap: number;
    ignored: number;
    classes: Record<StaticCollider['class'], number>;
  };
  digest: string;
};

export function extractGlbColliders(buffer: Buffer, tileId: string): { colliders: StaticCollider[]; ignored: number };
export function buildStaticColliderArtifact(input: {
  mapId: string;
  sourceManifestSha256: string;
  manifest: Record<string, any>;
  topology: Record<string, any>;
  readSource(file: string): Buffer;
}): StaticColliderArtifact;
export function serializeStaticColliderArtifact(artifact: StaticColliderArtifact): string;
