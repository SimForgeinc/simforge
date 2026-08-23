import "server-only";

import { createHash } from "node:crypto";

import {
  getRuntimeMapArtifactBucket,
  getRuntimeMapArtifactVersion,
} from "@/app/lib/editor-map/runtime-map-artifacts";
import {
  readRuntimeTopologyBundleInput,
  readRuntimeTopologyBundleManifest,
} from "@/app/lib/editor-map/runtime-topology-bundle";
import { getS3ObjectUtf8 } from "@/app/lib/s3/s3-get-object";
import { joinCookedSignalHousings } from "./cooked-signal-housings";
import {
  parseXodrSignalGeometry,
  projectEditorTrafficLights,
  type EditorTrafficLight,
} from "./editor-traffic-lights";

/**
 * Server-side read of a map's signal heads, cached per bundle.
 *
 * ## Why the cache is not optional
 *
 * There is no way to read the heads without reading the WHOLE runtime bundle:
 * `readRuntimeTopologyBundleInput` pulls the manifest, the XODR, the runtime
 * meta (which is where `traffic_lights` lives — 113 KB–1.87 MB of it) and the
 * road-segment section, then checksum-verifies each one. Measured cold against
 * San Ramon P1 that is tens of seconds, and it is the same work every time
 * because the answer cannot change without a new bundle.
 *
 * The sibling signal-junctions route never had this problem because it reads
 * through `getMapTopologyIndex`, which has its own cache. This is that cache,
 * for this route, holding the 2–33 KB projection rather than the megabytes it
 * came from.
 *
 * `bundleVersion` is part of the key, so a rebuilt bundle can never be served a
 * stale head — the worst case is a cold read, never a wrong one.
 */

const MAX_CACHED_MAPS = 8;

const cache = new Map<string, EditorTrafficLight[]>();
/** In-flight reads, so N concurrent first-loads do ONE bundle read, not N. */
const pending = new Map<string, Promise<EditorTrafficLight[]>>();

function normalizedMapSegment(value: string): string {
  const tail = value.replace(/\\/g, "/").split("/").pop() ?? value;
  const mapName = tail.endsWith(".xodr") ? tail.slice(0, -5) : tail;
  return mapName.replace(/[^A-Za-z0-9._-]/g, "_");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function readEnvironmentObjects(
  runtimeMapName: string,
  bundleVersion: string,
): Promise<readonly unknown[]> {
  const manifest = await readRuntimeTopologyBundleManifest(
    runtimeMapName,
    bundleVersion,
  );
  const section = manifest.sections.environment_objects;
  if (!section) {
    throw new Error("bundle manifest has no environment_objects section");
  }
  const prefix =
    `map-bundles/${bundleVersion}/${normalizedMapSegment(runtimeMapName)}/`;
  if (!section.key.startsWith(prefix) || section.key.includes("..")) {
    throw new Error("environment_objects section key is outside the bundle prefix");
  }

  const raw = await getS3ObjectUtf8(getRuntimeMapArtifactBucket(), section.key);
  const actualSize = Buffer.byteLength(raw, "utf8");
  if (actualSize !== section.size_bytes_raw) {
    throw new Error(
      `environment_objects size mismatch (expected ${section.size_bytes_raw}, got ${actualSize})`,
    );
  }
  const actualSha256 = sha256(raw);
  if (actualSha256 !== section.sha256.toLowerCase()) {
    throw new Error("environment_objects checksum mismatch");
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("environment_objects payload is not an array");
  }
  return parsed;
}

async function readEnvironmentObjectsSoft(
  runtimeMapName: string,
  bundleVersion: string,
): Promise<readonly unknown[] | null> {
  try {
    return await readEnvironmentObjects(runtimeMapName, bundleVersion);
  } catch (error) {
    console.warn(
      `[editor-traffic-lights] Serving ${runtimeMapName} without cooked housings:`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

function remember(key: string, lights: EditorTrafficLight[]): void {
  cache.delete(key);
  cache.set(key, lights);
  while (cache.size > MAX_CACHED_MAPS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export type EditorTrafficLightsRead = {
  lights: EditorTrafficLight[];
  runtimeMapName: string;
  bundleVersion: string;
};

/**
 * The map's signal heads, projected into the editor's slim runtime-frame shape.
 *
 * Throws `RuntimeTopologyBundleError` when the map has no readable bundle — the
 * route turns that into a 404, because a map whose heads are unknown is a map
 * the editor can still open.
 */
export async function readEditorTrafficLights(
  runtimeMapName: string,
): Promise<EditorTrafficLightsRead> {
  const bundleVersion = getRuntimeMapArtifactVersion();
  const key = `${runtimeMapName}::${bundleVersion}`;

  const cached = cache.get(key);
  if (cached) {
    // Refresh recency without re-reading.
    remember(key, cached);
    return { lights: cached, runtimeMapName, bundleVersion };
  }

  const inFlight = pending.get(key);
  if (inFlight) {
    return { lights: await inFlight, runtimeMapName, bundleVersion };
  }

  const read = (async () => {
    const [bundle, environmentObjects] = await Promise.all([
      readRuntimeTopologyBundleInput(runtimeMapName, bundleVersion),
      readEnvironmentObjectsSoft(runtimeMapName, bundleVersion),
    ]);
    // The head IS the `<signal>` — pose, facing, height, housing and hardware.
    // The CARLA actor is a copy of it and survives only as a fallback. Both come
    // out of THIS bundle, so the ids join exactly; the export lane's id-drift
    // problem (audit 2026-07-27 §3) is between the bundle and the UPLOADED
    // xodr and cannot reach this read. Reading the uploaded one here would
    // mis-join the majority of heads on every map.
    const housings = environmentObjects
      ? joinCookedSignalHousings(
          environmentObjects,
          bundle.runtime.traffic_lights,
        )
      : null;
    if (housings) {
      console.info(
        `[editor-traffic-lights] Cooked housing join for ${runtimeMapName}:`,
        housings.diagnostics,
      );
    }
    const lights = projectEditorTrafficLights(
      bundle.runtime.traffic_lights,
      parseXodrSignalGeometry(bundle.xodr),
      housings,
    );
    remember(key, lights);
    return lights;
  })();
  pending.set(key, read);
  try {
    return { lights: await read, runtimeMapName, bundleVersion };
  } finally {
    pending.delete(key);
  }
}

export function __clearEditorTrafficLightCacheForTests(): void {
  cache.clear();
  pending.clear();
}
