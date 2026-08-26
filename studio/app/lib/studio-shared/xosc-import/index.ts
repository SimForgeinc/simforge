/**
 * OpenSCENARIO 1.0 XML → `ScenarioEditorDraft`: the inverse of our own writer.
 *
 * ## Scope, stated plainly
 *
 * This imports **the emission vocabulary of
 * `apps/web/app/lib/scenario-editor/xosc-writer/`** — the eight action kinds,
 * nine condition kinds and two signal emission paths that writer produces, with
 * absolute `WorldPosition`s throughout. It is NOT third-party OpenSCENARIO
 * ingest and must never be cited as such: a file from esmini's own examples, or
 * from a vendor toolchain, will parse (the allowlist parser accepts far more
 * than we emit) and then import as a mostly-empty draft with a pile of
 * `unknown_action` diagnostics. Supporting `LanePosition`, catalogs, controllers
 * or route assignment is a different project with a different scope.
 *
 * What it IS for: closing the export → run → import loop, so a scenario written
 * in the editor, exported to .xosc and run through esmini can come back as a
 * draft the editor, the browser preview engine and the CARLA job pipeline all
 * drive. `importXoscToDraft(writer.xml)` re-exports byte-identically for every
 * writer golden, and that round trip is the spec — see
 * `apps/web/test/unit/scenario-editor/xosc-import/round-trip.test.ts`.
 *
 * ## Fail open, always
 *
 * Nothing here throws, including on a file the security parser rejects. An
 * unreadable document returns an empty draft carrying an `error` diagnostic;
 * an element with no inverse is dropped with an `unknown_action` /
 * `unknown_condition`; a lossy fold is reported as `imported_approximation`.
 * Nothing is ever invented to fill a gap.
 *
 * ## The loss list — what the writer drops, and what comes back instead
 *
 * These are the places the round trip is byte-exact but the DRAFT is not the
 * one that was exported. Each one emits an `imported_approximation`.
 *
 * 1. **`follow_route` and `turn_at_next_intersection` → `follow_path`.** Both
 *    compile to an untimed `FollowTrajectoryAction` over resolved world points;
 *    the road anchors and the junction instruction are gone from the file.
 * 2. **`intercept` → `go_to`.** The writer already flattens the chase to an
 *    acquire-position at the target's start; the import reads exactly that.
 * 3. **`cut_in` with no `gap_m` → `lane_change`.** With a gap the cut-in is
 *    recoverable, because the gap rides on the start trigger as a named
 *    condition. Without one the emission is a bare lane change.
 * 4. **`cruise {speed_kph: 0}` → `stop`.** Identical emission; `stop` is the
 *    reading that survives.
 * 5. **`lane_offset.transition_m`** is never emitted and cannot come back.
 *    **`lane_change.transition_m`** always comes back explicit (the writer
 *    substitutes its 25 m default for an absent one).
 * 6. **`reverse.distance_m`**, **`yield_to`**, **`follow_actor`**, **`avoid`**,
 *    **`autopilot`** and every **disabled clip** are absent from the file
 *    entirely. So is any actor with no resolvable world position, and any clip
 *    whose trigger failed to compile.
 * 7. **A clip `end` of `{kind: "duration"}`** comes back from three places: a
 *    simulation-time stop condition on a time-started clip; a self-referencing
 *    `startTransition` condition on a condition-started LATERAL clip — the one
 *    family that genuinely releases on end; and, for every other family, the
 *    DELAY on a downstream `after_clip` chain, which the writer sets to the
 *    upstream clip's duration. A duration therefore survives whenever something
 *    was chained after the clip. What still does not survive is a duration on a
 *    condition-started clip that nothing chains off: its command stands after
 *    the clip ends, so the writer cannot stop its event without cancelling the
 *    action mid-flight, and nothing else records the number. That imports as
 *    `completion`, which for a `cruise` is the OSC reading —
 *    `{on: "target_speed"}`, the clip ends when the vehicle reaches the
 *    commanded speed, which is where esmini ends the event — and NOT the "hold
 *    until superseded" an authored cruise means.
 *
 *    When the author wrote BOTH a duration and a chain `delay_s`, the file
 *    carries only their sum and they cannot be separated; the whole delay is
 *    read back as the duration, which re-exports to identical timing.
 * 8. **`placement_mode` and `autopilot`.** Every imported actor is placed by
 *    world point, because that is all the file records. A road-anchored or
 *    Traffic-Manager actor comes back as a point/path actor at the same world
 *    pose. `is_static` cannot be distinguished from "authored no maneuver"
 *    either, so only props are marked static.
 * 9. **`path_timing`.** A schedule and an ordering path emit the same
 *    trajectory; only the Init speed differs, and that is not enough to tell
 *    them apart. Imported timed paths carry `path_timing: "ordering"` and keep
 *    the schedule on the `follow_path {timed: true}` clip.
 * 10. **Signal junction and movement identity.** See `signals.ts`: a program's
 *    ids come back sanitized and split at the first underscore, and a static or
 *    scripted plan's junction is synthesized outright.
 * 11. **An omitted `weather` / `roadSurface`** comes back as the explicit
 *    `CLEAR_SKY` / `DRY_ROAD` the writer emitted for it. A draft with no
 *    environment preset at all is recognised by the writer's fallback sun
 *    vector and comes back with none.
 * 12. **Clip ids and actor-scoped names** are sanitized to identifier
 *    characters by the writer, so `my.clip:1` returns as `my_clip_1`. Actor ids
 *    themselves are exact (they are the entity names).
 * 13. **`role`.** An .xosc has no role field. The legacy entity name `ego`
 *    is normalized to the subject role; every other vehicle remains traffic.
 */

