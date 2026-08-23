// Isolated declarations for SC1/SC3/SC4-owned absolute imports.
// The integrated app replaces these declarations with the real modules.
declare function __integrationBoundary();
type IntegrationBoundary = ReturnType<typeof __integrationBoundary>;

declare module "@/app/components/CarlaCompatibilityPill" {
  export const CarlaCompatibilityPill: IntegrationBoundary;
}

declare module "@/app/components/CarlaReadyMark" {
  export const CarlaReadyMark: IntegrationBoundary;
}

declare module "@/app/components/city-viewer/rendering-preference" {
  export const readRenderingPreference: IntegrationBoundary;
  export type RenderingPreference = IntegrationBoundary;
}

declare module "@/app/components/CloudLoadingSurface" {
  export const CloudActivityIndicator: IntegrationBoundary;
}

declare module "@/app/components/DashboardLoadingCoordinator" {
  export type DashboardLoadingSource = IntegrationBoundary;
  export const useDashboardLoadingSource: IntegrationBoundary;
}

declare module "@/app/components/SkyCloudBackdrop" {
  export const SkyCloudBackdrop: IntegrationBoundary;
}

declare module "@/app/components/TopBarSlot" {
  export const TopBarActionsPortal: IntegrationBoundary;
  export const TopBarTrailingPortal: IntegrationBoundary;
  export const useSetPageTitle: IntegrationBoundary;
  export const useSetTopBarActionsAlignment: IntegrationBoundary;
}

declare module "@/app/components/ui/button" {
  export const Button: IntegrationBoundary;
}

declare module "@/app/components/ui/input" {
  export const Input: IntegrationBoundary;
}

declare module "@/app/components/ui/select-menu" {
  export const SelectMenu: IntegrationBoundary;
  export const SelectMenuField: IntegrationBoundary;
}

declare module "@/app/components/ui/sheet" {
  export const Sheet: IntegrationBoundary;
  export const SheetContent: IntegrationBoundary;
  export const SheetDescription: IntegrationBoundary;
  export const SheetHeader: IntegrationBoundary;
  export const SheetTitle: IntegrationBoundary;
  export const SheetTrigger: IntegrationBoundary;
}

declare module "@/app/components/ui/sim-loader" {
  export const RouteLoading: IntegrationBoundary;
}

declare module "@/app/components/ui/switch" {
  export const Switch: IntegrationBoundary;
}

declare module "@/app/components/ui/tabs" {
  export const Tabs: IntegrationBoundary;
  export const TabsContent: IntegrationBoundary;
  export const TabsList: IntegrationBoundary;
  export const TabsTrigger: IntegrationBoundary;
}

declare module "@/app/components/ui/textarea" {
  export const Textarea: IntegrationBoundary;
}

declare module "@/app/components/WorkspacePaneLoading" {
  export const WorkspacePaneLoading: IntegrationBoundary;
}

declare module "@/app/dashboard/uniscenario/list/document-map-groups" {
  export type UniScenarioMapOption = IntegrationBoundary;
}

declare module "@/app/lib/asset-gallery/contracts" {
  export type GalleryAssetSummary = IntegrationBoundary;
}

declare module "@/app/lib/asset-gallery/editor-bridge" {
  export const primeGalleryEntriesForDocument: IntegrationBoundary;
  export const resolveGalleryCatalogIds: IntegrationBoundary;
}

declare module "@/app/lib/db/app-context" {
  export const requireAppContext: IntegrationBoundary;
}

declare module "@/app/lib/maps/frontend/map-asset-cache" {
  export const availableStorageBytes: IntegrationBoundary;
  export const fetchMapAsset: IntegrationBoundary;
  export const flushMapAssetCacheIndex: IntegrationBoundary;
  export const hasCachedMapAsset: IntegrationBoundary;
  export const prepareMapAssetCache: IntegrationBoundary;
}

declare module "@/app/lib/uniscenario/ambient/AmbientTrafficPanel" {
  export const AmbientTrafficPanel: IntegrationBoundary;
}

declare module "@/app/lib/uniscenario/artifact-cache" {
  export const fetchContentAddressedArtifact: IntegrationBoundary;
}

