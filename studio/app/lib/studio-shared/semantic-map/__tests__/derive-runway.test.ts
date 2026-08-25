import { describe, expect, it } from "vitest";

import { deriveRunway, runwayBudgetM, runwayPolyline } from "../derive-runway";
import type {
  JunctionMovement,
  JunctionMovementVariant,
  LaneCorridor,
  SemanticMapGraph,
  SemanticMapPoint,
} from "../types";

/**
 * A four-way: one corridor running east into a junction that offers straight on,
 * a left north, a right south, and a U-turn back west.
 *
 *                north
 *                  |
 *   west --------- + --------- east
 *                  |
 *                south
 *
 * Turn relations use the SCHEMA's capitalised spellings (`TurnRelationSchema`:
 * Left / Right / Straight / UTurnLeft / UTurnRight) rather than the lowercase
 * ones `compile-autopilot-route.test.ts` casts in, because the straightest-first
 * rule reads that field directly and a graph in production carries the
 * capitalised form.
 */
function line(from: SemanticMapPoint, to: SemanticMapPoint, steps = 10): SemanticMapPoint[] {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const t = index / steps;
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: 0 };
  });
}

function corridor(
  id: string,
  polyline: SemanticMapPoint[],
  overrides: Partial<LaneCorridor> = {},
): LaneCorridor {
  return {
    id,
    laneType: "driving",
    runtimeFragments: [{ rsl: `${id}_rsl`, startArcM: 0, endArcM: 90 }],
    polyline,
    lengthM: 90,
    representativeWidthM: 3.5,
    minWidthM: 3.5,
    maxWidthM: 3.5,
    speedLimitKph: 50,
    start: { point: polyline[0]!, headingRad: 0, kind: "map_boundary", junctionId: null },
    end: {
      point: polyline[polyline.length - 1]!,
      headingRad: 0,
      kind: "junction",
      junctionId: "j1",
    },
    predecessorCorridorIds: [],
    successorCorridorIds: [],
    lateralAdjacencies: [],
    seams: [],
    authoringStatus: "authorable",
    diagnosticCodes: [],
    ...overrides,
  } as LaneCorridor;
}

function variant(
  id: string,
  movementId: string,
  incomingCorridorId: string,
  outgoingCorridorId: string,
  polyline: SemanticMapPoint[],
): JunctionMovementVariant {
  return {
    id,
    movementId,
    gateId: `${id}_gate`,
    incomingCorridorId,
    outgoingCorridorId,
    runtimeLaneRsls: ["a", "b"],
    polyline,
    lengthM: 20,
    entryStationM: 0,
    exitStationM: 20,
    representativeWidthM: 3.5,
    authoringStatus: "authorable",
    diagnosticCodes: [],
  } as JunctionMovementVariant;
}

function movement(id: string, turnRelation: string): JunctionMovement {
  return {
    id,
    junctionId: "j1",
    incomingApproachId: "in",
    outgoingApproachId: "out",
    turnRelation,
    variantIds: [`${id}_v`],
    representativeVariantId: `${id}_v`,
    conflictZoneIds: [],
    authoringStatus: "authorable",
    diagnosticCodes: [],
  } as unknown as JunctionMovement;
}

const BOUNDARY = (point: SemanticMapPoint) => ({
  point,
  headingRad: 0,
  kind: "map_boundary" as const,
  junctionId: null,
});

