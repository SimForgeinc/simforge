/**
 * `@uniscenarios/sim-engine` — the deterministic scenario simulation engine
 * (layer 3 of `docs/agent-authoring-architecture.md`).
 *
 * Pure TypeScript, zod for the input contract, no rendering dependency: the
 * editor preview and the headless CLI run *this* code, byte for byte.
 *
 * ```ts
 * const graph = buildLaneGraph(await loadTopologyIndex(url));
 * const input = parseSimScenarioInput(doc);
 * const { trace } = runSimulation(input, { graph });
 * const verdict = evaluateTrace(trace);
 * ```
 */

export { ENGINE_VERSION } from './version.js';

/* ------------------------------------------------------------- the contract */
export {
  resolveOverlappingControlLanes,
  type ControlBindingRepair,
} from './sim/signals.js';

export {
  simScenarioInputSchema,
  parseSimScenarioInput,
  safeParseSimScenarioInput,
  normalizeSimScenarioInput,
  resolvePhysicsConfig,
  ACTOR_KINDS,
  MOTION_PHYSICS_MODES,
  DEFAULT_MOTION_PHYSICS_MODE,
  DEFAULT_ACTOR_DIMS,
  CONTROL_INDICATIONS,
  isPedestrianLikeKind,
  isRoadActorKind,
  actorSchema,
  actorRulesSchema,
  arrivalSpecSchema,
  conditionSchema,
  dynamicsSchema,
  interactionSchema,
  laneRefSchema,
  occluderSchema,
  occlusionPairSchema,
  nearMissCriterionSchema,
  operationalConditionsSchema,
  motionPhysicsModeSchema,
  physicsConfigSchema,
  vehiclePhysicsProfileSchema,
  poseSchema,
  regionSchema,
  routeSpecSchema,
  roadControlSchema,
  signalProgramSchema,
  surfacePatchSchema,
  staticPropSchema,
  triggerSchema,
  verbSchema,
} from './schema/input.js';
export type {
  ActorKind,
  ActorRules,
  ArrivalPoint,
  ArrivalSpec,
  Condition,
  ControlIndication,
  Dims,
  Dynamics,
  Interaction,
  LaneChangeTarget,
  LaneRef,
  Occluder,
  OcclusionPair,
  NearMissCriterion,
  OperationalConditions,
  MotionPhysicsMode,
  PhysicsConfig,
  ResolvedPhysicsConfig,
  VehiclePhysicsProfile,
  Pose,
  Region,
  RoadControl,
  RouteSpec,
  ScenePoint,
  SignalProgram,
  SimActor,
  SimSchemaIssue,
  SimScenarioInput,
  SimScenarioInputSpec,
  SpeedTarget,
  StaticProp,
  SurfacePatch,
  Trigger,
  TurnRelation,
  VerbSpec,
} from './schema/input.js';
export { pruneDanglingAfterInteractions } from './schema/repair.js';
export type { RemovedDanglingInteraction } from './schema/repair.js';

/* ------------------------------------------------------------------ frames */
export { localFromScene, toSceneXZ, sceneHeading } from './frames.js';
export type { SceneXZ } from './frames.js';

/* -------------------------------------------------------------------- maps */
export { buildLaneGraph, LaneGraph, ENDPOINT_TOL_M } from './map/lane-graph.js';
export type { DirectedLane, LaneGeometry } from './map/lane-graph.js';
export { pointOf } from './map/topology.js';
export { decodeTopologyIndex } from './map/decode-topology.js';
export type { TopologyIndexFile } from './map/decode-topology.js';
export type {
  LaneRsl,
  TopologyGate,
  TopologyIndex,
  TopologyJunction,
  TopologyLane,
} from './map/topology.js';
export {
  buildRoute,
  buildFollowRoute,
  buildLanePathRoute,
  buildSeededPlacementRoute,
  buildDefaultPlacementRoute,
  Route,
  retargetToLane,
  retargetToNeighbour,
} from './map/route.js';
export type { PlacementRouteOptions, RouteLeg, RoutePose, RouteBuildError, SeededPlacementRouteOptions, SeededPlacementRouteResult } from './map/route.js';