import {
  OpenScenarioImportError,
  analyzeOpenScenarioImport,
  type OpenScenarioImportAnalysis,
} from "@simforge-oss/openscenario/import";

import type { EnvironmentPreset } from "../environment-preset";
import { laneAtPose } from "../map-topology/lane-at-pose";
import type { MapTopologyIndex } from "../map-topology/types";
import type {
  ActorBehaviorProgram,
  BehaviorActorRef,
  BehaviorClip,
  BehaviorSignalRef,
  BehaviorTrigger,
} from "../scenario-behavior";
import {
  ACTOR_BEHAVIOR_SCHEMA_VERSION,
  BEHAVIOR_CLIP_END_ON_TARGET_SPEED,
} from "../scenario-behavior";
import {
  ScenarioEditorDraftSchema,
  type ScenarioEditorActorDraft,
  type ScenarioEditorDraft,
  type ScenarioEditorTimedWaypoint,
} from "../scenario-editor";
import type { JunctionSignalPlan } from "../scenario-signals";
import { parseXoscFileHeaderDescription } from "../xosc/file-header-metadata";
import {
  attrNumber,
  attrString,
  childEl,
  childrenEl,
  descendantEl,
  parseXmlDocument,
  type XmlElement,
} from "../xosc/xml-dom";
import { composeAction, readPrivateAction, type ReadPrivateAction } from "./actions";
import {
  ImportDiagnosticCollector,
  type XoscImportDiagnostic,
} from "./diagnostics";
import { importEnvironment } from "./environment";
import { importSignalPlans, readSignalStateActions } from "./signals";
import { isRisingSimulationTime, readCondition, triggerConditions } from "./triggers";

export {
  XOSC_IMPORT_DIAGNOSTIC_CODES,
  hasDroppedImportContent,
  type XoscImportDiagnostic,
  type XoscImportDiagnosticCode,
  type XoscImportDiagnosticSeverity,
} from "./diagnostics";
export { SIGNAL_IMPORT_HOLD_TAIL_S } from "./signals";

const RAD_TO_DEG = 180 / Math.PI;
const MPS_TO_KPH = 3.6;
/** `ScenarioEditorSimulationConfigSchema` bounds. */
const MIN_DURATION_S = 1;
const MAX_DURATION_S = 60;
const DEFAULT_DURATION_S = 30;
const OFFSET_RETURN_SUFFIX = "_offset_return";

export type XoscImportOptions = {
  /**
   * Overrides everything. Falls back to the id our own writer embeds in
   * `FileHeader@description` (see `xosc/file-header-metadata`), and then to
   * `""` with a `metadata_defaulted` diagnostic for a file that carries none.
   */
  mapAssetId?: string;
  /**
   * Overrides everything. Falls back to the map name embedded in
   * `FileHeader@description`, and then to the LogicFile basename without its
   * `.xodr` extension.
   */
  mapName?: string;
  /**
   * Defaults to the FileHeader description with the `[simcloud:...]`
   * provenance suffix stripped, which is what the writer puts there.
   */
  sourceScenarioId?: string;
  /** Draft `createdAt` / `updatedAt`. Defaults to now; pass it for determinism. */
  now?: string;
  /**
   * OpenDRIVE lane id per entity name. Lateral values in an .xosc are in the
   * lane reference-line frame while the behavior schema's are travel-relative,
   * and the two are mirror images on positive-id lanes (`laneFrameSign`). The
   * file itself does not carry lane ids — the writer emits world positions — so
   * a caller that knows the map must supply them. Entities left out import
   * their lateral values unconverted, with an `imported_approximation`.
   *
   * Prefer `mapTopology` unless you already know the ids: this record wins
   * where both are given, which makes it the override rather than the norm.
   */
  laneIdByEntity?: Readonly<Record<string, number | null>>;
  /**
   * The map's topology index, from which each entity's lane id is resolved by
   * looking its Init spawn position up against the sampled lane centrelines
   * (`laneAtPose`). This is the answer to "the file has no lane ids": it does
   * carry world positions, and the topology index speaks the same runtime-world
   * metres. Resolution that fails, or that lands on a lane the entity is facing
   * up rather than down, is reported rather than guessed at.
   */
  mapTopology?: Pick<MapTopologyIndex, "lanes">;
};

