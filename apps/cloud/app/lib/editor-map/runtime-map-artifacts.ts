import "server-only";

import { S3_BUCKET } from "@/app/lib/s3/s3-config";
import { headS3ObjectInfo } from "@/app/lib/s3/s3-get-object";

export function normalizeRuntimeMapName(name: string | null | undefined): string {
  if (!name) return "";
  const normalized = name.replace(/\\/g, "/").split("/").pop() ?? name;
  return normalized.endsWith(".xodr") ? normalized.slice(0, -5) : normalized;
}

export function getRuntimeMapArtifactVersion(): string {
  return process.env.CARLA_MAP_BUNDLE_VERSION_UE5?.trim()
    || process.env.CARLA_MAP_BUNDLE_VERSION?.trim()
    || "unversioned";
}

const ENV_SUFFIXES = ["dev", "staging", "prod"] as const;

function deploymentEnvironment(): (typeof ENV_SUFFIXES)[number] | null {
  const configured = process.env.SIMFORGE_ENV?.trim().toLowerCase();
  if ((ENV_SUFFIXES as readonly string[]).includes(configured ?? "")) {
    return configured as (typeof ENV_SUFFIXES)[number];
  }
  if (process.env.VERCEL_ENV?.trim().toLowerCase() === "production") return "prod";
  return null;
}

export function getRuntimeMapArtifactBucket(): string {
  const bucket = process.env.MAP_RUNTIME_BUNDLE_BUCKET?.trim() || S3_BUCKET;
  if (process.env.MAP_BUNDLE_ENV_ENFORCE?.trim() === "1") {
    const environment = deploymentEnvironment();
    if (environment) {
      const mismatch = ENV_SUFFIXES.find(
        (suffix) => suffix !== environment && bucket.endsWith(`-${suffix}`),
      );
      if (mismatch) {
        throw new Error(
          `Runtime map artifact bucket "${bucket}" belongs to "${mismatch}" but this deployment is "${environment}". `
          + "Refusing cross-environment artifact access (MAP_BUNDLE_ENV_ENFORCE=1).",
        );
      }
    }
  }
  return bucket;
}

function safeMapSegment(mapName: string): string {
  return normalizeRuntimeMapName(mapName).replace(/[^A-Za-z0-9._-]/g, "_");
}

export function buildRuntimeMapArtifactManifestKey(
  mapName: string,
  version = getRuntimeMapArtifactVersion(),
): string {
  return `map-bundles/${version}/${safeMapSegment(mapName)}/manifest.json`;
}

export const RUNTIME_MAP_ARTIFACT_MANIFEST_CONTRACT =
  "simforge.map-bundle-manifest.v1" as const;

export type RuntimeMapArtifactManifestSection = {
  key: string;
  sha256: string;
  size_bytes_raw: number;
  size_bytes_stored: number;
  encoding: "json" | "text";
};

export type RuntimeMapArtifactManifest = {
  contract: typeof RUNTIME_MAP_ARTIFACT_MANIFEST_CONTRACT;
  bundle_version: string;
  map_name: string;
  normalized_map_name: string;
  created_at: string;
  base: {
    schema_version: number;
    source: {
      authority: "maintenance_materializer";
      map_asset_id?: string | null;
      carla_version?: string | null;
      image?: string | null;
      image_digest?: string | null;
      actor_catalog_version?: string | null;
      actor_catalog_hash?: string | null;
    };
  };
  sections: Record<string, RuntimeMapArtifactManifestSection>;
};

/** Manifest-only readiness. Monolithic bundle.json objects are intentionally ignored. */
export async function headRuntimeMapArtifactManifest(
  mapName: string,
  version = getRuntimeMapArtifactVersion(),
): Promise<{ exists: boolean; complete: boolean; source: "manifest" | "none" }> {
  const info = await headS3ObjectInfo(
    getRuntimeMapArtifactBucket(),
    buildRuntimeMapArtifactManifestKey(mapName, version),
  );
  return info.exists
    ? { exists: true, complete: (info.sizeBytes ?? 0) > 0, source: "manifest" }
    : { exists: false, complete: false, source: "none" };
}
