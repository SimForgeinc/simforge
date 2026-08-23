import "server-only";

/**
 * The one module that turns map artifacts into the editor's signal projection.
 *
 * ## Why a projection and not the raw data
 *
 * The inputs are a whole XODR and a whole topology index — tens of megabytes for
 * a real map, and v1 measured its equivalent runtime block at 113 KB–1.87 MB per
 * map of which almost all was bookkeeping no editor surface ever read. Every
 * signal surface needs the same small thing: which heads exist, which controller
 * stage owns each, which movements a stage runs, where the junctions are, and
 * what timing runs when nothing is authored. That is
 * {@link EditorSignalControlProjection}, and it is a few tens of kilobytes.
 *
 * Unlike v1's projection this one is **exact rather than measured**. v1's shipped
 * head poses recovered from two disagreeing sources with a documented accuracy
 * budget (position from the CARLA actor, facing from the `<signal>`, 8–15 deg
 * residual against the stop-line bearing) and needed a geometric fallback to
 * attribute a light to a junction at all. Here every relation is an id from the
 * map's own `<controller>` declarations: `buildSignalControlIndex`'s contract is
 * that "no geometric/proximity inference occurs".
 *
 * ## Single source of truth
 *
 * The catalog, baseline programs, and control index are produced by
 * `@uniscenarios/scenario-materializer` — the same `parseMapSignalCatalog`,
 * `buildMapControlPlan`, and `buildSignalControlIndex` used by playback. The
 * projection also records the broad control-plan hash as provenance, while plan
 * validity is decided from immutable map and exact physical reference ids.
 *
 * `buildMapControlPlan` takes a `SignalMapBundle` whose `index` field is a
 * `DerivedMapIndex`. It is genuinely unused on the signal-program path —
 * `buildSignalPlanForJunction` reads only `signalCatalog`, `topology` and
 * `graph`, and `apps/web/test/unit/lib/uniscenario-signal-canary.test.ts` already
 * passes `{ junctionDescriptors: {} } as never` for it. That is asserted by a
 * test here rather than assumed, because it is the one place this module depends
 * on a package internal.
 *
 * ## §2.5 conformance
 *
 * {@link readEditorSignalControlProjection} is a pure function of artifact
 * *bytes*: no `cookies()`, no session, no presigning. Its caller authorizes,
 * fetches, and may cache the artifact reads keyed on `mapVersionId` — an
 * immutable published artifact set, i.e. the `cacheLife('days')` class with tag
 * `uniscenario:map-version:<id>`. The presigned URLs used to fetch them must not
 * be cached: `MEDIA_URL_TTL_SECONDS` is 3600, pinned at the IAM role ceiling, and
 * no built-in profile is safe (plan §2.5.3). This module never sees a URL, only
 * the bytes, which is what keeps that rule impossible to break here.
 */

import {
  buildMapControlPlan,
  buildSignalControlIndex,
  parseMapSignalCatalog,
} from "@uniscenarios/scenario-materializer";
import {
  buildLaneGraph,
  contentHash,
  type SignalProgram,
  type TopologyIndex,
} from "@uniscenarios/sim-engine";

import {
  EDITOR_SIGNAL_PROJECTION_VERSION,
  type EditorSignalBaseline,
  type EditorSignalController,
  type EditorSignalControlProjection,
  type EditorSignalDiagnostic,
  type EditorSignalHead,
  type EditorSignalJunction,
  type EditorSignalMovement,
  type GateConflictPair,
} from "./types";

/** `derived/topology-derived.json.gz`, reduced to the part this needs. */
export type DerivedTopologyConflicts = {
  readonly junctions?: readonly {
    readonly junctionId: string;
    readonly conflictPairs?: readonly { readonly gateA: string; readonly gateB: string }[];
  }[];
};

export type ReadEditorSignalControlInput = {
  /** `uniscenario.map_versions.id`. */
  readonly mapVersionId: string;
  /** The compiler's map id, i.e. what `MapSignalPlan.binding.mapId` must equal. */
  readonly mapId: string;
  /** `uniscenario.map_versions.xodr_sha256`, echoed into the projection. */
  readonly xodrSha256: string;
  /** The map version's XODR text. */
  readonly xodr: string;
  /** The decoded `signals.geojson`. */
  readonly signalsGeoJson: unknown;
  /** The decoded `topology-index.json`. */
  readonly topology: TopologyIndex;
  /**
   * The decoded derived-topology artifact, when reachable.
   *
   * Advisory only — see {@link EditorSignalControlProjection.conflictPairsByJunction}.
   * Nothing here derives conflicts when it is absent.
   */
  readonly derivedTopology?: DerivedTopologyConflicts | null;
};

/**
 * Build the projection.
 *
 * Pure: same bytes in, same projection out, including `controlDigest`. That
 * determinism is load-bearing — the digest is the value a plan's binding is
 * checked against, so a projection that varied between two reads of the same map
 * version would invalidate every plan authored against the other read.
 */