export type XoscImportResult = {
  draft: ScenarioEditorDraft;
  /** `RoadNetwork/LogicFile@filepath`, e.g. `"Town03.xodr"`. */
  logicFile: string;
  /**
   * Provenance the FILE carries, before any caller option is applied — the
   * `[simcloud:...]` suffix our writer puts on `FileHeader@description`. Both
   * fields are null for a foreign file. A caller resolving the map wants this
   * rather than `draft.metadata`, which cannot say whether an id came from the
   * file or from the caller's own option.
   */
  embeddedMetadata: {
    mapAssetId: string | null;
    mapName: string | null;
  };
  /**
   * The environment the file describes, or `null` when it is the writer's
   * no-preset fallback block. Pass it straight back as the writer's
   * `environment` option — `ScenarioEditorDraftSchema` strips `renderConfig`,
   * so a schema-parsed draft cannot carry it.
   */
  environmentPreset: EnvironmentPreset | null;
  /**
   * Every OpenDRIVE signal id the file names. Feed this back as the writer's
   * `signalCatalog`: by construction it is exactly the set of ids that passed
   * the writer's verification on the way out, so a re-export emits the same
   * signal block. Without it, the writer fails closed and emits none.
   */
  signalCatalog: string[];
  /** Draft actor id → the `ScenarioObject` name it came from (identity today). */
  entityNames: Record<string, string>;
  diagnostics: XoscImportDiagnostic[];
};

/** OSC names are attribute text, so the writer keeps them to identifier characters. */
function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_");
}

function emptyDraft(
  options: XoscImportOptions,
  mapName: string,
  mapAssetId: string,
): ScenarioEditorDraft {
  const now = options.now ?? new Date().toISOString();
  return ScenarioEditorDraftSchema.parse({
    version: 2,
    metadata: {
      sourceScenarioId: options.sourceScenarioId ?? "",
      mapAssetId: options.mapAssetId ?? mapAssetId,
      mapName: options.mapName ?? mapName,
      notes: "",
      createdAt: now,
      updatedAt: now,
    },
    actors: [],
  });
}

type EntityInfo = {
  name: string;
  kind: "vehicle" | "walker" | "prop";
  blueprint: string;
  dimensions: { length_m: number; width_m: number; height_m: number } | null;
};

function readEntity(
  scenarioObject: XmlElement,
  diagnostics: ImportDiagnosticCollector,
): EntityInfo | null {
  const name = attrString(scenarioObject, "name");
  if (!name) return null;
  const body =
    childEl(scenarioObject, "Vehicle") ??
    childEl(scenarioObject, "Pedestrian") ??
    childEl(scenarioObject, "MiscObject");
  if (!body) {
    diagnostics.add(
      "entity_kind_unknown",
      "carries no Vehicle, Pedestrian or MiscObject body, so it imports as a vehicle",
      { actorId: name },
    );
    return { name, kind: "vehicle", blueprint: "", dimensions: null };
  }
  const kind =
    body.name === "Pedestrian" ? "walker" : body.name === "MiscObject" ? "prop" : "vehicle";
  const dimensionsEl = descendantEl(body, "BoundingBox", "Dimensions");
  const length = attrNumber(dimensionsEl, "length");
  const width = attrNumber(dimensionsEl, "width");
  const height = attrNumber(dimensionsEl, "height");
  return {
    name,
    kind,
    blueprint: attrString(body, "name") ?? "",
    dimensions:
      length !== null && width !== null && height !== null
        ? { length_m: length, width_m: width, height_m: height }
        : null,
  };
}

type InitPose = { x: number; y: number; z: number; yawDeg: number; speedKph: number | null };

function readInitPrivate(privateEl: XmlElement): InitPose | null {
  let pose: { x: number; y: number; z: number; yawDeg: number } | null = null;
  let speedKph: number | null = null;
  for (const wrapper of childrenEl(privateEl, "PrivateAction")) {
    const read = readPrivateAction(wrapper);
    if (read.kind === "teleport") {
      pose = { x: read.x, y: read.y, z: read.z, yawDeg: read.headingRad * RAD_TO_DEG };
    } else if (read.kind === "speed") {
      speedKph = read.targetMps * MPS_TO_KPH;
    }
  }
  return pose ? { ...pose, speedKph } : null;
}

type ReadEvent = {
  name: string;
  clipId: string;
  actions: ReadPrivateAction[];
  startTrigger: XmlElement | null;
  stopTrigger: XmlElement | null;
};

function readEvents(maneuver: XmlElement | null, entityName: string): ReadEvent[] {
  const prefix = `${sanitize(entityName)}_`;
  return childrenEl(maneuver, "Event").map((event) => {
    const name = attrString(event, "name") ?? "";
    return {
      name,
      clipId: name.startsWith(prefix) ? name.slice(prefix.length) : name,
      actions: childrenEl(event, "Action")
        .map((action) => childEl(action, "PrivateAction"))
        .filter((element): element is XmlElement => element !== null)
        .map(readPrivateAction),
      startTrigger: childEl(event, "StartTrigger"),
      stopTrigger: childEl(event, "StopTrigger"),
    };
  });
}

/**
 * The scenario's duration, from the storyboard's own stop trigger.
 *
 * The writer emits it as the one `rising`-edge simulation-time condition at
 * storyboard level, so this reads a fact rather than guessing from the last
 * event time.
 */
function readDuration(
  storyboard: XmlElement | null,
  diagnostics: ImportDiagnosticCollector,
): number {
  for (const condition of triggerConditions(childEl(storyboard, "StopTrigger"))) {
    const simTime = descendantEl(condition, "ByValueCondition", "SimulationTimeCondition");
    const value = attrNumber(simTime, "value");
    if (value === null) continue;
    if (value >= MIN_DURATION_S && value <= MAX_DURATION_S) return value;
    const clamped = Math.min(MAX_DURATION_S, Math.max(MIN_DURATION_S, value));
    diagnostics.add(
      "duration_clamped",
      `the storyboard stops at ${value}s, which is outside the draft's ${MIN_DURATION_S}–${MAX_DURATION_S}s range; the imported draft runs for ${clamped}s`,
    );
    return clamped;
  }
  diagnostics.add(
    "metadata_defaulted",
    `the storyboard carries no duration stop trigger; the imported draft runs for the default ${DEFAULT_DURATION_S}s`,
  );
  return DEFAULT_DURATION_S;
}

