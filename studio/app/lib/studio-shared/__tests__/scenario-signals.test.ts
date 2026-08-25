import { describe, expect, it } from "vitest";
import {
  JunctionSignalPlanSchema,
  SIGNAL_PLAN_SCHEMA_VERSION,
  approachIdFromLaneRsl,
  compassLabel,
  deriveJunctionMovementTable,
  deriveJunctionMovements,
  deriveConflictFreeGroups,
  deriveMovementConflicts,
  detectSignalPlanWarnings,
  formatMovementId,
  junctionGatesFromTopology,
  mapDefaultSignalPlan,
  movementStateAt,
  parseMovementId,
  readSignalStateEvents,
  resolveBehaviorSignalRef,
  signalBandsFromEvents,
  signalChannelId,
  signalPhaseAt,
  signalPlanIssues,
  signalProgramCycleDurationS,
  signalTurnFromRelation,
  synthesizeSignalProgram,
  withSignalPlanWarnings,
} from "../scenario-signals";
import type {
  JunctionGateInput,
  JunctionMovementBinding,
  JunctionSignalPlan,
} from "../scenario-signals";
import { ScenarioEditorDraftSchema } from "../scenario-editor";

// A textbook 4-way junction in the CARLA basis (+x east, +y SOUTH), so a
// vehicle travelling north has heading -PI/2. Roads: 10 enters from the south,
// 20 from the north, 30 from the west, 40 from the east.
const NORTH = -Math.PI / 2;
const SOUTH = Math.PI / 2;
const EAST = 0;
const WEST = Math.PI;

function gate(
  approachLaneRsl: string,
  turnRelation: string,
  approachHeading: number,
  exitHeading: number,
  extra: Partial<JunctionGateInput> = {},
): JunctionGateInput {
  return {
    approach_lane_rsl: approachLaneRsl,
    turn_relation: turnRelation,
    approach_heading_rad: approachHeading,
    exit_heading_rad: exitHeading,
    ...extra,
  };
}

const FOUR_WAY: JunctionGateInput[] = [
  gate("10:0:-1", "Straight", NORTH, NORTH, { exit_lane_rsls: ["20:0:1"] }),
  gate("10:0:-2", "Left", NORTH, WEST),
  gate("10:0:-1", "Right", NORTH, EAST),
  gate("20:0:-1", "Straight", SOUTH, SOUTH),
  gate("20:0:-2", "Left", SOUTH, EAST),
  gate("30:0:-1", "Straight", EAST, EAST),
  gate("40:0:-1", "Straight", WEST, WEST),
];

function movementIds(bindings: JunctionMovementBinding[]): string[] {
  return bindings.map((binding) => binding.movement_id);
}

function conflictsOf(bindings: JunctionMovementBinding[], movementId: string): string[] {
  return bindings.find((binding) => binding.movement_id === movementId)?.conflicts_with ?? [];
}

describe("movement identity", () => {
  it("derives an approach id from a runtime lane key", () => {
    expect(approachIdFromLaneRsl("10:0:-1")).toBe("10.0.r");
    expect(approachIdFromLaneRsl("10:0:2")).toBe("10.0.l");
    expect(approachIdFromLaneRsl("10:0:0")).toBeNull();
    expect(approachIdFromLaneRsl("10:0")).toBeNull();
  });

  it("round-trips a movement id", () => {
    const id = formatMovementId("10.0.r", "left");
    expect(id).toBe("10.0.r:left");
    expect(parseMovementId(id)).toEqual({ approach_id: "10.0.r", turn: "left" });
    expect(parseMovementId("10.0.r:diagonal")).toBeNull();
    expect(parseMovementId("nope")).toBeNull();
  });

  it("collapses both U-turn relations onto one turn class", () => {
    expect(signalTurnFromRelation("UTurnLeft")).toBe("uturn");
    expect(signalTurnFromRelation("UTurnRight")).toBe("uturn");
    expect(signalTurnFromRelation("Straight")).toBe("straight");
    expect(signalTurnFromRelation("sideways")).toBeNull();
  });

  it("labels an approach by the direction traffic is going", () => {
    expect(compassLabel(NORTH)).toBe("NB");
    expect(compassLabel(SOUTH)).toBe("SB");
    expect(compassLabel(EAST)).toBe("EB");
    expect(compassLabel(WEST)).toBe("WB");
  });
});

