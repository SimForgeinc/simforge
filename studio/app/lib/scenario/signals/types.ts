/**
 * The editor's traffic-signal domain, over v2's stable map handles.
 *
 * ## What v2 changed, and why this is not a transliteration of v1
 *
 * v1 bound signal authoring to `map_assets` rows, OpenDRIVE road ids and a
 * runtime CARLA bundle, and every one of those renumbers across a UE5 map
 * rebuild. Roughly a third of v1's 9,253 lines of signal code exists to survive
 * that instability: a sha256 identity gate between the topology index's source
 * XODR and the uploaded artifact (`xodr-signal-groups.server.ts`), a 25 m
 * geometric "which junction is this light standing in" fallback
 * (`attributeLightsToJunctions`), a `topology_only` signalization tier for maps
 * with no compiled semantic graph, and a per-process cache keyed on a hand-bumped
 * derivation version.
 *
 * v2 deletes the premise. `simforge.map_versions` carries `xodr_artifact_id`,
 * `xodr_sha256`, `topology_artifact_url`, `signals_artifact_id` and
 * `coordinate_system_sha256` **on one row**, under
 * `UNIQUE (workspace_id, xodr_sha256, coordinate_system_sha256)`. A map version
 * *is* its XODR identity, so the XODR a signal binding was authored against and
 * the topology it was attributed through cannot disagree — the check v1 spent a
 * module on is satisfied by the schema. See `MapSignalPlan.binding`, which
 * carries `mapId` + `junctionId` + `controlDigest` for exactly this reason: the
 * digest is a content hash of the compiled control plan, so a stale binding is
 * caught by value rather than by re-deriving ids.
 *
 * ## The three grains, and which one an author touches
 *
 * | grain | id | comes from |
 * |---|---|---|
 * | physical head | OpenDRIVE `<signal>` id, e.g. `900` | `MapSignalCatalog.heads` |
 * | controller stage | OpenDRIVE `<controller>` id, e.g. `951` | `MapSignalCatalog.controllers` |
 * | movement | engine program id, `signal:<firstHeadId>` | `SignalProgram.mapBinding` |
 *
 * An author clicks a **head**. `selectSignalReference` resolves that to exactly
 * one reference movement and one controller stage, plus the head sets to
 * highlight. A `MapSignalPlanClip` then names `{ controllerId, headId }` and one
 * indication, and `evaluateSignalReferencePhase` projects that onto every other
 * head at the junction, failing closed when a program cannot express the result.
 *
 * That is why this module carries **no per-movement state map**. v1's
 * `SignalPhaseInterval.states: Record<movementId, BehaviorSignalState>` restated
 * every movement in the junction on every interval, and v1 needed
 * `allRedStates`/`withGroup` helpers to keep those maps consistent. In v2 a clip
 * states one head's indication and the compiler derives the rest, so the whole
 * class of "the panel invented a partition the validator disagrees with" bug
 * that v1's `synthesizeSignalProgram` comment warns about cannot occur here.
 *
 * ## Baseline timing is the map's, not an editor invention
 *
 * v1's `map_default` mode meant "every dynamic light is forced GREEN and frozen
 * for the whole scenario" — a decision forced on it because v1 had no map-owned
 * program to fall back to. v2 has one: `buildMapControlPlan` emits a real
 * looping `SignalProgram` per controller-stage group, and
 * `compileMapSignalPlans` retains that baseline through warm-up and through
 * every interval no clip covers. So "no plan" is a *better* default than v1's
 * forced green, and {@link SignalPlanMode} has no `map_default` member: the
 * absence of a `MapSignalPlan` is the mode.
 *
 * ## Where these inputs come from
 *
 * Everything here is structural, so the pure model runs in tests with no S3, no
 * database and no React. `control-plan.server.ts` is the one module that reads
 * artifacts; it produces {@link EditorSignalControlProjection}, which is what
 * crosses the wire and what every function in this folder consumes.
 */

import type { MapSignalIndication } from "@simforge/scenario";
import type { ControlIndication } from "@simforge/engine";

export type { ControlIndication, MapSignalIndication };