/**
 * Fold the several `TrafficSignalCondition`s a multi-head movement produced
 * back into ONE `signal_state` trigger.
 *
 * The writer emits one condition per physical head inside a single AND group.
 * Reading only the first would re-export one condition where the file has
 * three, so a multi-head read looks for the movement whose verified heads are
 * exactly this set and references it by movement instead of by bulb.
 */
function foldSignalTriggers(
  triggers: readonly BehaviorTrigger[],
  plans: readonly JunctionSignalPlan[],
  junctionBySignalId: ReadonlyMap<string, string>,
): BehaviorTrigger[] {
  const signalTriggers = triggers.filter(
    (trigger): trigger is Extract<BehaviorTrigger, { kind: "signal_state" }> =>
      trigger.kind === "signal_state",
  );
  if (signalTriggers.length === 0) return [...triggers];
  const others = triggers.filter((trigger) => trigger.kind !== "signal_state");

  const ids = signalTriggers.map((trigger) => trigger.signal.signal_id ?? "");
  const state = signalTriggers[0]!.state;
  const resolveJunction = (signalId: string): string =>
    junctionBySignalId.get(signalId) ?? plans[0]?.junction_id ?? "imported_junction";

  if (signalTriggers.length === 1) {
    const signalId = ids[0]!;
    const signal: BehaviorSignalRef = {
      junction_id: resolveJunction(signalId),
      signal_id: signalId,
    };
    return [...others, { kind: "signal_state", signal, state }];
  }

  const sorted = [...ids].sort();
  for (const plan of plans) {
    for (const movement of plan.movements) {
      const heads = [...movement.signal_ids].sort();
      if (heads.length !== sorted.length) continue;
      if (heads.every((head, index) => head === sorted[index])) {
        return [
          ...others,
          {
            kind: "signal_state",
            signal: { junction_id: plan.junction_id, movement_id: movement.movement_id },
            state,
          },
        ];
      }
    }
  }
  // No movement owns exactly this head set — reference the first bulb and let
  // the caller report the reduction.
  const signalId = ids[0]!;
  return [
    ...others,
    {
      kind: "signal_state",
      signal: { junction_id: resolveJunction(signalId), signal_id: signalId },
      state,
    },
  ];
}