describe("deriveJunctionMovements", () => {
  it("groups gates by approach lane group and turn", () => {
    const bindings = deriveJunctionMovements(FOUR_WAY);
    expect(movementIds(bindings)).toEqual([
      "10.0.r:left",
      "10.0.r:right",
      "10.0.r:straight",
      "20.0.r:left",
      "20.0.r:straight",
      "30.0.r:straight",
      "40.0.r:straight",
    ]);
    const through = bindings.find((binding) => binding.movement_id === "10.0.r:straight")!;
    expect(through.label).toBe("NB through");
    expect(through.approach_lane_rsls).toEqual(["10:0:-1"]);
    expect(through.exit_lane_rsls).toEqual(["20:0:1"]);
    expect(through.approach_heading_deg).toBeCloseTo(-90, 6);
  });

  it("merges the lanes of one approach into a single movement", () => {
    const bindings = deriveJunctionMovements([
      gate("10:0:-1", "Straight", NORTH, NORTH),
      gate("10:0:-2", "Straight", NORTH, NORTH),
    ]);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.approach_lane_rsls).toEqual(["10:0:-1", "10:0:-2"]);
  });

  it("drops gates whose lane key or turn relation is unusable", () => {
    expect(deriveJunctionMovements([gate("bogus", "Straight", NORTH, NORTH)])).toEqual([]);
    expect(deriveJunctionMovements([gate("10:0:-1", "Sideways", NORTH, NORTH)])).toEqual([]);
  });

  it("reads gates and headings out of a map-topology index", () => {
    // Polylines are stored `+s`-ascending, ALWAYS. Lane -1 runs with `+s` so
    // its stored order is its travel order; lane +1 runs against it, so the
    // northbound exit is stored southbound and has to be flipped back.
    // Travelling north in the CARLA basis is decreasing y.
    const gates = junctionGatesFromTopology(
      {
        lanes: {
          "10:0:-1": { rsl: "10:0:-1", polyline: [{ x: 0, y: 20 }, { x: 0, y: 10 }] },
          "20:0:1": { rsl: "20:0:1", polyline: [{ x: 0, y: -20 }, { x: 0, y: -10 }] },
        },
        gates: [
          {
            junctionId: "5",
            turnRelation: "Straight",
            approachLaneRsl: "10:0:-1",
            exitLaneRsls: ["20:0:1"],
          },
          { junctionId: "6", turnRelation: "Left", approachLaneRsl: "10:0:-1" },
        ],
      },
      "5",
    );
    expect(gates).toHaveLength(1);
    expect(gates[0]!.approach_heading_rad).toBeCloseTo(NORTH, 6);
    expect(gates[0]!.exit_heading_rad).toBeCloseTo(NORTH, 6);
  });

  it("takes the direction of travel from the bound index, not the lane sign", () => {
    // A left-hand-traffic road, or any lane the sign convention gets wrong:
    // lane -1 is stored `+s`-ascending as always, but CARLA's crawl says it is
    // driven the other way. The bound index's answer must win, or the gate
    // reports a bearing 180 degrees out and every conflict inverts.
    const lanes = {
      "10:0:-1": { rsl: "10:0:-1", laneId: -1, polyline: [{ x: 0, y: 20 }, { x: 0, y: 10 }] },
    };
    const gates = [
      { junctionId: "5", turnRelation: "Straight", approachLaneRsl: "10:0:-1" },
    ];
    expect(
      junctionGatesFromTopology({ lanes, gates }, "5")[0]!.approach_heading_rad,
    ).toBeCloseTo(NORTH, 6);
    expect(
      junctionGatesFromTopology(
        { lanes, gates, laneTravelIncreasesS: { "10:0:-1": false } },
        "5",
      )[0]!.approach_heading_rad,
    ).toBeCloseTo(SOUTH, 6);
  });
});

