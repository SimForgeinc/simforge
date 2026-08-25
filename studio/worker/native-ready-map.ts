import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type PublishedMapPayload = {
  relativePath: string;
  sha256: string;
};

export type NativeReadyPayload = {
  relativePath: string;
  path: string;
  sourceSha256: string;
  sha256: string;
};

export type NativeReadyMap = {
  mapDigest: string;
  corpusDir: string;
  payloads: NativeReadyPayload[];
};

/** A failure with a stable API/worker error code. */
export class HifiPreviewFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

type CorpusEntry = {
  path: string;
  sha256: string;
  srcSha256: string;
  kind: "glb" | "sidecar" | "scene";
};

type CorpusManifest = {
  schema: "sensor-corpus.v1";
  mapId: string;
  files: CorpusEntry[];
};

function isCorpusManifest(value: unknown): value is CorpusManifest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CorpusManifest>;
  return candidate.schema === "sensor-corpus.v1"
    && typeof candidate.mapId === "string"
    && Array.isArray(candidate.files)
    && candidate.files.every((entry) =>
      entry && typeof entry.path === "string" && typeof entry.sha256 === "string"
      && typeof entry.srcSha256 === "string" && typeof entry.kind === "string");
}

/**
 * Native preview loads one consistent static LOD: the road plus every
 * `tile_*.lod0.glb`. Vegetation corpus GLBs are instance templates without a
 * default scene and cannot be loaded as standalone Bevy scene tiles.
 */
function isRenderGlb(entry: CorpusEntry): boolean {
  return entry.kind === "glb"
    && (entry.path === "tiles/road.glb"
      || /^tiles\/tile_.+\.lod0\.glb$/.test(entry.path));
}

async function inspectCorpus(
  corpusDir: string,
  mapId: string,
  mapDigest: string,
  publishedByPath: ReadonlyMap<string, PublishedMapPayload>,
): Promise<NativeReadyMap | null> {
  const manifestPath = join(corpusDir, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return null;
  }
  if (!isCorpusManifest(parsed) || parsed.mapId !== mapId) return null;

  const entries = parsed.files.filter(isRenderGlb);
  if (entries.length === 0) return null;
  const payloads: NativeReadyPayload[] = [];
  for (const entry of entries) {
    const publishedPath = `3d/${entry.path}`;
    const published = publishedByPath.get(publishedPath);
    const outputPath = join(corpusDir, entry.path);
    if (!published || published.sha256 !== entry.srcSha256 || !existsSync(outputPath)) return null;
    payloads.push({
      relativePath: entry.path,
      path: outputPath,
      sourceSha256: entry.srcSha256,
      sha256: entry.sha256,
    });
  }
  return { mapDigest, corpusDir, payloads };
}

export async function resolveNativeReadyMap(input: {
  mapId: string;
  mapDigest: string;
  published: readonly PublishedMapPayload[];
  roots: readonly string[];
  allowBuild: boolean;
  build?: () => Promise<string>;
}): Promise<NativeReadyMap> {
  const publishedByPath = new Map(input.published.map((payload) => [payload.relativePath, payload]));
  const candidates = input.roots.flatMap((root) => [
    join(root, input.mapId, input.mapDigest),
    join(root, input.mapId),
  ]);
  for (const candidate of [...new Set(candidates)]) {
    const resolved = await inspectCorpus(candidate, input.mapId, input.mapDigest, publishedByPath);
    if (resolved) return resolved;
  }

  if (!input.allowBuild) {
    throw new HifiPreviewFailure(
      "native_payload_unavailable",
      `no native-ready corpus matches published map ${input.mapId}`,
      { mapId: input.mapId, mapDigest: input.mapDigest, buildPermitted: false },
    );
  }
  if (!input.build) {
    throw new HifiPreviewFailure(
      "native_payload_build_unavailable",
      `native corpus build is permitted but unavailable for map ${input.mapId}`,
      { mapId: input.mapId, mapDigest: input.mapDigest, buildPermitted: true },
    );
  }

  const builtDir = await input.build();
  const resolved = await inspectCorpus(builtDir, input.mapId, input.mapDigest, publishedByPath);
  if (!resolved) {
    throw new HifiPreviewFailure(
      "native_payload_build_invalid",
      `native corpus build did not match published map ${input.mapId}`,
      { mapId: input.mapId, mapDigest: input.mapDigest, corpusDir: builtDir },
    );
  }
  return resolved;
}
