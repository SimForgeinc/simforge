import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { asMapId, buildMapIntel } from "@simforge/maps";
import { CoordinateFrame } from "@simforge/maps/opendrive";
import { readGlb } from "@simcloud/shared/map-ingest/glb";
import {
  buildRoadwayConsistencyReport,
  serializeRoadwayConsistencyReport,
} from "@simcloud/shared/map-ingest/roadway-consistency-report";
import { validateRoadwayConsistency } from "@simcloud/shared/map-topology/roadway-consistency-core.mjs";

import type { MapSources } from "@simforge/maps";
import type { MapTopologyIndex } from "@simcloud/shared/map-topology/types";
import type { CityManifestDocument } from "./city-manifest";

import mapIntelPackageJson from "../../../../../../packages/maps/package.json";

/**
 * Build receipts record the exact version of the workspace package that the
 * local cloud app executes. Reading its manifest keeps provenance aligned with
 * workspace package bumps while the app dependency remains `workspace:*`.
 */
export const MAP_INTEL_BUILDER_VERSION = mapIntelPackageJson.version;

export type BuildDerivedArtifactsInput = {
  mapId: string;
  xodrText: string;
  xodrSha256: string;
  topologyIndex: MapTopologyIndex;
  topologyBytes: Buffer;
  lanePolygonsJson: NonNullable<MapSources["lanePolygons"]>;
  signalsJson: NonNullable<MapSources["signals"]>;
  manifest: CityManifestDocument;
  roadGlbBytes: Buffer;
};