/**
 * The indications a MAP signal plan may author.
 *
 * Deliberately six, not eleven. `@simforge/engine` defines
 * eleven `CONTROL_INDICATIONS` and the render worker now renders all eleven
 * (`SIGNAL_LAMP_BY_INDICATION`, with `flashing_*` alternating at 1 Hz), but
 * `MapSignalPlanClipSchema` refines the enum down to these six and
 * `TrafficControlSchema` gates the other five behind `kind`:
 * `green_arrow`/`yellow_arrow`/`red_x` belong to `lane_control` gantries and
 * `proceed`/`stop` to a `human_director`. Neither is a road signal.
 *
 * This is consistent with the hardware model rather than a limitation of it.
 * A protected-left head shows a green ARROW because its lens is an arrow — that
 * is hardware, derived from the plan's protected turns by
 * {@link signalLensKindIndex} — while the indication it is *commanded* to is
 * still plain `green`. Offering `green_arrow` here would ask an author to
 * restate in the timing what the lens already says, and the schema would reject
 * it.
 */
export const MAP_SIGNAL_PLAN_INDICATIONS = [
  "green",
  "yellow",
  "red",
  "flashing_yellow",
  "flashing_red",
  "off",
] as const satisfies readonly MapSignalIndication[];

/** A physical head, as the projection ships it. */
export type EditorSignalHead = {
  /** OpenDRIVE `<signal>` id — the handle every clip, export and worker uses. */
  readonly id: string;
  readonly roadId: string;
  readonly s: number;
  /** `dynamic="yes"`: a state-changing device. A static sign is not authorable. */
  readonly dynamic: boolean;
  /** Junctions claiming this head. More than one is a map defect. */
  readonly junctionIds: readonly string[];
  readonly controllerIds: readonly string[];
  /** Engine program ids this head participates in. */
  readonly movementIds: readonly string[];
  /**
   * False when the head exists physically but no program/controller owns it.
   *
   * v1 answered this question geometrically and could only ever produce a
   * junction, never a movement. Here it is exact: `buildSignalControlIndex`
   * performs no proximity inference at all.
   */
  readonly resolved: boolean;
};

/** One OpenDRIVE controller stage. */
export type EditorSignalController = {
  readonly id: string;
  /** `<controller>` order within its junction — the map's own stage sequence. */
  readonly sequence: number;
  readonly junctionId: string;
  readonly headIds: readonly string[];
  readonly movementIds: readonly string[];
};

/**
 * One executable movement: the grain that holds a single indication at `t`.
 *
 * `id` is the engine program id (`signal:<firstHeadId>`), which is also
 * `SignalMovementBinding.id`. `turnRelations` is joined from
 * `TopologyGate.turnRelation` through `connectingLaneRsls` — v1 recovered the
 * same information by splitting a composite `movement_id` string on its last
 * `":"`, which only worked because v1 minted those ids itself.
 */
export type EditorSignalMovement = {
  readonly id: string;
  readonly junctionId: string;
  readonly controllerIds: readonly string[];
  readonly headIds: readonly string[];
  readonly approachLaneRsls: readonly string[];
  readonly connectingLaneRsls: readonly string[];
  /** Gate ids realised by this movement. */
  readonly gateIds: readonly string[];
  /** Distinct `TopologyGate.turnRelation` values across those gates, sorted. */
  readonly turnRelations: readonly string[];
  /** Human label for the panel: `"Northbound left"`-shaped when derivable. */
  readonly label: string;
};

/** A signalized junction, reduced to what the canvas and the panel need. */
export type EditorSignalJunction = {
  readonly junctionId: string;
  /**
   * Centroid of the junction's internal lanes, in **scene** metres
   * (`x`, `z`) — the frame `LaneIndex` and the renderer share.
   *
   * Internal (connecting) lanes span the junction box by construction, so their
   * sampled vertices are the tightest description the topology carries.
   */
  readonly center: { readonly x: number; readonly z: number };
  /** Centre to the farthest internal-lane vertex: the click/label footprint. */
  readonly radiusM: number;
  readonly controllerIds: readonly string[];
  readonly headIds: readonly string[];
  readonly movementIds: readonly string[];
  /** At least one head is bound to an executable program. */
  readonly signalized: boolean;
};

/** A conflict between two gates, as the derived-topology artifact reports it. */
export type GateConflictPair = {
  readonly gateA: string;
  readonly gateB: string;
};

/** One diagnostic from `buildSignalControlIndex`, carried through the wire. */
export type EditorSignalDiagnostic = {
  readonly code:
    | "unresolved_head"
    | "unresolved_movement"
    | "shared_head"
    | "conflicting_controller_stage"
    | "missing_controller_stage";
  readonly message: string;
  readonly headIds?: readonly string[];
  readonly movementIds?: readonly string[];
  readonly controllerIds?: readonly string[];
};