function makeFourWay(): SemanticMapGraph {
  const west = corridor("c_west", line({ x: -100, y: 0, z: 0 }, { x: -10, y: 0, z: 0 }), {
    runtimeFragments: [
      { rsl: "10:0:-1", startArcM: 0, endArcM: 45 },
      { rsl: "10:1:-1", startArcM: 45, endArcM: 90 },
    ],
  });
  const east = corridor("c_east", line({ x: 10, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }), {
    runtimeFragments: [{ rsl: "20:0:-1", startArcM: 0, endArcM: 90 }],
    end: BOUNDARY({ x: 100, y: 0, z: 0 }),
  });
  const north = corridor("c_north", line({ x: 0, y: 10, z: 0 }, { x: 0, y: 100, z: 0 }), {
    runtimeFragments: [{ rsl: "30:0:1", startArcM: 0, endArcM: 90 }],
    end: BOUNDARY({ x: 0, y: 100, z: 0 }),
  });
  const south = corridor("c_south", line({ x: 0, y: -10, z: 0 }, { x: 0, y: -100, z: 0 }), {
    runtimeFragments: [{ rsl: "40:0:-1", startArcM: 0, endArcM: 90 }],
    end: BOUNDARY({ x: 0, y: -100, z: 0 }),
  });
  const backWest = corridor(
    "c_back_west",
    line({ x: -10, y: -4, z: 0 }, { x: -100, y: -4, z: 0 }),
    {
      runtimeFragments: [{ rsl: "10:0:1", startArcM: 0, endArcM: 90 }],
      end: BOUNDARY({ x: -100, y: -4, z: 0 }),
    },
  );

  return {
    corridors: [west, east, north, south, backWest],
    approaches: [],
    movements: [
      movement("m_straight", "Straight"),
      movement("m_left", "Left"),
      movement("m_right", "Right"),
      movement("m_uturn", "UTurnLeft"),
    ],
    movementVariants: [
      variant(
        "m_straight_v",
        "m_straight",
        "c_west",
        "c_east",
        line({ x: -10, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 4),
      ),
      variant("m_left_v", "m_left", "c_west", "c_north", [
        { x: -10, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 10, z: 0 },
      ]),
      variant("m_right_v", "m_right", "c_west", "c_south", [
        { x: -10, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: 0, y: -10, z: 0 },
      ]),
      variant("m_uturn_v", "m_uturn", "c_west", "c_back_west", [
        { x: -10, y: 0, z: 0 },
        { x: 0, y: -2, z: 0 },
        { x: -10, y: -4, z: 0 },
      ]),
    ],
    conflictZones: [],
    diagnostics: [],
  } as unknown as SemanticMapGraph;
}

const START = { x: -100, y: 0 };

describe("deriveRunway", () => {
  it("goes straight through a junction that also offers left, right and a U-turn", () => {
    const runway = deriveRunway({ graph: makeFourWay(), start: START, travelBudgetM: 250 });

    const junction = runway.legs.find((leg) => leg.kind === "junction");
    expect(junction).toMatchObject({ id: "m_straight_v", turn: "Straight" });
    // It carried on east, not north or south.
    expect(runway.legs.map((leg) => leg.id)).toEqual(["c_west", "m_straight_v", "c_east"]);
    expect(runway.unmetTurns).toEqual([]);
  });

  it("is a pure function of the graph — no seed, so no per-actor divergence", () => {
    const graph = makeFourWay();
    const a = deriveRunway({ graph, start: START, travelBudgetM: 250 });
    const b = deriveRunway({ graph, start: START, travelBudgetM: 250 });
    expect(a.anchors).toEqual(b.anchors);
    expect(a.legs).toEqual(b.legs);
  });

  it("does not depend on the graph's array order, which is a build artifact", () => {
    const graph = makeFourWay();
    const shuffled = {
      ...graph,
      movementVariants: [...graph.movementVariants].reverse(),
      corridors: [...graph.corridors].reverse(),
    } as SemanticMapGraph;
    expect(deriveRunway({ graph: shuffled, start: START, travelBudgetM: 250 }).legs).toEqual(
      deriveRunway({ graph, start: START, travelBudgetM: 250 }).legs,
    );
  });

  it("takes an authored left instead of the straight default, and says it was authored", () => {
    const runway = deriveRunway({
      graph: makeFourWay(),
      start: START,
      travelBudgetM: 250,
      turnAtJunctions: ["left"],
    });

    expect(runway.legs.map((leg) => leg.id)).toEqual(["c_west", "m_left_v", "c_north"]);
    expect(runway.legs.find((leg) => leg.kind === "junction")).toMatchObject({
      turn: "Left",
      authored: true,
    });
  });

  it("takes an authored right, and an authored U-turn the default would never pick", () => {
    const right = deriveRunway({
      graph: makeFourWay(),
      start: START,
      travelBudgetM: 250,
      turnAtJunctions: ["right"],
    });
    expect(right.legs.map((leg) => leg.id)).toEqual(["c_west", "m_right_v", "c_south"]);

    const uTurn = deriveRunway({
      graph: makeFourWay(),
      start: START,
      travelBudgetM: 250,
      turnAtJunctions: ["u_turn"],
    });
    expect(uTurn.legs.map((leg) => leg.id)).toEqual([
      "c_west",
      "m_uturn_v",
      "c_back_west",
    ]);
  });

  it("reports an unmeetable turn rather than silently going straight", () => {
    // A T with no left: west into a junction offering only straight and right.
    const graph = makeFourWay() as SemanticMapGraph & {
      movementVariants: JunctionMovementVariant[];
    };
    const noLeft = {
      ...graph,
      movementVariants: graph.movementVariants.filter(
        (candidate) => candidate.movementId !== "m_left",
      ),
    } as SemanticMapGraph;

    const runway = deriveRunway({
      graph: noLeft,
      start: START,
      travelBudgetM: 250,
      turnAtJunctions: ["left"],
    });

    expect(runway.unmetTurns).toEqual([0]);
    // Fell back to straightest, and the leg is NOT marked authored.
    expect(runway.legs.find((leg) => leg.kind === "junction")).toMatchObject({
      turn: "Straight",
    });
    expect(runway.legs.find((leg) => leg.kind === "junction")?.authored).toBeUndefined();
  });

  it("picks straightest by geometry when nothing is classified Straight", () => {
    // A fork: the junction offers a gentle bend and a hard left, neither of them
    // relation `Straight`. Geometry has to break the tie, because a real map
    // index leaves plenty of forks unclassified.
    const graph = makeFourWay();
    const forked = {
      ...graph,
      movements: [movement("m_left", "Left"), movement("m_bend", "Left")],
      movementVariants: [
        variant("m_bend_v", "m_bend", "c_west", "c_east", [
          { x: -10, y: 0, z: 0 },
          { x: 0, y: 1, z: 0 },
          { x: 10, y: 1.5, z: 0 },
        ]),
        variant("m_left_v", "m_left", "c_west", "c_north", [
          { x: -10, y: 0, z: 0 },
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 10, z: 0 },
        ]),
      ],
    } as unknown as SemanticMapGraph;

    const runway = deriveRunway({ graph: forked, start: START, travelBudgetM: 250 });
    expect(runway.legs.map((leg) => leg.id)).toEqual(["c_west", "m_bend_v", "c_east"]);
  });

  it("stops instead of taking an unauthored U-turn when it is the only way out", () => {
    const graph = makeFourWay() as SemanticMapGraph & {
      movementVariants: JunctionMovementVariant[];
    };
    const deadEnd = {
      ...graph,
      movementVariants: graph.movementVariants.filter(
        (candidate) => candidate.movementId === "m_uturn",
      ),
    } as SemanticMapGraph;

    const runway = deriveRunway({ graph: deadEnd, start: START, travelBudgetM: 250 });
    expect(runway.legs.map((leg) => leg.id)).toEqual(["c_west"]);
    expect(runway.terminated).toBe("dead_end");
    expect(runway.stopReason).toBe("no_continuation");
  });

  it("rejects a successor edge whose geometry cannot join the driven corridor", () => {
    // The 2026-07-31 corpus contained ten stale semantic edges like this, with
    // jumps up to 128.9 m. An id cannot overrule the geometry the car executes.
    const first = corridor("c_first", line({ x: 0, y: 0, z: 0 }, { x: 50, y: 0, z: 0 }), {
      successorCorridorIds: ["c_far"],
      end: { point: { x: 50, y: 0, z: 0 }, headingRad: 0, kind: "branch", junctionId: null },
    });
    const far = corridor("c_far", line({ x: 150, y: 0, z: 0 }, { x: 200, y: 0, z: 0 }), {
      predecessorCorridorIds: ["c_first"],
      end: { point: { x: 200, y: 0, z: 0 }, headingRad: 0, kind: "map_boundary", junctionId: null },
    });
    const graph = {
      corridors: [first, far],
      approaches: [],
      movements: [],
      movementVariants: [],
      conflictZones: [],
      diagnostics: [],
    } as unknown as SemanticMapGraph;

    const runway = deriveRunway({ graph, start: { x: 0, y: 0 }, travelBudgetM: 500 });
    expect(runway.legs.map((leg) => leg.id)).toEqual(["c_first"]);
    expect(runway.terminated).toBe("dead_end");
  });

  it("ignores a stale terminal detour when the preceding point joins the successor", () => {
    // Prebuilt Di Rosa and Saratoga graphs contain XODR splice tails that turn
    // 82–90° away from the CARLA crawl. The point before the tail is the real
    // runtime seam and joins the successor within millimetres.
    const first = corridor(
      "c_first",
      [
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
        { x: 10, y: 5, z: 0 },
      ],
      { successorCorridorIds: ["c_next"] },
    );
    const next = corridor(
      "c_next",
      line({ x: 10, y: 0, z: 0 }, { x: 30, y: 0, z: 0 }),
      { predecessorCorridorIds: ["c_first"] },
    );
    const graph = {
      corridors: [first, next],
      approaches: [],
      movements: [],
      movementVariants: [],
      conflictZones: [],
      diagnostics: [],
    } as unknown as SemanticMapGraph;

    const runway = deriveRunway({ graph, start: { x: 0, y: 0 }, travelBudgetM: 500 });
    expect(runway.legs.map((leg) => leg.id)).toEqual(["c_first", "c_next"]);
    expect(runway.anchors.some((anchor) => anchor.y === 5)).toBe(false);
  });

  it("carries the lane binding an anchor sits on, across a section boundary", () => {
    const runway = deriveRunway({ graph: makeFourWay(), start: START, travelBudgetM: 250 });
    const bindings = new Set(
      runway.anchors.map((anchor) => anchor.rsl).filter((rsl): rsl is string => rsl != null),
    );
    // The approach spans 10:0:-1 and 10:1:-1; a route that reported only the
    // first fragment for every point would name a lane it had already left.
    expect(bindings.has("10:0:-1") || bindings.has("10:1:-1")).toBe(true);
    expect(bindings.has("20:0:-1")).toBe(true);
    for (const anchor of runway.anchors) {
      if (anchor.rsl === null) expect(anchor.s_fraction).toBeNull();
      else expect(anchor.s_fraction).not.toBeNull();
    }
  });

  it("stops at the travel budget and reports why", () => {
    const short = deriveRunway({ graph: makeFourWay(), start: START, travelBudgetM: 40 });
    expect(short.terminated).toBe("budget");
    expect(short.travelledM).toBeGreaterThan(0);
    // Never crossed the junction: the budget ran out on the approach.
    expect(short.legs.every((leg) => leg.kind === "corridor")).toBe(true);
  });

  it("reports dead_end when the actor is nowhere near a corridor", () => {
    const runway = deriveRunway({
      graph: makeFourWay(),
      start: { x: 10_000, y: 10_000 },
      travelBudgetM: 250,
    });
    // A far-away start still resolves to the NEAREST corridor by design (a car
    // on a driveway is legitimate); what it must not do is throw.
    expect(runway.anchors.length).toBeGreaterThanOrEqual(0);
  });

  it("picks the corridor going the actor's way on a two-way road", () => {
    // Two corridors 4 m apart running opposite ways — an ordinary two-way road.
    // Nearest-vertex alone is a coin flip between them, and picking wrong puts
    // the car head-on into oncoming traffic at zero distance from the authored
    // route. Measured against the corpus 2026-07-29: six actors did exactly
    // that (B2, B2-nodist, B4, B6, F10, S12) — 0.0 m away, 180 deg wrong.
    const eastbound = corridor("c_east_bound", line({ x: -100, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }), {
      end: BOUNDARY({ x: 100, y: 0, z: 0 }),
    });
    const westbound = corridor(
      "c_west_bound",
      line({ x: 100, y: 4, z: 0 }, { x: -100, y: 4, z: 0 }),
      { end: BOUNDARY({ x: -100, y: 4, z: 0 }) },
    );
    const graph = {
      corridors: [eastbound, westbound],
      approaches: [],
      movements: [],
      movementVariants: [],
      conflictZones: [],
      diagnostics: [],
    } as unknown as SemanticMapGraph;

    // Sitting between the two, facing east: must take the eastbound corridor.
    const facingEast = deriveRunway({
      graph,
      start: { x: 0, y: 2.1 },
      startHeadingDeg: 0,
      travelBudgetM: 150,
    });
    expect(facingEast.legs[0]?.id).toBe("c_east_bound");

    // Same spot, facing west: the westbound one, even though it is fractionally
    // further from the requested point.
    const facingWest = deriveRunway({
      graph,
      start: { x: 0, y: 1.9 },
      startHeadingDeg: 180,
      travelBudgetM: 150,
    });
    expect(facingWest.legs[0]?.id).toBe("c_west_bound");
  });

  it("puts an against-lane actor on the corridor that goes its way", () => {
    // An against-lane recovery scenario (corpus: F10 "Against-lane recovery",
    // J6 "Against-lane spawn reverses"). The car sits in the eastbound lane
    // facing WEST. The corridor going its way is the oncoming one, and that is
    // the honest answer: a car driving the wrong way down a road is, in lane
    // terms, travelling the oncoming lane's direction. Picking the corridor it
    // is geometrically closest to would drive it backwards instead.
    const eastbound = corridor("c_east_bound", line({ x: -100, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }), {
      end: BOUNDARY({ x: 100, y: 0, z: 0 }),
    });
    const westbound = corridor(
      "c_west_bound",
      line({ x: 100, y: 4, z: 0 }, { x: -100, y: 4, z: 0 }),
      { end: BOUNDARY({ x: -100, y: 4, z: 0 }) },
    );
    const graph = {
      corridors: [eastbound, westbound],
      approaches: [],
      movements: [],
      movementVariants: [],
      conflictZones: [],
      diagnostics: [],
    } as unknown as SemanticMapGraph;

    // Mid-road, in the eastbound lane, facing west.
    const runway = deriveRunway({
      graph,
      start: { x: 0, y: 0 },
      startHeadingDeg: 180,
      travelBudgetM: 150,
    });
    expect(runway.legs[0]?.id).toBe("c_west_bound");
    expect(runway.anchors.length).toBeGreaterThan(1);
    // And it heads west, not east.
    const [first, last] = [runway.anchors[0]!, runway.anchors[runway.anchors.length - 1]!];
    expect(last.x).toBeLessThan(first.x);
  });

  it("says WHY it stopped, so an unbound junction is not read as a dead end", () => {
    const graph = makeFourWay() as SemanticMapGraph & {
      movementVariants: JunctionMovementVariant[];
    };
    // Every variant present but none authorable — the shape 684 of San Ramon's
    // 941 variants have (`GATE_GEOMETRY_DISCONTINUITY`, measured 2026-07-29).
    const unbound = {
      ...graph,
      movementVariants: graph.movementVariants.map((variant) => ({
        ...variant,
        authoringStatus: "diagnostic_only",
      })),
    } as unknown as SemanticMapGraph;

    const blocked = deriveRunway({ graph: unbound, start: START, travelBudgetM: 250 });
    expect(blocked.terminated).toBe("dead_end");
    expect(blocked.stopReason).toBe("junction_unbound");

    // A walk that covers its budget says so.
    expect(deriveRunway({ graph: makeFourWay(), start: START, travelBudgetM: 40 }).stopReason).toBe(
      "budget_reached",
    );

    // And one that runs out of ROAD is `no_continuation` — a real end, not an
    // unbound junction. The four-way's east corridor ends at a map boundary.
    expect(
      deriveRunway({ graph: makeFourWay(), start: START, travelBudgetM: 5000 }).stopReason,
    ).toBe("no_continuation");
  });

  it("respects the anchor cap the route schema enforces", () => {
    const runway = deriveRunway({
      graph: makeFourWay(),
      start: START,
      travelBudgetM: 250,
      anchorCap: 4,
      toleranceM: 0.01,
    });
    expect(runway.anchors.length).toBeLessThanOrEqual(4);
  });
});

