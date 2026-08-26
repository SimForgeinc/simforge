import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { normalizeDerivedMapIndex, type DerivedMapIndex } from "@simforge-oss/compiler";
import type { DerivedTopology, LocationCatalog } from "@simforge-oss/maps";
import { exportOpenScenarioXml14 } from "@simforge-oss/openscenario";
import { OFFICIAL_OPENSCENARIO_140_XSD, validateOpenScenarioXml14 } from "@simforge-oss/openscenario/node";
import { withBoundedSpeedCruiseRestoration, withStableHighSpeedWorldRoutes } from "@simforge-oss/playback";
import {
  buildMapControlPlan,
  materializationSemanticLosses,
  materializeMapBound,
  parseMapSignalCatalog,
  topologyWithMapSpeedLimits,
  type MapBundle,
  type MapControlPlan,
  withStudioBodyColorTags,
} from "@simforge-oss/compiler";
import { parseTemplate, serializeTemplate, validateTemplate, type ScenarioTemplateV2 } from "@simforge-oss/scenario";
import {
  ambientTrafficProfileFromExtensions,
  buildLaneGraph,
  materializeAmbientTrafficProfile,
  normalizeSimScenarioInput,
  resolveArrivalTriggers,
  resolveOverlappingControlLanes,
  type AmbientTrafficProvenance,
  type SimScenarioInput,
  type TopologyIndex,
} from "@simforge-oss/engine";

import { bakedParkedCarsFromExtensions, withParkedCarActors } from "../app/lib/studio-shared/parked-cars.js";
import { buildXodrElevationResolver } from "./xodr-elevation.js";

export const COMPILER_VERSION = "uniscenario-compiler@2.0.0";
const RUNTIME_CONTRACT_VERSION = "uniscenario.execution-package/v1";
const EMPTY_AMBIENT_CONFIG_SHA256 = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_XML_BYTES = 128 * 1024 * 1024;

export type CompilerArtifactKind = "xosc" | "capability-report" | "compiler-provenance" | "execution-manifest";
export type CompilerArtifact = { kind: CompilerArtifactKind; mediaType: "application/xml" | "application/json"; bytes: Uint8Array; sha256: string };
type MapArtifactKind = "map-xodr" | "map-topology" | "map-derived-topology" | "map-locations" | "map-signals" | "asset-catalog";
type MaterializedTraffic = { artifactId: string; sha256: string; sizeBytes: number; sourceInputDigest: string; mapAssetId: string; mapVersionId: string };
export type CompilerClaim = {
  contract: "uniscenario.compiler-claim/v1";
  exportId: string; attemptId: string; fenceToken: string; leaseExpiresAt: string; compilerVersion: string;
  revision: { id: string; contentSha256: string; canonicalContent: unknown; mapVersionId: string };
  map: {
    id: string; sourceMapId: string; runtimeMapName: string; coordinateSystemId: string; coordinateSystemSha256: string;
    assetCatalogVersionId: string; assetCatalogManifestSha256: string; sumoNetworkSha256: string | null;
    artifacts: Array<{ id: string; kind: MapArtifactKind; mediaType: string; sha256: string; sizeBytes: number; downloadUrl: string }>;
  };
  ambient:
    | { mode: "disabled"; ambientConfig: Record<string, unknown>; configSha256: string; resultSha256: string; materializedTraffic: MaterializedTraffic }
    | { mode: "native"; runtimeVersion: string; seed: string | number; ambientConfig: Record<string, unknown>; configSha256: string; resultSha256: string; materializedTraffic: MaterializedTraffic }
    | { mode: "sumo"; sumoVersion: string; networkSha256: string; seed: string | number; ambientConfig: Record<string, unknown>; configSha256: string; resultSha256: string; materializedTraffic: MaterializedTraffic };
};
export type CompileResult = { artifacts: CompilerArtifact[]; manifestSha256: string; xsdSha256: string; sourceInputDigest: string };

type LoadedMapClosure = { bundle: MapBundle; xodr: string; artifactDigests: Readonly<Record<string, string>> };