function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`);
}

/** Deterministic bytes; see the note in sidecars.ts on the omitted `mtime`. */
function gzipCanonicalJson(value: unknown): Buffer {
  return gzipSync(canonicalBytes(value), { level: 9 });
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sidecarDigest(value: unknown): string {
  return sha256(gzipCanonicalJson(value));
}

/**
 * `roadId -> <road name>` straight from the OpenDRIVE.
 *
 * map-intel otherwise learns road names from a search index or a street-name
 * sign, and an uploaded map has neither, so the names its own source file
 * states would be discarded and every junction movement would be nameless.
 */
function roadNamesFrom(xodrText: string): Record<string, string> {
  const names: Record<string, string> = {};
  for (const road of xodrText.matchAll(/<road\b([^>]*)>/g)) {
    const attributes = road[1] ?? "";
    const id = /\bid\s*=\s*"([^"]*)"/.exec(attributes)?.[1]?.trim();
    const name = /\bname\s*=\s*"([^"]*)"/.exec(attributes)?.[1]?.trim();
    if (id && name && !(id in names)) names[id] = name;
  }
  return names;
}


/**
 * Count the road layer's marking and support primitives by material name.
 *
 * Uploaded maps carry no RoadRunner layer hierarchy, so this classifies on the
 * only signal an authored GLB reliably has: what the artist called the material.
 * The patterns are the material half of the pipeline's own classifier in
 * roads-only-v2.mjs, minus its layer-name requirement.
 */
const MARKING_MATERIAL = /(?:marking|paint|lane[_ .-]?mark|crosswalk|stop[_ .-]?(?:bar|line)|direction[_ .-]?arrow|road[_ .-]?text)/i;
const SUPPORT_MATERIAL = /(?:asphalt|concrete|(?:^|[_ .-])road(?:[_ .-]|$)|tarmac|pavement)/i;

function auditRoadMaterials(roadGlbBytes: Buffer): {
  contractVersion: string;
  keptMarkingPrimitives: number;
  keptSupportPrimitives: number;
  unclassifiedPrimitives: number;
  materials: string[];
} {
  const glb = readGlb(roadGlbBytes);
  const materials = (glb.json.materials ?? []).map(
    (material, index) => material.name ?? `material_${index}`,
  );
  let marking = 0;
  let support = 0;
  let unclassified = 0;
  for (const mesh of glb.json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const name = primitive.material === undefined
        ? (mesh.name ?? "")
        : materials[primitive.material] ?? "";
      if (MARKING_MATERIAL.test(name)) marking += 1;
      else if (SUPPORT_MATERIAL.test(name)) support += 1;
      else unclassified += 1;
    }
  }
  return {
    contractVersion: "simforge.uploaded-road-material-audit/v1",
    keptMarkingPrimitives: marking,
    keptSupportPrimitives: support,
    unclassifiedPrimitives: unclassified,
    materials: [...materials].sort(),
  };
}

export function buildDerivedArtifacts({
  mapId,
  xodrText,
  xodrSha256,
  topologyIndex,
  topologyBytes,
  lanePolygonsJson,
  signalsJson,
  manifest,
  roadGlbBytes,
}: BuildDerivedArtifactsInput): {
  locations: { bytes: Buffer; count: number };
  derivedTopology: { bytes: Buffer };
  roadwayConsistency: { bytes: Buffer; verdict: string };
} {
  const sourceHashes = {
    "lane-polygons": sidecarDigest(lanePolygonsJson),
    signals: sidecarDigest(signalsJson),
    "topology-index": sha256(topologyBytes),
    xodr: xodrSha256,
  };
  // Both packages describe the same topology-index.json, but with different
  // conventions for "not known": this builder writes `null` (its zod schema is
  // the authoritative one, and the reference lane of every road genuinely has
  // no representative width), while map-intel's interface spells the same
  // absence as `undefined`. map-intel never validates the object — it
  // JSON.parses it and reads defensively (`representativeWidthM ?? 0`,
  // `laneChangePermissions ?? []`) — so the bytes it already consumes on disk
  // contain these nulls. One asserted seam is honest here; deep-rewriting every
  // null would invent a third shape and change the digests map-intel hashes.
  const mapIntelTopology = topologyIndex as unknown as MapSources["topology"];
  const sources: MapSources = {
    mapId: asMapId(mapId),
    mapAssetId: topologyIndex.mapName || mapId,
    dir: `in-memory map upload ${mapId}`,
    frame: CoordinateFrame.fromMapAssets(xodrText.slice(0, 8192), manifest),
    topology: mapIntelTopology,
    searchIndex: null,
    signals: signalsJson,
    lanePolygons: lanePolygonsJson,
    mapGeojson: null,
    overlay: null,
    roadNames: roadNamesFrom(xodrText),
    sourceHashes,
  };
  const build = buildMapIntel(sources);
  const locationsBytes = gzipCanonicalJson(build.catalog);
  const derivedTopologyBytes = gzipCanonicalJson(build.derived);
  // `makeMarkingFirstRoadsOnlyGlb` is the RoadRunner-shaped optimizer: it only
  // recognises markings and asphalt inside nodes named `Roads_Marking_Layer1` /
  // `Roads_Road_Layer0`, and refuses outright when it finds neither. Demanding
  // that naming from a hand-authored map would be demanding RoadRunner's
  // internals, so an uploaded map is audited on its own terms instead.
  //
  // Nothing is lost by that: the report's substance comes from
  // `validate(topology)`, and the audit only ever contributes a primitive count
  // to a `visualEvidence` block that this validator hardcodes to `unavailable`
  // for every map, RoadRunner-derived or not.
  const roadAudit = auditRoadMaterials(roadGlbBytes);
  const roadAuditBytes = Buffer.from(canonicalJson(roadAudit));
  const roadwayReport = buildRoadwayConsistencyReport({
    mapId,
    topology: topologyIndex,
    roadAudit,
    sourceDigests: {
      xodrSha256,
      topologySha256: sha256(topologyBytes),
      sourceRoadGeometrySha256: sha256(roadGlbBytes),
      // An uploaded map publishes its authored road layer as the final road:
      // the KTX2/roads-only variant chain never runs for it.
      finalRoadSha256: sha256(roadGlbBytes),
      roadAuditSha256: sha256(roadAuditBytes),
    },
    validate: validateRoadwayConsistency,
  });

  return {
    locations: { bytes: locationsBytes, count: build.catalog.locations.length },
    derivedTopology: { bytes: derivedTopologyBytes },
    roadwayConsistency: {
      bytes: serializeRoadwayConsistencyReport(roadwayReport),
      verdict: roadwayReport.verdict,
    },
  };
}