export function importXoscToDraft(
  xoscText: string,
  options: XoscImportOptions = {},
): XoscImportResult {
  const diagnostics = new ImportDiagnosticCollector();
  const blank = (
    logicFile: string,
    mapName: string,
    embedded: XoscImportResult["embeddedMetadata"] = { mapAssetId: null, mapName: null },
  ): XoscImportResult => ({
    draft: emptyDraft(options, mapName, embedded.mapAssetId ?? ""),
    logicFile,
    embeddedMetadata: embedded,
    environmentPreset: null,
    signalCatalog: [],
    entityNames: {},
    diagnostics: diagnostics.all(),
  });

  // Canonical OpenSCENARIO parsing owns bounded XML validation, encoding
  // checks, and source metadata extraction. Product-specific conversion below
  // remains intentionally fail-open for constructs the editor cannot preserve.
  let analysis: OpenScenarioImportAnalysis;
  try {
    analysis = analyzeOpenScenarioImport(new TextEncoder().encode(xoscText));
  } catch (error) {
    const detail =
      error instanceof OpenScenarioImportError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    diagnostics.add(
      "file_rejected",
      `the canonical OpenSCENARIO importer refused this file: ${detail}`,
    );
    return blank("", "");
  }

  const root = parseXmlDocument(xoscText);
  if (!root || root.name !== "OpenSCENARIO") {
    diagnostics.add("malformed_document", "the document has no <OpenSCENARIO> root element");
    return blank(analysis.logicFile ?? "", "");
  }

  const logicFile = analysis.logicFile ?? "";
  // Precedence, everywhere: an explicit caller option, then the provenance our
  // own writer embedded in the FileHeader, then the file's OpenDRIVE name. The
  // LogicFile basename is LAST because for our own exports it is the XODR
  // object's filename, which is not a map name at all.
  const header = parseXoscFileHeaderDescription(
    attrString(childEl(root, "FileHeader"), "description"),
  );
  const embeddedMetadata = { mapAssetId: header.mapAssetId, mapName: header.mapName };
  const mapName =
    options.mapName ?? header.mapName ?? logicFile.replace(/\.xodr$/i, "");
  const mapAssetId = options.mapAssetId ?? header.mapAssetId ?? "";
  const sourceScenarioId = options.sourceScenarioId ?? header.description;
  if (options.mapAssetId === undefined && !header.mapAssetId) {
    diagnostics.add(
      "metadata_defaulted",
      "an .xosc names its OpenDRIVE file but not the map asset it came from, and this one carries no SimCloud provenance in its FileHeader; the imported draft carries an empty mapAssetId until a caller supplies one",
    );
  }

  const storyboard = childEl(root, "Storyboard");
  const durationSeconds = readDuration(storyboard, diagnostics);

  // -----------------------------------------------------------------------
  // Entities
  // -----------------------------------------------------------------------
  const entities: EntityInfo[] = [];
  for (const scenarioObject of childrenEl(childEl(root, "Entities"), "ScenarioObject")) {
    const entity = readEntity(scenarioObject, diagnostics);
    if (entity) entities.push(entity);
  }

  // -----------------------------------------------------------------------
  // Init: environment, signal baseline, per-actor spawn pose and speed
  // -----------------------------------------------------------------------
  const initActions = descendantEl(storyboard, "Init", "Actions");
  const environmentRead = importEnvironment(
    descendantEl(childEl(initActions, "GlobalAction"), "EnvironmentAction", "Environment"),
  );
  for (const unmatched of environmentRead?.unmatched ?? []) {
    diagnostics.add(
      "imported_approximation",
      `the environment block's ${unmatched} matches no preset the writer emits, so that field is left unset on the imported draft`,
    );
  }
  const environmentPreset = environmentRead?.preset ?? null;

  const initSignalActions = childrenEl(initActions, "GlobalAction")
    .filter((action) => childEl(action, "InfrastructureAction") !== null)
    .flatMap((action) => readSignalStateActions(action));

  const poseByEntity = new Map<string, InitPose>();
  for (const privateEl of childrenEl(initActions, "Private")) {
    const entityRef = attrString(privateEl, "entityRef");
    if (!entityRef) continue;
    const pose = readInitPrivate(privateEl);
    if (pose) poseByEntity.set(entityRef, pose);
  }

  // The lane id per entity, which the file itself cannot carry — see
  // `XoscImportOptions.laneIdByEntity`. An explicit id always wins; otherwise
  // the spawn position is looked up against the map's lane centrelines.
  const laneIdByEntity = new Map<string, number | null>();
  for (const [entityRef, pose] of poseByEntity) {
    const explicit = options.laneIdByEntity?.[entityRef];
    if (explicit !== undefined) {
      laneIdByEntity.set(entityRef, explicit);
      continue;
    }
    if (!options.mapTopology) continue;
    const hit = laneAtPose(options.mapTopology, {
      x: pose.x,
      y: pose.y,
      yawDeg: pose.yawDeg,
    });
    if (!hit) {
      diagnostics.add(
        "imported_approximation",
        "spawns off every driving lane in the map topology, so its lane frame could not be resolved and its lateral values are unconverted — on a positive-id lane they will be mirrored",
        { actorId: entityRef },
      );
      continue;
    }
    if (hit.headingAgrees === false) {
      // Not fatal — only the SIGN feeds `laneFrameSign` and the nearest lane is
      // reliable on that — but an entity facing up its own lane is either a
      // reversing actor or a bad spawn, and silently absorbing it would hide
      // both.
      diagnostics.add(
        "imported_approximation",
        `spawns on lane ${hit.rsl} facing against that lane's direction of travel; the lane frame was resolved anyway from the nearest centreline`,
        { actorId: entityRef },
      );
    }
    laneIdByEntity.set(entityRef, hit.laneId);
  }

  // -----------------------------------------------------------------------
  // Story: maneuver groups, and the scene group that carries the signals
  // -----------------------------------------------------------------------
  const act = descendantEl(storyboard, "Story", "Act");
  const maneuverGroups = childrenEl(act, "ManeuverGroup");
  const sceneGroup =
    maneuverGroups.find((group) => attrString(group, "name") === "scene_group") ?? null;
  const sceneEvents = childrenEl(childEl(sceneGroup, "Maneuver"), "Event");

  const signals = importSignalPlans({
    initActions: initSignalActions,
    sceneEvents,
    diagnostics,
    // A scene clip has no owning actor, so `self` must never resolve.
    triggerContext: { selfEntity: null, clipIdForEventName: () => null },
  });

  // -----------------------------------------------------------------------
  // Actors
  // -----------------------------------------------------------------------
  const groupByEntity = new Map<string, XmlElement>();
  for (const group of maneuverGroups) {
    if (group === sceneGroup) continue;
    const entityRef = attrString(
      descendantEl(group, "Actors", "EntityRef"),
      "entityRef",
    );
    if (entityRef) groupByEntity.set(entityRef, group);
  }

  const actors: ScenarioEditorActorDraft[] = [];
  const entityNames: Record<string, string> = {};
  for (const entity of entities) {
    const pose = poseByEntity.get(entity.name);
    if (!pose) {
      diagnostics.add(
        "entity_unplaced",
        "has no Init teleport, so there is no world position to place it at and it was not imported",
        { actorId: entity.name },
      );
      continue;
    }

    const group = groupByEntity.get(entity.name);
    // One Maneuver per COMMAND CHANNEL, not one per actor — the writer splits
    // longitudinal from path commands so that `priority="overwrite"` cannot
    // cancel across channels. Reading only the first would silently drop every
    // clip of the other channel. Clip order therefore follows the channels
    // rather than the authored order; nothing downstream reads clip order, and
    // `after_clip` resolves by id.
    const events = childrenEl(group ?? null, "Maneuver").flatMap((maneuver) =>
      readEvents(maneuver, entity.name),
    );
    const clipIdByEventName = new Map(events.map((event) => [event.name, event.clipId]));
    // Authored durations, from two places.
    //
    // 1. An event's own self-referencing stop condition — lateral clips, the
    //    only family the writer gives one (see its
    //    RELEASING_ON_END_ACTION_KINDS).
    // 2. The DOWNSTREAM chain. A longitudinal clip's duration leaves no mark on
    //    its own event (stopping a SpeedAction mid-ramp would strand the actor,
    //    so the writer never does), but anything chained after it starts at
    //    `upstream startTransition + duration`, so the delay on that condition
    //    IS the duration. Recovering it here is what stops a round-trip from
    //    degrading the clip to `completion` and re-introducing the swerve
    //    collapse the chain fix exists to prevent (Saratoga 1.4275 -> 0.1700).
    //    When the author also wrote a chain `delay_s`, the two are summed in
    //    the file and cannot be told apart; attributing the whole delay to the
    //    duration re-exports to identical timing, which is the property that
    //    matters.
    const durationByEventName = new Map<string, number>();
    for (const event of events) {
      const seconds = selfStartDurationS(event);
      if (seconds !== null) durationByEventName.set(event.name, seconds);
    }
    for (const [eventName, seconds] of chainStartDurations(events)) {
      if (!durationByEventName.has(eventName)) durationByEventName.set(eventName, seconds);
    }

    // A lane-offset return is a second event in the same maneuver, not a clip.
    const returnAfterByEvent = new Map<string, number>();
    for (const event of events) {
      if (!event.name.endsWith(OFFSET_RETURN_SUFFIX)) continue;
      const parentName = event.name.slice(0, -OFFSET_RETURN_SUFFIX.length);
      const parent = events.find((candidate) => candidate.name === parentName);
      if (!parent) continue;
      const returnAt = attrNumber(
        descendantEl(
          event.startTrigger,
          "ConditionGroup",
          "Condition",
          "ByValueCondition",
          "SimulationTimeCondition",
        ),
        "value",
      );
      const startAt = attrNumber(
        descendantEl(
          parent.startTrigger,
          "ConditionGroup",
          "Condition",
          "ByValueCondition",
          "SimulationTimeCondition",
        ),
        "value",
      );
      if (returnAt === null || startAt === null) continue;
      returnAfterByEvent.set(parentName, Math.round((returnAt - startAt) * 1000) / 1000);
    }

    const clips: BehaviorClip[] = [];
    for (const event of events) {
      const isFoldedReturn =
        event.name.endsWith(OFFSET_RETURN_SUFFIX) &&
        returnAfterByEvent.has(event.name.slice(0, -OFFSET_RETURN_SUFFIX.length));
      if (isFoldedReturn) continue;

      const triggerContext = {
        selfEntity: entity.name,
        clipIdForEventName: (name: string) => clipIdByEventName.get(name) ?? null,
        durationForEventName: (name: string) => durationByEventName.get(name) ?? 0,
      };

      const rawTriggers: BehaviorTrigger[] = [];
      let cutIn: { actorRef: BehaviorActorRef; gapM: number } | null = null;
      for (const condition of triggerConditions(event.startTrigger)) {
        const read = readCondition(condition, triggerContext);
        if (read.kind === "trigger") rawTriggers.push(read.trigger);
        else if (read.kind === "cutin_gap") cutIn = { actorRef: read.actorRef, gapM: read.gapM };
        else {
          diagnostics.add(
            "unknown_condition",
            `start condition <${read.element}> has no trigger inverse, so it was not imported`,
            { actorId: entity.name, clipId: event.clipId },
          );
        }
      }
      const folded = foldSignalTriggers(rawTriggers, signals.plans, signals.junctionBySignalId);
      const trigger = folded[0] ?? { kind: "at_time" as const, t: 0 };
      if (folded.length > 1) {
        diagnostics.add(
          "imported_approximation",
          `start trigger ANDs ${folded.length} conditions, which a single behavior trigger cannot express; only the first was imported`,
          { actorId: entity.name, clipId: event.clipId },
        );
      }
      if (folded.length === 0 && event.actions.length > 0) {
        diagnostics.add(
          "unknown_condition",
          "has no readable start condition, so it starts at t=0 in the imported draft",
          { actorId: entity.name, clipId: event.clipId },
        );
      }

      const composed = composeAction(event.actions, {
        isWalker: entity.kind === "walker",
        cutInGap: cutIn,
        returnAfterS: returnAfterByEvent.get(event.name) ?? null,
        selfLaneId: laneIdByEntity.get(entity.name) ?? null,
      });
      for (const element of composed.unsupported) {
        diagnostics.add(
          "unknown_action",
          `<${element}> has no behavior-action inverse and was not imported`,
          { actorId: entity.name, clipId: event.clipId },
        );
      }
      for (const approximation of composed.approximations) {
        diagnostics.add("imported_approximation", approximation, {
          actorId: entity.name,
          clipId: event.clipId,
        });
      }
      if (!composed.action) {
        diagnostics.add("clip_action_empty", "commands no action this importer can read", {
          actorId: entity.name,
          clipId: event.clipId,
        });
        continue;
      }

      clips.push({
        id: event.clipId,
        enabled: true,
        trigger,
        end: readClipEnd(
          event,
          trigger,
          composed.action.kind,
          diagnostics,
          entity.name,
          triggerContext,
          durationByEventName.get(event.name) ?? null,
        ),
        action: composed.action,
      });
    }

    const program: ActorBehaviorProgram = {
      schema_version: ACTOR_BEHAVIOR_SCHEMA_VERSION,
      clips,
      conflict_policy: "overwrite",
    };
    actors.push(actorDraftFor(entity, pose, program, diagnostics));
    entityNames[entity.name] = entity.name;
  }


  const draft = ScenarioEditorDraftSchema.parse({
    version: 2,
    metadata: {
      sourceScenarioId,
      mapAssetId,
      mapName,
      notes: "",
      createdAt: options.now ?? new Date().toISOString(),
      updatedAt: options.now ?? new Date().toISOString(),
    },
    simulationConfig: {
      duration_seconds: durationSeconds,
      fixed_delta_seconds: 0.05,
      physics_profile_id: "carla_default",
    },
    actors,
    ...(signals.plans.length > 0 ? { signal_plans: signals.plans } : {}),
  });

  // `renderConfig` is not on the draft schema — it rides along on the
  // normalized draft, and the writer reads it structurally — so it is attached
  // after the parse that would otherwise strip it.
  if (environmentPreset) {
    (draft as ScenarioEditorDraft & { renderConfig?: unknown }).renderConfig = {
      environmentPreset,
    };
  }

  return {
    draft,
    logicFile,
    embeddedMetadata,
    environmentPreset,
    signalCatalog: signals.signalIds,
    entityNames,
    diagnostics: diagnostics.all(),
  };
}


