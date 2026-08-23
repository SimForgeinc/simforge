export {
  CARLA_MAPS,
  DatasetStatusSchema,
  DATASET_STATUS_VALUES,
  ExportFormatSchema,
  EXPORT_FORMAT_VALUES,
  SimulationArtifactClassSchema,
  DatasetExportSourceFilterSchema,
  VariationConfigSchema,
  DatasetStatsRepairStateSchema,
  DatasetStatsSchema,
  DatasetSchema,
  CreateDatasetInputSchema,
  DatasetExportSchema,
} from "./dataset";
export type {
  CarlaMapName,
  DatasetStatus,
  ExportFormat,
  SimulationArtifactClass,
  DatasetExportSourceFilter,
  VariationConfig,
  DatasetStatsRepairState,
  DatasetStats,
  Dataset,
  CreateDatasetInput,
  DatasetExport,
} from "./dataset";
export {
  SCENARIO_INTENTION_SCHEMA_VERSION,
  ActorBehaviorMetadataSchema,
  GeneratedActorBehaviorMetadataSchema,
  ScenarioExpectedBehaviorSchema,
  ScenarioIntentionContextSchema,
  ScenarioIntentionModifiersSchema,
  ScenarioIntentionOutcomeSchema,
  ScenarioIntentionSchema,
  ScenarioIntentionSubjectSchema,
} from "./scenario-intention";
export type {
  ActorBehaviorMetadata,
  GeneratedActorBehaviorMetadata,
  ScenarioIntention,
} from "./scenario-intention";
export {
  ALL_CATEGORIES,
  ImportedCategorySchema,
  LIVE_CATEGORIES,
  RESERVED_CATEGORIES,
  SCENARIO_CATALOG_VERSION,
  ScenarioCatalogGroupSchema,
  ScenarioCatalogStatusSchema,
  categoryById,
  resolveCategory,
} from "./scenario-catalog";
export type {
  CategoryResolution,
  ConflictClassification,
  GeneratorClassification,
  ImportedCategory,
  NominalClassification,
  ScenarioCatalogEntry,
  ScenarioCatalogGroup,
  ScenarioCatalogStatus,
} from "./scenario-catalog";
/**
 * Only the PURE bundle contract is re-exported here. The builder, selection
 * and evidence modules read the filesystem and hash with node:crypto, and this
 * barrel is imported by browser code — re-exporting them drags node builtins
 * into the client bundle and fails `next build` with UnhandledSchemeError.
 * Node-side consumers import from "./autogen-import/index" directly.
 */
