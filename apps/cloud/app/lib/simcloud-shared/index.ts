export {
  MapAssetArtifactType,
  MapAssetSchema,
} from "./map-asset";
export type { MapAsset, MapAssetArtifact } from "./map-asset";

export {
  MAP_ASSET_DESCRIPTOR_TAG_IDS,
  MAP_ASSET_DESCRIPTOR_TAGS,
  getMapAssetDescriptorTag,
} from "./map-asset-tags";

export type {
  MapCoordinateRef,
  MapPlaceContext,
  MapSource,
  MapStats,
  MapStatsSignalization,
} from "./map-asset-metadata";
export type {
  MapAssetEnrichmentManifest,
  MapAssetEnrichmentSnapshot,
  MapOverlayLayer,
  MapOverlayLayerId,
} from "./map-asset-enrichment";
export type { CandidateLocation, CandidateLocationKind } from "./map-candidate-location";
export type {
  MapSearchIndex,
  MapSearchIndexObject,
  MapSearchIndexStreetFacts,
  OsmRoadClass,
} from "./map-search-index";

export { primaryActor } from "./scenario-editor";
export type { ScenarioEditorActorDraft } from "./scenario-editor";
export {
  COLLISION_TEMPLATES,
} from "./scenario-families/collision-templates";
export type { CollisionFamilyId } from "./scenario-families/collision-templates";
export { laneTravelIncreasesSFromCenterline } from "./map-topology/lane-travel";
export { ScenarioStatus } from "./run-status";
export type { SceneFormation, SceneFormationSolution } from "./scene-formation";
export type { SemanticMapOverlay } from "./semantic-map/overlay";
export type { SemanticSiteQueryResult } from "./semantic-map/site-query";
export type { RenderOutputSpec } from "./simulation-run";
export type {
  EsminiValidationMetrics,
  ScenarioValidationJob,
  ScenarioValidationRepairKind,
  ScenarioValidationVerdict,
} from "./scenario-validation-job";
export type { JunctionSignalPlan } from "./scenario-signals";
export {
  UNISCENARIO_NATIVE_PHYSICS_ACCEPTANCE_LIMITS,
  UniScenarioParityEvidenceV1Schema,
  UniScenarioRenderWorkerIdentitySchema,
} from "./uniscenario-render-control";
export type {
  UniScenarioParityEvidenceV1,
  UniScenarioRenderResourceRequest,
  UniScenarioRenderWorkerIdentity,
} from "./uniscenario-render-control";

export { deriveEnrichmentTags } from "./enrichment/derive-enrichment-tags";
export { isPedestrianSpawnCandidate } from "./enrichment/pedestrian-spawn";
export { MapProjection } from "./enrichment/proj";
export {
  parseDatum,
  parseHorizontalUnits,
  parseProjOrigin,
  parseVerticalUnits,
  projProjectionType,
  utmZoneFromLonLat,
} from "./enrichment/parse-proj";
export {
  localToLonLat,
  parseGeometrySegments,
  resolveSTtoXY,
  resolveSTtoXYWithHeading,
  sampleGeometry,
  sampleRoadReferenceLineToLonLat,
} from "./enrichment/xodr-geometry";
export type {
  CoordTransform,
  GeometrySegment,
  XY,
} from "./enrichment/xodr-geometry";
export type { XodrJunctionMatchInfo } from "./enrichment/extractors/geojson-junction-extractor";

// Map presentation and editor-runtime contracts consumed by the shared 2D/3D
// map viewer. These are vendored source modules, not cloud service adapters.
export * from "./behavior-base-clip";
export * from "./carla-runtime-catalog";
export * from "./defaults";
export * from "./environment-preset";
export * from "./scenario-behavior";
export * from "./scenario-editor";
export * from "./scenario-intention";
export * from "./scenario-metadata";
export * from "./scenario-signals";
export * from "./scenario-timing";
export * from "./scenario-validation-job";
export * from "./scene-formation";
export * from "./simulation-run";
export * from "./traffic-manager";
export * from "./xodr-signal-controllers";