/** One interval of a map-owned baseline program, for the timeline's ghost row. */
export type EditorBaselinePhase = {
  readonly indication: ControlIndication;
  readonly durationS: number;
};

/**
 * A map-owned baseline program, projected for the editor.
 *
 * This is the timing that runs wherever a plan does not. `timingSource` is
 * `"synthetic-default"` on every production map today —
 * `map-signals.ts` preserves RoadRunner's real head ids, controller membership
 * and stage sequence but says plainly that the *durations* are a documented
 * fallback rather than field timing. The panel must say so too; an author who
 * believes the baseline is surveyed will not author the timing they need.
 */
export type EditorSignalBaseline = {
  /** Engine program id; equals {@link EditorSignalMovement.id}. */
  readonly movementId: string;
  readonly junctionId: string;
  readonly headIds: readonly string[];
  readonly controllerIds: readonly string[];
  readonly phases: readonly EditorBaselinePhase[];
  readonly offsetS: number;
  readonly loop: boolean;
  readonly timingSource: "synthetic-default" | "authored";
};

export const EDITOR_SIGNAL_PROJECTION_VERSION = "uniscenario.editor-signal-control.v1";

/**
 * Everything the editor's signal surfaces need for one map version.
 *
 * Shipped as a projection for the same reason v1 projected its traffic lights:
 * the raw inputs are a whole XODR plus a topology index, tens of megabytes, and
 * no signal surface reads more than this. Unlike v1's projection this one is
 * *exact* rather than measured — every field is an id relation from the map's
 * own OpenDRIVE controller declarations, so there is no accuracy caveat to
 * carry, only a completeness one ({@link EditorSignalDiagnostic}).
 */
export type EditorSignalControlProjection = {
  readonly schemaVersion: typeof EDITOR_SIGNAL_PROJECTION_VERSION;
  /** `simforge.map_versions.id` — the stable v2 handle. */
  readonly mapVersionId: string;
  /** The compiler's `mapId`, i.e. what `MapSignalPlan.binding.mapId` must equal. */
  readonly mapId: string;
  /**
   * Provenance hash of the projected map-control closure.
   *
   * Executability does not depend on this broad hash: a signal plan binds by
   * immutable map id plus exact junction, controller, and head ids. This value
   * remains useful for diagnostics and cache identity without allowing unrelated
   * road-control enrichment to invalidate a working signal plan.
   */
  readonly controlDigest: string;
  /** `map_versions.xodr_sha256`, echoed so a client can prove provenance. */
  readonly xodrSha256: string;
  readonly heads: readonly EditorSignalHead[];
  readonly controllers: readonly EditorSignalController[];
  readonly movements: readonly EditorSignalMovement[];
  readonly junctions: readonly EditorSignalJunction[];
  readonly baselines: readonly EditorSignalBaseline[];
  /**
   * Gate conflicts per junction.
   *
   * From the map's `derived/topology-derived.json.gz`
   * (`map_versions.derived_topology_artifact_id`) when it is reachable, which is
   * the same source `compileMapSignalPlans` validates against.
   *
   * **Advisory, not load-bearing.** Nothing in this folder partitions movements
   * from these pairs: the conflict-free partition an author cycles through is
   * the map's own declared controller-stage sequence (see `stages.ts`), which is
   * authoritative and needs no derivation. These pairs are used only to
   * pre-flight a cycle against the exact rule
   * `map_signal_plan_controller_conflict` applies, so the panel can warn before
   * an Apply that the compiler would reject. Empty is a normal state and costs
   * only that warning.
   */
  readonly conflictPairsByJunction: Readonly<Record<string, readonly GateConflictPair[]>>;
  /**
   * Whether {@link conflictPairsByJunction} is authoritative.
   *
   * `"derived-artifact"` means it came from the artifact the compiler uses.
   * `"none"` means no conflict data was reachable, so the pre-flight warning is
   * suppressed rather than guessed. It is deliberately never derived
   * geometrically here: an invented partition is how v1 shipped 32 spurious
   * `shared_signal_heads` warnings on an otherwise ordinary Apply, and a second
   * source of truth for conflicts is worse than no warning.
   */
  readonly conflictSource: "derived-artifact" | "none";
  readonly diagnostics: readonly EditorSignalDiagnostic[];
};
