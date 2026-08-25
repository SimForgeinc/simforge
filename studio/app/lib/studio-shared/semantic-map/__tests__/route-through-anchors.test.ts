import { describe, expect, it } from "vitest";

import {
  LANE_CHANGE_COST_M,
  anchorStation,
  routeThroughAnchors,
  slicePolylineByStation,
} from "../route-through-anchors";
import type {
  JunctionMovementVariant,
  LaneCorridor,
  SemanticMapGraph,
  SemanticMapPoint,
} from "../types";

/**
 * The anchor router (`plans/2026-07-30-road-network-consolidation.md` Phase 2).
 *
 * What is worth testing here is not "does Dijkstra work" — it is the three things
 * this router does that the retired runtime router could not, plus the one
 * thing it must keep doing exactly as before:
 *
 * - a lane change across a solid line is REFUSED, not merely penalised;
 * - the penalty still keeps it in lane when staying in lane is nearly as short;
 * - an anchor's `s_fraction` is along `+s`, so a positive-id lane is measured
 *   from the far end — getting that inverted places a car at the wrong end of the
 *   right road, facing a plausible direction, which fails as a wrong journey
 *   rather than as an error;
 * - an unconnectable leg splits the corridor and is reported, never bridged.
 */

function line(
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 10,
): SemanticMapPoint[] {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const t = index / steps;
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: 0 };
  });
}