describe("runwayBudgetM", () => {
  it("overshoots the nominal distance, because ending early brakes the car", () => {
    // 10 m/s for 30 s = 300 m nominal; the margin must exceed it.
    expect(runwayBudgetM(30, 36)).toBeGreaterThan(300);
  });

  it("has a floor, so a stationary or very slow actor still gets a route", () => {
    expect(runwayBudgetM(30, 0)).toBeGreaterThanOrEqual(50);
    expect(runwayBudgetM(0, 50)).toBeGreaterThanOrEqual(50);
  });
});

/**
 * `runwayPolyline` — the geometry a comparison should be measured against.
 *
 * Written after the migration's own verification was fooled: E4's ego had all
 * three authored anchors sitting 0.00 m from the concatenated runway with every
 * tangent 180 degrees reversed. A direction-blind comparison called that a perfect
 * fit; the car would have driven its route backwards.
 */
describe("runwayPolyline", () => {
  const point = (x: number, y: number) => ({ x, y, z: 0 });

  function graphWith(corridorPolylines: Array<Array<{ x: number; y: number; z: number }>>) {
    return {
      corridors: corridorPolylines.map((polyline, index) => ({
        id: `cor-${index + 1}`,
        polyline,
      })),
      movementVariants: [],
    } as never;
  }

  it("lays a reversed leg down the way the walk traverses it", () => {
    // Two corridors that meet at (100, 0). The second is STORED from its far end,
    // which is the shape half a real map's lanes are in.
    const graph = graphWith([
      [point(0, 0), point(50, 0), point(100, 0)],
      [point(200, 0), point(150, 0), point(100, 0)],
    ]);
    const runway = {
      legs: [
        { kind: "corridor", id: "cor-1", lengthM: 100 },
        { kind: "corridor", id: "cor-2", lengthM: 100 },
      ],
      anchors: [],
    } as never;
    const polyline = runwayPolyline(graph, runway);
    // Monotonic: it goes one way, which is the whole point.
    for (let index = 1; index < polyline.length; index += 1) {
      expect(polyline[index]!.x).toBeGreaterThan(polyline[index - 1]!.x);
    }
    expect(polyline[polyline.length - 1]).toMatchObject({ x: 200 });
  });

  it("falls back to the anchors when a leg is not in the graph", () => {
    const polyline = runwayPolyline(graphWith([]), {
      legs: [{ kind: "corridor", id: "missing", lengthM: 10 }],
      anchors: [
        { x: 0, y: 0, z: 0, yaw: 0, speed_limit_kph: null, rsl: null, s_fraction: null },
        { x: 10, y: 0, z: 0, yaw: 0, speed_limit_kph: null, rsl: null, s_fraction: null },
      ],
    } as never);
    // Coarse beats nothing: a caller comparing against two points is worse off
    // than one comparing against the corridors, and much better off than one
    // comparing against an empty array.
    expect(polyline).toHaveLength(2);
  });

  /**
   * A variant polyline spans approach + connector + exit, and only the middle is
   * the junction. On the nine dev maps 5426 of 5431 variants carry ~66 m of that
   * context, so this is the shape in production — not an edge case.
   *
   * Drawing or driving the whole polyline lays the approach and exit down a
   * second time, starting from the approach's far end, which renders as a car
   * U-turning and looping on a straight road. Measured on Di Rosa before the
   * fix: 89.2 % of authorable corridors produced a route with a >120 degree
   * reversal in it; after, 2.4 %.
   */
  function spanningJunctionGraph(): SemanticMapGraph {
    const approach = corridor("c_in", line({ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }), {
      end: { point: { x: 100, y: 0, z: 0 }, headingRad: 0, kind: "junction", junctionId: "j1" },
    });
    const exit = corridor("c_out", line({ x: 120, y: 0, z: 0 }, { x: 220, y: 0, z: 0 }), {
      end: BOUNDARY({ x: 220, y: 0, z: 0 }),
    });
    // Approach (0-100) + connector (100-120) + exit (120-220), exactly as the
    // compiler emits it.
    const spanning = variant(
      "v_through",
      "m_straight",
      "c_in",
      "c_out",
      line({ x: 0, y: 0, z: 0 }, { x: 220, y: 0, z: 0 }, 22),
    );
    return {
      corridors: [approach, exit],
      approaches: [],
      movements: [movement("m_straight", "Straight")],
      movementVariants: [
        { ...spanning, lengthM: 220, entryStationM: 100, exitStationM: 120 },
      ],
      conflictZones: [],
      diagnostics: [],
    } as unknown as SemanticMapGraph;
  }

  it("charges a junction leg only the junction, not the road either side of it", () => {
    const runway = deriveRunway({
      graph: spanningJunctionGraph(),
      start: { x: 10, y: 0 },
      startHeadingDeg: 0,
      travelBudgetM: 400,
    });
    const junction = runway.legs.find((leg) => leg.kind === "junction");
    expect(junction?.lengthM).toBeCloseTo(20, 1);
    // 90 m of approach left + 20 m of junction + 100 m of exit.
    expect(runway.travelledM).toBeCloseTo(210, 1);
  });

  it("draws a route through a junction without doubling back", () => {
    const graph = spanningJunctionGraph();
    const runway = deriveRunway({
      graph,
      start: { x: 10, y: 0 },
      startHeadingDeg: 0,
      travelBudgetM: 400,
    });
    const polyline = runwayPolyline(graph, runway);
    // Monotonic in +x is the whole claim: the road is straight, so a route that
    // ever steps backwards has re-driven something.
    const backwards = polyline.filter(
      (point, index) => index > 0 && point.x < polyline[index - 1]!.x - 1e-6,
    );
    expect(backwards).toEqual([]);
    expect(polyline[0]!.x).toBeCloseTo(10, 1);
    expect(polyline[polyline.length - 1]!.x).toBeCloseTo(220, 1);
  });

  it("drops the duplicate vertex at a seam", () => {
    const graph = graphWith([
      [point(0, 0), point(100, 0)],
      [point(100, 0), point(200, 0)],
    ]);
    const polyline = runwayPolyline(graph, {
      legs: [
        { kind: "corridor", id: "cor-1", lengthM: 100 },
        { kind: "corridor", id: "cor-2", lengthM: 100 },
      ],
      anchors: [],
    } as never);
    expect(polyline.map((entry) => entry.x)).toEqual([0, 100, 200]);
  });
});
