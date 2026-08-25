import { describe, expect, it } from "vitest";
import {
  ALL_CATEGORIES,
  LIVE_CATEGORIES,
  RESERVED_CATEGORIES,
  SCENARIO_CATALOG_VERSION,
  categoryById,
  resolveCategory,
} from "../scenario-catalog";

/**
 * The 28 categories the customer capability report already advertises. This
 * list is transcribed from the product requirements table and must not shrink:
 * removing one silently breaks a category the customer has been told exists.
 */
const ADVERTISED_28 = [
  "nominal.lane_keep",
  "nominal.lane_change_left",
  "nominal.lane_change_right",
  "nominal.overtake_left",
  "nominal.turn_left",
  "nominal.turn_right",
  "nominal.stop.lead_brake",
  "control.stop_sign",
  "control.yield_sign",
  "control.traffic_light_stop",
  "control.uncontrolled_junction",
  "highway.lane_keep",
  "highway.lane_change_left",
  "highway.lane_change_right",
  "highway.entry",
  "highway.exit",
  "conflict.pedestrian.adult.visible",
  "conflict.pedestrian.adult.occluded",
  "conflict.pedestrian.child.occluded",
  "conflict.turn_left.pedestrian",
  "conflict.turn_right.pedestrian",
  "conflict.turn_left.car",
  "conflict.turn_left.motorcycle",
  "conflict.turn_left.bicycle",
  "conflict.turn_right.bicycle",
  "conflict.turn_right.car",
  "conflict.turn_right.motorcycle",
  "conflict.bicycle_merge",
];

describe("catalog shape", () => {
  it("keeps every advertised category live", () => {
    for (const id of ADVERTISED_28) {
      const entry = categoryById(id);
      expect(entry, `${id} missing from the catalog`).toBeDefined();
      expect(entry?.status, `${id} must stay live`).toBe("live");
    }
    expect(ADVERTISED_28).toHaveLength(28);
  });

  it("adds exactly the two newly named live categories", () => {
    const extra = LIVE_CATEGORIES.map((c) => c.id).filter(
      (id) => !ADVERTISED_28.includes(id),
    );
    expect(extra.sort()).toEqual([
      "nominal.overtake_right",
      "nominal.stop.vru_yield",
    ]);
    expect(LIVE_CATEGORIES).toHaveLength(30);
  });

  it("records the three unreachable stop variants as reserved", () => {
    expect(RESERVED_CATEGORIES.map((c) => c.id).sort()).toEqual([
      "reserved.stop.junction_proceed",
      "reserved.stop.queue_at_junction",
      "reserved.stop.stop_sign",
    ]);
    for (const entry of RESERVED_CATEGORIES) {
      expect(entry.status).toBe("reserved");
      expect(entry.reservedReason, `${entry.id} needs a reason`).toBeTruthy();
    }
  });

  it("has no duplicate ids", () => {
    const ids = ALL_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never collides a reserved id with a live one", () => {
    // Specifically: the reserved composite `stop_sign` variant must not reuse
    // control.stop_sign, which is the separate stop_at_stop_sign strategy.
    const live = new Set(LIVE_CATEGORIES.map((c) => c.id));
    for (const entry of RESERVED_CATEGORIES) {
      expect(live.has(entry.id)).toBe(false);
    }
    expect(categoryById("control.stop_sign")?.status).toBe("live");
    expect(categoryById("reserved.stop.stop_sign")?.status).toBe("reserved");
  });

  it("stamps a version", () => {
    expect(SCENARIO_CATALOG_VERSION).toBe("simforge.scenario-catalog.v1");
  });
});

