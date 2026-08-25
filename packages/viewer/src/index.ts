export { CityViewer } from './viewer';
export type { CityViewerLayers } from './viewer';
export { DEFAULT_ACTIVE_LUMINAIRE_LIMIT, isLuminaireObjectName, LuminaireLightingController } from './luminaire-lighting';
export type { LuminaireLightingStats } from './luminaire-lighting';
export { CameraRig } from './camera-controls';
export { CAMERA_ORBIT_EVENT } from './camera-events';
export type { CameraMode, CameraView, CameraPoseConstraint } from './camera-controls';
export {
  applyEyeOrbit,
  cameraLookDrag,
  cameraKeyboardMagnitude,
  cameraPanDrag,
  cameraSensitivityMultiplier,
  cameraWheelDollyScale,
  crossedCameraDragThreshold,
  DEFAULT_CAMERA_CONTROL_PREFERENCES,
  dampedEyeOrbitStep,
  invertedOrbitDrag,
  invertedPanDrag,
} from './camera-drag';
export type { CameraControlPreferences, CameraDragButton, EyeOrbitDelta } from './camera-drag';
export { FrameStats } from './frame-stats';
export { AssetDownloadTracker, readResponseBufferWithProgress } from './download-progress';
export type { AssetDownloadStats } from './download-progress';
export { GroundIndex, isGroundSurfaceMesh } from './ground-index';
export type { GroundIndexOptions, GroundIndexStats } from './ground-index';
export { indexedWorldHeightSampler } from './indexed-height-sampler';
export {
  ATMOSPHERIC_TRANSMITTANCE,
  CIVIL_TWILIGHT_DEG,
  DEFAULT_TONEMAP,
  EXTRATERRESTRIAL_ILLUMINANCE_LX,
  SENSOR_EV100,
  SHADOW_FILL_RATIO_MAX,
  SHADOW_FILL_RATIO_MIN,
  SUN_ANGULAR_DIAMETER_DEG,
  VIEWER_ENVIRONMENT_INTENSITY,
  VIEWER_EXPOSURE,
  VIEWER_SUN_INTENSITY,
  airMass,
  ev100ForSunElevation,
  sunColorTemperatureK,
  sunDirectHorizontalIlluminanceLx,
  sunDirectNormalIlluminanceLx,
  twilightRamp,
} from './lighting-calibration';
export type { GroundHeightSampler } from './indexed-height-sampler';
export { keepInRoadsOnly, isTrafficSignalMesh, isLowFidelityHiddenHelper, isRoadsOnlyHiddenHelper, LOW_FIDELITY_HIDDEN_ROLE, ROADS_ONLY_HIDDEN_ROLE } from './roads-only';
export { ShadowAtlas } from './shadow-atlas';
export { ATMOSPHERE_LAYER, CLEAR_SKY, SkyDome, skyAppearanceForWeather, sunElevationFalloff } from './sky';
export type { SkyAppearance } from './sky';
export {
  bakedSuppressionRadii,
  fitSunShadow,
  shadowBakeIsStale,
  shadowRadiusForScene,
} from './sun-shadow';
export type { SunShadowFit } from './sun-shadow';
export { isCityAssetVariantManifest, selectAssetVariant } from './asset-variants';
export type {
  CityAssetVariant,
  CityAssetVariantFile,
  CityAssetVariantId,
  CityAssetVariantManifest,
  CityAssetVariantPreference,
} from './asset-variants';
export {
  BUILTIN_SURFACE_MATERIAL_PACK,
  SurfaceMaterialRegistry,
  classifySurface,
  geometryDigest,
} from './surface-materials';
export type {
  MaterialPack,
  MaterialPackProvenance,
  SurfaceClass,
  SurfaceClassification,
  SurfaceIdentity,
  SurfaceLayer,
  SurfaceMaterialProfile,
  SurfaceMaterialReport,
} from './surface-materials';
export { buildVegetation } from './vegetation';
export type { VegetationBuildResult, VegPrototypeGroup } from './vegetation';
export * from './weather';
export { boundsToBox3, normalizeLods, resolveUrl, estimateLodBytes } from './manifest';
export type {
  BenchResult,
  CameraDiagnostics,
  CityManifest,
  CityViewerOptions,
  CityViewerStats,
  CityViewerLiveQuality,
  FramePhaseStats,
  FrameTimeCounts,
  RendererCapability,
  ManifestLod,
  ManifestTile,
  ManifestVegetationTile,
  VegetationInstanceFile,
} from './types';

export * from './actorRenderer';
export * from './externalModel';
export * from './sensorOverlay';
export * from './camera-rig/index.js';
export {
  ACTOR_CLASS_LEGEND,
  PARITY_FIXTURE_VERSION,
  PROJECTED_HEADLIGHT_LIMIT,
  RENDERER_CONTRACT_VERSION,
  STATIC_SEMANTICS_SCHEMA_ID,
  STATIC_SEMANTIC_CLASS_LEGEND,
  STREET_LUMINAIRE_ACTIVE_LIMIT,
  actorInstanceLegend,
  actorRenderStateFromSceneState,
  deriveVehicleLightStates,
  followCameraPose,
  frameCameraPose,
  scheduleTimestampsMicros,
  validateParityFixture,
} from './renderer-contract';
export type {
  ActorDims,
  ActorDoorName,
  ActorDoorState,
  ActorFrameBatch,
  ActorFrameLayer,
  ActorRenderState,
  ActorSimKind,
  ArtifactProvenance,
  CameraAttachment,
  CameraCommand,
  CameraIntrinsics,
  CameraPoseCommand,
  CameraStateReport,
  DeterminismClass,
  FixtureCameraCase,
  FixturePickCase,
  FrameBounds,
  LightStateReport,
  MapPublicationDescriptor,
  Mat4,
  ParityFixture,
  PickHit,
  PickLayer,
  PickRequest,
  PickResult,
  Quat,
  RenderSchedule,
  RendererImplementation,
  SemanticLegend,
  StreetLightingState,
  Vec3,
  VehicleLightState,
} from './renderer-contract';
export { ThreeRendererAdapter, cityViewerAsAdapterHost, contractActorToView } from './renderer-contract-adapter';
export type { ThreeAdapterHost } from './renderer-contract-adapter';