/* ------------------------------------------------------------------ engine */
export { createFixedStepSimulation, runSimulation } from './sim/engine.js';
export type { StaticColliderClass, StaticMapCollider } from './sim/static-colliders.js';
export type {
  ActionHook,
  ActionHookContext,
  ActionOverride,
  AdvanceOptions,
  EngineTickObservation,
  FixedStepSimulationProgress,
  FixedStepSimulationSession,
  RunOptions,
  SessionActorSnapshot,
  SessionPairMinima,
  SimResult,
  SimulationSnapshot,
  TickObserver,
} from './sim/engine.js';
export { evaluateCondition } from './sim/triggers.js';
export type { ConditionContext } from './sim/triggers.js';
export { buildOccluders, hasLineOfSight, blockingOccluder } from './sim/visibility.js';
export type { OccluderShape } from './sim/visibility.js';
export { DEFAULT_DARK_DWELL_S, SignalBook, phaseForbidsEntry, SIGNAL_SNAPSHOT_TICK_HZ, signalSnapshotAt } from './sim/signals.js';
export type { SignalPhase, SignalState, SignalSnapshot, StopLineAuthority, StopLineBinding } from './sim/signals.js';

/* ----------------------------------------------------- localised conditions */
export { SURFACE_KINDS, SURFACE_KIND_FRICTION_SCALE, SurfaceField } from './environment.js';
export type { SurfaceKind, SurfacePatchSpec, SurfaceQuery, SurfaceSample } from './environment.js';
export {
  MOTION_LIMITS_BY_KIND,
  PEDESTRIAN_LIMITS,
  VEHICLE_LIMITS,
  limitsFor,
  gapScaleFor,
  requiredDecelFor,
} from './sim/controllers.js';
export type { MotionLimits } from './sim/controllers.js';
export { shapeValue, transitionDuration, transitionValue } from './sim/dynamics.js';
export {
  DynamicV1Backend,
  DYNAMIC_V1_DEFAULT_SUBSTEP_S,
  GENERIC_PASSENGER_CAR_PROFILE,
  resolveVehiclePhysicsProfile,
} from './sim/dynamic-v1.js';
export type { ResolvedVehiclePhysicsProfile } from './sim/dynamic-v1.js';
export type {
  MotionActorInitialization,
  MotionBackend,
  MotionIntent,
  MotionStepResult,
  PhysicsTelemetrySample,
  VehicleControl,
  VehicleMotionState,
} from './sim/motion-backend.js';
export { actorPhysicsBackend, actorPhysicsBackends, physicsBackendCounts } from './sim/physics-provenance.js';
export {
  alongRouteGapM,
  articulatedDoorObb,
  DOOR_MAX_OPEN_ANGLE_RAD,
  DOOR_OPEN_DURATION_S,
  isReverseMotion,
  headwayS,
  pairKey,
  readPair,
  readPathConflict,
  readStaticPathConflict,
  sweptObbTimeOfImpact,
} from './sim/pairs.js';
export type { DoorName, PairReadout, PathConflictReadout, SweptObbResult } from './sim/pairs.js';
export type { ActorRuntime, AxisId } from './sim/state.js';
export { axisOf } from './sim/state.js';

/* ------------------------------------------------------------------ solves */
export { solveArrival, applyArrivalSolution, resolveArrivalTriggers, ARRIVAL_TOLERANCE_M } from './solve/arrival.js';
export type { ArrivalSolution } from './solve/arrival.js';
export { solvePedestrianNearMiss } from './solve/pedestrian-near-miss.js';
export type { PedestrianNearMissRequest, PedestrianNearMissResult, PedestrianNearMissSolution, PedestrianNearMissDiagnostic, PedestrianNearMissIssueCode, NearMissPass, TimedTrajectoryPoint } from './solve/pedestrian-near-miss.js';
export { resolvePedestrianProjection } from './solve/pedestrian-projection.js';
export type { PedestrianProjection, PedestrianProjectionMovement, PedestrianProjectionSegment, PedestrianProjectionSegmentKind } from './solve/pedestrian-projection.js';
export { verifyNearMissOutcome } from './trace/near-miss.js';
export { computeRealizedPet } from './trace/realized-pet.js';
export { computeMinClearance } from './trace/min-clearance.js';
export type { MinClearanceResult } from './trace/min-clearance.js';
export type { RealizedPetResult, RealizedPetStatus } from './trace/realized-pet.js';
export type { NearMissVerification } from './trace/near-miss.js';
export { checkFeasibility, COMFORT_DECEL_MPS2, HARD_DECEL_MPS2 } from './solve/guards.js';
export { actionAwareRunwayNeedM, nominalRun, nominalRunwayNeedM } from './solve/nominal.js';
export type { NominalActor, NominalProbe } from './solve/nominal.js';

