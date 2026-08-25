import { describe, expect, it } from "vitest";

import { compileAutopilotRoute } from "../compile-autopilot-route";
import { deriveRunway } from "../derive-runway";
import type {
  JunctionMovement,
  JunctionMovementVariant,
  LaneCorridor,
  SemanticMapGraph,
  SemanticMapPoint,
} from "../types";

/**
 * A T: one corridor running east, ending at a junction that offers a straight
 * continuation and a left turn north.
 *
 *            north
 *              |
 *   west ----- + ----- east
 *
 * Built by hand rather than from a fixture so the properties under test — which
 * way the walk went, how far, what it kept — are readable at the assertion.
 */
function line(
  from: SemanticMapPoint,
  to: SemanticMapPoint,
  steps = 10,
): SemanticMapPoint[] {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const t = index / steps;
    return {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      z: 0,
    };
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
    runtimeFragments: [{ rsl: `${id}_rsl`, startArcM: 0, endArcM: 100 }],
    polyline,
    lengthM: 100,
    representativeWidthM: 3.5,
    minWidthM: 3.5,
    maxWidthM: 3.5,
    speedLimitKph: 50,
    start: {
      point: polyline[0]!,
      headingRad: 0,
      kind: "map_boundary",
      junctionId: null,
    },
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
    runtimeLaneRsls: ["a", "b", "c"],
    polyline,
    lengthM: 20,
    entryStationM: 0,
    exitStationM: 20,
    representativeWidthM: 3.5,
    authoringStatus: "authorable",
    diagnosticCodes: [],
  } as JunctionMovementVariant;
}

function movement(
  id: string,
  turnRelation: JunctionMovement["turnRelation"],
): JunctionMovement {
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
  } as JunctionMovement;
}