export {
  AUTOGEN_IMPORT_SCHEMA_VERSION,
  ArtifactRoleSchema,
  AutogenImportManifestSchema,
  BundleArtifactSchema,
  BundleExclusionsSchema,
  BundleGatesSchema,
  BundleSceneSchema,
  EvaluationArtifactRoleSchema,
  GateStateSchema,
  IMPORT_LIMITS,
  MANDATORY_ARTIFACT_ROLES,
  SystemArtifactRoleSchema,
  sceneEligibilityErrors,
} from "./autogen-import/manifest";
export type {
  ArtifactRole,
  AutogenImportManifest,
  BundleArtifact,
  BundleExclusions,
  BundleGates,
  BundleScene,
  EvaluationArtifactRole,
  GateState,
} from "./autogen-import/manifest";
export {
  DATASET_EXPORT_RECIPES,
  DatasetExportRecipeIdSchema,
  assertDatasetExportRecipeQueueable,
  defaultDatasetExportRequestedOutputs,
  defaultDatasetExportSourceFilter,
  datasetExportRecipeQueueBlockMessage,
  isDatasetExportRecipeQueueable,
  mergeDatasetExportSourceFilters,
  resolveDatasetExportRecipe,
} from "./dataset-export-recipes";
export type {
  DatasetExportRecipeDefinition,
  DatasetExportRecipeExecutionMode,
  DatasetExportRecipeId,
} from "./dataset-export-recipes";
export {
  ALPAMAYO_SFT_V3_CONTRACT_VERSION,
  ALPAMAYO_SFT_V3_QUEUE_BLOCK_MESSAGE,
  ALPAMAYO_SFT_V3_RECIPE_ID,
  ALPAMAYO_SFT_V3_TARGET_TASK,
  ALPAMAYO_STAGE1_NAV_CAMERA_IDS,
} from "./alpamayo-sft-v3";
export {
  BILLING,
  COSMOS_PRICE_MODEL,
  CUSTOM_TOPUP,
  DEFAULT_WORKSPACE_CREDITS_CENTS,
  NORMAL_QUEUE_MULTIPLIER_BPS,
  PRIORITY_QUEUE_MULTIPLIER_BPS,
  RENDER_QUEUE_PRICE_MODEL,
  RENDER_PRICE_MODEL,
  TOP_UP_TIERS,
  countRenderSensors,
  estimateCosmosCostCents,
  estimateRenderCostCents,
  normalizeCarlaQueueTier,
} from "./billing";
export type {
  BillingRates,
  CarlaQueueTier,
  CosmosCostEstimate,
  RenderCostEstimate,
  TopUpTier,
} from "./billing";
export {
  DATASET_RECIPES,
  DEFAULT_SDG_DIRECT_RENDER_DRAFT,
  DatasetRecipeIdSchema,
  getDatasetRecipe,
  SDG_AUGMENTATION_MATRIX,
  SDG_COSMOS,
  SDG_OUTPUT_DEPENDENCIES,
  SDG_OUTPUTS,
  SDG_RAW_OUTPUT_MODALITIES,
  SDG_RECIPE_CONFIG,
  SDG_RENDER_FPS,
  SDG_RENDER_RESOLUTION,
  SDG_SENSOR_RIG,
  SdgBbox2dVisiblePixelSchema,
  SdgBbox3dSchema,
  SdgBboxQualitySchema,
  SdgManifestArtifactSchema,
  SdgManifestSchema,
  SdgOdvgDetectionSchema,
  SdgOdvgFrameSchema,
  SdgOutputSchema,
  SdgQualityMetricsSchema,
  SdgQualityStateSchema,
  SdgRenderOutputPlanSchema,
  expandSdgOutputs,
  getRequiredSdgRawModalities,
  orderedSdgOutputs,
  PublicExportFormatSchema,
} from "./recipes";
export type {
  DatasetRecipe,
  DatasetRecipeId,
  DatasetRecipeStages,
  PublicExportFormat,
  SdgBbox2dVisiblePixel,
  SdgBbox3d,
  SdgBboxQuality,
  SdgManifest,
  SdgManifestArtifact,
  SdgOdvgDetection,
  SdgOdvgFrame,
  SdgOutput,
  SdgQualityMetrics,
  SdgQualityState,
  SdgDirectRenderDraft,
  SdgRenderOutputPlan,
} from "./recipes";
export {
  RECORDING_DEFAULTS,
  SIMULATION_DEFAULTS,
  COSMOS_DEFAULTS,
} from "./defaults";
export {
  SCENARIO_TIMING,
  normalizeRenderDurationOverrideSeconds,
  normalizeScenarioDurationSeconds,
  resolveRenderDurationSeconds,
} from "./scenario-timing";
export {
  EnvironmentPresetSchema,
  EnvironmentPresetLighting,
  EnvironmentPresetRoadSurface,
  EnvironmentPresetWeather,
  ENVIRONMENT_PRESET_LIGHTING_VALUES,
  ENVIRONMENT_PRESET_ROAD_SURFACE_VALUES,
  ENVIRONMENT_PRESET_WEATHER_VALUES,
  environmentPresetToRef,
} from "./environment-preset";
export type {
  EnvironmentPreset,
  EnvironmentPresetLighting as EnvironmentPresetLightingType,
  EnvironmentPresetRoadSurface as EnvironmentPresetRoadSurfaceType,
  EnvironmentPresetWeather as EnvironmentPresetWeatherType,
} from "./environment-preset";
export {
  CarlaWeatherSchema,
  environmentPresetToCarlaWeather,
} from "./carla-weather";
export type { CarlaWeather } from "./carla-weather";
// Self-check on documents WE emit. Not to be confused with `./xosc/parser`,
// which is the hardened reader for inbound third-party files — see the header
// of `allowlist-self-check.ts` for why the two must not be conflated.
export {
  SCENARIO_RUNNER_1_0_ACTION_ALLOWLIST,
  SCENARIO_RUNNER_1_0_CONDITION_ALLOWLIST,
  classifyXoscDocument,
} from "./xosc/allowlist-self-check";
export type { XoscAllowlistClassification } from "./xosc/allowlist-self-check";
export {
  SCENARIO_METADATA_SCHEMA_VERSION,
  GeneratedScenarioMetadataSchema,
  ScenarioExpectedEgoOutcomeSchema,
  ScenarioMetadataInteractionTypeSchema,
  ScenarioMetadataJunctionTypeSchema,
  ScenarioMetadataLegalitySchema,
  ScenarioMetadataLightingSchema,
  ScenarioMetadataOcclusionSchema,
  ScenarioMetadataRelativeDirectionSchema,
  ScenarioMetadataRoadTypeSchema,
  ScenarioMetadataSchema,
  ScenarioMetadataSourceSchema,
  ScenarioMetricSchema,
  ScenarioOddSchema,
  ScenarioTagsSchema,
  ScenarioTestCaseSchema,
} from "./scenario-metadata";
export type {
  GeneratedScenarioMetadata,
  ScenarioMetadata,
} from "./scenario-metadata";
export {
  normalizePhysicsProfileId,
  ACTOR_LEGACY_MOTION_KEYS,
  ACTOR_LEGACY_MOTION_SCHEMA_VERSION,
  AmbientRegionOriginSchema,
  InteractionRelocationActorProvenanceSchema,
  CrossMapActorTransferProvenanceSchema,
  PhysicsProfileIdSchema,
  readLegacyActorMotion,
  ScenarioEditorActorDraftSchema,
  ScenarioEditorActorLegacyMotionSchema,
  ScenarioEditorActorLegacyWireSchema,
  ScenarioEditorActorPlacementModeSchema,
  ScenarioEditorAmbientTrafficSchema,
  ScenarioEditorDraftSchema,
  ScenarioEditorMapPointSchema,
  ScenarioEditorMetadataSchema,
  ScenarioValidationIntentSchema,
  ScenarioEditorPathSegmentDirectionSchema,
  ScenarioEditorRoadAnchorSchema,
  ScenarioEditorSimulationConfigSchema,
  ScenarioEditorTemplateSchema,
  plannedSubjectActor,
  primaryActor,
  ScenarioEditorTimelineActionSchema,
  ScenarioEditorTimelineClipSchema,
  TimedInstructionArgsSchema,
  TimedInstructionFollowRoutePlanSchema,
  TimedInstructionHashesSchema,
  TimedInstructionIntentSchema,
  TimedInstructionManifestRowSchema,
  TimedInstructionPrimitiveIdSchema,
  TimedInstructionRejectedPlanSchema,
  TimedInstructionResolvedPlanSchema,
  TimedInstructionSemanticExecutionPlanSchema,
  TimedInstructionValidationSchema,
  TimedInstructionWorkerValidationSchema,
  TimedInstructionsSchema,
} from "./scenario-editor";
export {
  SEMANTIC_ACTOR_AUTHORING_SCHEMA_VERSION,
  SEMANTIC_RUNTIME_BINDING_COMPILER_VERSION,
  SEMANTIC_RUNTIME_BINDING_COMPILER_VERSION_V1,
  SemanticLaneRoleSchema,
  SemanticCorridorStationIntentSchema,
  SemanticCorridorRouteIntentSchema,
  SemanticMovementTrajectoryIntentSchema,
  SemanticActorIntentSchema,
  SemanticRuntimeBindingCompilationSchema,
  SemanticActorAuthoringSchema,
  semanticExecutableActorProjection,
  quantizeSemanticExecutableProof,
  stableSemanticBindingJson,
} from "./semantic-actor-authoring";
export type {
  SemanticLaneRole,
  SemanticActorIntent,
  SemanticRuntimeBindingCompilation,
  SemanticActorAuthoring,
  SemanticExecutableActorProjection,
} from "./semantic-actor-authoring";
export {
  SEMANTIC_MAP_SCHEMA_VERSION,
  SEMANTIC_MAP_COMPILER_VERSION,
  SemanticMapPointSchema,
  SemanticMapAuthoringStatusSchema,
  SemanticMapDiagnosticCodeSchema,
  SemanticMapDiagnosticSchema,
  SemanticMapBuildConfigSchema,
  RuntimeBoundLaneGeometrySchema,
  CorridorEndpointSchema,
  CorridorSeamSchema,
  LaneCorridorSchema,
  JunctionApproachSchema,
  JunctionMovementVariantSchema,
  JunctionMovementSchema,
  ConflictZoneSchema,
  SemanticMapStatsSchema,
  SemanticMapGraphSchema,
  BuildSemanticMapGraphInputSchema,
} from "./semantic-map/types";
export type {
  SemanticMapPoint,
  SemanticMapAuthoringStatus,
  SemanticMapDiagnosticCode,
  SemanticMapDiagnostic,
  SemanticMapBuildConfig,
  RuntimeBoundLaneGeometry,
  CorridorEndpoint,
  CorridorSeam,
  LaneCorridor,
  JunctionApproach,
  JunctionMovementVariant,
  JunctionMovement,
  ConflictZone,
  SemanticMapStats,
  SemanticMapGraph,
  BuildSemanticMapGraphInput,
} from "./semantic-map/types";
export {
  JUNCTION_STRAIGHT_MAX_DEG,
  JUNCTION_TURN_WEIGHTS,
  JUNCTION_UTURN_MIN_DEG,
  TIMED_INSTRUCTION_PRIMITIVE_FOR_JUNCTION_DIRECTION,
  authoredJunctionTurn,
  classifyJunctionTurn,
  isGeneratedAmbientTraffic,
  junctionBranchHeadingChangeDeg,
  junctionDirectionPolicy,
  junctionHeadingDeltaDeg,
  junctionTurnForBranch,
  type AuthoredJunctionDirection,
  type JunctionDirectionActorRead,
  type JunctionDirectionPolicy,
  type JunctionTurn,
  type JunctionVec2,
} from "./junction-direction";
export { buildSemanticMapGraph } from "./semantic-map/build-semantic-map-graph";
export {
  corridorStationAnchor,
  parseRsl,
  pointAndYawAtStation,
  runtimeBindingAtCorridorStation,
  travelFractionToRoadFraction,
} from "./semantic-map/corridor-station";
export type {
  CorridorStationAnchor,
  ParsedRsl,
  RuntimeLaneBinding,
} from "./semantic-map/corridor-station";
export { compileAutopilotRoute } from "./semantic-map/compile-autopilot-route";
export type {
  CompileAutopilotRouteArgs,
  CompiledRoute,
  CompiledRouteAnchor,
  CompiledRouteLeg,
  CompiledRouteTermination,
} from "./semantic-map/compile-autopilot-route";
export { deriveRunway, runwayBudgetM, runwayPolyline } from "./semantic-map/derive-runway";
export {
  LANE_CHANGE_COST_M,
  anchorStation,
  routeLeg,
  routeLineLengthM,
  routeThroughAnchors,
  slicePolylineByStation,
} from "./semantic-map/route-through-anchors";
export type {
  AnchorRouteResult,
  AnchorStation,
  RouteAnchorRef,
} from "./semantic-map/route-through-anchors";
export { fitRunwayTurns } from "./semantic-map/fit-runway-turns";
export type { FitRunwayTurns, FitRunwayTurnsArgs } from "./semantic-map/fit-runway-turns";
export {
  baselineAction,
  baselineChoice,
  baselineChoicesFor,
  resolveActorMotion,
  resolveTurnIntents,
} from "./resolve-actor-motion";
export type {
  BaselineChoice,
  FreeReason,
  MotionBaseline,
  MotionPlacement,
  MotionPoint,
  MotionPointLock,
  ResolvedActorMotion,
} from "./resolve-actor-motion";
export type {
  DeriveRunwayArgs,
  DerivedRunway,
  DerivedRunwayAnchor,
  DerivedRunwayLeg,
  DerivedRunwayTermination,
  RunwayTurnIntent,
} from "./semantic-map/derive-runway";
export {
  SEMANTIC_EXECUTION_INDEX_SCHEMA_VERSION,
  LEGACY_SEMANTIC_EXECUTION_INDEX_COMPILER_VERSION,
  SEMANTIC_EXECUTION_INDEX_COMPILER_VERSION,
  SemanticExecutionIndexSchema,
  buildSemanticExecutionIndex,
} from "./semantic-map/execution-index";
export type {
  SemanticExecutionIndex,
  SemanticExecutionRuntimeControls,
} from "./semantic-map/execution-index";
export {
  SEMANTIC_MAP_OVERLAY_SCHEMA_VERSION,
  SemanticMapOverlaySchema,
} from "./semantic-map/overlay";
export type { SemanticMapOverlay } from "./semantic-map/overlay";
export {
  SEMANTIC_FEATURE_GRAPH_SCHEMA_VERSION,
  SEMANTIC_FEATURE_GRAPH_COMPILER_VERSION,
  SemanticFeatureSourceSchema,
  SemanticFeatureKindSchema,
  SemanticFeatureGeometrySchema,
  SemanticFeatureRuntimeBindingSchema,
  SemanticFeatureSchema,
  SemanticFeatureRelationKindSchema,
  SemanticFeatureRelationSchema,
  SemanticFeatureGraphSchema,
} from "./semantic-map/feature-graph";
export type {
  SemanticFeatureSource,
  SemanticFeatureKind,
  SemanticFeatureGeometry,
  SemanticFeatureRuntimeBinding,
  SemanticFeature,
  SemanticFeatureRelation,
  SemanticFeatureGraph,
} from "./semantic-map/feature-graph";
export {
  SEMANTIC_GRAPH_PUBLICATION_SCHEMA_VERSION,
  SemanticGraphArtifactDescriptorSchema,
  SemanticGraphPublicationManifestSchema,
} from "./semantic-map/publication";
export type {
  SemanticGraphArtifactDescriptor,
  SemanticGraphPublicationManifest,
} from "./semantic-map/publication";
export {
  SEMANTIC_SITE_QUERY_SCHEMA_VERSION,
  SEMANTIC_SITE_QUERY_RESULT_SCHEMA_VERSION,
  SemanticSiteAnchorSchema,
  SemanticSiteNearbyRequirementSchema,
  SemanticSiteQuerySchema,
  SemanticSiteQueryCandidateSchema,
  SemanticSiteQueryPruningSummarySchema,
  SemanticSiteQueryResultSchema,
} from "./semantic-map/site-query";
export type {
  SemanticSiteQuery,
  SemanticSiteQueryCandidate,
  SemanticSiteQueryResult,
} from "./semantic-map/site-query";
export {
  SCENARIO_RENDER_ANNOTATION_SCHEMA_VERSION,
  ScenarioRenderAnnotationSchema,
  ScenarioRenderAnnotationInputSchema,
} from "./scenario-render-annotation";
export type {
  ScenarioRenderAnnotation,
  ScenarioRenderAnnotationInput,
} from "./scenario-render-annotation";
export {
  SCENARIO_RATING_SCHEMA_VERSION,
  ScenarioRatingSchema,
  ScenarioRatingInputSchema,
  ScenarioRatingAggregateSchema,
  ScenarioReviewedViaSchema,
  ScenarioReviewQueueRenderSchema,
  ScenarioReviewQueueItemSchema,
  ScenarioReviewQueuePageSchema,
  ScenarioReviewStateSchema,
} from "./scenario-rating";
export type {
  ScenarioRating,
  ScenarioRatingInput,
  ScenarioRatingAggregate,
  ScenarioReviewedVia,
  ScenarioReviewQueueRender,
  ScenarioReviewQueueItem,
  ScenarioReviewQueuePage,
  ScenarioReviewState,
} from "./scenario-rating";
export {
  SEMANTIC_SCENARIO_TEMPLATE_SCHEMA_VERSION,
  SemanticScenarioTemplateFamilySchema,
  SemanticScenarioTemplateSchema,
} from "./semantic-scenario-template";
export type {
  SemanticScenarioTemplateFamily,
  SemanticScenarioTemplate,
} from "./semantic-scenario-template";
export type {
  AmbientRegionOrigin,
  InteractionRelocationActorProvenance,
  CrossMapActorTransferProvenance,
  PhysicsProfileId,
  RuntimeScenarioEditorActor,
  ScenarioEditorActorDraft,
  ScenarioEditorActorLegacyMotion,
  ScenarioEditorActorLegacyWire,
  ScenarioEditorActorPlacementMode,
  ScenarioEditorAmbientTraffic,
  ScenarioEditorDraft,
  ScenarioEditorMapPoint,
  ScenarioEditorMetadata,
  ScenarioValidationIntent,
  ScenarioEditorPathSegmentDirection,
  ScenarioEditorRoadAnchor,
  ScenarioEditorSimulationConfig,
  ScenarioEditorTemplate,
  ScenarioEditorTimedWaypoint,
  ScenarioEditorTimelineAction,
  ScenarioEditorTimelineClip,
  TimedInstructionArgs,
  TimedInstructionHashes,
  TimedInstructionIntent,
  TimedInstructionManifestRow,
  TimedInstructionPrimitiveId,
  TimedInstructionResolvedPlan,
  TimedInstructions,
  TimedInstructionValidation,
  TimedInstructionWorkerValidation,
} from "./scenario-editor";
export {
  COLLISION_FAMILY_IDS,
  CONTACT_FAMILY_IDS,
  NEAR_MISS_FAMILY_IDS,
  COLLISION_TEMPLATES,
  COLLISION_ANCHOR_STRATEGIES,
  COLLISION_ACTOR_ROLES,
  FAMILY_EVENT_PRIOR,
  FAMILY_ESMINI_OUTCOME,
  NPC_AGGRESSIVENESS_VALUES,
  SCENARIO_DURATION_S,
  TARGET_COLLISION_TIME_S,
  applyAggressivenessToSpeedKph,
  isNearMissFamily,
  parseAggressivenessLabel,
} from "./scenario-families/collision-templates";
export type {
  CollisionFamilyId,
  CollisionFamilyTemplate,
  CollisionRequiredGeometry,
  CollisionClarificationSlot,
  CollisionActorRecipe,
  CollisionActorRole,
  CollisionAnchorStrategy,
  CollisionTimelineClipTemplate,
  ContactFamilyId,
  FamilyEventPrior,
  NearMissFamilyId,
  NearMissMargin,
  NpcAggressiveness,
} from "./scenario-families/collision-templates";
export {
  CRASH_CATEGORY_PRONE,
  CRASH_CATEGORY_BASE_RATES,
  CRASH_CATEGORY_PRIOR_PARAMS,
  CRASH_SHARED_CATEGORIES,
  CRASH_PRONE_TAG_SUFFIX,
  crashSharedCategoriesForCandidate,
  crashPropensityFamiliesForCandidate,
  crashPropensityTagsForCandidate,
} from "./scenario-families/crash-category-prior";
export type { CrashSharedCategory } from "./scenario-families/crash-category-prior";
export {
  SCENARIO_VALIDATION_ENGINE,
  ScenarioValidationReportSchema,
  ValidationVerdictSchema,
  ValidationCheckStatusSchema,
  ValidationCheckIdSchema,
  ValidationCheckSchema,
  ValidationCollisionSchema,
  ValidationActorDiagnosticSchema,
  ValidationRepairSchema,
  ValidationPointSchema,
} from "./scenario-validation";
export type {
  ScenarioValidationReport,
  ValidationVerdict,
  ValidationCheckStatus,
  ValidationCheckId,
  ValidationCheck,
  ValidationCollision,
  ValidationActorDiagnostic,
  ValidationRepair,
  ValidationPoint,
} from "./scenario-validation";
export {
  CARLA_RUNTIME_ALLOWED_LANE_TYPES,
  MAP_TOPOLOGY_SCHEMA_VERSION,
  MapTopologyIndexSchema,
  RuntimeBoundMapTopologyIndexSchema,
  RuntimeTopologyFamilySchema,
  RuntimeTopologyParityDiagnosticSchema,
  RuntimeTopologyParitySchema,
  RuntimeTopologyProvenanceSchema,
  TopologyLaneSchema,
  TopologyGateSchema,
  TopologyJunctionSchema,
  TopologyAdjacentLaneSchema,
  TopologyLaneChangePermissionSchema,
  TopologyStatsSchema,
  TurnRelationSchema,
  Vec2Schema,
} from "./map-topology/types";
export type {
  MapTopologyIndex,
  RuntimeBoundMapTopologyIndex,
  RuntimeTopologyFamily,
  RuntimeTopologyParityDiagnostic,
  RuntimeTopologyParity,
  RuntimeTopologyProvenance,
  RuntimeTopologySegment,
  TopologyLane,
  TopologyGate,
  TopologyJunction,
  TopologyAdjacentLane,
  TopologyLaneChangePermission,
  TopologyStats,
  TurnRelation,
  Vec2,
} from "./map-topology/types";
export {
  SCENARIO_INTERACTION_RELOCATION_SCHEMA_VERSION,
  ScenarioInteractionRelocationStatusSchema,
  ScenarioInteractionRelocationDiagnosticCodeSchema,
  ScenarioInteractionRelocationDiagnosticSchema,
  ScenarioInteractionRelocationActorBindingSchema,
  ScenarioInteractionRelocationPreviewPathSchema,
  ScenarioInteractionRelocationCandidateSchema,
  ScenarioInteractionRelocationSourceSchema,
  ScenarioInteractionRelocationReportSchema,
  ScenarioInteractionRelocationRequestSchema,
  ScenarioInteractionRelocationResultSchema,
} from "./scenario-interaction-relocation";
export {
  SCENE_FORMATION_SCHEMA_VERSION,
  SCENE_FORMATION_SOLUTION_SCHEMA_VERSION,
  SceneFormationAnchorSchema,
  SceneFormationConstraintKindSchema,
  SceneFormationConstraintSchema,
  SceneFormationFootprintSchema,
  SceneFormationKindSchema,
  SceneFormationMemberPoseSchema,
  SceneFormationMemberSchema,
  SceneFormationResidualSchema,
  SceneFormationSchema,
  SceneFormationSolveReportSchema,
  SceneFormationSolutionSchema,
  SceneFormationSolvedMemberSchema,
  SceneFormationTransferPolicySchema,
  canonicalSceneFormationJson,
} from "./scene-formation";
export type {
  SceneFormation,
  SceneFormationAnchor,
  SceneFormationConstraint,
  SceneFormationMember,
  SceneFormationResidual,
  SceneFormationSolveReport,
  SceneFormationSolution,
} from "./scene-formation";
export {
  CROSS_MAP_SCENE_MOTIF_SCHEMA_VERSION,
  CROSS_MAP_VARIATION_SCHEMA_VERSION,
  CrossMapMotifActorBehaviorSchema,
  CrossMapMotifActorSchema,
  CrossMapMotifRelationSchema,
  CrossMapSceneMotifSchema,
  CrossMapVariationDiagnosticSchema,
  CrossMapVariationMatchSchema,
  CrossMapVariationConstraintSettingsSchema,
  CrossMapVariationPreviewRequestSchema,
  CrossMapVariationPreviewResponseSchema,
  CrossMapVariationMaterializeRequestSchema,
  CrossMapVariationMaterializeResponseSchema,
} from "./scenario-cross-map";
export type {
  CrossMapSceneMotif,
  CrossMapVariationMatch,
  CrossMapVariationConstraintSettings,
  CrossMapVariationPreviewRequest,
  CrossMapVariationPreviewResponse,
  CrossMapVariationMaterializeRequest,
  CrossMapVariationMaterializeResponse,
} from "./scenario-cross-map";
export type {
  ScenarioInteractionRelocationStatus,
  ScenarioInteractionRelocationDiagnosticCode,
  ScenarioInteractionRelocationDiagnostic,
  ScenarioInteractionRelocationActorBinding,
  ScenarioInteractionRelocationCandidate,
  ScenarioInteractionRelocationSource,
  ScenarioInteractionRelocationReport,
  ScenarioInteractionRelocationRequest,
  ScenarioInteractionRelocationResult,
} from "./scenario-interaction-relocation";
export {
  buildMapTopologyIndex,
  TOPOLOGY_CONTENT_EPOCH,
  buildLanePolygonsLocal,
  constrainTopologyToRuntimeLaneTypes,
  parseXodr,
  classifyTurn,
  turnRelationForHeadingChangeDeg,
  junctionTurnForRelation,
} from "./map-topology/build-topology-index";
export {
  bindRuntimeTopology,
  buildRuntimeTopologyParity,
} from "./map-topology/build-runtime-parity";
export type {
  BuildTopologyArgs,
  LanePolygonLocal,
} from "./map-topology/build-topology-index";
export type { TravelAwareTopologyIndex } from "./map-topology/lane-travel";
export {
  flipFractionForTravel,
  laneTravelIncreasesS,
  laneTravelIncreasesSByConvention,
  laneTravelIncreasesSFromCenterline,
  travelOrderedPolyline,
} from "./map-topology/lane-travel";
export { laneAtPose, DEFAULT_MAX_LANE_DISTANCE_M } from "./map-topology/lane-at-pose";
export type { LaneAtPose, PoseXY } from "./map-topology/lane-at-pose";
export {
  ROADWAY_CONSISTENCY_FORMAT,
  RoadwayConsistencyIntervalSchema,
  RoadwayConsistencyIssueCodeSchema,
  RoadwayConsistencyIssueSchema,
  RoadwayConsistencyReportSchema,
  validateRoadwayConsistency,
} from "./map-topology/roadway-consistency";
export type {
  RoadwayConsistencyInterval,
  RoadwayConsistencyIssue,
  RoadwayConsistencyIssueCode,
  RoadwayConsistencyOptions,
  RoadwayConsistencyReport,
} from "./map-topology/roadway-consistency";
export {
  ScenarioStatus,
  SCENARIO_STATUS_VALUES,
  SimulationStatus,
  SIMULATION_STATUS_VALUES,
} from "./run-status";
export type {
  ScenarioStatus as ScenarioStatusType,
  SimulationStatus as SimulationStatusType,
} from "./run-status";
export {
  ActorSensorRigSchema,
} from "./scenario-render-config";
export type {
  ActorSensorRig,
} from "./scenario-render-config";
export {
  BboxSchema,
  RegionBboxSchema,
  ScenarioLocationSchema,
} from "./scenario-location";
export type { Bbox, RegionBbox, ScenarioLocation } from "./scenario-location";
export {
  EditorOffsetMSchema,
  EuclideanBboxMSchema,
  MapCoordinateRefSchema,
  MapPlaceContextSchema,
  MapSourceSchema,
  MapStatsFeatureInventorySchema,
  MapStatsLaneCountsSchema,
  MapStatsRoadNetworkSchema,
  MapStatsSchema,
  MapStatsSignalizationSchema,
} from "./map-asset-metadata";
export type {
  EditorOffsetM,
  EuclideanBboxM,
  MapCoordinateRef,
  MapPlaceContext,
  MapSource,
  MapStats,
  MapStatsFeatureInventory,
  MapStatsLaneCounts,
  MapStatsRoadNetwork,
  MapStatsSignalization,
} from "./map-asset-metadata";
export {
  MAP_CANDIDATE_LOCATION_KINDS,
  MAP_OVERLAY_LAYER_IDS,
  MapAssetEnrichmentManifestSchema,
  MapAssetEnrichmentSnapshotSchema,
  MapCandidateLocationKindSchema,
  MapCandidateLocationSchema,
  MapEnrichmentFeatureCountsSchema,
  MapEnrichmentProviderSchema,
  MapEnrichmentSummarySchema,
  MapOverlayFeatureReferenceSchema,
  MapOverlayLayerIdSchema,
  MapOverlayLayerSchema,
  MapOverlayPayloadSchema,
} from "./map-asset-enrichment";
export {
  MAP_SEARCH_INDEX_VERSION,
  OSM_ROAD_CLASSES,
  MapSearchIndexAnchorSchema,
  MapSearchIndexBboxSchema,
  MapSearchIndexCentroidSchema,
  MapSearchIndexFeatureRefSchema,
  MapSearchIndexFeatureRoleSchema,
  MapSearchIndexGraphEdgeSchema,
  MapSearchIndexGraphRelationSchema,
  MapSearchIndexGraphSchema,
  MapSearchIndexJunctionFactsSchema,
  MapSearchIndexJunctionObjectSchema,
  MapSearchIndexObjectSchema,
  MapSearchIndexPoiFactsSchema,
  MapSearchIndexPoiKindSchema,
  MapSearchIndexPoiObjectSchema,
  MapSearchIndexSchema,
  MapSearchIndexSegmentFactsSchema,
  MapSearchIndexSegmentObjectSchema,
  MapSearchIndexSourceSignaturesSchema,
  MapSearchIndexStreetFactsSchema,
  MapSearchIndexStreetObjectSchema,
  addressObjectId,
  junctionObjectId,
  poiObjectId,
  segmentObjectId,
  streetObjectId,
} from "./map-search-index";
export type {
  MapSearchIndex,
  MapSearchIndexAddressFacts,
  MapSearchIndexAddressObject,
  MapSearchIndexAnchor,
  MapSearchIndexBbox,
  MapSearchIndexCentroid,
  MapSearchIndexFeatureRef,
  MapSearchIndexFeatureRole,
  MapSearchIndexGraph,
  MapSearchIndexGraphEdge,
  MapSearchIndexGraphRelation,
  MapSearchIndexJunctionFacts,
  MapSearchIndexObject,
  MapSearchIndexPoiFacts,
  MapSearchIndexPoiKind,
  MapSearchIndexSegmentFacts,
  MapSearchIndexSourceSignatures,
  MapSearchIndexStreetFacts,
  OsmRoadClass,
} from "./map-search-index";
export type {
  MapAssetEnrichmentManifest,
  MapAssetEnrichmentSnapshot,
  MapCandidateLocation,
  MapCandidateLocationKind,
  MapEnrichmentFeatureCounts,
  MapEnrichmentProvider,
  MapEnrichmentSummary,
  MapOverlayFeatureReference,
  MapOverlayLayer,
  MapOverlayLayerId,
  MapOverlayPayload,
} from "./map-asset-enrichment";
export {
  MapAssetArtifactSchema,
  MapAssetArtifactsSchema,
  MapAssetArtifactType,
  MapAssetCenterSchema,
  MapAssetSchema,
  MapAssetTagsSchema,
  MapImageryTilesetSchema,
  MAP_ASSET_ARTIFACT_TYPE_VALUES,
} from "./map-asset";
export type {
  MapAsset,
  MapAssetArtifact,
  MapAssetArtifacts,
  MapAssetCenter,
  MapAssetTags,
  MapImageryTileset,
} from "./map-asset";
export {
  CarlaActorCatalogSchema,
  CarlaActorBlueprintGeometrySchema,
  CarlaRuntimeCatalogSchema,
  CARLA_PEDESTRIAN_BLUEPRINTS,
  DEFAULT_CARLA_ACTOR_BLUEPRINTS,
  DEFAULT_CARLA_ACTOR_CATALOG,
  DEFAULT_CARLA_VEHICLE_BLUEPRINTS,
  DEFAULT_CARLA_WALKER_BLUEPRINTS,
  RuntimeCatalogMapSchema,
  RuntimeStreetFurnitureSchema,
} from "./carla-runtime-catalog";
export {
  CARLA_UE5_HEAVY_VEHICLE_BLUEPRINTS,
  CARLA_UE5_STREET_VEHICLE_BLUEPRINTS,
  CARLA_UE5_VEHICLE_BLUEPRINT_METADATA,
  CARLA_UE5_VEHICLE_BLUEPRINTS,
  isCarlaUe5VehicleBlueprint,
  toCarlaUe5VehicleBlueprint,
} from "./carla-ue5-vehicle-blueprints";
export type { CarlaUe5VehicleBlueprint } from "./carla-ue5-vehicle-blueprints";
export {
  BlueprintSubstitutionRelaxationSchema,
  CARLA_BLUEPRINT_CLASS_FALLBACK_DIMENSIONS_M,
  CARLA_BLUEPRINT_CLASSES,
  classifyCarlaBlueprint,
  CrossMapVariationRelaxationSchema,
  planBlueprintSubstitutions,
  selectSubstituteBlueprint,
  SignalCommandDroppedRelaxationSchema,
  SignalPlanDroppedRelaxationSchema,
} from "./carla-blueprint-substitution";
export type {
  BlueprintFootprintDimensions,
  BlueprintSubstitutionPlan,
  BlueprintSubstitutionRelaxation,
  BlueprintSubstituteSelection,
  CarlaBlueprintClass,
  CrossMapVariationRelaxation,
  SignalCommandDroppedRelaxation,
  SignalPlanDroppedRelaxation,
  SubstituteCatalogEntry,
} from "./carla-blueprint-substitution";
export {
  CARLA_UE5_WALKER_BLUEPRINTS,
  CARLA_UE5_WALKER_ADULTS,
  CARLA_UE5_WALKER_CHILDREN,
  CARLA_UE5_WALKER_TEENAGERS,
  CARLA_UE5_WALKER_AGE,
  CARLA_UE5_WALKER_DENYLIST,
  isValidWalkerBlueprint,
  walkerBlueprintAt,
} from "./carla-ue5-walker-blueprints";
export type { WalkerAge } from "./carla-ue5-walker-blueprints";
export type {
  CarlaActorCatalog,
  CarlaRuntimeCatalog,
  RuntimeCatalogMap,
  RuntimeStreetFurnitureContract,
} from "./carla-runtime-catalog";
export { MapAssetAddressSchema } from "./map-asset-address";
export type { MapAssetAddress } from "./map-asset-address";
export { MapAssetBuildingSchema } from "./map-asset-building";
export type { MapAssetBuilding } from "./map-asset-building";
export {
  getMapAssetDescriptorTag,
  MAP_ASSET_DESCRIPTOR_TAGS,
  MAP_ASSET_DESCRIPTOR_TAG_IDS,
} from "./map-asset-tags";
export type {
  MapAssetDescriptorPriority,
  MapAssetDescriptorTag,
} from "./map-asset-tags";
export {
  CarlaSpawnStrategySchema,
  CarlaTrafficConfigSchema,
  CarlaTrafficCardSchema,
  TrafficCardLaneSelectionSchema,
  TrafficCardSchema,
  TrafficCardVehicleMixSchema,
  TrafficEngine,
  TrafficManagerIntentSchema,
  TrafficManagerSchema,
  TrafficDistributionEntrySchema,
  TrafficPopulationSchema,
  TRAFFIC_ENGINE_VALUES,
  parseCarlaTrafficConfig,
  parseEngineConfig,
} from "./traffic-manager";
export type {
  CarlaSpawnStrategy,
  CarlaTrafficConfig,
  CarlaTrafficCard,
  TrafficCard,
  TrafficCardLaneSelection,
  TrafficCardVehicleMix,
  TrafficAggressiveness,
  TrafficDensity,
  TrafficManager,
  TrafficManagerIntent,
  TrafficDistributionEntry,
  TrafficPopulation,
  VehicleMixPreset,
} from "./traffic-manager";
export {
  // Sensor types (unified, flat)
  SensorCategory,
  SensorOutputModality,
  RenderOutputProfile,
  RenderOutputAnnotation,
  RenderOutputMetadata,
  RenderOutputEncoding,
  RenderOutputSpecSchema,
  SdgCosmosConfigSchema,
  SdgPostprocessConfigSchema,
  SdgRecipeConfigSchema,
  SdgRecipeStageConfigSchema,
  SdgRecorderConfigSchema,
  SensorAttachmentType,
  SensorPoseSchema,
  SensorSchema,
  SimulationEngine,
  // Native scenario definition types
  FileHeaderSchema,
  ParameterDeclarationSchema,
  RoadNetworkSchema,
  WorldPositionSchema,
  VehicleCategory,
  PedestrianCategory,
  BoundingBoxSchema,
  VehicleEntitySchema,
  PedestrianEntitySchema,
  MiscObjectEntitySchema,
  EntityObjectSchema,
  ObjectControllerSchema,
  ScenarioObjectSchema,
  EntityLifecycleSchema,
  InitActionSchema,
  ManeuverActionSchema,
  TriggerConditionSchema,
  TriggerSchema,
  EventSchema,
  ManeuverSchema,
  ManeuverGroupSchema,
  ActSchema,
  StorySchema,
  StoryboardSchema,
  ScenarioDefinitionSchema,
  // Helpers
  isEgoEntity,
  getEntityCategory,
  blueprintToVehicleCategory,
  // Output & Artifact — primary names
  DEFAULT_OUTPUT_CONFIG,
  GeneratedBy,
  OutputConfigSchema,
  OutputType,
  SimulationArtifactSchema,
  ScenarioSchema,
} from "./simulation-run";
export type {
  Sensor,
  RenderOutputProfile as RenderOutputProfileValue,
  RenderOutputAnnotation as RenderOutputAnnotationValue,
  RenderOutputMetadata as RenderOutputMetadataValue,
  RenderOutputEncoding as RenderOutputEncodingValue,
  RenderOutputSpec,
  SdgCosmosConfig,
  SdgPostprocessConfig,
  SdgRecipeConfig,
  SdgRecipeStageConfig,
  SdgRecorderConfig,
  SensorPose,
  SensorAttachmentType as SensorAttachmentTypeValue,
  // Native scenario definition types
  FileHeader,
  ParameterDeclaration,
  RoadNetwork,
  WorldPosition,
  BoundingBox,
  VehicleEntity,
  PedestrianEntity,
  MiscObjectEntity,
  EntityObject,
  ObjectController,
  ScenarioObject,
  EntityLifecycle,
  InitAction,
  ManeuverAction,
  TriggerCondition,
  Trigger,
  Event,
  Maneuver,
  ManeuverGroup,
  Act,
  Story,
  Storyboard,
  ScenarioDefinition,
  // Primary names
  Scenario,
  SimulationArtifact,
  GeneratedBy as GeneratedByType,
  OutputConfig,
} from "./simulation-run";