/* ------------------------------------------------------------------- trace */
export {
  quantizeTrace,
  quantizeMetrics,
  traceToSceneFrame,
  TRACE_FORMAT_VERSION,
  LATERAL_OFFSET_TRACE_VERSION,
  READABLE_TRACE_FORMAT_VERSIONS,
  isReadableTraceFormatVersion,
  TRACE_PRECISION,
} from './trace/trace.js';
export type {
  ActorTrack,
  ActorPhysicsTrack,
  ActorPhysicsBackendProvenance,
  TraceActorMetadata,
  DeclaredOcclusionMetric,
  DeclaredOcclusionStatus,
  EpisodeMetrics,
  InvariantResidual,
  OccluderIneffective,
  MinTtcRecord,
  MinPathTtcRecord,
  MinPetRecord,
  CriticalitySamples,
  PairMinDistance,
  RevealToConflict,
  SceneTrace,
  SignalTrack,
  SimEvent,
  SimTrace,
  TraceHeader,
  PhysicsTraceProvenance,
} from './trace/trace.js';
export { encodeTraceGz, decodeTraceGz, serializeTrace, traceDigest } from './trace/gzip.js';
export { computeMetrics, criticalityWindow } from './trace/metrics.js';
export { MONITORED_PAIR_POLICY_VERSION, selectMetricPair } from './trace/monitored-pairs.js';
export type { MetricPairSelection, MonitoredPairPolicy } from './trace/monitored-pairs.js';
export {
  evaluateTrace,
  evaluateMetrics,
  criticalityMetricsInWindow,
  DEFAULT_MAX_DECEL_MPS2,
  DEFAULT_TRIVIAL_TTC_S,
} from './trace/evaluate.js';
export type {
  EvaluateFilters,
  RejectCode,
  RejectFinding,
  TraceEvaluation,
} from './trace/evaluate.js';
export {
  createBlindReviewPacket,
  evaluateIntentRubric,
  intentCriterionSchema,
  intentRubricSchema,
  summarizeBehavior,
} from './trace/intent-rubric.js';
export type {
  BehaviorSummary,
  BlindReviewPacket,
  CriterionStatus,
  CriterionVerdict,
  IntentCriterion,
  IntentCriterionInput,
  IntentEvaluation,
  IntentRubric,
  IntentRubricInput,
  TraceEvidence,
} from './trace/intent-rubric.js';

/* -------------------------------------------------------------- perception */
export {
  atmosphereSchema,
  detectionModelSchema,
  emissiveGlareSchema,
  mapDivergenceSchema,
  mapDivergenceKindSchema,
  perceptionConfigSchema,
  simSensorSchema,
  sensorApertureSchema,
  sensorMountSchema,
  DEFAULT_PERCEPTION_CONFIG,
  MAP_DIVERGENCE_KINDS,
} from './perception/schema.js';
export type {
  Atmosphere,
  DetectionModel,
  EmissiveGlare,
  MapDivergence,
  MapDivergenceExtent,
  MapDivergenceKind,
  PerceptionConfig,
  SensorAperture,
  SensorMount,
  SimSensor,
} from './perception/schema.js';
export {
  angularSeparationRad,
  contrastLimitedRangeM,
  detectionReasonCode,
  koschmiederContrast,
  observeTarget,
  resolutionLimitedRangeM,
  sensorPose,
  DETECTION_REASONS,
  DETECTION_STATUS,
  KOSCHMIEDER_K,
} from './perception/model.js';
export type {
  DetectionObservation,
  DetectionReason,
  DetectionStatusCode,
  GlareSource,
  PerceivedTarget,
  SensorPose,
} from './perception/model.js';
export { PerceptionRuntime, inExtent } from './perception/runtime.js';
export type { LineOfSightFn, PerceptionActorView, PerceptionObserverSpec } from './perception/runtime.js';
export {
  quantizeSensorTracks,
  sensorChannelKey,
  SENSOR_TRACE_PRECISION,
  SENSOR_TRACE_REASON_LEGEND,
  SENSOR_TRACE_STATUS_LEGEND,
} from './trace/sensor-track.js';
export type {
  DetectionGap,
  MapDivergenceMetric,
  MapDivergenceTrack,
  PerceptionMetrics,
  SensorPerceptionMetric,
  SensorTargetTrack,
  SensorTrack,
} from './trace/sensor-track.js';
export type { PerceptionQuery } from './sim/triggers.js';

/* ------------------------------------------------------------------ errors */
export { SimEngineError, issue } from './errors.js';
export type { SimIssue, SimIssueCode, SimIssueSeverity } from './errors.js';

/* -------------------------------------------------------------------- util */
export { canonicalJson, contentHash, sha256 } from './core/hash.js';
export { Rng, normalizeSeed, seedFromString } from './core/rng.js';
export { obbOverlap, obbCorners } from './core/math.js';
export type { Obb, Vec2 } from './core/math.js';