describe("deriveMovementConflicts", () => {
  const table = deriveJunctionMovementTable(FOUR_WAY);

  it("crosses perpendicular throughs", () => {
    expect(conflictsOf(table, "10.0.r:straight")).toContain("30.0.r:straight");
    expect(conflictsOf(table, "30.0.r:straight")).toContain("10.0.r:straight");
  });

  it("leaves opposing throughs compatible", () => {
    expect(conflictsOf(table, "10.0.r:straight")).not.toContain("20.0.r:straight");
  });

  it("crosses an opposing left with a through", () => {
    expect(conflictsOf(table, "10.0.r:straight")).toContain("20.0.r:left");
  });

  it("leaves dual protected lefts compatible", () => {
    expect(conflictsOf(table, "10.0.r:left")).not.toContain("20.0.r:left");
  });

  it("never conflicts two movements off the same approach", () => {
    expect(conflictsOf(table, "10.0.r:straight")).not.toContain("10.0.r:left");
    expect(conflictsOf(table, "10.0.r:straight")).not.toContain("10.0.r:right");
  });

  it("reports a shared exit as a merge, not a crossing", () => {
    const conflicts = deriveMovementConflicts(deriveJunctionMovements(FOUR_WAY));
    const merge = conflicts.find(
      (conflict) =>
        conflict.movement_ids.includes("10.0.r:right") &&
        conflict.movement_ids.includes("30.0.r:straight"),
    );
    expect(merge?.kind).toBe("merge");
    expect(conflictsOf(table, "10.0.r:right")).not.toContain("30.0.r:straight");
  });

  it("says nothing about movements with no geometry", () => {
    const bindings = deriveJunctionMovements([
      { approach_lane_rsl: "10:0:-1", turn_relation: "Straight" },
      { approach_lane_rsl: "30:0:-1", turn_relation: "Straight" },
    ]);
    expect(deriveMovementConflicts(bindings)).toEqual([]);
  });
});

const MOVEMENTS = deriveJunctionMovementTable(FOUR_WAY);

function plan(overrides: Partial<JunctionSignalPlan> = {}): unknown {
  return {
    junction_id: "5",
    mode: "map_default",
    movements: MOVEMENTS,
    ...overrides,
  };
}