export {
  CANDIDATE_LOCATION_KINDS,
  CANDIDATE_LOCATION_SOURCES,
  CandidateLocationEvidenceSchema,
  CandidateLocationKindSchema,
  CandidateLocationRegionSchema,
  CandidateLocationSchema,
  CandidateLocationSourceSchema,
  OCCLUSION_SUBTYPES,
  OcclusionSeveritySchema,
  OcclusionSubtypeSchema,
  RegionPointSchema,
  RegionPolygonSchema,
} from "./map-candidate-location";
export type {
  CandidateLocation,
  CandidateLocationEvidence,
  CandidateLocationKind,
  CandidateLocationRegion,
  CandidateLocationSource,
  OcclusionSeverity,
  OcclusionSubtype,
  OcclusionSupportingFeatures,
} from "./map-candidate-location";

export {
  ACCIDENT_DATASETS,
  ACCIDENT_EVENTS_SCHEMA_VERSION,
  ACCIDENT_SEVERITIES,
  AccidentDatasetSchema,
  AccidentEventSchema,
  AccidentSeveritySchema,
} from "./accident-events";
export type {
  AccidentDataset,
  AccidentEvent,
  AccidentSeverity,
} from "./accident-events";

// Enrichment utilities — pure functions shared across enrichment and metadata workflows
export {
  bboxFromCoords,
  bboxIntersects,
  bboxToLine,
  bboxToPoint,
  bboxToPolygon,
  clipBbox,
  expandBbox,
  featureBbox,
  deriveEnrichmentTags,
  buildCandidateLocations,
  clusterLocations,
  clusterLocationsKeyed,
  MIN_BBOX_RADIUS_M,
  extractJunctionCandidates,
  extractStreetParkingCandidates,
  extractOvertureCandidates,
  extractBuildings,
  extractAddresses,
  attachRoadAccessToAddresses,
  applyAddressContext,
  copyBuildingRowAddressFieldsToFeature,
  mapAssetAddressRowId,
  mapAssetBuildingRowId,
  extractParkingCandidates,
  pointInPolygon,
  pointInBbox,
  parsePolygonRings,
  simplifyPolygon,
  // XODR geometry & projection utilities (used by scene graph builders and apps/web metadata)
  localToLonLat,
  sampleGeometry,
  resolveSTtoXY,
  resolveSTtoXYWithHeading,
  parseGeometrySegments,
  sampleRoadReferenceLineToLonLat,
  attr,
  stripXmlComments,
  extractGeoReferenceText,
  parseProjOrigin,
  projProjectionType,
  utmZoneFromLonLat,
  parseDatum,
  parseHorizontalUnits,
  parseVerticalUnits,
  // proj4-backed projection wrapper (replaces hand-rolled TMerc and the
  // earlier flat-earth equirectangular it replaced).
  MapProjection,
  synthesizeTmercProjString,
  // Scene graph + pipeline
  buildMapSceneGraph,
  buildParkingClusters,
  buildRoadSegments,
  runAllDetectors,
  DETECTOR_REGISTRY,
  generateCandidates,
  selectTopK,
  poolCandidates,
  // Road proximity filter
  extractRoadNetworkPoints,
  filterByRoadProximity,
  filterEnrichmentSnapshotByRoadProximity,
  ROAD_PROXIMITY_THRESHOLD_M,
  // Convex hull (standalone geometry utility)
  convexHull,
  // Street name resolver
  resolveStreetNamesForCandidates,
  NAMEABLE_KINDS,
  // Occlusion-likelihood candidate generation
  runMetadataPhaseOcclusion,
  runEnrichmentPhaseOcclusion,
  OCCLUSION_DETECTOR_VERSION,
  // Pedestrian-spawn eligibility (canonical signal consumed by sidecar
  // build, legacy corpus build, geometry tool, scenario builder)
  isPedestrianSpawnCandidate,
  PEDESTRIAN_SPAWN_KINDS,
  PEDESTRIAN_SPAWN_OCCLUSION_SUBTYPES,
} from "./enrichment";
export type {
  OcclusionMetadataPhaseInput,
  OcclusionEnrichmentPhaseInput,
  OcclusionBuilding,
  OcclusionPoi,
  OcclusionLatLng,
} from "./enrichment";
export type { XodrJunctionMatchInfo } from "./enrichment";
export type { ExtractedOvertureCandidate } from "./enrichment";
export type { ExtractedParkingCandidate } from "./enrichment";
export type { OvertureParkingLot } from "./enrichment";
export type { XY, GeometrySegment, CoordTransform } from "./enrichment";
export type {
  BuildSceneGraphOptions,
  BuildSceneGraphResult,
} from "./enrichment";
export type { RoadNetworkPoint } from "./enrichment";
export type { LngLat } from "./enrichment";
export type {
  ExtractedAddress,
  ExtractAddressesResult,
  OvertureAddressInput,
  ExtractedBuilding,
  OvertureBuildingInput,
  Ring,
  PolygonRings,
} from "./enrichment";
export type { GenerateCandidatesOptions } from "./enrichment";
export type {
  CandidateForNaming,
  RoadSegmentForMatching,
  StreetNameResolution,
  MatchedRoadSegment,
  ResolveOptions,
} from "./enrichment";
export type { AttachRoadAccessOptions } from "./enrichment";
export type { ApplyAddressContextOptions } from "./enrichment";