/* ------------------------------------------------------ SUMO authored world */
export {
  buildSumoAuthoredOccupancies,
  buildSumoRoadOccupancyIndex,
  sumoAuthoredOccupanciesAt,
  sumoAuthoredOccupancySourcesAt,
} from './ambient/authored-occupancy.js';
export type {
  SumoAuthoredOccupancy,
  SumoAuthoredOccupancyKind,
  SumoAuthoredOccupancySource,
  SumoRoadOccupancyIndex,
} from './ambient/authored-occupancy.js';

/* ------------------------------------------------ physics validation */
export {
  PHYSICS_VALIDATION_CONTRACT_VERSION,
  PHYSICS_VALIDATION_GATES,
  report as physicsValidationReport,
  validateGoldenReference,
  validateDeterminism as validatePhysicsDeterminism,
  validateFrictionCircle,
  validatePerformance as validatePhysicsPerformance,
  validateReferenceValue,
  validateStoppingDistanceMonotonicity,
  validateTimestepConvergence,
} from './validation/physics.js';
export type {
  FrictionObservation,
  ValidationFinding as PhysicsValidationFinding,
  ValidationReport as PhysicsValidationReport,
  VehicleObservation,
} from './validation/physics.js';
export {
  validateGoldenManeuvers,
  type GoldenManeuverFixture,
  type GoldenManeuverReference,
} from './validation/golden-maneuvers.js';

/* --------------------------------------------------------- ambient traffic */
export {
  AMBIENT_TRAFFIC_EXTENSION_KEY,
  ambientTrafficProfileFromExtensions,
  ambientTrafficProfileSchema,
  applyAmbientTraffic,
  createAmbientCandidatePool,
  defaultAmbientTrafficProfile,
  materializeAmbientCandidatePool,
  materializeAmbientTrafficProfile,
  promoteAmbientActor,
  resolveAmbientTrafficProfile,
} from './ambient/traffic.js';
export {
  MATERIALIZED_TRAFFIC_SCHEMA,
  MATERIALIZED_TRAFFIC_TIME_PRECISION,
  MATERIALIZED_TRAFFIC_MAX_ACTORS,
  MATERIALIZED_TRAFFIC_MAX_ACTOR_STATES,
  MaterializedTrafficRecorder,
  createDisabledMaterializedTrafficArtifact,
  decodeMaterializedTrafficArtifact,
  encodeMaterializedTrafficArtifact,
  materializedTrafficActorSchema,
  materializedTrafficActorStateSchema,
  materializedTrafficArtifactEnvelope,
  materializedTrafficArtifactSchema,
  materializedTrafficFrameCount,
  materializedTrafficSignalSchema,
  materializedTrafficSignalStateSchema,
  materializedTrafficTime,
  parseMaterializedTrafficArtifact,
  validateMaterializedTrafficBinding,
} from './ambient/materialized-traffic.js';
export type {
  MaterializedTrafficActor,
  MaterializedTrafficActorState,
  MaterializedTrafficArtifact,
  MaterializedTrafficArtifactEnvelope,
  MaterializedTrafficBinding,
  MaterializedTrafficFrame,
  MaterializedTrafficFrameActor,
  MaterializedTrafficProvider,
  MaterializedTrafficSignal,
  MaterializedTrafficSignalState,
} from './ambient/materialized-traffic.js';
export { settleAmbientTraffic } from './ambient/settle.js';
export type {
  AmbientSettleOptions,
  AmbientSettleProvenance,
  AmbientSettleResult,
} from './ambient/settle.js';
export type {
  AmbientActorProvenance,
  AmbientCandidate,
  AmbientCandidatePool,
  AmbientReservation,
  AmbientScreeningReason,
  AmbientTrafficOptions,
  AmbientTrafficProfile,
  AmbientTrafficProvenance,
  AmbientTrafficResult,
  ResolvedAmbientTrafficProfile,
} from './ambient/traffic.js';
export {
  buildSumoRouteDocument,
  sumoActorIdHash,
  sumoNetworkHeadingToScene,
  sumoNetworkToScene,
  sumoNumericSeed,
  sumoSceneHeadingToNetwork,
  sumoSceneToNetwork,
  sumoVehicleId,
  validateSumoNetworkManifest,
  validateSumoRuntimeManifest,
} from './ambient/sumo.js';
export type {
  SumoNetworkManifest,
  SumoNetworkPoint,
  SumoNetworkWorldTransform,
  SumoRouteDocumentOptions,
  SumoRuntimeManifest,
  SumoScenePoint,
} from './ambient/sumo.js';
export {
  DEFAULT_AMBIENT_ROBUSTNESS_CASES,
  evaluateAmbientRobustness,
} from './ambient/robustness.js';
export type {
  AmbientRobustnessCase,
  AmbientRobustnessCaseReport,
  AmbientRobustnessOptions,
  AmbientRobustnessReport,
} from './ambient/robustness.js';