function corridor(
  id: string,
  rsl: string,
  polyline: SemanticMapPoint[],
  overrides: Partial<LaneCorridor> = {},
): LaneCorridor {
  const lengthM = polyline.reduce(
    (sum, point, index) =>
      index === 0
        ? 0
        : sum + Math.hypot(point.x - polyline[index - 1]!.x, point.y - polyline[index - 1]!.y),
    0,
  );
  return {
    id,
    laneType: "driving",
    runtimeFragments: [{ rsl, startArcM: 0, endArcM: lengthM }],
    polyline,
    lengthM,
    representativeWidthM: 3.5,
    minWidthM: 3.5,
    maxWidthM: 3.5,
    speedLimitKph: 50,
    start: { point: polyline[0]!, headingRad: 0, kind: "map_boundary", junctionId: null },
    end: { point: polyline.at(-1)!, headingRad: 0, kind: "map_boundary", junctionId: null },
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
  incomingCorridorId: string,
  outgoingCorridorId: string,
  polyline: SemanticMapPoint[],
  overrides: Partial<JunctionMovementVariant> = {},
): JunctionMovementVariant {
  return {
    id,
    movementId: `${id}_m`,
    gateId: `${id}_g`,
    incomingCorridorId,
    outgoingCorridorId,
    runtimeLaneRsls: [],
    polyline,
    lengthM: 10,
    entryStationM: 0,
    exitStationM: 10,
    representativeWidthM: 3.5,
    authoringStatus: "authorable",
    diagnosticCodes: [],
    ...overrides,
  } as unknown as JunctionMovementVariant;
}

function graphOf(
  corridors: LaneCorridor[],
  movementVariants: JunctionMovementVariant[] = [],
): SemanticMapGraph {
  return {
    corridors,
    approaches: [],
    movements: [],
    movementVariants,
    conflictZones: [],
    diagnostics: [],
  } as unknown as SemanticMapGraph;
}

/** Two parallel eastbound lanes, 3.5 m apart, running x 0..100. */
function parallelPair(permission: { allowed: boolean }) {
  const left = corridor("c_left", "10:0:-1", line({ x: 0, y: 0 }, { x: 100, y: 0 }), {
    lateralAdjacencies: [
      {
        side: "left",
        targetCorridorId: "c_right",
        sameDirection: true,
        permissionIntervals: [
          { startM: 0, endM: 100, allowed: permission.allowed, marking: null, source: "xodr_lane_link" },
        ],
      },
    ],
  });
  const right = corridor("c_right", "10:0:-2", line({ x: 0, y: -3.5 }, { x: 100, y: -3.5 }));
  return graphOf([left, right]);
}

describe("anchorStation", () => {
  it("reads s_fraction along +s, so a positive-id lane measures from the far end", () => {
    // Positive-id lanes sit left of the reference line and are driven AGAINST +s
    // (US right-hand-drive), so the corridor's travel order is the reverse of the
    // lane's `+s` order. An anchor at s_fraction 0.25 is therefore three quarters
    // of the way along the corridor, not one quarter.
    const negative = corridor("c_neg", "10:0:-1", line({ x: 0, y: 0 }, { x: 100, y: 0 }));
    const positive = corridor("c_pos", "10:0:1", line({ x: 100, y: 4 }, { x: 0, y: 4 }));
    const graph = graphOf([negative, positive]);

    expect(anchorStation(graph, { rsl: "10:0:-1", sFraction: 0.25 })?.stationM).toBeCloseTo(25, 6);
    expect(anchorStation(graph, { rsl: "10:0:1", sFraction: 0.25 })?.stationM).toBeCloseTo(75, 6);
  });

  it("returns null for a lane no corridor carries", () => {
    const graph = graphOf([corridor("c", "10:0:-1", line({ x: 0, y: 0 }, { x: 100, y: 0 }))]);
    expect(anchorStation(graph, { rsl: "99:0:-1", sFraction: 0.5 })).toBeNull();
    expect(anchorStation(graph, { rsl: "not-an-rsl", sFraction: 0.5 })).toBeNull();
  });

  it("uses a stamped position as the station authority", () => {
    const graph = graphOf([
      corridor("c", "10:0:-1", line({ x: 0, y: 0 }, { x: 100, y: 0 })),
    ]);
    expect(
      anchorStation(graph, {
        rsl: "10:0:-1",
        sFraction: 0.9,
        point: { x: 25, y: 0, z: 0 },
      })?.stationM,
    ).toBeCloseTo(25, 6);
  });

  it("can preserve fraction-based slicing while a stamp disambiguates the corridor", () => {
    const graph = graphOf([
      corridor("c_far", "10:0:-1", line({ x: 0, y: 20 }, { x: 100, y: 20 })),
      corridor("c_near", "10:0:-1", line({ x: 0, y: 0 }, { x: 100, y: 0 })),
    ]);
    const resolved = anchorStation(graph, {
      rsl: "10:0:-1",
      sFraction: 0.9,
      point: { x: 25, y: 0, z: 0 },
      stationAuthority: "fraction",
    });
    expect(resolved?.corridor.id).toBe("c_near");
    expect(resolved?.stationM).toBeCloseTo(90, 6);
  });

  it("uses a corroborating local stamp without trusting one displaced beyond half a lane", () => {
    const graph = graphOf([
      corridor("c", "10:0:-1", line({ x: 0, y: 0 }, { x: 100, y: 0 })),
    ]);
    expect(
      anchorStation(graph, {
        rsl: "10:0:-1",
        sFraction: 0.25,
        point: { x: 26, y: 0, z: 0 },
        stationAuthority: "compatible",
      })?.stationM,
    ).toBeCloseTo(26, 6);
    expect(
      anchorStation(graph, {
        rsl: "10:0:-1",
        sFraction: 0.25,
        point: { x: 30, y: 0, z: 0 },
        stationAuthority: "compatible",
      })?.stationM,
    ).toBeCloseTo(25, 6);
  });

  it("attaches a stamped junction-lane anchor to the nearest corridor", () => {
    const incoming = corridor(
      "c_in",
      "10:0:-1",
      line({ x: 0, y: 0 }, { x: 100, y: 0 }),
    );
    const outgoing = corridor(
      "c_out",
      "12:0:-1",
      line({ x: 110, y: 10 }, { x: 110, y: 100 }),
    );
    const composed = [
      ...incoming.polyline,
      ...line({ x: 100, y: 0 }, { x: 110, y: 10 }, 4).slice(1),
      ...outgoing.polyline.slice(1),
    ];
    const graph = graphOf(
      [incoming, outgoing],
      [
        variant("v", "c_in", "c_out", composed, {
          runtimeLaneRsls: ["10:0:-1", "999:0:-1", "12:0:-1"],
          entryStationM: 100,
          exitStationM: 100 + Math.hypot(10, 10),
          lengthM: 100 + Math.hypot(10, 10) + 90,
        }),
      ],
    );
    const resolved = anchorStation(graph, {
      rsl: "999:0:-1",
      sFraction: 0.5,
      point: { x: 105, y: 5, z: 0 },
    });
    expect(resolved?.corridor.id).toBe("c_out");
    expect(resolved?.junction?.variant.id).toBe("v");
    expect(resolved?.junction?.stationM).toBeCloseTo(
      100 + Math.hypot(5, 5),
      6,
    );
    expect(
      anchorStation(graph, {
        rsl: "999:0:-1",
        sFraction: 0.5,
      })?.junction?.stationM,
    ).toBeCloseTo(100 + Math.hypot(5, 5), 6);
  });
});

describe("slicePolylineByStation", () => {
  it("interpolates both ends rather than snapping to a vertex", () => {
    // The lane is sampled every 10 m. Snapping would move an anchor by up to a
    // whole sample, which is enough to put a car through a stop line it was
    // placed behind.
    const slice = slicePolylineByStation(line({ x: 0, y: 0 }, { x: 100, y: 0 }), 12.5, 47.5);
    expect(slice[0]!.x).toBeCloseTo(12.5, 6);
    expect(slice.at(-1)!.x).toBeCloseTo(47.5, 6);
    expect(slice.every((point, index) => index === 0 || point.x > slice[index - 1]!.x)).toBe(true);
  });

  it("is empty for a zero-length or inverted span", () => {
    const points = line({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(slicePolylineByStation(points, 40, 40)).toEqual([]);
    expect(slicePolylineByStation(points, 60, 40)).toEqual([]);
  });
});

describe("routeThroughAnchors", () => {
  it("slices one lane when both anchors sit on it", () => {
    const graph = graphOf([corridor("c", "10:0:-1", line({ x: 0, y: 0 }, { x: 100, y: 0 }))]);
    const result = routeThroughAnchors(graph, [
      { rsl: "10:0:-1", sFraction: 0.1 },
      { rsl: "10:0:-1", sFraction: 0.8 },
    ]);
    expect(result.unresolvedLegIndexes).toEqual([]);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]![0]!.x).toBeCloseTo(10, 6);
    expect(result.lines[0]!.at(-1)!.x).toBeCloseTo(80, 6);
  });

  it("projects stamped endpoints onto the lane without a short off-axis seam", () => {
    const graph = graphOf([
      corridor("c", "10:0:-1", line({ x: 0, y: 0 }, { x: 100, y: 0 })),
    ]);
    const result = routeThroughAnchors(graph, [
      {
        rsl: "10:0:-1",
        sFraction: 0.1,
        point: { x: 10, y: 0.1, z: 2 },
      },
      {
        rsl: "10:0:-1",
        sFraction: 0.9,
        point: { x: 90, y: -0.1, z: 3 },
      },
    ]);
    expect(result.lines[0]![0]).toEqual({ x: 10, y: 0, z: 0 });
    expect(result.lines[0]!.at(-1)).toEqual({ x: 90, y: 0, z: 0 });
  });

  it("walks a junction between two lanes", () => {
    const west = corridor("c_west", "10:0:-1", line({ x: 0, y: 0 }, { x: 95, y: 0 }));
    const north = corridor("c_north", "12:0:-1", line({ x: 100, y: 5 }, { x: 100, y: 100 }));
    const graph = graphOf(
      [west, north],
      [variant("v_left", "c_west", "c_north", line({ x: 95, y: 0 }, { x: 100, y: 5 }, 4))],
    );
    const result = routeThroughAnchors(graph, [
      { rsl: "10:0:-1", sFraction: 0.1 },
      { rsl: "12:0:-1", sFraction: 0.5 },
    ]);
    expect(result.unresolvedLegIndexes).toEqual([]);
    const points = result.lines[0]!;
    // Left the approach, crossed the junction, and stopped halfway up the exit.
    expect(points.at(-1)!.x).toBeCloseTo(100, 6);
    expect(points.at(-1)!.y).toBeCloseTo(52.5, 1);
  });

  it("bridges an aligned same-lane publication gap at an explicit dead end", () => {
    const before = corridor(
      "c_before",
      "10:0:-1",
      line({ x: 0, y: 0 }, { x: 100, y: 0 }),
    );
    const after = corridor(
      "c_after",
      "11:0:-1",
      line({ x: 150, y: 0 }, { x: 250, y: 0 }),
    );
    const result = routeThroughAnchors(graphOf([before, after]), [
      { rsl: "10:0:-1", sFraction: 0.9 },
      { rsl: "11:0:-1", sFraction: 0.5 },
    ]);
    expect(result.unresolvedLegIndexes).toEqual([]);
    expect(result.lines[0]![0]!.x).toBeCloseTo(90, 6);
    expect(result.lines[0]!.at(-1)!.x).toBeCloseTo(200, 6);
    expect(result.lines[0]!.some((point) => point.x === 100)).toBe(true);
    expect(result.lines[0]!.some((point) => point.x === 150)).toBe(true);
  });

  it("uses only the junction span of a composed movement variant", () => {
    // Real variants contain the WHOLE incoming lane, the connector, and the
    // WHOLE outgoing lane. `entryStationM` and `exitStationM` mark the connector.
    // Treating `polyline` as connector-only repeats both corridors and inserts a
    // backwards jump at every seam — A1 measured four such jumps and grew from
    // a 262 m old route to 663 m before extension.
    const incoming = corridor(
      "c_in",
      "10:0:-1",
      line({ x: 0, y: 0 }, { x: 100, y: 0 }),
    );
    const outgoing = corridor(
      "c_out",
      "12:0:-1",
      line({ x: 110, y: 10 }, { x: 110, y: 100 }),
    );
    const approach = line({ x: 0, y: 0 }, { x: 100, y: 0 });
    const connector = line({ x: 100, y: 0 }, { x: 110, y: 10 }, 4);
    const exit = line({ x: 110, y: 10 }, { x: 110, y: 100 });
    const entryStationM = 100;
    const exitStationM = entryStationM + Math.hypot(10, 10);
    const composed = [
      ...approach,
      ...connector.slice(1),
      ...exit.slice(1),
    ];
    const graph = graphOf(
      [incoming, outgoing],
      [
        variant("v_composed", "c_in", "c_out", composed, {
          lengthM: exitStationM + 90,
          entryStationM,
          exitStationM,
        }),
      ],
    );

    const result = routeThroughAnchors(graph, [
      { rsl: "10:0:-1", sFraction: 0.9 },
      { rsl: "12:0:-1", sFraction: 0.5 },
    ]);

    expect(result.unresolvedLegIndexes).toEqual([]);
    const points = result.lines[0]!;
    expect(points[0]!.x).toBeCloseTo(90, 6);
    expect(points.at(-1)!.y).toBeCloseTo(55, 6);
    expect(points.some((point) => point.x < 90)).toBe(false);
    expect(points.some((point) => point.y > 55)).toBe(false);
  });

  it("routes from a stamped anchor inside a junction movement", () => {
    const incoming = corridor(
      "c_in",
      "10:0:-1",
      line({ x: 0, y: 0 }, { x: 100, y: 0 }),
    );
    const outgoing = corridor(
      "c_out",
      "12:0:-1",
      line({ x: 110, y: 10 }, { x: 110, y: 100 }),
    );
    const connector = line({ x: 100, y: 0 }, { x: 110, y: 10 }, 4);
    const composed = [
      ...incoming.polyline,
      ...connector.slice(1),
      ...outgoing.polyline.slice(1),
    ];
    const graph = graphOf(
      [incoming, outgoing],
      [
        variant("v", "c_in", "c_out", composed, {
          runtimeLaneRsls: ["10:0:-1", "999:0:-1", "12:0:-1"],
          entryStationM: 100,
          exitStationM: 100 + Math.hypot(10, 10),
          lengthM: 100 + Math.hypot(10, 10) + 90,
        }),
      ],
    );

    const result = routeThroughAnchors(graph, [
      {
        rsl: "999:0:-1",
        sFraction: 0.5,
        point: { x: 105, y: 5, z: 0 },
      },
      {
        rsl: "12:0:-1",
        sFraction: 0.5,
        point: { x: 110, y: 55, z: 0 },
      },
    ]);

    expect(result.unresolvedLegIndexes).toEqual([]);
    expect(result.lines[0]![0]!.x).toBeCloseTo(105, 6);
    expect(result.lines[0]![0]!.y).toBeCloseTo(5, 6);
    expect(result.lines[0]!.at(-1)!.x).toBeCloseTo(110, 6);
    expect(result.lines[0]!.at(-1)!.y).toBeCloseTo(55, 6);
  });

  it("changes lanes to reach an anchor the adjacency permits", () => {
    // The capability that made this a rewrite rather than a port: two anchors on
    // adjacent lanes of one road are a lane change, not an unresolvable leg.
    const result = routeThroughAnchors(parallelPair({ allowed: true }), [
      { rsl: "10:0:-1", sFraction: 0.1 },
      { rsl: "10:0:-2", sFraction: 0.9 },
    ]);
    expect(result.unresolvedLegIndexes).toEqual([]);
    const points = result.lines[0]!;
    expect(points[0]!.y).toBeCloseTo(0, 6);
    expect(points.at(-1)!.y).toBeCloseTo(-3.5, 6);
    expect(points.at(-1)!.x).toBeCloseTo(90, 6);
  });

  it("can defer a source-edge lane change for node-edge compatibility", () => {
    const result = routeThroughAnchors(
      parallelPair({ allowed: true }),
      [
        { rsl: "10:0:-1", sFraction: 0.1 },
        { rsl: "10:0:-2", sFraction: 0.9 },
      ],
      { deferInitialLaneChange: true },
    );
    expect(result.lines).toEqual([]);
    expect(result.unresolvedLegIndexes).toEqual([0]);
  });

  it("REFUSES a lane change the adjacency forbids", () => {
    // The old graph could only discourage this — a flat penalty on a per-lane
    // boolean. `permissionIntervals` says where a change is legal, so a solid
    // line is a wall rather than a toll, and a leg with no legal way across is
    // reported instead of driven.
    const result = routeThroughAnchors(parallelPair({ allowed: false }), [
      { rsl: "10:0:-1", sFraction: 0.1 },
      { rsl: "10:0:-2", sFraction: 0.9 },
    ]);
    expect(result.unresolvedLegIndexes).toEqual([0]);
    expect(result.lines).toEqual([]);
  });

  it("refuses a change into oncoming traffic however the intervals read", () => {
    const oncoming = graphOf([
      corridor("c_fwd", "10:0:-1", line({ x: 0, y: 0 }, { x: 100, y: 0 }), {
        lateralAdjacencies: [
          {
            side: "left",
            targetCorridorId: "c_back",
            sameDirection: false,
            permissionIntervals: [
              { startM: 0, endM: 100, allowed: true, marking: null, source: "xodr_lane_link" },
            ],
          },
        ],
      }),
      corridor("c_back", "10:0:1", line({ x: 100, y: 3.5 }, { x: 0, y: 3.5 })),
    ]);
    const result = routeThroughAnchors(oncoming, [
      { rsl: "10:0:-1", sFraction: 0.1 },
      { rsl: "10:0:1", sFraction: 0.1 },
    ]);
    expect(result.unresolvedLegIndexes).toEqual([0]);
  });

  it("stays in lane when the lane change would only save a little", () => {
    // The penalty's whole job. Both anchors are reachable by staying put or by
    // hopping to the parallel lane and back; without a cost on the hop the router
    // would weave for a metre, and the author would see a corridor they did not
    // draw. 25 m is the same figure the retired runtime router used.
    const straightThrough = graphOf([
      corridor("c_a", "10:0:-1", line({ x: 0, y: 0 }, { x: 100, y: 0 }), {
        successorCorridorIds: ["c_c"],
        lateralAdjacencies: [
          {
            side: "left",
            targetCorridorId: "c_b",
            sameDirection: true,
            permissionIntervals: [
              { startM: 0, endM: 100, allowed: true, marking: null, source: "xodr_lane_link" },
            ],
          },
        ],
      }),
      corridor("c_b", "10:0:-2", line({ x: 0, y: -3.5 }, { x: 100, y: -3.5 }), {
        successorCorridorIds: ["c_c"],
      }),
      corridor("c_c", "11:0:-1", line({ x: 100, y: 0 }, { x: 200, y: 0 })),
    ]);
    const result = routeThroughAnchors(straightThrough, [
      { rsl: "10:0:-1", sFraction: 0.1 },
      { rsl: "11:0:-1", sFraction: 0.5 },
    ]);
    expect(result.unresolvedLegIndexes).toEqual([]);
    // Never left y=0: the detour through the parallel lane costs the penalty and
    // buys nothing.
    expect(result.lines[0]!.every((point) => Math.abs(point.y) < 1e-6)).toBe(true);
    expect(LANE_CHANGE_COST_M).toBe(25);
  });

  it("splits the corridor at an unconnectable leg rather than bridging it", () => {
    // Bridging would draw a straight line through whatever lies between two
    // anchors the map cannot connect — a road that does not exist, handed to the
    // engine as if it did.
    const graph = graphOf([
      corridor("c_a", "10:0:-1", line({ x: 0, y: 0 }, { x: 100, y: 0 })),
      corridor("c_b", "50:0:-1", line({ x: 900, y: 900 }, { x: 1000, y: 900 })),
    ]);
    const result = routeThroughAnchors(graph, [
      { rsl: "10:0:-1", sFraction: 0.1 },
      { rsl: "50:0:-1", sFraction: 0.1 },
      { rsl: "50:0:-1", sFraction: 0.9 },
    ]);
    expect(result.unresolvedLegIndexes).toEqual([0]);
    expect(result.lines).toHaveLength(1);
    // The surviving run is the second leg, on the far corridor.
    expect(result.lines[0]![0]!.x).toBeCloseTo(910, 6);
  });

  it("will not drive backwards to reach an anchor behind it", () => {
    // The retired runtime resolver sliced the lane in reverse here and returned a
    // polyline running against travel — a corridor no car can drive, reported as
    // if it could. With no way round, the honest answer is that the leg does not
    // resolve.
    const graph = graphOf([corridor("c", "10:0:-1", line({ x: 0, y: 0 }, { x: 100, y: 0 }))]);
    const result = routeThroughAnchors(graph, [
      { rsl: "10:0:-1", sFraction: 0.8 },
      { rsl: "10:0:-1", sFraction: 0.2 },
    ]);
    expect(result.unresolvedLegIndexes).toEqual([0]);
  });

  it("preserves an explicitly stamped reverse manoeuvre on one lane", () => {
    const graph = graphOf([
      corridor("c", "10:0:-1", line({ x: 0, y: 0 }, { x: 100, y: 0 })),
    ]);
    const result = routeThroughAnchors(graph, [
      {
        rsl: "10:0:-1",
        sFraction: 0.8,
        point: { x: 80, y: 0, z: 0 },
      },
      {
        rsl: "10:0:-1",
        sFraction: 0.2,
        point: { x: 20, y: 0, z: 0 },
      },
    ]);
    expect(result.unresolvedLegIndexes).toEqual([]);
    expect(result.lines[0]![0]!.x).toBeCloseTo(80, 6);
    expect(result.lines[0]!.at(-1)!.x).toBeCloseTo(20, 6);
    expect(
      result.lines[0]!.every(
        (point, index, points) =>
          index === 0 || point.x <= points[index - 1]!.x + 1e-6,
      ),
    ).toBe(true);
  });

  it("loops the block when the map offers a way round to an anchor behind it", () => {
    // The other half: refusing to reverse must not become refusing to route. A
    // one-way circuit back onto the same lane is a legitimate answer.
    const start = corridor("c_a", "10:0:-1", line({ x: 0, y: 0 }, { x: 100, y: 0 }), {
      successorCorridorIds: ["c_loop"],
    });
    const loop = corridor("c_loop", "11:0:-1", line({ x: 100, y: 0 }, { x: 0, y: -20 }), {
      successorCorridorIds: ["c_a"],
    });
    const result = routeThroughAnchors(graphOf([start, loop]), [
      { rsl: "10:0:-1", sFraction: 0.8 },
      { rsl: "10:0:-1", sFraction: 0.2 },
    ]);
    expect(result.unresolvedLegIndexes).toEqual([]);
    expect(result.lines[0]!.at(-1)!.x).toBeCloseTo(20, 6);
  });

  it("skips corridors that are not authorable", () => {
    // `diagnostic_only` means the compiler could not verify the lane against the
    // runtime. Routing through one produces a corridor CARLA may not have.
    const graph = graphOf([
      corridor("c_a", "10:0:-1", line({ x: 0, y: 0 }, { x: 100, y: 0 }), {
        successorCorridorIds: ["c_bad"],
      }),
      corridor("c_bad", "11:0:-1", line({ x: 100, y: 0 }, { x: 200, y: 0 }), {
        authoringStatus: "diagnostic_only",
      }),
    ]);
    const result = routeThroughAnchors(graph, [
      { rsl: "10:0:-1", sFraction: 0.1 },
      { rsl: "11:0:-1", sFraction: 0.5 },
    ]);
    expect(result.unresolvedLegIndexes).toEqual([0]);
  });

  it("is stable: the same anchors resolve to the same corridor twice", () => {
    // Ties break on corridor id, so the answer cannot depend on the graph's array
    // order — which is a build artifact, not a fact about the map. An unstable
    // choice hands one draft two different corridors on two reads.
    const graph = parallelPair({ allowed: true });
    const anchors = [
      { rsl: "10:0:-1", sFraction: 0.1 },
      { rsl: "10:0:-2", sFraction: 0.9 },
    ];
    expect(routeThroughAnchors(graph, anchors)).toEqual(routeThroughAnchors(graph, anchors));
  });
});