export function readEditorSignalControlProjection(
  input: ReadEditorSignalControlInput,
): EditorSignalControlProjection {
  const signalCatalog = parseMapSignalCatalog(input.xodr, input.signalsGeoJson as never);
  const graph = buildLaneGraph(input.topology);
  const controlPlan = buildMapControlPlan({
    // Unused on this path; see the module header. Asserted by a test.
    index: { junctionDescriptors: {} } as never,
    graph,
    topology: input.topology,
    signalCatalog,
  });
  const controlDigest = contentHash(controlPlan);
  const controlIndex = buildSignalControlIndex(
    controlPlan.signalPrograms,
    signalCatalog.heads.map((head) => head.id),
  );

  const gateById = new Map(input.topology.gates.map((gate) => [gate.id, gate]));
  const gatesByConnectingLane = new Map<string, string[]>();
  for (const gate of input.topology.gates) {
    const list = gatesByConnectingLane.get(gate.connectingLaneRsl);
    if (list) list.push(gate.id);
    else gatesByConnectingLane.set(gate.connectingLaneRsl, [gate.id]);
  }

  const movements: EditorSignalMovement[] = [...controlIndex.movements.values()]
    .map((movement) => {
      const gateIds = [
        ...new Set(
          movement.connectingLaneRsls.flatMap(
            (rsl) => gatesByConnectingLane.get(rsl) ?? [],
          ),
        ),
      ].sort();
      // `TopologyGate.turnRelation` is optional in the artifact shape, so the
      // relation set is narrowed to present strings rather than asserted.
      const turnRelations = [
        ...new Set(
          gateIds.flatMap((gateId) => {
            const relation = gateById.get(gateId)?.turnRelation;
            return typeof relation === "string" && relation.length > 0 ? [relation] : [];
          }),
        ),
      ].sort();
      return {
        id: movement.id,
        junctionId: movement.junctionId,
        controllerIds: [...movement.controllerIds],
        headIds: [...movement.headIds],
        approachLaneRsls: [...movement.approachLaneRsls],
        connectingLaneRsls: [...movement.connectingLaneRsls],
        gateIds,
        turnRelations,
        label: movementLabel(movement.id, turnRelations),
      } satisfies EditorSignalMovement;
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const catalogControllerById = new Map(
    signalCatalog.controllers.map((controller) => [controller.id, controller]),
  );
  const controllers: EditorSignalController[] = [...controlIndex.controllers.values()]
    .map((controller) => ({
      id: controller.id,
      // OpenDRIVE's own stage order. Falling back to Number.MAX_SAFE_INTEGER
      // rather than 0 keeps an unparsed controller at the END of the sequence
      // instead of silently leading the cycle.
      sequence: catalogControllerById.get(controller.id)?.sequence ?? Number.MAX_SAFE_INTEGER,
      junctionId: controller.junctionId,
      headIds: [...controller.headIds],
      movementIds: [...controller.movementIds],
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const catalogHeadById = new Map(signalCatalog.heads.map((head) => [head.id, head]));
  const heads: EditorSignalHead[] = [...controlIndex.heads.values()]
    .map((head) => {
      const physical = catalogHeadById.get(head.id);
      return {
        id: head.id,
        roadId: physical?.roadId ?? "",
        s: physical?.s ?? 0,
        dynamic: physical?.dynamic ?? false,
        junctionIds: [...head.junctionIds],
        controllerIds: [...head.controllerIds],
        movementIds: [...head.movementIds],
        resolved: head.resolved,
      } satisfies EditorSignalHead;
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const junctions = buildJunctions(input.topology, controlIndex);
  const baselines = buildBaselines(controlPlan.signalPrograms);

  const conflictPairsByJunction: Record<string, readonly GateConflictPair[]> = {};
  for (const junction of input.derivedTopology?.junctions ?? []) {
    const pairs = (junction.conflictPairs ?? []).map(({ gateA, gateB }) => ({ gateA, gateB }));
    if (pairs.length > 0) conflictPairsByJunction[junction.junctionId] = pairs;
  }

  return {
    schemaVersion: EDITOR_SIGNAL_PROJECTION_VERSION,
    mapVersionId: input.mapVersionId,
    mapId: input.mapId,
    controlDigest,
    xodrSha256: input.xodrSha256,
    heads,
    controllers,
    movements,
    junctions,
    baselines,
    conflictPairsByJunction,
    conflictSource: input.derivedTopology ? "derived-artifact" : "none",
    diagnostics: controlIndex.diagnostics.map(
      (diagnostic) =>
        ({
          code: diagnostic.code,
          message: diagnostic.message,
          ...(diagnostic.headIds ? { headIds: [...diagnostic.headIds] } : {}),
          ...(diagnostic.movementIds ? { movementIds: [...diagnostic.movementIds] } : {}),
          ...(diagnostic.controllerIds ? { controllerIds: [...diagnostic.controllerIds] } : {}),
        }) satisfies EditorSignalDiagnostic,
    ),
  };
}

/** `signal:900` plus its turns — enough for a panel row before geometry loads. */
function movementLabel(movementId: string, turnRelations: readonly string[]): string {
  const head = movementId.startsWith("signal:") ? movementId.slice("signal:".length) : movementId;
  return turnRelations.length > 0 ? `Head ${head} · ${turnRelations.join("/")}` : `Head ${head}`;
}

/**
 * Junction footprints, in scene metres.
 *
 * Internal (connecting) lanes span the junction box by construction, so their
 * sampled vertices are the tightest description the topology carries. Approach
 * lanes are the fallback for a junction whose internal lanes failed to sample —
 * their last vertex is at the stop line, which still brackets the box, just more
 * loosely.
 *
 * `TopologyLane.polyline` is OpenDRIVE-local (x east, y north); the scene is
 * y-up with `scene = (x, height, -y)`, the same transform `LaneIndex` applies at
 * build time. Doing it once here keeps every consumer in the frame the renderer
 * and the placement controller already use.
 */
function buildJunctions(
  topology: TopologyIndex,
  controlIndex: ReturnType<typeof buildSignalControlIndex>,
): EditorSignalJunction[] {
  const out: EditorSignalJunction[] = [];
  for (const junction of Object.values(topology.junctions ?? {})) {
    const junctionId = String(junction.junctionId ?? "").trim();
    if (!junctionId) continue;
    const lanes = topology.lanes ?? {};
    const internal = (junction.internalLaneRsls ?? []).flatMap(
      (rsl) => lanes[String(rsl)]?.polyline ?? [],
    );
    const points =
      internal.length > 0
        ? internal
        : (junction.approachLaneRsls ?? []).flatMap((rsl) => {
            const polyline = lanes[String(rsl)]?.polyline ?? [];
            const last = polyline[polyline.length - 1];
            return last ? [last] : [];
          });

    // Already converted to the scene frame, so the centroid and the radius agree
    // on one basis rather than one of them silently using the local one.
    const scene = points.flatMap((point) => {
      const vertex = localVertexOf(point);
      return vertex ? [{ x: vertex.x, z: -vertex.y }] : [];
    });
    if (scene.length === 0) continue;
    const center = {
      x: scene.reduce((sum, point) => sum + point.x, 0) / scene.length,
      z: scene.reduce((sum, point) => sum + point.z, 0) / scene.length,
    };
    const radius = scene.reduce(
      (max, point) => Math.max(max, Math.hypot(point.x - center.x, point.z - center.z)),
      0,
    );

    const control = controlIndex.junctions.get(junctionId);
    const headIds = [...(control?.headIds ?? [])];
    out.push({
      junctionId,
      center: { x: round(center.x), z: round(center.z) },
      radiusM: Math.round(radius * 100) / 100,
      controllerIds: [...(control?.controllerIds ?? [])],
      headIds,
      movementIds: [...(control?.movementIds ?? [])],
      // Exact: a junction is signalized when a program binds a head to it. v1
      // needed a positional fallback here and a `topology_only` tier that
      // reported every junction as unsignalized; neither has an analogue.
      signalized: headIds.length > 0,
    });
  }
  return out.sort((left, right) =>
    left.junctionId.localeCompare(right.junctionId, undefined, { numeric: true }),
  );
}

/**
 * A polyline vertex, whichever of the artifact's two shapes it arrived in.
 *
 * `TopologyLane.polyline` is `{ x, y }` objects in the topology index this repo
 * generates, but the decoded type also admits `[x, y]` pairs, and reading `.x`
 * off a tuple yields `undefined` rather than an error — a whole junction's
 * centroid would silently become `NaN`. The same normalisation exists in
 * `editor/core/laneIndex.ts` for the same reason.
 */
function localVertexOf(point: unknown): { x: number; y: number } | null {
  if (Array.isArray(point)) {
    const [x, y] = point as [unknown, unknown];
    return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)
      ? { x, y }
      : null;
  }
  if (point != null && typeof point === "object") {
    const { x, y } = point as { x?: unknown; y?: unknown };
    return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)
      ? { x, y }
      : null;
  }
  return null;
}

function buildBaselines(programs: readonly SignalProgram[]): EditorSignalBaseline[] {
  return programs
    .filter((program) => program.mapBinding != null)
    .map((program): EditorSignalBaseline => ({
      movementId: program.id,
      junctionId: program.mapBinding!.junctionId,
      headIds: [...program.mapBinding!.headIds],
      controllerIds: [...program.mapBinding!.controllerIds],
      phases: program.phases.map((phase) => ({
        indication: phase.phase,
        durationS: phase.durationS,
      })),
      offsetS: program.offsetS,
      loop: program.loop,
      timingSource: program.mapBinding!.timingSource === "authored" ? "authored" : "synthetic-default",
    }))
    .sort((left, right) => left.movementId.localeCompare(right.movementId));
}

/** Millimetres are already far finer than a junction centroid is meaningful to. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
