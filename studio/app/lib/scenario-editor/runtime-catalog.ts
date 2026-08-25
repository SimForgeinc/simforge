import "server-only";

import {
  CarlaActorCatalogSchema,
  CarlaRuntimeCatalogSchema,
  DEFAULT_CARLA_ACTOR_CATALOG,
  type CarlaActorCatalog,
  type CarlaRuntimeCatalog,
} from "@simforge/studio-shared";
import { getRuntimeMapArtifactBucket } from "@/app/lib/editor-map/runtime-map-artifacts";
import { getS3ObjectUtf8 } from "@/app/lib/s3/s3-get-object";

const runtimeCatalogReads = new Map<
  string,
  Promise<CarlaRuntimeCatalog | null>
>();
const actorCatalogReads = new Map<string, Promise<CarlaActorCatalog>>();

function cachedRead<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  read: () => Promise<T>,
): Promise<T> {
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = read().catch((error) => {
    // Do not poison a long-lived web process after a transient S3 failure.
    if (cache.get(key) === pending) cache.delete(key);
    throw error;
  });
  cache.set(key, pending);
  return pending;
}

export function resetRuntimeCatalogCachesForTests(): void {
  runtimeCatalogReads.clear();
  actorCatalogReads.clear();
}

function s3MissingObject(error: unknown): boolean {
  const candidate = error as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate?.name === "NoSuchKey" ||
    candidate?.Code === "NoSuchKey" ||
    candidate?.$metadata?.httpStatusCode === 404
  );
}

export function getRuntimeCatalogVersion(runtime?: string | null): string {
  // UE5 resolves from its own env var and intentionally yields "" when unset:
  // the S3 readers then skip the read and fall back (same fail-open semantics
  // as UE5 actor submit-validation until CARLA_RUNTIME_CATALOG_VERSION_UE5 is
  // projected into the environment).
  if (runtime === "carla_ue5") {
    return process.env.CARLA_RUNTIME_CATALOG_VERSION_UE5?.trim() || "";
  }
  return process.env.CARLA_RUNTIME_CATALOG_VERSION?.trim() || "local-default";
}

export function runtimeCatalogKey(version = getRuntimeCatalogVersion()) {
  return `runtime-catalogs/${version}/catalog.json`;
}

export function actorCatalogKey(version = getRuntimeCatalogVersion()) {
  return `runtime-catalogs/${version}/actor-catalog.json`;
}

export async function readCarlaRuntimeCatalogFromS3(
  version = getRuntimeCatalogVersion(),
): Promise<CarlaRuntimeCatalog | null> {
  if (!version) return null;
  const bucket = getRuntimeMapArtifactBucket();
  return cachedRead(runtimeCatalogReads, `${bucket}\0${version}`, async () => {
    try {
      const raw = await getS3ObjectUtf8(bucket, runtimeCatalogKey(version));
      return CarlaRuntimeCatalogSchema.parse(JSON.parse(raw));
    } catch (error) {
      if (s3MissingObject(error)) return null;
      throw error;
    }
  });
}

export async function readCarlaActorCatalogFromS3(
  version = getRuntimeCatalogVersion(),
): Promise<CarlaActorCatalog> {
  if (!version) return DEFAULT_CARLA_ACTOR_CATALOG;
  const bucket = getRuntimeMapArtifactBucket();
  return cachedRead(actorCatalogReads, `${bucket}\0${version}`, async () => {
    try {
      const raw = await getS3ObjectUtf8(bucket, actorCatalogKey(version));
      return CarlaActorCatalogSchema.parse(JSON.parse(raw));
    } catch (error) {
      if (s3MissingObject(error)) return DEFAULT_CARLA_ACTOR_CATALOG;
      throw error;
    }
  });
}