/**
 * The `completion` end for an action, in the OSC reading of the file.
 *
 * `cruise` is the one action whose native completion is "never" — it holds its
 * commanded speed until a later clip supersedes it — while the `SpeedAction` it
 * compiles to COMPLETES when the vehicle reaches the target, which is where
 * esmini ends the event and releases whatever is chained after it. The file
 * means the OSC thing, so an imported cruise carries the OSC reading explicitly
 * and every other end kind is untouched. Authored drafts never set it, which is
 * what keeps a hand-authored endless cruise endless.
 */
function completionEnd(actionKind: string): BehaviorClip["end"] {
  return actionKind === "cruise"
    ? { kind: "completion", on: BEHAVIOR_CLIP_END_ON_TARGET_SPEED }
    : { kind: "completion" };
}

/**
 * A clip's `end`, from its `<StopTrigger>`.
 *
 * A rising SIMULATION-TIME condition is what separates the two cases: the writer
 * generates one of those from a `{kind: "duration"}` end and from nothing else.
 * The edge on its own is not the discriminator — entity start triggers are
 * `rising` too — which is why `isRisingSimulationTime` tests the condition
 * family as well. So a lone rising time condition is a duration measured from
 * the clip's scheduled start, and anything else is an `until_trigger`.
 */
/**
 * The authored duration an event times off its OWN `startTransition`, or `null`.
 *
 * A condition-started clip has no wall clock, so the writer expresses its
 * duration as a self-referencing delayed condition. The SELF-reference is the
 * discriminator: the same element naming any OTHER event is an ordinary chain.
 */