// Map intelligence types — scene graph entities, detectors, pipeline output
export {
  ProvenanceSchema,
  SceneEntityKindSchema,
  JunctionEntitySchema,
  RoadSegmentEntitySchema,
  CrosswalkEntitySchema,
  ParkingClusterEntitySchema,
  SignalEntitySchema,
  DetectorEvidenceSchema,
  DetectorResultSchema,
  MapSceneGraphSchema,
} from "./map-intelligence";
export type {
  Provenance,
  SceneEntityKind,
  JunctionEntity,
  RoadSegmentEntity,
  CrosswalkEntity,
  ParkingClusterEntity,
  SignalEntity,
  DetectorEvidence,
  DetectorResult,
  Detector,
  MapSceneGraph,
} from "./map-intelligence";

export {
  EnrichmentJobTypeSchema,
  EnrichmentJobStatusSchema,
  EnrichmentJobSchema,
} from "./map-asset-enrichment-job";
export type {
  EnrichmentJobType,
  EnrichmentJobStatus,
  EnrichmentJob,
  EnrichmentJobQueueMessage,
} from "./map-asset-enrichment-job";

export {
  ScenarioValidationJobStatusSchema,
  ScenarioValidationJobPurposeSchema,
  ScenarioValidationVerdictSchema,
  ScenarioValidationRepairKindSchema,
  ScenarioValidationJobSchema,
  EsminiTrajectoryPointSchema,
  EsminiActorTrajectorySchema,
  EsminiCollisionEventSchema,
  EsminiValidationMetricsSchema,
} from "./scenario-validation-job";
export type {
  ScenarioValidationJobStatus,
  ScenarioValidationJobPurpose,
  ScenarioValidationVerdict,
  ScenarioValidationRepairKind,
  ScenarioValidationJob,
  ScenarioValidationQueueMessage,
  EsminiExpectedOutcome,
  EsminiTrajectoryPoint,
  EsminiActorTrajectory,
  EsminiCollisionEvent,
  EsminiValidationMetrics,
} from "./scenario-validation-job";
export {
  parseEsminiCsv,
  summarizeMetrics,
  verdictFromMetrics,
} from "./esmini-state-log";
export type { ParsedEsminiStateLog } from "./esmini-state-log";

