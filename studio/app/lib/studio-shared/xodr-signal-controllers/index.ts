export {
  attachSignalIdsToGates,
  buildSignalPlacementIndex,
  deriveXodrSignalGroups,
  refineMovementSignalIds,
  type ApproachSide,
  type DeriveXodrSignalGroupsResult,
  type GateWithSignals,
  type MovementBindingWithSignals,
  type XodrApproachSignals,
  type XodrJunctionSignalGroup,
  type XodrMovementSignals,
  type XodrPhaseGroup,
  type XodrPhaseGrouping,
  type XodrSignalPlacement,
} from "./derive-signal-groups";

export {
  enrichXodrWithSignalControllers,
  type EnrichXodrOptions,
  type EnrichXodrResult,
} from "./enrich-xodr";

export {
  isEsminiTrafficLightSignal,
  normalizeXodrForEsmini,
  normalizeXodrForEsminiWithStats,
  type NormalizeXodrForEsminiResult,
} from "./normalize-for-esmini";