/** west->centre, then either straight on east or left onto north. */
function makeGraph(): SemanticMapGraph {
  // Real `road:section:lane` keys, and the approach is stitched from TWO of
  // them: a corridor that spans a section boundary is the ordinary case, and
  // it is the one that catches an anchor reporting whichever lane happened to
  // be listed first. `c_north` uses a POSITIVE lane id, where the road's `+s`
  // axis runs against travel — the inversion `s_fraction` has to apply.
  const approach = corridor("c_west", line({ x: -100, y: 0, z: 0 }, { x: -10, y: 0, z: 0 }), {
    lengthM: 90,
    runtimeFragments: [
      { rsl: "10:0:-1", startArcM: 0, endArcM: 45 },
      { rsl: "10:1:-1", startArcM: 45, endArcM: 90 },
    ],
  });
  const east = corridor("c_east", line({ x: 10, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }), {
    lengthM: 90,
    runtimeFragments: [{ rsl: "20:0:-1", startArcM: 0, endArcM: 90 }],
    end: { point: { x: 100, y: 0, z: 0 }, headingRad: 0, kind: "map_boundary", junctionId: null },
  });
  const north = corridor("c_north", line({ x: 0, y: 10, z: 0 }, { x: 0, y: 100, z: 0 }), {
    lengthM: 90,
    runtimeFragments: [{ rsl: "30:0:1", startArcM: 0, endArcM: 90 }],
    end: { point: { x: 0, y: 100, z: 0 }, headingRad: 0, kind: "map_boundary", junctionId: null },
  });

  return {
    corridors: [approach, east, north],
    approaches: [],
    movements: [movement("m_straight", "straight"), movement("m_left", "left")],
    movementVariants: [
      variant("m_straight_v", "m_straight", "c_west", "c_east",
        line({ x: -10, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 4)),
      variant("m_left_v", "m_left", "c_west", "c_north",
        [{ x: -10, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }]),
    ],
    conflictZones: [],
    diagnostics: [],
  } as unknown as SemanticMapGraph;
}

describe("compileAutopilotRoute", () => {
  const start = { x: -100, y: 0 };

  it("crosses the junction — successorCorridorIds alone would stop at it", () => {
    // The corridors carry no successorCorridorIds at all here, exactly as the
    // real builder leaves them at a junction (junction lanes have no corridor,
    // so they filter out). Only the movement variants cross.
    const route = compileAutopilotRoute({
      graph: makeGraph(),
      start,
      travelBudgetM: 250,
      seed: "actor-1",
    });

    expect(route.legs.some((leg) => leg.kind === "junction")).toBe(true);
    expect(route.legs[0]).toMatchObject({ kind: "corridor", id: "c_west" });
    expect(route.travelledM).toBeGreaterThan(100);
  });

  it("is deterministic for one actor and varies between actors", () => {
    const graph = makeGraph();
    const routeFor = (seed: string) =>
      compileAutopilotRoute({ graph, start, travelBudgetM: 250, seed }).legs
        .map((leg) => leg.id)
        .join(">");

    // Same seed, same answer, every time.
    expect(routeFor("actor-1")).toBe(routeFor("actor-1"));

    // Across a spread of actors, both ways through the junction get used —
    // that is the point of seeding per actor rather than always going straight.
    const turns = new Set(
      Array.from({ length: 24 }, (_, index) => routeFor(`actor-${index}`)),
    );
    expect(turns.size).toBeGreaterThan(1);
  });

  it("uses the exact same seeded leg sequence as deriveRunway", () => {
    const graph = makeGraph();
    for (const seed of Array.from({ length: 24 }, (_, index) => `actor-${index}`)) {
      const compiled = compileAutopilotRoute({
        graph,
        start,
        travelBudgetM: 250,
        seed,
      });
      const derived = deriveRunway({
        graph,
        start,
        travelBudgetM: 250,
        pick: { kind: "weighted", seed },
      });
      expect(
        compiled.legs.map(({ kind, id }) => ({ kind, id })),
        seed,
      ).toEqual(derived.legs.map(({ kind, id }) => ({ kind, id })));
    }
  });

  it("does not depend on the order corridors appear in the graph", () => {
    // Array order is a build artifact, not a fact about the map: a rebuild that
    // reorders the graph must not silently re-route every car.
    const graph = makeGraph();
    const reversed = {
      ...graph,
      corridors: [...graph.corridors].reverse(),
      movementVariants: [...graph.movementVariants].reverse(),
    } as SemanticMapGraph;

    const ids = (g: SemanticMapGraph) =>
      compileAutopilotRoute({ graph: g, start, travelBudgetM: 250, seed: "a" })
        .legs.map((leg) => leg.id);

    expect(ids(reversed)).toEqual(ids(graph));
  });

  it("respects the anchor cap and keeps the corner when it thins", () => {
    const graph = makeGraph();
    // Force the left turn so there IS a corner, by seeding until one is found.
    let route = compileAutopilotRoute({
      graph, start, travelBudgetM: 250, seed: "a", anchorCap: 6,
    });
    for (let index = 0; index < 40 && !route.legs.some((leg) => leg.turn === "left"); index += 1) {
      route = compileAutopilotRoute({
        graph, start, travelBudgetM: 250, seed: `seed-${index}`, anchorCap: 6,
      });
    }
    expect(route.legs.some((leg) => leg.turn === "left")).toBe(true);
    expect(route.anchors.length).toBeLessThanOrEqual(6);

    // The turn survives the thinning: the route's headings must span the
    // ~90 degrees between driving east and driving north. A simplifier that
    // spent its budget on the straight approach would flatten this.
    const yaws = route.anchors.map((anchor) => anchor.yaw);
    expect(Math.max(...yaws) - Math.min(...yaws)).toBeGreaterThan(60);
  });

  it("gives every anchor a world position and a speed", () => {
    const route = compileAutopilotRoute({
      graph: makeGraph(), start, travelBudgetM: 150, seed: "actor-1",
    });
    // World positions are what make the export faithful (`anchorIsResolvable`)
    // and what survive a UE5 rebuild renumbering the road ids.
    for (const anchor of route.anchors) {
      expect(Number.isFinite(anchor.x)).toBe(true);
      expect(Number.isFinite(anchor.y)).toBe(true);
      expect(Number.isFinite(anchor.yaw)).toBe(true);
      expect(anchor.speed_limit_kph).toBe(50);
    }
  });

  it("binds each anchor to the lane and station it was compiled at", () => {
    // The failure this pins is silent: an anchor that names a lane but a
    // constant `s_fraction` resolves to that lane's MIDPOINT, so every anchor
    // on one lane collapses to the same point. The job still succeeds; the car
    // just never drives the route. (Observed: a 100 m compiled route driven as
    // 25 m of confused wandering.)
    //
    // A CURVED corridor, because the simplifier is right to flatten a straight
    // one to its two endpoints and there is nothing to observe in between.
    const bend: SemanticMapPoint[] = Array.from({ length: 41 }, (_, index) => {
      const angle = (Math.PI / 2) * (index / 40);
      return { x: 100 * Math.sin(angle), y: 100 * (1 - Math.cos(angle)), z: 0 };
    });
    const arcLength = bend.reduce(
      (total, point, index) =>
        index === 0
          ? 0
          : total + Math.hypot(point.x - bend[index - 1]!.x, point.y - bend[index - 1]!.y),
      0,
    );
    const curved = corridor("c_bend", bend, {
      lengthM: arcLength,
      runtimeFragments: [
        { rsl: "10:0:-1", startArcM: 0, endArcM: arcLength / 2 },
        { rsl: "10:1:-1", startArcM: arcLength / 2, endArcM: arcLength },
      ],
      end: { point: bend.at(-1)!, headingRad: 0, kind: "map_boundary", junctionId: null },
    });
    const route = compileAutopilotRoute({
      graph: {
        ...makeGraph(),
        corridors: [curved],
        movementVariants: [],
      } as unknown as SemanticMapGraph,
      start: { x: 0, y: 0 },
      travelBudgetM: arcLength,
      seed: "actor-1",
      toleranceM: 0.5,
    });

    expect(route.anchors.length).toBeGreaterThan(2);
    for (const anchor of route.anchors) {
      expect(anchor.s_fraction).not.toBeNull();
      expect(anchor.s_fraction!).toBeGreaterThanOrEqual(0);
      expect(anchor.s_fraction!).toBeLessThanOrEqual(1);
    }
    // Distinct stations, not one repeated midpoint. Keyed by lane AND
    // fraction: each fragment is measured 0..1 in its own right, so the same
    // fraction on two different lanes is two different places.
    expect(
      new Set(route.anchors.map((anchor) => `${anchor.rsl}@${anchor.s_fraction}`))
        .size,
    ).toBe(route.anchors.length);
    // The corridor spans a section boundary, and the anchors past it must say
    // so rather than all reporting the first fragment.
    expect(new Set(route.anchors.map((anchor) => anchor.rsl))).toEqual(
      new Set(["10:0:-1", "10:1:-1"]),
    );
    // Negative lane: travel runs WITH `+s`, so the fraction climbs within a
    // fragment as the walk advances.
    const firstFragment = route.anchors.filter((a) => a.rsl === "10:0:-1");
    expect(firstFragment.at(-1)!.s_fraction!).toBeGreaterThan(
      firstFragment[0]!.s_fraction!,
    );
  });

  it("leaves junction-interior anchors unbound rather than guessing a station", () => {
    // A movement variant knows which lanes it crosses, not where along each one
    // a vertex falls. Naming a lane at an invented fraction is worse than
    // naming none: the runtime resolves an unbound anchor by geometry (right)
    // and a bound one by lane (wrong, and confidently).
    const graph = makeGraph();
    let route = compileAutopilotRoute({
      graph, start, travelBudgetM: 250, seed: "a", toleranceM: 0.01,
    });
    for (let index = 0; index < 40 && !route.legs.some((leg) => leg.kind === "junction"); index += 1) {
      route = compileAutopilotRoute({
        graph, start, travelBudgetM: 250, seed: `seed-${index}`, toleranceM: 0.01,
      });
    }
    expect(route.legs.some((leg) => leg.kind === "junction")).toBe(true);
    for (const anchor of route.anchors) {
      expect(anchor.rsl === null).toBe(anchor.s_fraction === null);
    }
  });

  it("stops at a dead end rather than inventing geometry", () => {
    const graph = makeGraph();
    const stub = {
      ...graph,
      movementVariants: [],
    } as SemanticMapGraph;

    const route = compileAutopilotRoute({
      graph: stub, start, travelBudgetM: 10_000, seed: "a",
    });
    expect(route.terminated).toBe("dead_end");
    expect(route.anchors.length).toBeGreaterThan(0);
  });

  it("reports an unroutable start instead of throwing", () => {
    // A car parked on a driveway matches no corridor. That is a legitimate
    // scenario the caller reports, not an error that fails the edit.
    const route = compileAutopilotRoute({
      graph: { ...makeGraph(), corridors: [] } as unknown as SemanticMapGraph,
      start,
      travelBudgetM: 100,
      seed: "a",
    });
    expect(route).toMatchObject({ anchors: [], terminated: "dead_end" });
  });

  it("cuts a loop short rather than spinning on a huge budget", () => {
    // A ring: one corridor whose junction variant feeds straight back into it.
    const ring = corridor("c_ring", line({ x: 0, y: 0, z: 0 }, { x: 50, y: 0, z: 0 }));
    const graph = {
      corridors: [ring],
      approaches: [],
      movements: [movement("m_loop", "straight")],
      movementVariants: [
        variant("m_loop_v", "m_loop", "c_ring", "c_ring",
          [{ x: 50, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }]),
      ],
      conflictZones: [],
      diagnostics: [],
    } as unknown as SemanticMapGraph;

    const route = compileAutopilotRoute({
      graph, start: { x: 0, y: 0 }, travelBudgetM: 1_000_000, seed: "a",
    });
    expect(route.terminated).toBe("cycle_guard");
    expect(route.legs.filter((leg) => leg.kind === "corridor")).toHaveLength(1);
  });
});

/**
 * The compiler and the browser preview's corridor walk answer the same question
 * about the same map — which way does a car go at a junction — and a route this
 * compiler writes becomes the anchors that walk then follows. So they cannot
 * disagree about what a route may contain, and the one thing neither may produce
 * for a car nobody asked to turn around is a U-turn.
 *
 * The corridor side is `JUNCTION_TURN_WEIGHTS` (uturn 0.01, and not drawn at all
 * outside generated ambient traffic). The compiler's side is here: its draw was
 * UNIFORM over movement variants, so at an ordinary four-way one compiled route
 * in four doubled back on itself.
 */
describe("compileAutopilotRoute agrees with the corridor walk about U-turns", () => {
  /** west -> centre, offering straight, left, and a U-turn back west. */
  function graphWithUTurn(): SemanticMapGraph {
    const base = makeGraph() as unknown as {
      corridors: LaneCorridor[];
      movements: JunctionMovement[];
      movementVariants: JunctionMovementVariant[];
    };
    const back = corridor("c_back", line({ x: -10, y: -6, z: 0 }, { x: -100, y: -6, z: 0 }), {
      lengthM: 90,
      runtimeFragments: [{ rsl: "40:0:-1", startArcM: 0, endArcM: 90 }],
      end: {
        point: { x: -100, y: -6, z: 0 },
        headingRad: 0,
        kind: "map_boundary",
        junctionId: null,
      },
    });
    return {
      ...(base as unknown as SemanticMapGraph),
      corridors: [...base.corridors, back],
      movements: [...base.movements, movement("m_uturn", "UTurnLeft")],
      movementVariants: [
        ...base.movementVariants,
        variant("m_uturn_v", "m_uturn", "c_west", "c_back", [
          { x: -10, y: 0, z: 0 },
          { x: 0, y: -3, z: 0 },
          { x: -10, y: -6, z: 0 },
        ]),
      ],
    } as unknown as SemanticMapGraph;
  }

  it("never doubles back while a through movement exists", () => {
    const graph = graphWithUTurn();
    for (const seed of ["a", "b", "c", "d", "e", "f", "g", "h", "car-1", "car-2", "car-3"]) {
      const route = compileAutopilotRoute({
        graph,
        start: { x: -100, y: 0 },
        travelBudgetM: 150,
        seed,
      });
      expect(
        route.legs.filter((leg) => String(leg.turn ?? "").startsWith("UTurn")),
        seed,
      ).toEqual([]);
    }
  });

  it("stops rather than inventing a U-turn when it is the only way out", () => {
    // A U-turn is an authored action, not lane following. Reversing because it
    // is the only graph edge violates the actor's plain motion program.
    const full = graphWithUTurn() as unknown as {
      corridors: LaneCorridor[];
      movements: JunctionMovement[];
      movementVariants: JunctionMovementVariant[];
    };
    const graph = {
      ...(full as unknown as SemanticMapGraph),
      movements: full.movements.filter((entry) => entry.id === "m_uturn"),
      movementVariants: full.movementVariants.filter((entry) => entry.id === "m_uturn_v"),
    } as unknown as SemanticMapGraph;

    const route = compileAutopilotRoute({
      graph,
      start: { x: -100, y: 0 },
      travelBudgetM: 150,
      seed: "a",
    });
    expect(route.legs.some((leg) => leg.turn === "UTurnLeft")).toBe(false);
  });
});

describe("junction legs", () => {
  /**
   * The editor calls THIS walker, not `deriveRunway`, so the same bug had to be
   * fixed twice — and having been fixed only in the other one is how it survived
   * a round of measurement: the offline numbers came back clean while the editor
   * still drew a car doubling back over a straight road.
   *
   * A variant polyline spans approach + connector + exit; only the middle is the
   * junction. 5426 of 5431 variants on the nine dev maps carry that context.
   */
  function spanningGraph(): SemanticMapGraph {
    const approach = corridor("c_in", line({ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }));
    const exit = corridor("c_out", line({ x: 120, y: 0, z: 0 }, { x: 220, y: 0, z: 0 }), {
      end: {
        point: { x: 220, y: 0, z: 0 },
        headingRad: 0,
        kind: "map_boundary",
        junctionId: null,
      },
    });
    const through = variant(
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
        { ...through, lengthM: 220, entryStationM: 100, exitStationM: 120 },
      ],
      conflictZones: [],
      diagnostics: [],
    } as unknown as SemanticMapGraph;
  }

  it("crosses the junction once instead of re-driving the road either side", () => {
    const route = compileAutopilotRoute({
      graph: spanningGraph(),
      start: { x: 10, y: 0 },
      travelBudgetM: 400,
      seed: "ego",
    });
    const junction = route.legs.find((leg) => leg.kind === "junction");
    expect(junction?.lengthM).toBeCloseTo(20, 1);
    // The road is straight, so any step backwards means something was re-driven.
    const backwards = route.anchors.filter(
      (anchor, index) => index > 0 && anchor.x < route.anchors[index - 1]!.x - 1e-6,
    );
    expect(backwards).toEqual([]);
  });
});
