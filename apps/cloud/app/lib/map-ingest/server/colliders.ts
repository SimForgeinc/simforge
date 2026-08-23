/**
 * Static collision derivative for an uploaded map.
 *
 * The browser simulation fails closed without it: `loadStaticMapColliders`
 * (`@uniscenarios/playback`) fetches `variants/manifest.json` beside the city
 * manifest, checks that its `sourceManifestSha256` matches the manifest bytes it
 * just read, then fetches and digest-verifies the artifact the
 * `static-colliders` variant names. Any missing link surfaces in the editor as
 * "Browser simulation could not be prepared".
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  buildStaticColliderArtifact,
  serializeStaticColliderArtifact,
} from "@simcloud/shared/map-ingest/static-colliders.mjs";

import type { MapTopologyIndex } from "@simcloud/shared/map-topology/types";
import type { CityManifestDocument } from "./city-manifest";

export type ColliderSourceLayer = {
  layerId: string;
  fileName: string;
  bytes: Buffer;
};

export type MapColliderDerivative = {
  artifact: { relativePath: string; bytes: Buffer };
  variantManifest: { relativePath: string; bytes: Buffer };
  acceptedColliders: number;
};

export function buildMapColliderDerivative({
  mapId,
  manifest,
  manifestBytes,
  topologyIndex,
  layers,
}: {
  mapId: string;
  manifest: CityManifestDocument;
  manifestBytes: Buffer;
  topologyIndex: MapTopologyIndex;
  layers: ColliderSourceLayer[];
}): MapColliderDerivative {
  const sourceManifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");

  // Every authored layer is a collider source now that the builder scans static
  // layers as well as tiles, so the real manifest goes through untouched.
  const bytesByFile = new Map(layers.map((layer) => [layer.fileName, layer.bytes]));

  const artifact = buildStaticColliderArtifact({
    mapId,
    sourceManifestSha256,
    manifest,
    topology: topologyIndex,
    readSource: (file: string) => {
      const bytes = bytesByFile.get(file);
      if (!bytes) throw new Error(`collider source ${file} is not an uploaded layer`);
      return bytes;
    },
  });

  const artifactBytes = Buffer.from(serializeStaticColliderArtifact(artifact));
  const outputSha256 = createHash("sha256").update(artifactBytes).digest("hex");
  // Named by its own digest, so republishing identical geometry reuses the object
  // and the variant manifest never points at bytes that changed underneath it.
  const artifactRelativePath = `3d/variants/static-colliders/${outputSha256}.json`;

  const variantManifest = {
    schemaVersion: 1,
    generator: "simforge-map-upload",
    sourceManifestSha256,
    variants: {
      "static-colliders": {
        schemaVersion: 1,
        // Resolved relative to `variants/`, which is where the reader resolves
        // it from — not relative to the map root.
        file: `static-colliders/${outputSha256}.json`,
        outputSha256,
        digest: artifact.digest,
      },
    },
  };

  return {
    artifact: { relativePath: artifactRelativePath, bytes: artifactBytes },
    variantManifest: {
      relativePath: "3d/variants/manifest.json",
      bytes: Buffer.from(`${JSON.stringify(variantManifest)}\n`),
    },
    acceptedColliders: artifact.statistics.accepted,
  };
}