declare module "@/app/lib/uniscenario/carla-compatibility" {
  export const CARLA_COMPATIBILITY_LABEL: IntegrationBoundary;
  export type CarlaCompatibility = IntegrationBoundary;
  export const carlaCompatibilityFor: IntegrationBoundary;
  export type CarlaCompatibilityTable = IntegrationBoundary;
  export const loadCarlaCompatibility: IntegrationBoundary;
}

declare module "@/app/lib/uniscenario/carla-objects" {
  export type CarlaObjectDto = IntegrationBoundary;
  export const registerCarlaObjects: IntegrationBoundary;
}

declare module "@/app/lib/uniscenario/contracts" {
  export type CreateUniScenarioRevisionResultDto = IntegrationBoundary;
  export const UNISCENARIO_AUTHORING_QUALITY_CHOICES: IntegrationBoundary;
  export const UNISCENARIO_AUTHORING_QUALITY_IDS: IntegrationBoundary;
  export const UNISCENARIO_SCHEMA_VERSION: IntegrationBoundary;
  export type UniScenarioAmbientProvenance = IntegrationBoundary;
  export type UniScenarioArtifactDto = IntegrationBoundary;
  export type UniScenarioAuthoringQuality = IntegrationBoundary;
  export type UniScenarioConflictDto = IntegrationBoundary;
  export type UniScenarioDocumentDto = IntegrationBoundary;
  export type UniScenarioExportDto = IntegrationBoundary;
  export type UniScenarioJobProvenanceDto = IntegrationBoundary;
  export type UniScenarioMapDescriptorDto = IntegrationBoundary;
  export type UniScenarioMaterializedTrafficReference = IntegrationBoundary;
  export type UniScenarioRenderJobDto = IntegrationBoundary;
  export type UniScenarioRenderSpec = IntegrationBoundary;
  export type UniScenarioRevisionDto = IntegrationBoundary;
}

declare module "@/app/lib/uniscenario/execution-package-client" {
  export const getExecutionPackageMembersClient: IntegrationBoundary;
}

declare module "@/app/lib/uniscenario/parking/extension" {
  export const PARKED_CARS_EXTENSION_KEY: IntegrationBoundary;
  export const parkedCarsFromExtensions: IntegrationBoundary;
  export type ParkedCarsSettings = IntegrationBoundary;
}

declare module "@/app/lib/uniscenario/parking/fill" {
  export type ParkedCarPlan = IntegrationBoundary;
}

declare module "@/app/lib/uniscenario/parking/ParkedCarsPanel" {
  export const ParkedCarsPanel: IntegrationBoundary;
}

declare module "@/app/lib/uniscenario/parking/useParkedCars" {
  export type ParkingStallsStatus = IntegrationBoundary;
  export const useParkedCarLayer: IntegrationBoundary;
  export const useParkedCars: IntegrationBoundary;
}

declare module "@/app/lib/uniscenario/parking/useStallOverlay" {
  export const useStallOverlay: IntegrationBoundary;
}

declare module "@/app/lib/uniscenario/playback/usePlayback" {
  export const usePlaybackControllerState: IntegrationBoundary;
}

declare module "@/app/lib/uniscenario/recording-client" {
  export const getBrowserRecordingClient: IntegrationBoundary;
  export const getBrowserRecordingRevisionInputClient: IntegrationBoundary;
  export const listBrowserRecordingsClient: IntegrationBoundary;
}

declare module "@/app/lib/uniscenario/recording-contracts" {
  export type BrowserRecordingDetailDto = IntegrationBoundary;
  export type BrowserRecordingSummaryDto = IntegrationBoundary;
}

declare module "@/app/lib/uniscenario/sumo-runtime" {
  export const SUMO_RUNTIME_MANIFEST_URL: IntegrationBoundary;
  export const SUMO_RUNTIME_MODULE_URL: IntegrationBoundary;
  export const SUMO_RUNTIME_WASM_URL: IntegrationBoundary;
}

declare module "@/app/lib/uniscenario/useMapSignalOverlays" {
  export const useMapSignalOverlays: IntegrationBoundary;
}

declare module "@/app/lib/use-visible-polling" {
  export const useVisiblePolling: IntegrationBoundary;
}

declare module "@/app/lib/utils" {
  export const cn: IntegrationBoundary;
}

declare module "*.module.css";