export {
  DEFAULT_LINT_CONFIG,
  compactLintReport,
  fromCarlaActorTrack,
  fromEsminiTrajectories,
  fromPreviewFrames,
  lintActorTracks,
  resolveLintConfig,
  SCENARIO_LINT_SCHEMA_VERSION,
  ScenarioLintActorPeaksSchema,
  ScenarioLintCompactReportSchema,
  ScenarioLintSeverityCountsSchema,
} from "./scenario-lint";
export type {
  LintActorKind,
  LintActorKinds,
  LintActorReport,
  LintActorTrack,
  LintConfig,
  LintMetricSample,
  LintReport,
  LintSeverity,
  LintThreshold,
  LintTrackSample,
  LintViolation,
  LintViolationKind,
  PreviewActorSample,
  PreviewFrame as LintPreviewFrame,
  ResolvedLintConfig,
  ScenarioLintActorPeaks,
  ScenarioLintCompactReport,
  ScenarioLintSeverityCounts,
} from "./scenario-lint";

export {
  createSimulationJobPayload,
  createWebhookCompletionPayload,
  createScenarioDraft,
  createArtifactRecord,
  createSensor,
} from "./test-fixtures";
export type {
  SimulationJobPayload,
  WebhookCompletionPayload,
} from "./test-fixtures";

