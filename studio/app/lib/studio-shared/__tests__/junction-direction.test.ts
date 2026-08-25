/**
 * The one rule for which way an actor goes at a junction.
 *
 * The geometry half is verified against a real map in
 * `apps/web/test/unit/scenario-editor/junction-turn-realmap.test.ts`; this is
 * the precedence half.
 */

import { describe, expect, it } from "vitest";
import {
  authoredJunctionTurn,
  classifyJunctionTurn,
  isAuthoredJunctionDirection,
  junctionBranchHeadingChangeDeg,
  junctionDirectionPolicy,
  junctionTurnForBranch,
  JUNCTION_TURN_FOR_AUTHORED_DIRECTION,
  TIMED_INSTRUCTION_PRIMITIVE_FOR_JUNCTION_DIRECTION,
  type JunctionVec2,
} from "../junction-direction";

function turnClip(direction: string, extra: Record<string, unknown> = {}) {
  return {
    behavior: {
      clips: [
        {
          id: "turn",
          trigger: { kind: "at_time", t: 0 },
          end: { kind: "completion" },
          action: { kind: "turn_at_next_intersection", direction },
          ...extra,
        },
      ],
    },
  };
}

describe("junctionDirectionPolicy", () => {
  it("keeps going when nobody said otherwise", () => {
    expect(junctionDirectionPolicy({})).toEqual({ kind: "straight" });
    expect(junctionDirectionPolicy({ role: "ego", route: [] })).toEqual({ kind: "straight" });
  });

  it("does not let role: traffic buy a guess", () => {
    // `traffic` is the schema DEFAULT, so it is true of every hand-placed car
    // the author never promoted to ego. Using it as the discriminator left those
    // cars taking weighted-random turns nobody asked for.
    expect(junctionDirectionPolicy({ role: "traffic" })).toEqual({ kind: "straight" });
  });

  it("lets only a generated ambient car draw", () => {
    expect(junctionDirectionPolicy({ role: "traffic", ambient_generated: true })).toEqual({
      kind: "ambient_draw",
    });
  });

  it("puts explicit anchors above everything", () => {
    expect(
      junctionDirectionPolicy({
        route: [{}],
        ambient_generated: true,
        ...turnClip("left"),
      }),
    ).toEqual({ kind: "route_anchors" });
  });

  it("puts an authored turn above the draw", () => {
    expect(junctionDirectionPolicy({ ambient_generated: true, ...turnClip("right") })).toEqual({
      kind: "authored_turn",
      direction: "right",
    });
  });

  it("reads the legacy timeline when the program has no turn", () => {
    expect(
      junctionDirectionPolicy({
        timeline: [{ id: "t1", action: "turn_left_at_next_intersection" }],
      }),
    ).toEqual({ kind: "authored_turn", direction: "left" });
    expect(
      junctionDirectionPolicy({
        timeline: [{ id: "t1", action: "go_straight_at_next_intersection" }],
      }),
    ).toEqual({ kind: "authored_turn", direction: "straight" });
  });

  it("survives the reduced payload the corridor endpoint receives", () => {
    // The editor strips behavior programs off the wire, so the rule has to
    // travel as its own answer. Resolve, reduce, resolve again — same verdict.
    for (const draft of [
      { ambient_generated: true },
      turnClip("left"),
      { route: [{}] },
      { role: "traffic" },
    ]) {
      const resolved = junctionDirectionPolicy(draft);
      const overWire = JSON.parse(
        JSON.stringify({ id: "a", junction_direction: resolved }),
      ) as Record<string, unknown>;
      expect(junctionDirectionPolicy(overWire)).toEqual(resolved);
    }
  });

  it("recomputes when the wire value is missing or nonsense", () => {
    expect(junctionDirectionPolicy({ junction_direction: { kind: "sideways" }, route: [{}] })).toEqual(
      { kind: "route_anchors" },
    );
    expect(
      junctionDirectionPolicy({ junction_direction: { kind: "authored_turn" }, route: [{}] }),
    ).toEqual({ kind: "route_anchors" });
  });

  it("ignores a disabled turn and a nonsense direction", () => {
    expect(junctionDirectionPolicy(turnClip("left", { enabled: false }))).toEqual({
      kind: "straight",
    });
    expect(junctionDirectionPolicy(turnClip("sideways"))).toEqual({ kind: "straight" });
    expect(
      junctionDirectionPolicy({ timeline: [{ id: "t1", action: "lane_change_left" }] }),
    ).toEqual({ kind: "straight" });
  });
});