function sha256(bytes: string | Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
function canonicalJsonBytes(value: unknown): Uint8Array { return new TextEncoder().encode(canonicalJson(value)); }

async function download(url: string, expectedSize: number, expectedSha256: string, signal: AbortSignal): Promise<Uint8Array> {
  if (expectedSize > MAX_ARTIFACT_BYTES) throw new Error("map_artifact_too_large");
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
  if (!response.ok || !response.body) throw new Error(`map_artifact_download_failed:${response.status}`);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const part = await reader.read(); if (part.done) break; total += part.value.byteLength;
    if (total > expectedSize || total > MAX_ARTIFACT_BYTES) { await reader.cancel(); throw new Error("map_artifact_too_large"); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (bytes.byteLength !== expectedSize) throw new Error("map_artifact_size_mismatch");
  if (sha256(bytes) !== expectedSha256) throw new Error("map_artifact_digest_mismatch");
  return bytes;
}
function decodeJson<T>(bytes: Uint8Array): T {
  const plain = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  return JSON.parse(Buffer.from(plain).toString("utf8")) as T;
}

async function loadMapClosure(claim: CompilerClaim, signal: AbortSignal): Promise<LoadedMapClosure> {
  const entries = await Promise.all(claim.map.artifacts.map(async (item) => [item.kind, await download(item.downloadUrl, item.sizeBytes, item.sha256, signal)] as const));
  const byKind = new Map(entries);
  const required = (kind: MapArtifactKind) => { const value = byKind.get(kind); if (!value) throw new Error(`map_closure_missing:${kind}`); return value; };
  const xodr = Buffer.from(required("map-xodr")).toString("utf8");
  const rawTopology = decodeJson<TopologyIndex>(required("map-topology"));
  const derived = decodeJson<DerivedTopology>(required("map-derived-topology"));
  const catalog = decodeJson<LocationCatalog>(required("map-locations"));
  const signalGeoJson = decodeJson<Parameters<typeof parseMapSignalCatalog>[1]>(required("map-signals"));
  const signalCatalog = parseMapSignalCatalog(xodr, signalGeoJson);
  const topology = topologyWithMapSpeedLimits(rawTopology, signalCatalog);
  const index: DerivedMapIndex = normalizeDerivedMapIndex(derived as unknown, { mapId: claim.map.sourceMapId, topology: topology as never, locations: catalog as unknown });
  const graph = buildLaneGraph(topology);
  return { bundle: { mapId: claim.map.sourceMapId, catalog, derived, topology, index, graph, signalCatalog }, xodr, artifactDigests: Object.fromEntries(claim.map.artifacts.map((item) => [item.kind, item.sha256])) };
}

function withMapControls(input: SimScenarioInput, controls: MapControlPlan): SimScenarioInput {
  const signalIds = new Set(input.signalPrograms.map((item) => item.id)); const roadControlIds = new Set(input.roadControls.map((item) => item.id));
  return { ...input, signalPrograms: [...input.signalPrograms, ...controls.signalPrograms.filter((item) => !signalIds.has(item.id))], roadControls: [...input.roadControls, ...controls.roadControls.filter((item) => !roadControlIds.has(item.id))] };
}
function concreteInput(template: ScenarioTemplateV2, bundle: MapBundle, ambientMode: "disabled" | "native" | "sumo"): { input: SimScenarioInput; siteId: string; materialization: unknown; ambientTraffic: AmbientTrafficProvenance } {
  if (template.roles.some((role) => role.kind !== "scene_absolute")) throw new Error("unsupported_portable_semantics");
  if (!template.sourceMap || template.sourceMap.mapId !== bundle.mapId) throw new Error("map_bound_source_mismatch");
  if (!template.anchor.pin || template.anchor.pin.mapId !== bundle.mapId) throw new Error("map_bound_pin_mismatch");
  if (template.anchor.pin.topologyDigest && template.anchor.pin.topologyDigest !== bundle.graph.topologyDigest) throw new Error("map_bound_topology_digest_mismatch");
  const product = materializeMapBound(template, bundle, { drawIndex: -1 });
  const losses = materializationSemanticLosses(product.manifest.notes);
  if (losses.length > 0) throw new Error(`semantic_loss:${JSON.stringify(losses)}`);
  if (!product.manifest.feasible) throw new Error(`materialization_infeasible:${JSON.stringify(product.manifest.issues)}`);
  const controlled = withParkedCarActors(withStudioBodyColorTags(withMapControls(product.input, buildMapControlPlan(bundle)), template), bakedParkedCarsFromExtensions(template.extensions));
  const ambient = materializeAmbientTrafficProfile(controlled, bundle.graph, ambientMode === "native" ? ambientTrafficProfileFromExtensions(template.extensions) : { version: 1, preset: "off", seed: "execution-provider-off" });
  return { input: ambient.input, siteId: product.manifest.replayKey.siteId, materialization: product.manifest, ambientTraffic: ambient.provenance };
}
function executionResolvedInput(input: SimScenarioInput, graph: MapBundle["graph"]): SimScenarioInput {
  const normalized = normalizeSimScenarioInput(withBoundedSpeedCruiseRestoration(withStableHighSpeedWorldRoutes(input)));
  return resolveArrivalTriggers(resolveOverlappingControlLanes(normalized, graph).input, graph).input;
}
function artifact(kind: CompilerArtifactKind, mediaType: CompilerArtifact["mediaType"], bytes: Uint8Array): CompilerArtifact { return { kind, mediaType, bytes, sha256: sha256(bytes) }; }

export async function compileClaim(claim: CompilerClaim, xsdPath: string, signal: AbortSignal): Promise<CompileResult> {
  if (claim.compilerVersion !== COMPILER_VERSION) throw new Error("compiler_version_mismatch");
  const loaded = await loadMapClosure(claim, signal);
  const template = parseTemplate(claim.revision.canonicalContent);
  if (sha256(new TextEncoder().encode(serializeTemplate(template))) !== claim.revision.contentSha256) throw new Error("revision_content_digest_mismatch");
  const validation = validateTemplate(template); if (!validation.ok) throw new Error(`template_invalid:${JSON.stringify(validation.issues)}`);
  if (sha256(canonicalJsonBytes(claim.ambient.ambientConfig)) !== claim.ambient.configSha256) throw new Error("ambient_config_digest_mismatch");
  if (claim.ambient.mode === "disabled" && claim.ambient.configSha256 !== EMPTY_AMBIENT_CONFIG_SHA256) throw new Error("disabled_ambient_provenance_mismatch");
  const concrete = concreteInput(template, loaded.bundle, claim.ambient.mode);
  for (const actor of concrete.input.actors) {
    const ids = actor.tags.filter((tag) => tag.startsWith("catalog:")).map((tag) => tag.slice(8)).filter(Boolean);
    if (ids.length === 0) throw new Error(`runtime_asset_identity_missing:${actor.id}`);
    if (ids.length !== 1 || new Set(ids).size !== 1) throw new Error(`runtime_asset_identity_ambiguous:${actor.id}`);
  }
  const resolved = executionResolvedInput(concrete.input, loaded.bundle.graph); const sourceInputDigest = sha256(canonicalJsonBytes(resolved));
  if (claim.ambient.materializedTraffic.sourceInputDigest !== sourceInputDigest) throw new Error("materialized_traffic_source_input_digest_mismatch");
  const xodrArtifact = claim.map.artifacts.find((item) => item.kind === "map-xodr")!;
  const exported = exportOpenScenarioXml14(resolved, {
    graph: loaded.bundle.graph, worldElevation: buildXodrElevationResolver(loaded.xodr, loaded.bundle.graph), roadFile: `${loaded.bundle.mapId}.xodr`, executionMode: "trajectory-replay",
    trustedAmbientActorIds: concrete.ambientTraffic.actors.map((item) => item.id), author: template.meta.author ?? "Scenario", description: template.meta.description || template.meta.name,
    provenance: { revisionId: claim.revision.id, revisionContentSha256: claim.revision.contentSha256, mapVersionId: claim.revision.mapVersionId, mapXodrSha256: xodrArtifact.sha256, concreteInputSha256: sourceInputDigest, inputHash: sourceInputDigest, compilerVersion: COMPILER_VERSION },
  });
  const xoscBytes = new TextEncoder().encode(exported.content); if (xoscBytes.byteLength > MAX_XML_BYTES) throw new Error("compiled_xosc_too_large");
  const xsdValidation = await validateOpenScenarioXml14(exported.content, xsdPath); if (!xsdValidation.valid) throw new Error(`xosc_xsd_invalid:${JSON.stringify(xsdValidation.diagnostics)}`);
  const capability = { contract: "uniscenario.capability-report/v1", openScenario: exported.capabilityReport, warnings: exported.warnings, validation: xsdValidation };
  const provenance = { contract: "uniscenario.compiler-provenance/v1", compilerVersion: COMPILER_VERSION, runtimeContractVersion: RUNTIME_CONTRACT_VERSION, revisionId: claim.revision.id, revisionContentSha256: claim.revision.contentSha256, mapVersionId: claim.revision.mapVersionId, runtimeMapName: claim.map.runtimeMapName, mapArtifactDigests: loaded.artifactDigests, coordinateSystemId: claim.map.coordinateSystemId, coordinateSystemSha256: claim.map.coordinateSystemSha256, assetCatalogVersionId: claim.map.assetCatalogVersionId, assetCatalogManifestSha256: claim.map.assetCatalogManifestSha256, ambient: claim.ambient, siteId: concrete.siteId, concreteInputSha256: sourceInputDigest, sourceInputDigest, materializedTrafficDigest: claim.ambient.materializedTraffic.sha256, materializedTrafficOverlapActorIds: concrete.ambientTraffic.actors.map((item) => item.id).sort(), ambientTraffic: concrete.ambientTraffic, materialization: concrete.materialization };
  const preliminary = [artifact("xosc", "application/xml", xoscBytes), artifact("capability-report", "application/json", canonicalJsonBytes(capability)), artifact("compiler-provenance", "application/json", canonicalJsonBytes(provenance))];
  const manifest = { contract: RUNTIME_CONTRACT_VERSION, openScenarioProfile: "ASAM OpenSCENARIO XML 1.4", xsdSha256: OFFICIAL_OPENSCENARIO_140_XSD.xsdSha256, revision: { id: claim.revision.id, sha256: claim.revision.contentSha256 }, sourceInputDigest, materializedTrafficDigest: claim.ambient.materializedTraffic.sha256, map: { assetId: claim.map.sourceMapId, versionId: claim.revision.mapVersionId, id: claim.revision.mapVersionId, runtimeMapName: claim.map.runtimeMapName, xodrSha256: xodrArtifact.sha256, artifacts: loaded.artifactDigests }, assetCatalog: { versionId: claim.map.assetCatalogVersionId, manifestSha256: claim.map.assetCatalogManifestSha256 }, ambient: claim.ambient, materializedTraffic: { artifactId: claim.ambient.materializedTraffic.artifactId, sha256: claim.ambient.materializedTraffic.sha256, sizeBytes: claim.ambient.materializedTraffic.sizeBytes, overlapActorIds: concrete.ambientTraffic.actors.map((item) => item.id).sort() }, files: preliminary.map((item) => ({ kind: item.kind, mediaType: item.mediaType, sha256: item.sha256, sizeBytes: item.bytes.byteLength })) };
  const manifestArtifact = artifact("execution-manifest", "application/json", canonicalJsonBytes(manifest));
  return { artifacts: [...preliminary, manifestArtifact], manifestSha256: manifestArtifact.sha256, xsdSha256: OFFICIAL_OPENSCENARIO_140_XSD.xsdSha256, sourceInputDigest };
}