describe("nominal resolution", () => {
  it("resolves every one-to-one strategy", () => {
    const cases: Array<[string, string]> = [
      ["lane_keep", "nominal.lane_keep"],
      ["lane_change_left", "nominal.lane_change_left"],
      ["lane_change_right", "nominal.lane_change_right"],
      ["overtake_left", "nominal.overtake_left"],
      ["overtake_right", "nominal.overtake_right"],
      ["turn_left", "nominal.turn_left"],
      ["turn_right", "nominal.turn_right"],
      ["stop_at_stop_sign", "control.stop_sign"],
      ["stop_at_yield_sign", "control.yield_sign"],
      ["stop_at_traffic_light", "control.traffic_light_stop"],
      ["stop_at_uncontrolled", "control.uncontrolled_junction"],
      ["highway_lane_keep", "highway.lane_keep"],
      ["highway_lane_change_left", "highway.lane_change_left"],
      ["highway_lane_change_right", "highway.lane_change_right"],
      ["highway_entry", "highway.entry"],
      ["highway_exit", "highway.exit"],
    ];
    for (const [strategy, id] of cases) {
      const got = resolveCategory({ kind: "nominal", strategy });
      expect(got.ok, `${strategy} failed to resolve`).toBe(true);
      if (got.ok) expect(got.entry.id).toBe(id);
    }
  });

  it("resolves the two live stop causes", () => {
    const lead = resolveCategory({
      kind: "nominal",
      strategy: "stop",
      stopVariant: "lead_brake",
    });
    expect(lead.ok && lead.entry.id).toBe("nominal.stop.lead_brake");

    // 35% of stop scenes. Regressing this fails a third of them closed.
    const vru = resolveCategory({
      kind: "nominal",
      strategy: "stop",
      stopVariant: "vru_yield",
    });
    expect(vru.ok && vru.entry.id).toBe("nominal.stop.vru_yield");
    // Canonical id stays nominal.*; the browsing facet is VRU.
    expect(vru.ok && vru.entry.group).toBe("VRU");
  });

  it("rejects unreachable stop variants as reserved, not unmapped", () => {
    for (const variant of [
      "junction_proceed",
      "queue_at_junction",
      "stop_sign",
    ]) {
      const got = resolveCategory({
        kind: "nominal",
        strategy: "stop",
        stopVariant: variant,
      });
      expect(got.ok).toBe(false);
      if (!got.ok) {
        expect(got.reason, `${variant} should be reserved`).toBe(
          "category_reserved",
        );
        expect(got.reason === "category_reserved" && got.id).toBe(
          `reserved.stop.${variant}`,
        );
      }
    }
  });

  it("requires a stopVariant for the composite stop strategy", () => {
    const got = resolveCategory({ kind: "nominal", strategy: "stop" });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe("category_unmapped");
  });

  it("fails closed on an unknown strategy", () => {
    const got = resolveCategory({ kind: "nominal", strategy: "teleport" });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe("category_unmapped");
  });
});

describe("conflict resolution", () => {
  it("splits pedestrian_crossing by profile and occlusion", () => {
    const visible = resolveCategory({
      kind: "conflict",
      family: "pedestrian_crossing",
      walkerProfile: "adult",
      requireOccluder: false,
    });
    expect(visible.ok && visible.entry.id).toBe(
      "conflict.pedestrian.adult.visible",
    );

    const occluded = resolveCategory({
      kind: "conflict",
      family: "pedestrian_crossing",
      walkerProfile: "adult",
      requireOccluder: true,
    });
    expect(occluded.ok && occluded.entry.id).toBe(
      "conflict.pedestrian.adult.occluded",
    );

    const child = resolveCategory({
      kind: "conflict",
      family: "pedestrian_crossing",
      walkerProfile: "child",
      requireOccluder: true,
    });
    expect(child.ok && child.entry.id).toBe("conflict.pedestrian.child.occluded");
  });

  it("does not alias a visible child onto the occluded child", () => {
    // The occlusion IS the child family's test case (Euro NCAP CPNCO), so a
    // visible child must be named before it can ship, not folded in silently.
    const got = resolveCategory({
      kind: "conflict",
      family: "pedestrian_crossing",
      walkerProfile: "child",
      requireOccluder: false,
    });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe("category_unmapped");
  });

  it("splits turn conflicts by participant type", () => {
    const cases: Array<[string, string, string]> = [
      ["unprotected_left_turn", "car", "conflict.turn_left.car"],
      ["unprotected_left_turn", "motorcycle", "conflict.turn_left.motorcycle"],
      ["unprotected_left_turn", "bicycle", "conflict.turn_left.bicycle"],
      ["right_turn_hook", "car", "conflict.turn_right.car"],
      ["right_turn_hook", "motorcycle", "conflict.turn_right.motorcycle"],
      ["right_turn_hook", "bicycle", "conflict.turn_right.bicycle"],
    ];
    for (const [family, participant, id] of cases) {
      const got = resolveCategory({
        kind: "conflict",
        family,
        npcVehicleType: participant as "car" | "bicycle" | "motorcycle",
      });
      expect(got.ok, `${family}/${participant} failed`).toBe(true);
      if (got.ok) expect(got.entry.id).toBe(id);
    }
  });

  it("defaults an omitted participant type to car, as the generator does", () => {
    // ~40% of real left-turn and right-hook scenes omit npcVehicleType and are
    // ordinary car conflicts. Rejecting them would drop them from the catalog.
    const left = resolveCategory({
      kind: "conflict",
      family: "unprotected_left_turn",
    });
    expect(left.ok && left.entry.id).toBe("conflict.turn_left.car");

    const right = resolveCategory({ kind: "conflict", family: "right_turn_hook" });
    expect(right.ok && right.entry.id).toBe("conflict.turn_right.car");
  });

  it("resolves the crosswalk and merge families", () => {
    expect(
      resolveCategory({ kind: "conflict", family: "left_turn_ped_crosswalk" }),
    ).toMatchObject({ ok: true });
    expect(
      resolveCategory({ kind: "conflict", family: "right_turn_ped_crosswalk" }),
    ).toMatchObject({ ok: true });
    expect(
      resolveCategory({ kind: "conflict", family: "bicycle_merge" }),
    ).toMatchObject({ ok: true });
  });

  it("fails closed on an unknown family", () => {
    const got = resolveCategory({ kind: "conflict", family: "rear_end" });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe("category_unmapped");
  });
});