export {
  BaseJobContractSchema,
  CANONICAL_JOB_STATUS_VALUES,
  CanonicalJobStatusSchema,
  InitiatorSurfaceSchema,
  JOB_FAMILY_VALUES,
  JobFamilySchema,
  JobPurposeSchema,
  normalizeCanonicalJobStatus,
  phaseForLegacyStatus,
} from "./job-family";
export type {
  BaseJobContract,
  CanonicalJobStatus,
  InitiatorSurface,
  JobFamily,
  JobPurpose,
} from "./job-family";

export {
  ArtifactFamilySchema,
  ArtifactManifestItemSchema,
  ArtifactManifestSchema,
  ArtifactRetentionClassSchema,
  ArtifactStatusSchema,
  CanonicalArtifactSchema,
} from "./artifact";
export type {
  ArtifactFamily,
  ArtifactManifest,
  ArtifactManifestItem,
  ArtifactRetentionClass,
  ArtifactStatus,
  CanonicalArtifact,
} from "./artifact";

export {
  WorkspaceDatasetStorageRowSchema,
  WorkspaceScenarioStorageRowSchema,
  WorkspaceStorageArtifactGroupSchema,
  WorkspaceStorageAvailabilitySchema,
  WorkspaceStorageBlockerSchema,
  WorkspaceStorageCleanupActionSchema,
  WorkspaceStorageDeletionPreviewRequestSchema,
  WorkspaceStorageDeletionPreviewSchema,
  WorkspaceStoragePolicySchema,
  WorkspaceStorageProtectionReasonSchema,
  WorkspaceStorageSelectionSchema,
  WorkspaceStorageSummarySchema,
  WorkspaceTrashRowSchema,
} from "./workspace-storage";
export type {
  WorkspaceDatasetStorageRow,
  WorkspaceScenarioStorageRow,
  WorkspaceStorageArtifactGroup,
  WorkspaceStorageCleanupAction,
  WorkspaceStorageDeletionPreview,
  WorkspaceStorageDeletionPreviewRequest,
  WorkspaceStoragePolicy,
  WorkspaceStorageSelection,
  WorkspaceStorageSummary,
  WorkspaceTrashRow,
} from "./workspace-storage";