function selfStartDurationS(event: ReadEvent): number | null {
  const first = triggerConditions(event.stopTrigger)[0];
  if (!first) return null;
  const selfStart = descendantEl(first, "ByValueCondition", "StoryboardElementStateCondition");
  if (
    !selfStart ||
    attrString(selfStart, "storyboardElementRef") !== event.name ||
    attrString(selfStart, "state") !== "startTransition"
  ) {
    return null;
  }
  return attrNumber(first, "delay");
}

/**
 * Upstream event name → the authored duration its downstream chain reveals.
 *
 * The mirror of `selfStartDurationS`: a `startTransition` element in a
 * START trigger naming some OTHER event is a chain, and the writer sets its
 * delay to the upstream clip's duration (see the `after_clip` case in the
 * writer's `triggers.ts`). Two clips chaining off the same upstream must agree,
 * so the first one wins and any disagreement would be an authoring error rather
 * than something to reconcile here.
 */
function chainStartDurations(events: readonly ReadEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const event of events) {
    for (const condition of triggerConditions(event.startTrigger)) {
      const chain = descendantEl(condition, "ByValueCondition", "StoryboardElementStateCondition");
      if (!chain || attrString(chain, "state") !== "startTransition") continue;
      const ref = attrString(chain, "storyboardElementRef");
      if (!ref || ref === event.name) continue;
      const delay = attrNumber(condition, "delay");
      if (delay === null || delay <= 0 || out.has(ref)) continue;
      out.set(ref, delay);
    }
  }
  return out;
}

