import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseXodr } from "../map-topology/build-topology-index";
import {
  approachIdFromLaneRsl,
  deriveJunctionMovements,
  type JunctionGateInput,
} from "../scenario-signals";
import {
  attachSignalIdsToGates,
  buildSignalPlacementIndex,
  deriveXodrSignalGroups,
  enrichXodrWithSignalControllers,
  refineMovementSignalIds,
} from "../xodr-signal-controllers";

const FIXTURE = readFileSync(
  join(__dirname, "fixtures/xodr/signalized-4way.xodr"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Minimal-xodr builder for topology edge cases the realistic fixture cannot
// express (T-junctions, perpendicular-only arms). One tag per line, because
// `parseXodr` scans line by line.
// ---------------------------------------------------------------------------

type Arm = { roadId: number; x: number; y: number; hdg: number; signalId: number };

function buildJunctionXodr(junctionId: number, arms: readonly Arm[]): string {
  const lines: string[] = [
    '<?xml version="1.0" standalone="yes"?>',
    "<OpenDRIVE>",
    '  <header revMajor="1" revMinor="6" name="edge-case" version="1.00" vendor="test">',
    "  </header>",
  ];
  const road = (
    id: number,
    junction: number,
    x: number,
    y: number,
    hdg: number,
    link: string,
    signal?: number,
  ) => {
    lines.push(`  <road name="r${id}" length="50.0" id="${id}" junction="${junction}">`);
    lines.push("    <link>");
    lines.push(link);
    lines.push("    </link>");
    lines.push("    <planView>");
    lines.push(`      <geometry s="0.0" x="${x}" y="${y}" hdg="${hdg}" length="50.0">`);
    lines.push("        <line/>");
    lines.push("      </geometry>");
    lines.push("    </planView>");
    lines.push("    <lanes>");
    lines.push('      <laneSection s="0.0">');
    lines.push("        <center>");
    lines.push('          <lane id="0" type="none" level="false"/>');
    lines.push("        </center>");
    lines.push("        <right>");
    lines.push('          <lane id="-1" type="driving" level="false"/>');
    lines.push("        </right>");
    lines.push("      </laneSection>");
    lines.push("    </lanes>");
    if (signal !== undefined) {
      lines.push("    <signals>");
      lines.push(
        `      <signal s="1.0" t="-5.0" id="${signal}" name="Signal_3Light_Post01" dynamic="yes" orientation="+" type="1000001" subtype="-1"/>`,
      );
      lines.push("    </signals>");
    }
    lines.push("  </road>");
  };

  for (const arm of arms) {
    road(
      arm.roadId,
      -1,
      arm.x,
      arm.y,
      arm.hdg,
      `      <successor elementType="junction" elementId="${junctionId}"/>`,
      undefined,
    );
  }
  // One connecting road per arm, each carrying that arm's head.
  for (const arm of arms) {
    road(
      arm.roadId + 100,
      junctionId,
      0,
      0,
      arm.hdg,
      `      <predecessor elementType="road" elementId="${arm.roadId}" contactPoint="end"/>`,
      arm.signalId,
    );
  }
  lines.push(`  <junction id="${junctionId}" name="edge">`);
  arms.forEach((arm, index) => {
    lines.push(
      `    <connection id="${index}" incomingRoad="${arm.roadId}" connectingRoad="${arm.roadId + 100}" contactPoint="start">`,
    );
    lines.push('      <laneLink from="-1" to="-1"/>');
    lines.push("    </connection>");
  });
  lines.push("  </junction>");
  lines.push("</OpenDRIVE>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------

describe("deriveXodrSignalGroups", () => {
  it("joins signals on connecting roads to the approaches they serve", () => {
    const result = deriveXodrSignalGroups(FIXTURE);
    expect(result.junctions).toHaveLength(1);
    const junction = result.junctions[0]!;
    expect(junction.junction_id).toBe("100");
    expect(junction.approaches.map((a) => a.approach_id)).toEqual([
      "1.0.r",
      "2.0.r",
      "3.0.r",
      "4.0.r",
    ]);
    // The west arm feeds a through movement (900) and a left turn (901); one
    // approach, two heads.
    expect(junction.approaches[0]!.signal_ids).toEqual(["900", "901"]);
    expect(junction.approaches[1]!.signal_ids).toEqual(["902"]);
    expect(junction.approaches[2]!.signal_ids).toEqual(["903", "904"]);
    expect(junction.approaches[3]!.signal_ids).toEqual(["905"]);
    expect(result.unassigned_signal_ids).toEqual([]);
  });

  it("excludes static signs from the traffic-light grouping", () => {
    // Signal 950 on road 1 is a `Sign_R2-1` speed-limit plate: dynamic="no",
    // type 274, no light-shaped name.
    const result = deriveXodrSignalGroups(FIXTURE);
    const allIds = result.junctions.flatMap((j) =>
      j.approaches.flatMap((a) => a.signal_ids),
    );
    expect(allIds).not.toContain("950");
    expect(result.unassigned_signal_ids).not.toContain("950");
  });

  it("computes approach headings as direction of travel into the junction", () => {
    const junction = deriveXodrSignalGroups(FIXTURE).junctions[0]!;
    const headings = Object.fromEntries(
      junction.approaches.map((a) => [a.approach_id, a.approach_heading_rad]),
    );
    expect(headings["1.0.r"]).toBeCloseTo(0, 6); // eastbound
    expect(headings["2.0.r"]!).toBeCloseTo(Math.PI, 6); // westbound
    expect(headings["3.0.r"]!).toBeCloseTo(Math.PI / 2, 6); // northbound
    expect(headings["4.0.r"]!).toBeCloseTo(-Math.PI / 2, 6); // southbound
  });

  it("pairs opposing arms into phase groups", () => {
    const junction = deriveXodrSignalGroups(FIXTURE).junctions[0]!;
    expect(junction.grouping).toBe("opposing_pairs");
    expect(junction.phase_groups).toHaveLength(2);
    expect(junction.phase_groups[0]!.approach_ids).toEqual(["1.0.r", "2.0.r"]);
    expect(junction.phase_groups[0]!.signal_ids).toEqual(["900", "901", "902"]);
    expect(junction.phase_groups[1]!.approach_ids).toEqual(["3.0.r", "4.0.r"]);
    expect(junction.phase_groups[1]!.signal_ids).toEqual(["903", "904", "905"]);
  });

  it("keys phase groups on content, not position", () => {
    const junction = deriveXodrSignalGroups(FIXTURE).junctions[0]!;
    expect(junction.phase_groups.map((g) => g.key)).toEqual(["ew:1.0.r", "ns:3.0.r"]);
    expect(junction.phase_groups.map((g) => g.controller_name)).toEqual([
      "sf:100:ew:1.0.r",
      "sf:100:ns:3.0.r",
    ]);
  });

  it("allocates controller ids above every id already in the document", () => {
    const result = deriveXodrSignalGroups(FIXTURE);
    // 950 is the highest id in the fixture (the speed-limit sign).
    expect(result.controller_id_base).toBe(951);
    expect(result.junctions[0]!.phase_groups.map((g) => g.controller_id)).toEqual([
      "951",
      "952",
    ]);
  });

  it("is deterministic across repeated runs", () => {
    expect(deriveXodrSignalGroups(FIXTURE)).toEqual(deriveXodrSignalGroups(FIXTURE));
  });

  it("leaves an unpaired arm of a T-junction as its own group", () => {
    const xodr = buildJunctionXodr(300, [
      { roadId: 1, x: -60, y: 0, hdg: 0, signalId: 900 }, // eastbound
      { roadId: 3, x: 0, y: -60, hdg: Math.PI / 2, signalId: 901 }, // northbound
      { roadId: 4, x: 0, y: 60, hdg: -Math.PI / 2, signalId: 902 }, // southbound
    ]);
    const junction = deriveXodrSignalGroups(xodr).junctions[0]!;
    expect(junction.grouping).toBe("opposing_pairs");
    expect(junction.phase_groups.map((g) => g.approach_ids)).toEqual([
      ["1.0.r"],
      ["3.0.r", "4.0.r"],
    ]);
  });

  it("falls back to an axis split when no arms oppose each other", () => {
    const xodr = buildJunctionXodr(300, [
      { roadId: 1, x: -60, y: 0, hdg: 0, signalId: 900 }, // eastbound
      { roadId: 3, x: 0, y: -60, hdg: Math.PI / 2, signalId: 901 }, // northbound
    ]);
    const junction = deriveXodrSignalGroups(xodr).junctions[0]!;
    expect(junction.grouping).toBe("axis_fallback");
    expect(junction.phase_groups.map((g) => g.approach_ids)).toEqual([
      ["1.0.r"],
      ["3.0.r"],
    ]);
    expect(junction.phase_groups.map((g) => g.key)).toEqual(["ew:1.0.r", "ns:3.0.r"]);
  });

  it("reports nothing for a map with no signals", () => {
    const xodr = buildJunctionXodr(300, []);
    const result = deriveXodrSignalGroups(xodr);
    expect(result.junctions).toEqual([]);
    expect(result.unassigned_signal_ids).toEqual([]);
  });
});

describe("enrichXodrWithSignalControllers", () => {
  it("can conservatively emit one deterministic controller per signal", () => {
    const result = enrichXodrWithSignalControllers(FIXTURE, { singleSignalControllers: true });
    expect(result.stats.controllers_added).toBe(6);
    expect(result.stats.controls_added).toBe(6);
    const controlsPerController = [...result.xodr.matchAll(/<controller\b[^>]*>([\s\S]*?)<\/controller>/g)]
      .map((match) => [...match[1]!.matchAll(/<control\b/g)].length);
    expect(controlsPerController).toEqual([1, 1, 1, 1, 1, 1]);
    expect(result.groups.junctions[0]?.phase_groups.map((group) => group.controller_id)).toEqual([
      "951", "952", "953", "954", "955", "956",
    ]);
  });

  it("emits one controller per phase group, with its controls", () => {
    const { xodr, stats } = enrichXodrWithSignalControllers(FIXTURE);
    expect(stats).toEqual({
      junctions_enriched: 1,
      junctions_skipped_existing_controllers: 0,
      controllers_added: 2,
      controls_added: 6,
      junctions_skipped_self_closing: 0,
    });
    expect(xodr).toContain('<controller id="951" name="sf:100:ew:1.0.r">');
    expect(xodr).toContain('<control signalId="900" type="0"/>');
    expect(xodr).toContain('<control signalId="905" type="0"/>');
  });

  it("places controllers where the root xs:sequence requires", () => {
    // OpenDRIVE 1.4/1.6/1.7 root order: header, road+, controller*, junction*.
    const { xodr } = enrichXodrWithSignalControllers(FIXTURE);
    const lastRoadEnd = xodr.lastIndexOf("</road>");
    const firstController = xodr.indexOf("<controller ");
    const firstJunction = xodr.search(/<junction\b/);
    expect(firstController).toBeGreaterThan(lastRoadEnd);
    expect(firstController).toBeLessThan(firstJunction);
  });

  it("back-references each controller from its junction", () => {
    // CARLA's TrafficLightManager drops a controller's lights entirely when the
    // controller is not referenced by a junction, so this is load-bearing.
    const { xodr } = enrichXodrWithSignalControllers(FIXTURE);
    const junctionBody = /<junction\b[^>]*>([\s\S]*?)<\/junction>/.exec(xodr)![1]!;
    expect(junctionBody).toContain('<controller id="951" sequence="0"/>');
    expect(junctionBody).toContain('<controller id="952" sequence="1"/>');
    // References sit after the connections, per the junction's own sequence.
    expect(junctionBody.lastIndexOf("</connection>")).toBeLessThan(
      junctionBody.indexOf("<controller"),
    );
  });

  it("preserves the road and junction structure the enriched file parses to", () => {
    const before = parseXodr(FIXTURE);
    const after = parseXodr(enrichXodrWithSignalControllers(FIXTURE).xodr);
    expect([...after.roads.keys()].sort()).toEqual([...before.roads.keys()].sort());
    expect(after.junctions.map((j) => j.id)).toEqual(before.junctions.map((j) => j.id));
    expect(after.junctions[0]!.connections).toEqual(before.junctions[0]!.connections);
  });

  it("is deterministic and idempotent", () => {
    const once = enrichXodrWithSignalControllers(FIXTURE).xodr;
    expect(enrichXodrWithSignalControllers(FIXTURE).xodr).toBe(once);
    // The second pass sees the junction references the first pass wrote and
    // leaves the file alone.
    const twice = enrichXodrWithSignalControllers(once);
    expect(twice.xodr).toBe(once);
    expect(twice.stats.controllers_added).toBe(0);
    expect(twice.stats.junctions_skipped_existing_controllers).toBe(1);
  });

  it("returns the input untouched when there is nothing to control", () => {
    const xodr = buildJunctionXodr(300, []);
    const result = enrichXodrWithSignalControllers(xodr);
    expect(result.xodr).toBe(xodr);
    expect(result.stats.controllers_added).toBe(0);
  });

  it("re-enriches an already-controlled junction only when asked", () => {
    const once = enrichXodrWithSignalControllers(FIXTURE).xodr;
    const forced = enrichXodrWithSignalControllers(once, {
      includeJunctionsWithExistingControllers: true,
    });
    expect(forced.stats.controllers_added).toBe(2);
    expect(forced.stats.junctions_skipped_existing_controllers).toBe(0);
  });

  it("marks a junction whose lights an unreferenced controller already claims", () => {
    // The DeepMap corpus shape: top-level controllers, no junction references.
    const orphaned = FIXTURE.replace(
      /<junction\b/,
      '<controller id="800" name="vendor">\n    <control signalId="900" type="0"/>\n  </controller>\n  <junction',
    );
    const result = deriveXodrSignalGroups(orphaned);
    expect(result.junctions[0]!.had_existing_controllers).toBe(true);
    expect(
      enrichXodrWithSignalControllers(orphaned).stats
        .junctions_skipped_existing_controllers,
    ).toBe(1);
  });
});

describe("attachSignalIdsToGates", () => {
  const group = deriveXodrSignalGroups(FIXTURE).junctions[0]!;

  it("fills signal ids on gates whose approach matches", () => {
    const gates: JunctionGateInput[] = [
      { approach_lane_rsl: "1:0:-1", turn_relation: "Straight" },
      { approach_lane_rsl: "1:0:-1", turn_relation: "Left" },
      { approach_lane_rsl: "3:0:-1", turn_relation: "Straight" },
    ];
    const attached = attachSignalIdsToGates(gates, group);
    expect(attached[0]!.signal_ids).toEqual(["900", "901"]);
    // Every turn off one approach inherits that approach's heads — one signal
    // head serves the whole approach.
    expect(attached[1]!.signal_ids).toEqual(["900", "901"]);
    expect(attached[2]!.signal_ids).toEqual(["903", "904"]);
  });

  it("leaves unmatched gates and pre-set ids alone", () => {
    const gates: JunctionGateInput[] = [
      { approach_lane_rsl: "77:0:-1", turn_relation: "Straight" },
      { approach_lane_rsl: "2:0:-1", turn_relation: "Straight", signal_ids: ["902", "999"] },
    ];
    const attached = attachSignalIdsToGates(gates, group);
    expect(attached[0]!.signal_ids).toBeUndefined();
    // Union, deduped, sorted numerically — never an overwrite.
    expect(attached[1]!.signal_ids).toEqual(["902", "999"]);
  });

  it("preserves every other gate field, including the conflict headings", () => {
    // `junctionGatesFromTopology` fills approach/exit headings off the lane
    // polylines and `deriveMovementConflicts` needs them, so the adapter
    // spreads rather than rebuilds.
    const gate: JunctionGateInput = {
      approach_lane_rsl: "1:0:-1",
      turn_relation: "Left",
      exit_lane_rsls: ["4:0:-1"],
      approach_heading_rad: 0,
      exit_heading_rad: Math.PI / 2,
    };
    const [attached] = attachSignalIdsToGates([gate], group);
    expect(attached).toEqual({ ...gate, signal_ids: ["900", "901"] });
  });

  it("returns the gates unchanged when the junction has no grouping", () => {
    const gates: JunctionGateInput[] = [
      { approach_lane_rsl: "1:0:-1", turn_relation: "Straight" },
    ];
    expect(attachSignalIdsToGates(gates, undefined)).toEqual(gates);
  });

  it("agrees with scenario-signals on approach identity", () => {
    // The lane-rsl -> approach-id rule is implemented in both modules; if they
    // ever diverge the seam silently stops matching, so pin it here.
    for (const approach of group.approaches) {
      const laneRsl = `${approach.road_id}:${approach.section}:${approach.side === "r" ? -1 : 1}`;
      expect(approachIdFromLaneRsl(laneRsl)).toBe(approach.approach_id);
    }
  });

  it("carries signal ids through to movement bindings", () => {
    const gates: JunctionGateInput[] = [
      { approach_lane_rsl: "1:0:-1", turn_relation: "Straight", approach_heading_rad: 0 },
      { approach_lane_rsl: "1:0:-1", turn_relation: "Left", approach_heading_rad: 0 },
      { approach_lane_rsl: "2:0:-1", turn_relation: "Straight", approach_heading_rad: Math.PI },
    ];
    const movements = deriveJunctionMovements(attachSignalIdsToGates(gates, group));
    const byId = Object.fromEntries(movements.map((m) => [m.movement_id, m.signal_ids]));
    expect(byId["1.0.r:straight"]).toEqual(["900", "901"]);
    expect(byId["1.0.r:left"]).toEqual(["900", "901"]);
    expect(byId["2.0.r:straight"]).toEqual(["902"]);
  });
});

describe("buildSignalPlacementIndex", () => {
  it("inverts the grouping so a bulb resolves to its approaches", () => {
    const index = buildSignalPlacementIndex(deriveXodrSignalGroups(FIXTURE));
    expect(Object.keys(index).sort()).toEqual([
      "900",
      "901",
      "902",
      "903",
      "904",
      "905",
    ]);
    expect(index["901"]).toEqual({
      junction_id: "100",
      approach_ids: ["1.0.r"],
      phase_group_key: "ew:1.0.r",
    });
    expect(index["905"]).toEqual({
      junction_id: "100",
      approach_ids: ["4.0.r"],
      phase_group_key: "ns:3.0.r",
    });
  });

  it("lists both approaches for a head shared across a mast", () => {
    // Two arms whose connections share one connecting road, so its head serves
    // both approaches.
    const shared = FIXTURE.replace(
      '<connection id="2" incomingRoad="2" connectingRoad="12" contactPoint="start">',
      '<connection id="2" incomingRoad="2" connectingRoad="11" contactPoint="start">',
    );
    const index = buildSignalPlacementIndex(deriveXodrSignalGroups(shared));
    expect(index["900"]!.approach_ids).toEqual(["1.0.r", "2.0.r"]);
  });
});

describe("per-movement heads", () => {
  const junction = deriveXodrSignalGroups(FIXTURE).junctions[0]!;

  it("recovers protected lefts from the connecting-road split", () => {
    // The west arm's through movement (connecting road 11) and its left turn
    // (road 15) carry different heads, so the approach-level union of
    // {900, 901} can be narrowed per turn. No `subtype` parsing involved.
    expect(
      junction.movements.map((m) => [m.movement_id, m.signal_ids, m.connecting_road_ids]),
    ).toEqual([
      ["1.0.r:left", ["901"], ["15"]],
      ["1.0.r:straight", ["900"], ["11"]],
      ["3.0.r:left", ["904"], ["16"]],
      ["3.0.r:straight", ["903"], ["13"]],
    ]);
  });

  it("stays silent for approaches with one head for every turn", () => {
    // Arms 2 and 4 have a single connecting road each — nothing to split, so
    // they must not appear and the approach-level union stands.
    expect(junction.movements.map((m) => m.approach_id)).not.toContain("2.0.r");
    expect(junction.movements.map((m) => m.approach_id)).not.toContain("4.0.r");
  });

  it("narrows bindings whose movement id it recognises", () => {
    const bindings = [
      { movement_id: "1.0.r:left", signal_ids: ["900", "901"] },
      { movement_id: "1.0.r:straight", signal_ids: ["900", "901"] },
      { movement_id: "2.0.r:straight", signal_ids: ["902"] },
    ];
    expect(refineMovementSignalIds(bindings, junction)).toEqual([
      { movement_id: "1.0.r:left", signal_ids: ["901"] },
      { movement_id: "1.0.r:straight", signal_ids: ["900"] },
      { movement_id: "2.0.r:straight", signal_ids: ["902"] },
    ]);
  });

  it("declines rather than guesses when a movement id is unfamiliar", () => {
    // Our turn class comes from the connecting road's reference line, the
    // topology's from the lane polyline; near the classifier thresholds they
    // can disagree. A disagreement must degrade to the approach union, never
    // produce a wrong binding.
    const bindings = [{ movement_id: "1.0.r:uturn", signal_ids: ["900", "901"] }];
    expect(refineMovementSignalIds(bindings, junction)).toEqual(bindings);
  });

  it("intersects rather than inventing when the binding already has ids", () => {
    const bindings = [{ movement_id: "1.0.r:left", signal_ids: ["900"] }];
    // 901 is not in the caller's set, so narrowing to {901} would invent a
    // head it never knew about; the original stands instead.
    expect(refineMovementSignalIds(bindings, junction)).toEqual(bindings);
  });

  it("adopts the narrowed set outright when the binding has no ids", () => {
    // Not a narrowing but an addition, and deliberately so: an empty
    // `signal_ids` sends the worker down its lane-rsl matching fallback, so
    // real heads beat none.
    const bindings = [{ movement_id: "1.0.r:left", signal_ids: [] }];
    expect(refineMovementSignalIds(bindings, junction)).toEqual([
      { movement_id: "1.0.r:left", signal_ids: ["901"] },
    ]);
  });

  it("passes bindings through when the junction has no split", () => {
    const bindings = [{ movement_id: "1.0.r:left", signal_ids: ["900", "901"] }];
    expect(refineMovementSignalIds(bindings, undefined)).toEqual(bindings);
  });
});

// ---------------------------------------------------------------------------
// Shared heads: `<signalReference>`
// ---------------------------------------------------------------------------

/**
 * A junction in the shape that Yale St junction 432 actually has.
 *
 * One head (`900`) is DEFINED on the connecting road off arm 1 and only
 * REFERENCED from the connecting roads off arms 2 and 3 — which is how CARLA's
 * `to_opendrive()` writes a mast-arm head that governs several turns. Arm 4's
 * connecting road carries a stop sign (`950`, `dynamic="no"`, type 206) that a
 * fifth connecting road references, which is how the same file expresses a
 * sign-controlled arm of a part-signalized intersection.
 *
 * Arms are laid out east / west / north / south so `partitionIntoPhaseGroups`
 * has real bearings to work with.
 */
function buildSharedHeadXodr(): string {
  const lines: string[] = [
    '<?xml version="1.0" standalone="yes"?>',
    "<OpenDRIVE>",
    '  <header revMajor="1" revMinor="6" name="shared-head" version="1.00" vendor="test">',
    "  </header>",
  ];
  const road = (
    id: number,
    junction: number,
    hdg: number,
    link: string,
    signals: readonly string[],
  ) => {
    lines.push(`  <road name="r${id}" length="50.0" id="${id}" junction="${junction}">`);
    lines.push("    <link>");
    lines.push(link);
    lines.push("    </link>");
    lines.push("    <planView>");
    lines.push(`      <geometry s="0.0" x="0" y="0" hdg="${hdg}" length="50.0">`);
    lines.push("        <line/>");
    lines.push("      </geometry>");
    lines.push("    </planView>");
    lines.push("    <lanes>");
    lines.push('      <laneSection s="0.0">');
    lines.push("        <center>");
    lines.push('          <lane id="0" type="none" level="false"/>');
    lines.push("        </center>");
    lines.push("        <right>");
    lines.push('          <lane id="-1" type="driving" level="false"/>');
    lines.push("        </right>");
    lines.push("      </laneSection>");
    lines.push("    </lanes>");
    if (signals.length > 0) {
      lines.push("    <signals>");
      for (const signal of signals) lines.push(`      ${signal}`);
      lines.push("    </signals>");
    }
    lines.push("  </road>");
  };

  const light = (id: number) =>
    `<signal s="30.0" t="-5.0" id="${id}" name="Signal_3Light_Post01" dynamic="yes" orientation="-" type="1000001" subtype="-1"/>`;
  const stop = (id: number) =>
    `<signal s="15.0" t="1.1" id="${id}" name="Stop_US" dynamic="no" orientation="+" country="US" type="206" subtype="-1"/>`;
  const ref = (id: number) => `<signalReference s="0.0" t="0.0" id="${id}" orientation="-"/>`;

  const arms = [
    { roadId: 1, hdg: 0 },
    { roadId: 2, hdg: Math.PI },
    { roadId: 3, hdg: Math.PI / 2 },
    { roadId: 4, hdg: -Math.PI / 2 },
  ];
  for (const arm of arms) {
    road(
      arm.roadId,
      -1,
      arm.hdg,
      '      <successor elementType="junction" elementId="500"/>',
      [],
    );
  }
  // 11 DEFINES head 900; 12 and 13 only REFERENCE it. 14 defines stop sign 950
  // and 15 references it — the sign-controlled arm.
  road(11, 500, 0, '      <predecessor elementType="road" elementId="1" contactPoint="end"/>', [light(900)]);
  road(12, 500, Math.PI, '      <predecessor elementType="road" elementId="2" contactPoint="end"/>', [ref(900)]);
  road(13, 500, Math.PI / 2, '      <predecessor elementType="road" elementId="3" contactPoint="end"/>', [ref(900), ref(900)]);
  road(14, 500, -Math.PI / 2, '      <predecessor elementType="road" elementId="4" contactPoint="end"/>', [stop(950)]);
  road(15, 500, -Math.PI / 2, '      <predecessor elementType="road" elementId="4" contactPoint="end"/>', [ref(950)]);

  lines.push('  <junction id="500" name="shared">');
  const connect = (index: number, incoming: number, connecting: number) => {
    lines.push(
      `    <connection id="${index}" incomingRoad="${incoming}" connectingRoad="${connecting}" contactPoint="start">`,
    );
    lines.push('      <laneLink from="-1" to="-1"/>');
    lines.push("    </connection>");
  };
  connect(0, 1, 11);
  connect(1, 2, 12);
  connect(2, 3, 13);
  connect(3, 4, 14);
  connect(4, 4, 15);
  lines.push("  </junction>");
  lines.push("</OpenDRIVE>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Left-side approaches: `.l` binds exactly like `.r`
// ---------------------------------------------------------------------------

/**
 * A junction with both SIDES of a two-way street as approaches, plus a
 * stop-controlled left-side arm — the Yale St junction 432 investigation shape
 * (2026-07-28).
 *
 * That investigation started from the suspicion that left-side (positive-lane,
 * against-`+s`) approaches systematically fail to bind heads. They do not: the
 * connecting-road rule reads only the `laneLink` sign, never a heading. What
 * junction 432 actually has is a cross street whose connecting roads reference
 * ONLY stop signs — headless by map design, not by a `.l` sign flip. This
 * fixture pins both halves so the suspicion never has to be re-litigated:
 * a `.l` approach binds a shared head exactly like its `.r` twin, its heading
 * comes out in TRAVEL direction (reference heading + pi), and a `.l` arm whose
 * references are all static signs stays honestly unsignalized.
 */
function buildTwoSidedXodr(): string {
  const lines: string[] = [
    '<?xml version="1.0" standalone="yes"?>',
    "<OpenDRIVE>",
    '  <header revMajor="1" revMinor="6" name="two-sided" version="1.00" vendor="test">',
    "  </header>",
  ];
  const road = (
    id: number,
    junction: number,
    x: number,
    hdg: number,
    link: string,
    laneId: number,
    signals: readonly string[],
  ) => {
    const side = laneId < 0 ? "right" : "left";
    lines.push(`  <road name="r${id}" length="50.0" id="${id}" junction="${junction}">`);
    lines.push("    <link>");
    lines.push(link);
    lines.push("    </link>");
    lines.push("    <planView>");
    lines.push(`      <geometry s="0.0" x="${x}" y="0" hdg="${hdg}" length="50.0">`);
    lines.push("        <line/>");
    lines.push("      </geometry>");
    lines.push("    </planView>");
    lines.push("    <lanes>");
    lines.push('      <laneSection s="0.0">');
    lines.push(`        <${side}>`);
    lines.push(`          <lane id="${laneId}" type="driving" level="false"/>`);
    lines.push(`        </${side}>`);
    lines.push("        <center>");
    lines.push('          <lane id="0" type="none" level="false"/>');
    lines.push("        </center>");
    lines.push("      </laneSection>");
    lines.push("    </lanes>");
    if (signals.length > 0) {
      lines.push("    <signals>");
      for (const signal of signals) lines.push(`      ${signal}`);
      lines.push("    </signals>");
    }
    lines.push("  </road>");
  };

  const light = (id: number) =>
    `<signal s="30.0" t="-5.0" id="${id}" name="Signal_3Light_Post01" dynamic="yes" orientation="-" type="1000001" subtype="-1"/>`;
  const stop = (id: number) =>
    `<signal s="15.0" t="1.1" id="${id}" name="Stop_US" dynamic="no" orientation="+" country="US" type="206" subtype="-1"/>`;
  const ref = (id: number) => `<signalReference s="0.0" t="0.0" id="${id}" orientation="-"/>`;

  // Road 1: junction at its END, right lane -1 — the `.r` side of the street.
  road(1, -1, -50, 0, '      <successor elementType="junction" elementId="600"/>', -1, []);
  // Road 2: junction at its START, left lane +1 — the SAME street's other
  // direction. Left-lane traffic travels against `+s`, into the junction.
  road(2, -1, 0, 0, '      <predecessor elementType="junction" elementId="600"/>', 1, []);
  // Road 3: a second left-side arm, stop-controlled — the 432 cross street.
  road(3, -1, 0, Math.PI / 2, '      <predecessor elementType="junction" elementId="600"/>', 1, []);

  // Connecting roads: 21 DEFINES head 910 (serves the `.r` arm), 22 only
  // REFERENCES it (serves the `.l` arm) — the shared mast across the street.
  // 23 defines stop sign 960 and 24 references it — the sign-controlled arm.
  road(21, 600, 0, 0, '      <predecessor elementType="road" elementId="1" contactPoint="end"/>', -1, [light(910)]);
  road(22, 600, 0, Math.PI, '      <predecessor elementType="road" elementId="2" contactPoint="start"/>', -1, [ref(910)]);
  road(23, 600, 0, -Math.PI / 2, '      <predecessor elementType="road" elementId="3" contactPoint="start"/>', -1, [stop(960)]);
  road(24, 600, 0, -Math.PI / 2, '      <predecessor elementType="road" elementId="3" contactPoint="start"/>', -1, [ref(960)]);

  lines.push('  <junction id="600" name="two-sided">');
  const connect = (index: number, incoming: number, connecting: number, from: number) => {
    lines.push(
      `    <connection id="${index}" incomingRoad="${incoming}" connectingRoad="${connecting}" contactPoint="start">`,
    );
    lines.push(`      <laneLink from="${from}" to="-1"/>`);
    lines.push("    </connection>");
  };
  connect(0, 1, 21, -1);
  connect(1, 2, 22, 1);
  connect(2, 3, 23, 1);
  connect(3, 3, 24, 1);
  lines.push("  </junction>");
  lines.push("</OpenDRIVE>");
  return lines.join("\n");
}

describe("left-side approaches (Yale 432 regression shape, 2026-07-28)", () => {
  const junction = deriveXodrSignalGroups(buildTwoSidedXodr()).junctions[0]!;
  const byApproach = Object.fromEntries(
    junction.approaches.map((a) => [a.approach_id, a]),
  );

  it("binds a `.l` approach to a shared head exactly like its `.r` twin", () => {
    expect(byApproach["1.0.r"]?.signal_ids).toEqual(["910"]);
    expect(byApproach["2.0.l"]?.signal_ids).toEqual(["910"]);
  });

  it("reports a `.l` approach heading in TRAVEL direction, not `+s` order", () => {
    // Road 2's reference line runs east (hdg 0); its left lane is driven WEST
    // into the junction, so the travel heading is pi — a raw `+s` read would
    // say 0 and put the approach on the wrong side of the junction circle.
    expect(byApproach["1.0.r"]?.approach_heading_rad).toBeCloseTo(0, 6);
    expect(Math.abs(byApproach["2.0.l"]?.approach_heading_rad ?? 0)).toBeCloseTo(
      Math.PI,
      6,
    );
  });

  it("leaves a stop-controlled `.l` arm unsignalized instead of inventing a head", () => {
    // Junction 432's actual cross street: connecting roads that reference only
    // a type-206 stop sign. Empty is the honest answer — the worker has no
    // light actor to command there, so binding one here would recreate the
    // preview/CARLA split (catalog defect D5).
    expect(byApproach["3.0.l"]).toBeUndefined();
    expect(junction.phase_groups.flatMap((g) => g.approach_ids)).not.toContain("3.0.l");
  });

  it("fills gate signal ids for positive-lane rsls through the same approach id", () => {
    const gates = attachSignalIdsToGates(
      [
        { approach_lane_rsl: "2:0:1", turn_relation: "Straight", signal_ids: [] },
        { approach_lane_rsl: "3:0:1", turn_relation: "Straight", signal_ids: [] },
      ],
      junction,
    );
    expect(gates[0]!.signal_ids).toEqual(["910"]);
    expect(gates[1]!.signal_ids).toEqual([]);
  });
});

describe("shared heads via <signalReference>", () => {
  const junction = deriveXodrSignalGroups(buildSharedHeadXodr()).junctions[0]!;
  const byApproach = Object.fromEntries(
    junction.approaches.map((a) => [a.approach_id, a.signal_ids]),
  );

  it("binds a head to every approach whose connecting road references it", () => {
    // Without reference resolution only arm 1 — the road the `<signal>` is
    // DEFINED on — sees head 900, and the other two arms it governs come out
    // unsignalized. This is the whole shared-mast case.
    expect(byApproach["1.0.r"]).toEqual(["900"]);
    expect(byApproach["2.0.r"]).toEqual(["900"]);
    expect(byApproach["3.0.r"]).toEqual(["900"]);
  });

  it("leaves an arm whose references are all static signs unsignalized", () => {
    // Arm 4's connecting roads carry a STOP sign and a reference to it. A
    // reference carries no type of its own, so it can only be resolved against
    // the definitions this module already classified as lights — which is what
    // keeps a stop-controlled arm out of the light table.
    expect(byApproach["4.0.r"]).toBeUndefined();
    expect(junction.phase_groups.flatMap((g) => g.approach_ids)).not.toContain("4.0.r");
  });

  it("counts a head once per road, however many times it is referenced", () => {
    // Road 13 references 900 twice. A duplicate would make road 13's head SET
    // differ from road 11's and fake a protected-left split.
    expect(byApproach["3.0.r"]).toEqual(["900"]);
    expect(junction.movements).toEqual([]);
  });

  it("does not leave a referenced head reported as unassigned", () => {
    const result = deriveXodrSignalGroups(buildSharedHeadXodr());
    expect(result.unassigned_signal_ids).toEqual([]);
  });
});