export {
  DatasetPublicationKindSchema,
  DatasetPublicationSchema,
  DatasetSnapshotItemRoleSchema,
  DatasetSnapshotItemSchema,
  DatasetSnapshotSchema,
  DatasetSplitSchema,
} from "./dataset-snapshot";
export type {
  DatasetPublication,
  DatasetPublicationKind,
  DatasetSnapshot,
  DatasetSnapshotItem,
  DatasetSnapshotItemRole,
  DatasetSplit,
} from "./dataset-snapshot";

export {
  DatasetExportScopeSchema,
} from "./dataset-export-scope";
export type { DatasetExportScope } from "./dataset-export-scope";

export {
  DatasetExportRequestedOutputDeliverySchema,
  DatasetExportRequestedOutputKindSchema,
  DatasetExportRequestedOutputSchema,
  DatasetExportRequestedOutputsSchema,
} from "./dataset-export-requested-outputs";
export type {
  DatasetExportRequestedOutput,
  DatasetExportRequestedOutputDelivery,
  DatasetExportRequestedOutputKind,
  DatasetExportRequestedOutputs,
} from "./dataset-export-requested-outputs";

export {
  DatasetExportTaskInputSchema,
  PackageArchiveTaskInputSchema,
  PrefixMaterializeTaskInputSchema,
  PublicationFinalizeTaskInputSchema,
  SnapshotResolveTaskInputSchema,
} from "./dataset-export-task-input";
export type {
  DatasetExportTaskInput,
  PackageArchiveTaskInput,
  PrefixMaterializeTaskInput,
  PublicationFinalizeTaskInput,
  SnapshotResolveTaskInput,
} from "./dataset-export-task-input";

export {
  DatasetExportJobSchema,
  DatasetExportPublicationKindSchema,
  DatasetExportPublicationSchema,
  DatasetExportPublicationStatusSchema,
  DatasetExportTaskSchema,
  DatasetExportTaskStageSchema,
  DatasetExportTaskStatusSchema,
  RequestedExportOutputSchema,
} from "./dataset-export-v2";
export type {
  DatasetExportJob,
  DatasetExportPublication,
  DatasetExportPublicationKind,
  DatasetExportPublicationStatus,
  DatasetExportTask,
  DatasetExportTaskStage,
  DatasetExportTaskStatus,
  RequestedExportOutput,
} from "./dataset-export-v2";

export {
  CarlaDeterminismSchema,
  CarlaRunManifestSchema,
} from "./carla-run-manifest";
export type {
  CarlaDeterminism,
  CarlaRunManifest,
} from "./carla-run-manifest";

export {
  DatasetCompletenessBlockerSchema,
  DatasetCompletenessReportSchema,
  DatasetContractKindSchema,
  DatasetReadinessLevelSchema,
} from "./dataset-completeness";
export type {
  DatasetCompletenessBlocker,
  DatasetCompletenessReport,
  DatasetContractKind,
  DatasetReadinessLevel,
} from "./dataset-completeness";