function readClipEnd(
  event: ReadEvent,
  trigger: BehaviorTrigger,
  actionKind: string,
  diagnostics: ImportDiagnosticCollector,
  actorId: string,
  triggerContext: { selfEntity: string | null; clipIdForEventName: (name: string) => string | null },
  /**
   * The clip's authored duration, when one survived the export — either on this
   * event's own stop condition or folded into a downstream chain's delay. See
   * where `durationByEventName` is built.
   */
  durationS: number | null,
): BehaviorClip["end"] {
  if (durationS !== null) return { kind: "duration", seconds: durationS };
  const conditions = triggerConditions(event.stopTrigger);
  if (conditions.length === 0) return completionEnd(actionKind);
  const first = conditions[0]!;
  if (isRisingSimulationTime(first)) {
    const stopAt = attrNumber(
      descendantEl(first, "ByValueCondition", "SimulationTimeCondition"),
      "value",
    );
    if (stopAt !== null && trigger.kind === "at_time") {
      return { kind: "duration", seconds: Math.round((stopAt - trigger.t) * 1000) / 1000 };
    }
  }
  const read = readCondition(first, triggerContext);
  if (read.kind === "trigger") return { kind: "until_trigger", trigger: read.trigger };
  diagnostics.add(
    "unknown_condition",
    `stop condition <${read.kind === "unsupported" ? read.element : "cut-in gap"}> has no trigger inverse, so the clip runs to completion`,
    { actorId, clipId: event.clipId },
  );
  return completionEnd(actionKind);
}

/**
 * One `ScenarioObject` + its Init block + its maneuver, as a draft actor.
 *
 * Placement is always world-point: an .xosc records where an actor IS, never
 * which road anchor an author picked, and the `world_anchor` doctrine forbids
 * inventing one. `timed_waypoints` / `path_placement` mirror the motion clip's
 * polyline so the editor has something to draw and drag, but the behavior
 * program is the authority — which is also why `path_timing` is left alone
 * (see loss 9 in the module doc).
 */
function actorDraftFor(
  entity: EntityInfo,
  pose: InitPose,
  program: ActorBehaviorProgram,
  diagnostics: ImportDiagnosticCollector,
): ScenarioEditorActorDraft {
  const motion = program.clips.find(
    (clip) => clip.action.kind === "follow_path" || clip.action.kind === "walk_path",
  );
  const action = motion?.action;
  const waypoints =
    action?.kind === "follow_path" || action?.kind === "walk_path" ? action.waypoints : [];
  const timed = action?.kind === "walk_path" || (action?.kind === "follow_path" && action.timed);

  const placementMode: ScenarioEditorActorDraft["placement_mode"] =
    waypoints.length === 0 ? "point" : timed ? "timed_path" : "path";

  if (entity.kind !== "prop" && program.clips.length === 0) {
    diagnostics.add(
      "imported_approximation",
      "carries no maneuver in the file, so it imports as a stationary point actor — an authored static actor and a Traffic-Manager actor the writer could not express are indistinguishable here",
      { actorId: entity.name },
    );
  }

  const timedWaypoints: ScenarioEditorTimedWaypoint[] = waypoints.map((waypoint, index) => ({
    x: waypoint.x,
    y: waypoint.y,
    ...(waypoint.z === undefined ? {} : { z: waypoint.z }),
    time: waypoint.time ?? index,
  }));
  // `path_placement` is the WHOLE polyline, spawn point included — that is what
  // an editor-authored path actor carries (the writer's `pathPolyline` prepends
  // the spawn and dedupes it against the first point, which is why an export of
  // one has the same count as its `path_placement`). It also has to be exactly
  // the polyline the motion clip drives: `behavior_program._validate_action`
  // requires a `follow_path` clip's waypoints to EQUAL `path_placement`, and
  // dropping the leading point here made every imported scenario unrunnable in
  // CARLA.
  const pathPlacement = waypoints.map((waypoint) => ({
    x: waypoint.x,
    y: waypoint.y,
    ...(waypoint.z === undefined ? {} : { z: waypoint.z }),
  }));

  return {
    id: entity.name,
    label: entity.name,
    kind: entity.kind,
    // Entity names are the only role-like information in OSC. Preserve the
    // legacy reserved name on read, but normalize it before the draft exists.
    role:
      entity.kind === "walker"
        ? "pedestrian"
        : entity.kind === "prop"
          ? "prop"
          : entity.name === "ego"
            ? "subject"
            : "traffic",
    is_static: entity.kind === "prop",
    placement_mode: placementMode,
    blueprint: entity.blueprint,
    // Required by the schema and unused for a world-point placement, but the
    // resolved pose is carried on it so anything reading `world_anchor` gets
    // the truth rather than an origin.
    spawn: {
      road_id: "",
      s_fraction: 0,
      world_anchor: { x: pose.x, y: pose.y, z: pose.z, yaw: pose.yawDeg },
    },
    spawn_point: { x: pose.x, y: pose.y, z: pose.z },
    spawn_yaw: pose.yawDeg,
    route: [],
    route_direction: "forward",
    lane_facing: "with_lane",
    destination: null,
    destination_point: null,
    speed_kph: pose.speedKph ?? 0,
    autopilot: false,
    timeline: [],
    sensors: [],
    behavior: program,
    ...(placementMode === "timed_path" ? { timed_waypoints: timedWaypoints } : {}),
    ...(placementMode === "path" ? { path_placement: pathPlacement } : {}),
    // The bounding box the file carries is ground truth for whoever wrote it —
    // a measured CARLA box or a catalog lookup — so it is preserved rather than
    // re-derived from the blueprint, which would silently resize an actor whose
    // dimensions were measured. Walkers are excluded: the writer builds a
    // pedestrian box from the catalog age class and never reads this field.
    ...(entity.dimensions && entity.kind !== "walker"
      ? { blueprint_geometry: entity.dimensions }
      : {}),
  } as ScenarioEditorActorDraft;
}