describe("JunctionSignalPlanSchema", () => {
  it("defaults to a map_default plan with no movements", () => {
    const parsed = JunctionSignalPlanSchema.parse({ junction_id: "5" });
    expect(parsed).toEqual(mapDefaultSignalPlan("5"));
    expect(parsed.schema_version).toBe(SIGNAL_PLAN_SCHEMA_VERSION);
  });

  it("rejects a mode whose payload is missing", () => {
    expect(JunctionSignalPlanSchema.safeParse(plan({ mode: "static" })).success).toBe(false);
    expect(JunctionSignalPlanSchema.safeParse(plan({ mode: "program" })).success).toBe(false);
    expect(JunctionSignalPlanSchema.safeParse(plan({ mode: "scripted" })).success).toBe(false);
  });

  it("rejects a movement id the junction does not have", () => {
    const parsed = JunctionSignalPlanSchema.safeParse(
      plan({ mode: "static", static: { "99.0.r:straight": "red" } }),
    );
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed)).toContain("Unknown movement");
  });

  it("accepts unknown movement ids when the plan carries no movement table", () => {
    const parsed = JunctionSignalPlanSchema.safeParse({
      junction_id: "5",
      mode: "static",
      static: { "99.0.r:straight": "red" },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a conflicting-green plan — conflicts are warnings, never errors", () => {
    const parsed = JunctionSignalPlanSchema.safeParse(
      plan({
        mode: "static",
        static: { "10.0.r:straight": "green", "30.0.r:straight": "green" },
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it("rejects a scene clip trigger that references 'self'", () => {
    const issues = signalPlanIssues({
      junction_id: "5",
      mode: "scripted",
      movements: MOVEMENTS,
      scripted: [
        {
          id: "clip-1",
          enabled: true,
          trigger: { kind: "speed", actor: "self", kph: 10, rule: "below" },
          end: { kind: "completion" },
          action: { kind: "set_junction_state", state: "red" },
        },
      ],
    });
    expect(issues.map((issue) => issue.message).join(" ")).toContain("no owning actor");
  });

  it("rejects duplicate scene clip ids and dangling after_clip chains", () => {
    const issues = signalPlanIssues({
      junction_id: "5",
      mode: "scripted",
      movements: MOVEMENTS,
      scripted: [
        {
          id: "clip-1",
          enabled: true,
          trigger: { kind: "at_time", t: 0 },
          end: { kind: "completion" },
          action: { kind: "set_junction_state", state: "red" },
        },
        {
          id: "clip-1",
          enabled: true,
          trigger: { kind: "after_clip", clip_id: "nope" },
          end: { kind: "completion" },
          action: { kind: "set_junction_state", state: "green" },
        },
      ],
    });
    const messages = issues.map((issue) => issue.message).join(" ");
    expect(messages).toContain("duplicate scene clip id");
    expect(messages).toContain("unknown clip 'nope'");
  });

  it("accepts a scripted plan with a program baseline (the dilemma-zone shape)", () => {
    const parsed = JunctionSignalPlanSchema.safeParse(
      plan({
        mode: "scripted",
        program: {
          cycle: [
            { duration_s: 20, states: { "10.0.r:straight": "green", "30.0.r:straight": "red" } },
            { duration_s: 20, states: { "10.0.r:straight": "red", "30.0.r:straight": "green" } },
          ],
          offset_s: 0,
        },
        scripted: [
          {
            id: "dilemma",
            enabled: true,
            trigger: {
              kind: "proximity",
              actor: { actor_id: "ego" },
              other: { actor_id: "stop-line" },
              distance_m: 20,
              mode: "closer",
            },
            end: { kind: "duration", seconds: 3 },
            action: {
              kind: "set_movement_state",
              movement_id: "10.0.r:straight",
              state: "yellow",
            },
          },
        ],
      }),
    );
    expect(parsed.success).toBe(true);
  });
});

describe("detectSignalPlanWarnings", () => {
  it("flags conflicting greens in a static plan", () => {
    const warnings = detectSignalPlanWarnings({
      junction_id: "5",
      mode: "static",
      movements: MOVEMENTS,
      static: { "10.0.r:straight": "green", "30.0.r:straight": "green" },
    });
    const conflict = warnings.find((warning) => warning.code === "conflicting_green");
    expect(conflict?.movement_ids).toEqual(["10.0.r:straight", "30.0.r:straight"]);
  });

  it("flags conflicting greens per phase and reports the phase index", () => {
    const warnings = detectSignalPlanWarnings({
      junction_id: "5",
      mode: "program",
      movements: MOVEMENTS,
      program: {
        cycle: [
          { duration_s: 10, states: Object.fromEntries(MOVEMENTS.map((m) => [m.movement_id, "red" as const])) },
          {
            duration_s: 10,
            states: {
              ...Object.fromEntries(MOVEMENTS.map((m) => [m.movement_id, "red" as const])),
              "10.0.r:straight": "green",
              "20.0.r:left": "green",
            },
          },
        ],
        offset_s: 0,
      },
    });
    const conflicts = warnings.filter((warning) => warning.code === "conflicting_green");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.phase_index).toBe(1);
    expect(warnings.some((warning) => warning.code === "incomplete_phase")).toBe(false);
  });

  it("flags a phase that leaves movements unstated", () => {
    const warnings = detectSignalPlanWarnings({
      junction_id: "5",
      mode: "program",
      movements: MOVEMENTS,
      program: { cycle: [{ duration_s: 10, states: { "10.0.r:straight": "green" } }], offset_s: 0 },
    });
    const incomplete = warnings.find((warning) => warning.code === "incomplete_phase");
    expect(incomplete?.movement_ids).not.toContain("10.0.r:straight");
    expect(incomplete?.movement_ids).toContain("30.0.r:straight");
  });

  it("flags a movement the worker could never bind", () => {
    const warnings = detectSignalPlanWarnings({
      junction_id: "5",
      mode: "static",
      movements: [
        {
          movement_id: "10.0.r:straight",
          approach_id: "10.0.r",
          turn: "straight",
          label: "NB through",
          approach_lane_rsls: [],
          exit_lane_rsls: [],
          signal_ids: [],
          approach_heading_deg: null,
          exit_heading_deg: null,
          conflicts_with: [],
        },
      ],
      static: { "10.0.r:straight": "red" },
    });
    expect(warnings.map((warning) => warning.code)).toContain("unresolvable_movement");
  });

  it("flags movements that share a signal head but are told different colours", () => {
    // The common case, per the XODR enrichment: a controlled signal sits on the
    // connecting road, so it identifies an approach and every turn off that
    // approach inherits it.
    const sharedHead = MOVEMENTS.filter((movement) => movement.approach_id === "10.0.r").map(
      (movement) => ({ ...movement, signal_ids: ["7"] }),
    );
    const warnings = detectSignalPlanWarnings({
      junction_id: "5",
      mode: "static",
      movements: sharedHead,
      static: { "10.0.r:straight": "green", "10.0.r:left": "red" },
    });
    const shared = warnings.find((warning) => warning.code === "shared_signal_heads");
    expect(shared?.movement_ids).toEqual(["10.0.r:left", "10.0.r:straight"]);

    // Same head, same colour: nothing to warn about.
    expect(
      detectSignalPlanWarnings({
        junction_id: "5",
        mode: "static",
        movements: sharedHead,
        static: { "10.0.r:straight": "green", "10.0.r:left": "green" },
      }).some((warning) => warning.code === "shared_signal_heads"),
    ).toBe(false);
  });

  it("stops firing once per-turn heads are refined in", () => {
    // The cross-lane invariant: `refineMovementSignalIds` narrows an approach's
    // shared head set to the per-turn heads the map actually wires, and that is
    // exactly what turns this warning off. Simulated here (disjoint heads per
    // movement) rather than importing the xodr lane, so this stays a pure test
    // of the warning's contract.
    const approach = MOVEMENTS.filter((movement) => movement.approach_id === "10.0.r");
    const shared = approach.map((movement) => ({ ...movement, signal_ids: ["900", "901"] }));
    const refined = approach.map((movement) => ({
      ...movement,
      signal_ids: movement.turn === "left" ? ["901"] : ["900"],
    }));
    const states = { "10.0.r:straight": "green" as const, "10.0.r:left": "red" as const };

    const before = detectSignalPlanWarnings({
      junction_id: "5",
      mode: "static",
      movements: shared,
      static: states,
    });
    const after = detectSignalPlanWarnings({
      junction_id: "5",
      mode: "static",
      movements: refined,
      static: states,
    });
    expect(before.some((warning) => warning.code === "shared_signal_heads")).toBe(true);
    expect(after.some((warning) => warning.code === "shared_signal_heads")).toBe(false);
  });

  it("stays quiet for a map_default junction", () => {
    expect(detectSignalPlanWarnings({ junction_id: "5", mode: "map_default", movements: MOVEMENTS })).toEqual([]);
  });

  it("caches its warnings onto the plan", () => {
    const cached = withSignalPlanWarnings({
      junction_id: "5",
      mode: "static" as const,
      movements: MOVEMENTS,
      static: { "10.0.r:straight": "green", "30.0.r:straight": "green" },
    });
    expect(cached.warnings.some((warning) => warning.code === "conflicting_green")).toBe(true);
    expect(JunctionSignalPlanSchema.safeParse(cached).success).toBe(true);
  });
});

describe("deriveConflictFreeGroups", () => {
  it("is the partition synthesizeSignalProgram phases", () => {
    // The extraction is a pure refactor, so the groups and the cycle's greens
    // must stay the same list. If this drifts, a group-tier paint stops being
    // conflict-free by construction.
    const program = synthesizeSignalProgram(MOVEMENTS)!;
    const greens = program.cycle
      .map((phase) =>
        Object.entries(phase.states)
          .filter(([, state]) => state === "green")
          .map(([movementId]) => movementId)
          .sort(),
      )
      .filter((group) => group.length > 0);
    expect(deriveConflictFreeGroups(MOVEMENTS)).toEqual(greens);
  });

  it("never puts two conflicting movements in one group", () => {
    const conflicts = new Map(
      MOVEMENTS.map((movement) => [movement.movement_id, new Set(movement.conflicts_with)]),
    );
    for (const group of deriveConflictFreeGroups(MOVEMENTS)) {
      for (const left of group) {
        for (const right of group) {
          if (left !== right) expect(conflicts.get(left)!.has(right)).toBe(false);
        }
      }
    }
  });

  it("is deterministic regardless of input order", () => {
    expect(deriveConflictFreeGroups(MOVEMENTS)).toEqual(
      deriveConflictFreeGroups([...MOVEMENTS].reverse()),
    );
  });

  it("covers every movement exactly once", () => {
    const flat = deriveConflictFreeGroups(MOVEMENTS).flat().sort();
    expect(flat).toEqual(MOVEMENTS.map((movement) => movement.movement_id).sort());
  });

  it("unions groups whose movements share a signal head, on request", () => {
    // A left and the opposing through are in different groups by conflict, but
    // one physical head cannot show them different colours — so an authoring
    // surface that paints groups must fuse them (plan §2.3).
    const shared = MOVEMENTS.map((movement) =>
      movement.movement_id === "10.0.r:left" || movement.movement_id === "30.0.r:straight"
        ? { ...movement, signal_ids: ["head-9"] }
        : movement,
    );
    const raw = deriveConflictFreeGroups(shared);
    const fused = deriveConflictFreeGroups(shared, { unionSharedHeads: true });
    expect(raw.length).toBeGreaterThan(fused.length);
    const together = fused.find((group) => group.includes("10.0.r:left"))!;
    expect(together).toContain("30.0.r:straight");
    expect(fused.flat().sort()).toEqual(MOVEMENTS.map((movement) => movement.movement_id).sort());
  });

  it("leaves movements with no shared heads alone when unioning", () => {
    expect(deriveConflictFreeGroups(MOVEMENTS, { unionSharedHeads: true })).toEqual(
      deriveConflictFreeGroups(MOVEMENTS),
    );
  });

  it("returns nothing for an empty table", () => {
    expect(deriveConflictFreeGroups([])).toEqual([]);
  });
});

describe("synthesizeSignalProgram", () => {
  const greensOf = (phase: { states: Record<string, string> }) =>
    Object.entries(phase.states)
      .filter(([, state]) => state === "green")
      .map(([movementId]) => movementId)
      .sort();

  it("splits a 4-way into the textbook NEMA phases", () => {
    // Not two phases: a 4-way with protected lefts needs three, because a left
    // conflicts with the opposing through. Greedy colouring finds exactly the
    // split a traffic engineer would draw — NS through (plus the conflict-free
    // right), EW through, then the two protected lefts together.
    const program = synthesizeSignalProgram(MOVEMENTS)!;
    const greens = program.cycle
      .filter((phase) => greensOf(phase).length > 0)
      .map((phase) => greensOf(phase));
    expect(greens).toEqual([
      ["10.0.r:right", "10.0.r:straight", "20.0.r:straight"],
      ["30.0.r:straight", "40.0.r:straight"],
      ["10.0.r:left", "20.0.r:left"],
    ]);
    expect(program.cycle).toHaveLength(9); // three groups x (green, yellow, all-red)
  });

  it("greens every movement exactly once per cycle", () => {
    const program = synthesizeSignalProgram(MOVEMENTS)!;
    const greened = program.cycle.flatMap((phase) => greensOf(phase));
    expect(greened.sort()).toEqual(MOVEMENTS.map((movement) => movement.movement_id).sort());
  });

  it("never greens two conflicting movements together", () => {
    const program = synthesizeSignalProgram(MOVEMENTS)!;
    const warnings = detectSignalPlanWarnings({
      junction_id: "5",
      mode: "program",
      movements: MOVEMENTS,
      program,
    });
    // The default the panel offers must not warn against itself.
    expect(warnings.filter((warning) => warning.code === "conflicting_green")).toEqual([]);
  });

  it("gives a junction with no conflicts a standing green, not a pointless cycle", () => {
    const oneApproach = MOVEMENTS.filter((movement) => movement.approach_id === "10.0.r");
    const program = synthesizeSignalProgram(oneApproach)!;
    expect(program.cycle).toHaveLength(1);
    expect(Object.values(program.cycle[0]!.states).every((state) => state === "green")).toBe(true);
  });

  it("is deterministic and honours custom timings", () => {
    const left = synthesizeSignalProgram(MOVEMENTS);
    const right = synthesizeSignalProgram([...MOVEMENTS].reverse());
    expect(left).toEqual(right);
    const custom = synthesizeSignalProgram(MOVEMENTS, { green_s: 5, yellow_s: 2, all_red_s: 0.5 })!;
    expect(signalProgramCycleDurationS(custom)).toBeCloseTo(3 * (5 + 2 + 0.5), 6);
  });

  it("returns null when there is nothing to phase", () => {
    expect(synthesizeSignalProgram([])).toBeNull();
  });

  it("produces a program the plan schema accepts", () => {
    const parsed = JunctionSignalPlanSchema.safeParse(
      plan({ mode: "program", program: synthesizeSignalProgram(MOVEMENTS)! }),
    );
    expect(parsed.success).toBe(true);
  });
});

describe("cycle math", () => {
  const program = {
    cycle: [
      { duration_s: 10, states: { a: "green" as const } },
      { duration_s: 4, states: { a: "yellow" as const } },
      { duration_s: 6, states: { a: "red" as const, b: "green" as const } },
    ],
    offset_s: 0,
  };

  it("sums the cycle", () => {
    expect(signalProgramCycleDurationS(program)).toBe(20);
  });

  it("locates the phase at a time", () => {
    expect(signalPhaseAt(program, 0).index).toBe(0);
    expect(signalPhaseAt(program, 9.9).index).toBe(0);
    expect(signalPhaseAt(program, 10).index).toBe(1);
    expect(signalPhaseAt(program, 14).index).toBe(2);
    expect(signalPhaseAt(program, 14).elapsed_s).toBeCloseTo(0, 9);
  });

  it("wraps past the end of the cycle", () => {
    expect(signalPhaseAt(program, 20).index).toBe(0);
    expect(signalPhaseAt(program, 31).index).toBe(1);
    expect(signalPhaseAt(program, 31).elapsed_s).toBeCloseTo(1, 9);
  });

  it("shifts the cycle forward by the offset", () => {
    expect(signalPhaseAt({ ...program, offset_s: 10 }, 0).index).toBe(1);
    expect(signalPhaseAt({ ...program, offset_s: 14 }, 0).index).toBe(2);
    expect(signalPhaseAt({ ...program, offset_s: 14 }, 6).index).toBe(0);
  });

  it("holds a movement's colour through phases that do not name it", () => {
    expect(movementStateAt(program, "b", 15)).toBe("green");
    // Phase 0 does not name `b`; the most recent phase that did is phase 2, one
    // cycle back.
    expect(movementStateAt(program, "b", 2)).toBe("green");
    expect(movementStateAt(program, "a", 11)).toBe("yellow");
    expect(movementStateAt(program, "missing", 0)).toBeNull();
  });
});

describe("signal reference resolution", () => {
  const plans: JunctionSignalPlan[] = [
    JunctionSignalPlanSchema.parse(plan({ mode: "static", static: { "10.0.r:straight": "red" } })),
  ];

  it("resolves a movement reference against its plan", () => {
    const result = resolveBehaviorSignalRef(
      { junction_id: "5", movement_id: "10.0.r:straight" },
      plans,
    );
    expect(result.movement?.label).toBe("NB through");
    expect(result.resolved).toBe(true);
  });

  it("does not resolve a movement its own plan lacks", () => {
    const result = resolveBehaviorSignalRef({ junction_id: "5", movement_id: "99.0.r:left" }, plans);
    expect(result.resolved).toBe(false);
  });

  it("treats a junction with no plan as map_default, not an error", () => {
    const result = resolveBehaviorSignalRef({ junction_id: "77", movement_id: "1.0.r:left" }, plans);
    expect(result.plan).toBeNull();
    expect(result.resolved).toBe(true);
  });
});

describe("signal events", () => {
  const events = [
    {
      actor_id: "scene",
      clip_id: signalChannelId("5", "10.0.r:straight"),
      kind: "signal_state_changed",
      t: 0,
      junction_id: "5",
      movement_id: "10.0.r:straight",
      state: "green",
    },
    {
      actor_id: "scene",
      clip_id: signalChannelId("5", "10.0.r:straight"),
      kind: "signal_state_changed",
      t: 10,
      junction_id: "5",
      movement_id: "10.0.r:straight",
      state: "yellow",
    },
    { actor_id: "ego", clip_id: "clip-1", kind: "clip_started", t: 3 },
    { kind: "signal_state_changed", t: 1 },
  ];

  it("reads only well-formed signal transitions", () => {
    const parsed = readSignalStateEvents({ behavior_events: events });
    expect(parsed).toHaveLength(2);
    expect(parsed[1]!.state).toBe("yellow");
  });

  it("degrades to an empty list without a behavior_events array", () => {
    expect(readSignalStateEvents({})).toEqual([]);
    expect(readSignalStateEvents(null)).toEqual([]);
    expect(readSignalStateEvents({ behavior_events: "nope" })).toEqual([]);
  });

  it("turns transitions into colour bands for the SCENE lane", () => {
    const bands = signalBandsFromEvents(readSignalStateEvents({ behavior_events: events }), 20);
    expect(bands).toEqual([
      {
        junction_id: "5",
        movement_id: "10.0.r:straight",
        state: "green",
        start_s: 0,
        end_s: 10,
      },
      {
        junction_id: "5",
        movement_id: "10.0.r:straight",
        state: "yellow",
        start_s: 10,
        end_s: 20,
      },
    ]);
  });
});

describe("draft integration", () => {
  const metadata = {
    sourceScenarioId: "scn-1",
    mapAssetId: "map-1",
    mapName: "Town10",
    notes: "",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  };

  it("leaves signal_plans absent on a legacy draft", () => {
    const draft = ScenarioEditorDraftSchema.parse({ version: 2, metadata, actors: [] });
    expect(draft.signal_plans).toBeUndefined();
  });

  it("carries authored plans on the draft", () => {
    const draft = ScenarioEditorDraftSchema.parse({
      version: 2,
      metadata,
      actors: [],
      signal_plans: [plan({ mode: "static", static: { "10.0.r:straight": "red" } })],
    });
    expect(draft.signal_plans?.[0]!.mode).toBe("static");
    expect(draft.signal_plans?.[0]!.movements).toHaveLength(MOVEMENTS.length);
  });
});