export {
  CARLA_LIVE_E2E_FIXTURE_VERSION,
  CARLA_LIVE_E2E_REPORT_VERSION,
  CARLA_LIVE_E2E_TIMELINE_VERSION,
  CarlaLiveE2eComparisonSchema,
  CarlaLiveE2eEnvironmentSchema,
  CarlaLiveE2eFixtureManifestSchema,
  CarlaLiveE2eFixtureSchema,
  CarlaLiveE2eReportSchema,
  CarlaLiveE2eStatusSchema,
  CarlaLiveE2eSuiteSchema,
  CarlaLiveE2eToleranceSchema,
  CarlaTimelineActorSampleSchema,
  CarlaTimelineArtifactSchema,
  CarlaTimelineFrameSchema,
} from "./carla-live-e2e";
export type {
  CarlaLiveE2eComparison,
  CarlaLiveE2eEnvironment,
  CarlaLiveE2eFixture,
  CarlaLiveE2eFixtureManifest,
  CarlaLiveE2eReport,
  CarlaLiveE2eStatus,
  CarlaLiveE2eSuite,
  CarlaLiveE2eTolerance,
  CarlaTimelineActorSample,
  CarlaTimelineArtifact,
  CarlaTimelineFrame,
} from "./carla-live-e2e";
export {
  ACTOR_BEHAVIOR_SCHEMA_VERSION,
  BEHAVIOR_ACTION_KINDS,
  BEHAVIOR_EVENT_CLIP_ENDED,
  BEHAVIOR_EVENT_CLIP_STARTED,
  BEHAVIOR_EVENT_TRIGGER_FIRED,
  BEHAVIOR_ROUTE_ANCHOR_CAP,
  BEHAVIOR_TIME_QUANTUM_S,
  BEHAVIOR_TRIGGER_KINDS,
  DEFAULT_BEHAVIOR_CLIP_END,
  DEFAULT_BEHAVIOR_TRIGGER,
  DEFAULT_REACTION_AGGRESSIVENESS,
  LEGACY_CREEP_SPEED_KPH,
  LEGACY_FOLLOWING_DISTANCE_M,
  LEGACY_REVERSE_SPEED_KPH,
  LEGACY_STOP_DECEL_WINDOW_S,
  LEGACY_SWERVE_OFFSET_M,
  LEGACY_WALKER_CONFLICT_TRIGGER_DISTANCE_M,
  ActorBehaviorProgramSchema,
  ACTOR_ROUTE_ACTION_KINDS,
  BehaviorActionKindSchema,
  BehaviorActionSchema,
  BehaviorActorRefSchema,
  BehaviorClipEndSchema,
  BehaviorClipRoleSchema,
  BehaviorClipSchema,
  BehaviorEventSchema,
  BehaviorFidelitySchema,
  BehaviorMapPointSchema,
  BehaviorRoadAnchorSchema,
  BehaviorSignalRefSchema,
  BehaviorSignalStateSchema,
  BehaviorTriggerKindSchema,
  BehaviorTriggerSchema,
  BehaviorWaypointSchema,
  ReactionProfileModeSchema,
  ReactionProfileSchema,
  behaviorActorRef,
  crossWhenClip,
  emptyActorBehaviorProgram,
  laneFrameSign,
  migrateActorDraft,
  migrateActorDraftReactionProfile,
  migrateActorDraftToBehaviorProgram,
  quantizeBehaviorTimeSeconds,
  readBehaviorEvents,
} from "./scenario-behavior";
export {
  DIVERT_TAIL_MAX_M,
  divertTailFromAbsolute,
  divertTailLengthM,
  resolveDivertTail,
  type DivertTailPoint,
  type DivertTriggerPose,
  type ResolvedDivertPoint,
} from "./divert-tail";
export type {
  ActorBehaviorMigrationContext,
  ActorBehaviorMigrationResult,
  ActorBehaviorProgram,
  BehaviorAction,
  BehaviorActionKind,
  BehaviorActorRef,
  BehaviorClip,
  BehaviorClipEnd,
  BehaviorClipRole,
  BehaviorEvent,
  BehaviorFidelity,
  BehaviorMapPoint,
  BehaviorRoadAnchor,
  BehaviorSignalRef,
  BehaviorSignalState,
  BehaviorTrigger,
  BehaviorTriggerKind,
  BehaviorWaypoint,
  ReactionProfile,
  ReactionProfileMode,
} from "./scenario-behavior";
export {
  baseActionForDraft,
  baseClip,
  baseClipId,
  baseClipIndex,
  expandLegacyWireActor,
  isBaseClip,
  migrateLegacyScenarioEditorActor,
  normalizeActorBaseClip,
  placementFieldsFromBaseClip,
  withBaseAction,
  withBaseSpeed,
  withCompiledBaseClip,
  type CompiledActorPlacementFields,
} from "./behavior-base-clip";
export {
  BEHAVIOR_FIDELITY_GLYPHS,
  BEHAVIOR_FIDELITY_LABELS,
  clipFidelity,
  emptyFidelitySummary,
  fidelityContextForActor,
  hasFidelityLoss,
  signalPlanFidelity,
  summarizeFidelity,
} from "./scenario-behavior-fidelity";
export type {
  ClipFidelityContext,
  ClipFidelityVerdict,
  FidelitySummary,
} from "./scenario-behavior-fidelity";
export {
  BEHAVIOR_EVENT_SIGNAL_STATE_CHANGED,
  BEHAVIOR_SCENE_ACTOR_ID,
  DEFAULT_PHASE_ALL_RED_S,
  DEFAULT_PHASE_GREEN_S,
  DEFAULT_PHASE_YELLOW_S,
  SIGNAL_PLAN_MODES,
  SIGNAL_PLAN_SCHEMA_VERSION,
  SIGNAL_PLAN_WARNING_CODES,
  SIGNAL_TURNS,
  SCENE_ACTION_KINDS,
  JunctionMovementBindingSchema,
  JunctionSignalPlanSchema,
  MovementIdSchema,
  SceneActionKindSchema,
  SceneActionSchema,
  SceneClipSchema,
  SetJunctionStateActionSchema,
  SetMovementStateActionSchema,
  SignalPhaseIntervalSchema,
  SignalPhaseProgramSchema,
  SignalPlanModeSchema,
  SignalPlanWarningCodeSchema,
  SignalPlanWarningSchema,
  SignalPlansSchema,
  SignalStateChangedEventSchema,
  SignalTurnSchema,
  approachIdFromLaneRsl,
  compassLabel,
  deriveConflictFreeGroups,
  deriveJunctionMovementTable,
  deriveJunctionMovements,
  deriveMovementConflicts,
  detectSignalPlanWarnings,
  formatMovementId,
  junctionGatesFromTopology,
  mapDefaultSignalPlan,
  movementStateAt,
  parseMovementId,
  resolveBehaviorSignalRef,
  readSignalStateEvents,
  signalBandsFromEvents,
  signalChannelId,
  signalPhaseAt,
  signalPlanIssues,
  signalProgramCycleDurationS,
  signalTurnFromRelation,
  synthesizeSignalProgram,
  withSignalPlanWarnings,
} from "./scenario-signals";
export type {
  JunctionGateInput,
  JunctionMovementBinding,
  JunctionSignalPlan,
  MovementConflict,
  SceneAction,
  SceneActionKind,
  SceneClip,
  SignalPhaseInterval,
  SignalPhaseProgram,
  SignalPlanMode,
  SignalPlanWarning,
  SignalPlanWarningCode,
  SignalStateChangedEvent,
  SignalTurn,
  TopologyIndexLike,
} from "./scenario-signals";
export {
  attachSignalIdsToGates,
  buildSignalPlacementIndex,
  deriveXodrSignalGroups,
  enrichXodrWithSignalControllers,
  isEsminiTrafficLightSignal,
  normalizeXodrForEsmini,
  normalizeXodrForEsminiWithStats,
  refineMovementSignalIds,
} from "./xodr-signal-controllers";
export type {
  ApproachSide,
  DeriveXodrSignalGroupsResult,
  EnrichXodrOptions,
  EnrichXodrResult,
  GateWithSignals,
  MovementBindingWithSignals,
  NormalizeXodrForEsminiResult,
  XodrApproachSignals,
  XodrJunctionSignalGroup,
  XodrMovementSignals,
  XodrPhaseGroup,
  XodrPhaseGrouping,
  XodrSignalPlacement,
} from "./xodr-signal-controllers";
// OpenSCENARIO importer (.xosc -> native job_spec) + post-sim checks/parity.
export {
  parseXoscToActors,
  XoscImportError,
  xoscToJobSpec,
  xoscActorsToJobSpecActors,
  computeEffectiveMotion,
  diffEffectiveMotion,
} from "./xosc/index";
export type {
  XoscImportedActor,
  XoscImportedScenario,
  XoscMapPoint,
  XoscTimedWaypoint,
  XoscJobSpec,
  XoscJobSpecActor,
  XoscToJobSpecOptions,
  EffectiveMotion,
  EffectiveMotionActorInput,
  EffectiveMotionDiff,
  EffectivePoint,
  EffectiveTimedPoint,
} from "./xosc/index";
export {
  buildPostSimChecklist,
  summarizeChecks,
  tracksFromEsminiTrajectories,
  tracksFromCarlaTimeline,
  runKinematicChecks,
  DEFAULT_KINEMATIC_THRESHOLDS,
  runOscRoundTripChecks,
  OSC_SUPPORTED_PLACEMENT_MODES,
  // The barrel-level `compareRuns` is the M3.3 parity harness below; the
  // post-sim checklist's track-level comparator keeps an aliased name.
  compareRuns as comparePostSimRuns,
  parityToChecks,
} from "./scenario-checks/index";
export type {
  CheckActorTrack,
  CheckTrackSample,
  ScenarioCheck,
  ScenarioCheckCategory,
  ScenarioCheckReport,
  ScenarioCheckStatus,
  KinematicThresholds,
  OscCheckSourceActor,
  OscRoundTripOptions,
  PostSimChecklistInput,
  ParityResult,
  ActorParity,
  ParityTolerance,
} from "./scenario-checks/index";
export {
  DEFAULT_PARITY_CONFIG,
  PARITY_REPORT_VERSION,
  ParityActorResultSchema,
  ParityCollisionPairResultSchema,
  ParityConfigSchema,
  ParityExcludedActorSchema,
  ParityReportSchema,
  compareRuns,
  resolveParityConfig,
} from "./parity";
export type {
  DeepPartial,
  ParityActorResult,
  ParityCollisionEvent,
  ParityConfig,
  ParityEventInputs,
  ParityExcludedActor,
  ParityFrame,
  ParityFrameActor,
  ParityReport,
  ParityRunEvents,
} from "./parity";
export {
  isUniScenarioParityEvidenceAccepted,
  UNISCENARIO_NATIVE_PHYSICS_ACCEPTANCE_LIMITS,
  UNISCENARIO_PARITY_EVIDENCE_VERSION,
  UNISCENARIO_REFERENCE_EQUIVALENCE_LIMITS,
  UNISCENARIO_RENDER_RESOURCE_REQUEST_VERSION,
  UNISCENARIO_LOCAL_RTX5080_HARDWARE_PROFILE,
  UNISCENARIO_RTX3080_HARDWARE_PROFILE,
  UniScenarioParityEvidenceV1Schema,
  UniScenarioRenderResourceRequestSchema,
  UniScenarioRenderHardwareProfileSchema,
  UniScenarioRenderWorkerIdentitySchema,
} from "./uniscenario-render-control";
export type {
  UniScenarioParityEvidenceV1,
  UniScenarioRenderResourceRequest,
  UniScenarioRenderHardwareProfile,
  UniScenarioRenderWorkerIdentity,
} from "./uniscenario-render-control";