describe("classifyJunctionTurn", () => {
  it("uses the map index's own thresholds", () => {
    // `map-topology/build-topology-index.ts::classifyTurn` — 0.349 rad and
    // 2.356 rad. Same branch, same name, in both places.
    expect(classifyJunctionTurn(0)).toBe("straight");
    expect(classifyJunctionTurn(19.9)).toBe("straight");
    expect(classifyJunctionTurn(-19.9)).toBe("straight");
    expect(classifyJunctionTurn(45)).toBe("left");
    expect(classifyJunctionTurn(-45)).toBe("right");
    expect(classifyJunctionTurn(134)).toBe("left");
    expect(classifyJunctionTurn(136)).toBe("uturn");
    expect(classifyJunctionTurn(-179)).toBe("uturn");
  });
});

describe("junctionBranchHeadingChangeDeg", () => {
  const approach: JunctionVec2[] = [
    { x: -20, y: 0 },
    { x: -10, y: 0 },
    { x: 0, y: 0 },
  ];

  /** A quarter circle of radius `r`, sampled every metre, turning left. */
  function connector(r: number, sign: 1 | -1): JunctionVec2[] {
    const points: JunctionVec2[] = [];
    for (let arc = 0; arc <= (Math.PI / 2) * r; arc += 1) {
      const t = arc / r;
      points.push({ x: r * Math.sin(t), y: sign * r * (1 - Math.cos(t)) });
    }
    return points;
  }

  it("reads a curving connector as the turn it is, not as straight", () => {
    // The whole defect in one assertion. The first two vertices of a 12 m radius
    // connector are 4.8 degrees apart from the approach; the connector is a
    // 90 degree turn.
    expect(junctionTurnForBranch(approach, connector(12, 1))).toBe("left");
    expect(junctionTurnForBranch(approach, connector(12, -1))).toBe("right");
    expect(junctionBranchHeadingChangeDeg(approach, connector(12, 1))).toBeGreaterThan(80);
  });

  it("reads a straight continuation as straight", () => {
    expect(
      junctionTurnForBranch(approach, [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 40, y: 0 },
      ]),
    ).toBe("straight");
  });

  it("answers null when there is nothing to measure", () => {
    expect(junctionBranchHeadingChangeDeg(approach, [{ x: 0, y: 0 }])).toBeNull();
    expect(junctionBranchHeadingChangeDeg([{ x: 0, y: 0 }], connector(12, 1))).toBeNull();
  });
});

/**
 * `u_turn` in the authored turn vocabulary.
 *
 * The corpus contains exactly one u-turn (E6), authored as the out-and-back anchor
 * pair the one-motion model deletes. `deriveRunway` already routes the intent and
 * `fitRunwayTurns` recovers it at 0.00 m residual, so the only thing that was
 * missing was a way to SAY it: with `direction` limited to left/right/straight the
 * migration had to downgrade a u-turn to a left turn, which put the car 12.8 m off
 * its authored route while every number in the migration read clean.
 *
 * Two names for one branch is the hazard this pins. The authored vocabulary spells
 * it `u_turn` (matching `RunwayTurnIntent`, which is what a direction is handed
 * to); the map's classifier spells it `uturn`. Comparing them raw makes every
 * u-turn look like a corridor that does not carry it.
 */
describe("u_turn as an authored direction", () => {
  it("accepts it, and rejects a spelling that is neither vocabulary", () => {
    expect(isAuthoredJunctionDirection("u_turn")).toBe(true);
    expect(isAuthoredJunctionDirection("left")).toBe(true);
    // The MAP's spelling is not the authored one, and silently accepting it would
    // let a draft carry a direction no consumer bridges.
    expect(isAuthoredJunctionDirection("uturn")).toBe(false);
    expect(isAuthoredJunctionDirection("U_TURN")).toBe(false);
  });

  it("bridges every authored direction to a map branch", () => {
    for (const direction of ["left", "right", "straight", "u_turn"] as const) {
      expect(JUNCTION_TURN_FOR_AUTHORED_DIRECTION[direction]).toBeTruthy();
    }
    expect(JUNCTION_TURN_FOR_AUTHORED_DIRECTION.u_turn).toBe("uturn");
  });

  it("has no legacy timed primitive for a u-turn", () => {
    // Deliberate: the legacy `timeline` channel never had one and Phase G deletes
    // the channel. The absence is what makes a caller trying to route a u-turn
    // through it fail to compile instead of writing an undefined primitive id.
    expect(
      (TIMED_INSTRUCTION_PRIMITIVE_FOR_JUNCTION_DIRECTION as Record<string, string | undefined>)
        .u_turn,
    ).toBeUndefined();
    expect(TIMED_INSTRUCTION_PRIMITIVE_FOR_JUNCTION_DIRECTION.left).toBe(
      "turn_left_at_next_intersection",
    );
  });

  it("reads a u_turn clip back off an actor", () => {
    expect(
      authoredJunctionTurn({
        behavior: {
          clips: [
            { enabled: true, action: { kind: "turn_at_next_intersection", direction: "u_turn" } },
          ],
        },
      }),
    ).toBe("u_turn");
  });
});
