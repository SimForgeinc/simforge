import { describe, it, expect } from "vitest";
import {
  COLLISION_FAMILY_IDS,
  COLLISION_TEMPLATES,
  CONTACT_FAMILY_IDS,
  FAMILY_ESMINI_OUTCOME,
  FAMILY_EVENT_PRIOR,
  NEAR_MISS_FAMILY_IDS,
  SCENARIO_TIMING,
  applyAggressivenessToSpeedKph,
  isNearMissFamily,
  parseAggressivenessLabel,
} from "../index";
import {
  DEFAULT_CONTACT_GRACE_M,
  DEFAULT_NEAR_MISS_MAX_M,
} from "../esmini-state-log";
import { ScenarioEditorTimelineActionSchema } from "../scenario-editor";

describe("collision template catalog", () => {
  it("declares one template per family id", () => {
    for (const id of COLLISION_FAMILY_IDS) {
      const template = COLLISION_TEMPLATES[id];
      expect(template, `missing template for family '${id}'`).toBeDefined();
      expect(template.id).toBe(id);
      expect(template.label.length).toBeGreaterThan(0);
      expect(template.promptCue.length).toBeGreaterThan(0);
    }
  });

  it("includes an subject actor in every recipe", () => {
    for (const id of COLLISION_FAMILY_IDS) {
      const recipe = COLLISION_TEMPLATES[id].actorRecipe;
      const subjects = recipe.filter((r) => r.role === "subject");
      expect(subjects, `family '${id}' must declare exactly one subject role`).toHaveLength(1);
      const subject = subjects[0]!;
      expect(subject.scenarioRole).toBe("subject");
      expect(subject.kind).toBe("vehicle");
    }
  });

  it("declares at least one conflicting NPC role beyond subject", () => {
    for (const id of COLLISION_FAMILY_IDS) {
      const recipe = COLLISION_TEMPLATES[id].actorRecipe;
      const npcs = recipe.filter((r) => r.role !== "subject");
      expect(
        npcs.length,
        `family '${id}' has no conflicting NPC role — a collision scenario needs at least one`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("uses only actions from the editor's timeline-action enum", () => {
    for (const id of COLLISION_FAMILY_IDS) {
      const recipe = COLLISION_TEMPLATES[id].actorRecipe;
      for (const role of recipe) {
        for (const clip of role.timeline) {
          const parsed = ScenarioEditorTimelineActionSchema.safeParse(clip.action);
          expect(
            parsed.success,
            `family '${id}' role '${role.role}' uses unknown timeline action '${clip.action}'`,
          ).toBe(true);
        }
      }
    }
  });

  it("orders timeline clips by start_time and keeps them within the family duration", () => {
    for (const id of COLLISION_FAMILY_IDS) {
      const template = COLLISION_TEMPLATES[id];
      for (const role of template.actorRecipe) {
        for (let i = 1; i < role.timeline.length; i++) {
          expect(
            role.timeline[i]!.start_time,
            `family '${id}' role '${role.role}' clip ${i} starts before clip ${i - 1}`,
          ).toBeGreaterThanOrEqual(role.timeline[i - 1]!.start_time);
        }
        for (const clip of role.timeline) {
          if (clip.end_time != null) {
            expect(clip.end_time).toBeLessThanOrEqual(template.durationSeconds);
            expect(clip.end_time).toBeGreaterThanOrEqual(clip.start_time);
          }
        }
      }
    }
  });

  it("uses central authored scenario duration for full-length collision templates", () => {
    for (const template of Object.values(COLLISION_TEMPLATES)) {
      expect(template.durationSeconds).toBe(SCENARIO_TIMING.defaultDurationSeconds);
      const endTimes: number[] = [];
      for (const role of template.actorRecipe) {
        for (const clip of role.timeline) {
          if (clip.end_time != null) endTimes.push(clip.end_time);
        }
      }
      expect(Math.max(...endTimes)).toBe(SCENARIO_TIMING.defaultDurationSeconds);
    }
  });
});

describe("family outcome map", () => {
  it("declares an esmini outcome for every family, and nothing else", () => {
    expect(Object.keys(FAMILY_ESMINI_OUTCOME).sort()).toEqual(
      [...COLLISION_FAMILY_IDS].sort(),
    );
  });

  it("declares an event prior for every family, and nothing else", () => {
    expect(Object.keys(FAMILY_EVENT_PRIOR).sort()).toEqual(
      [...COLLISION_FAMILY_IDS].sort(),
    );
    for (const id of COLLISION_FAMILY_IDS) {
      const prior = FAMILY_EVENT_PRIOR[id];
      expect(prior.modalActorCount, `family '${id}' prior`).toBeGreaterThanOrEqual(2);
      expect(prior.n, `family '${id}' prior`).toBeGreaterThan(0);
      expect(prior.modalActorCountShare).toBeGreaterThan(0);
      expect(prior.modalActorCountShare).toBeLessThanOrEqual(1);
    }
  });

  it("partitions the catalog into contact and near-miss families", () => {
    expect([...COLLISION_FAMILY_IDS].sort()).toEqual(
      [...CONTACT_FAMILY_IDS, ...NEAR_MISS_FAMILY_IDS].sort(),
    );
    const overlap = (CONTACT_FAMILY_IDS as readonly string[]).filter((id) =>
      (NEAR_MISS_FAMILY_IDS as readonly string[]).includes(id),
    );
    expect(overlap).toEqual([]);
  });

  it("maps contact families to 'collision' and near-miss families to 'near_miss'", () => {
    for (const id of CONTACT_FAMILY_IDS) {
      expect(FAMILY_ESMINI_OUTCOME[id], `family '${id}'`).toBe("collision");
      expect(isNearMissFamily(id)).toBe(false);
    }
    for (const id of NEAR_MISS_FAMILY_IDS) {
      expect(FAMILY_ESMINI_OUTCOME[id], `family '${id}'`).toBe("near_miss");
      expect(isNearMissFamily(id)).toBe(true);
    }
  });

  it("keeps the six crash-corpus families as contact families", () => {
    // Regression guard: near-miss additions must not re-grade an existing
    // family. Any change here re-grades already-generated scenarios.
    expect([...CONTACT_FAMILY_IDS]).toEqual([
      "unprotected_left_turn",
      "unsafe_cut_in",
      "pedestrian_crossing",
      "rear_end",
      "sideswipe",
      "right_turn_hook",
    ]);
  });
});

describe("near-miss families", () => {
  it("authors at least two near-miss families", () => {
    expect(NEAR_MISS_FAMILY_IDS.length).toBeGreaterThanOrEqual(2);
  });

  it("carries a near-miss margin on exactly the near-miss families", () => {
    for (const id of COLLISION_FAMILY_IDS) {
      const template = COLLISION_TEMPLATES[id];
      expect(
        template.nearMissMargin !== undefined,
        `family '${id}' margin presence must match its graded outcome`,
      ).toBe(isNearMissFamily(id));
    }
  });

  it("targets a miss the esmini grader scores as a near miss, not a graze", () => {
    for (const id of NEAR_MISS_FAMILY_IDS) {
      const margin = COLLISION_TEMPLATES[id].nearMissMargin!;
      // Below the contact grace the grader calls it a grazing contact, which
      // FAILS a near_miss intent; above the near-miss max the actors never
      // really conflicted and the scenario is degenerate.
      expect(margin.targetMissDistanceM, `family '${id}'`).toBeGreaterThan(
        DEFAULT_CONTACT_GRACE_M,
      );
      expect(margin.targetMissDistanceM).toBeLessThanOrEqual(margin.maxMissDistanceM);
      expect(margin.maxMissDistanceM).toBeLessThanOrEqual(DEFAULT_NEAR_MISS_MAX_M);
    }
  });

  it("solves the planner lead time to a gap inside the graded band", () => {
    for (const id of NEAR_MISS_FAMILY_IDS) {
      const template = COLLISION_TEMPLATES[id];
      const margin = template.nearMissMargin!;
      const subject = template.actorRecipe.find((r) => r.role === "subject")!;
      const plannedGapM = (margin.conflictLeadTimeS * subject.baseSpeedKph) / 3.6;
      expect(
        plannedGapM,
        `family '${id}': ${margin.conflictLeadTimeS}s lead at ${subject.baseSpeedKph}kph is a ${plannedGapM.toFixed(2)}m gap`,
      ).toBeGreaterThanOrEqual(margin.targetMissDistanceM);
      expect(plannedGapM).toBeLessThanOrEqual(margin.maxMissDistanceM);
    }
  });

  it("never plants a ram — the converging clip holds a standoff instead", () => {
    for (const id of NEAR_MISS_FAMILY_IDS) {
      const template = COLLISION_TEMPLATES[id];
      const margin = template.nearMissMargin!;
      const pursuitClips = template.actorRecipe.flatMap((role) =>
        role.timeline.filter((clip) => clip.target_role != null),
      );
      for (const clip of pursuitClips) {
        expect(
          clip.action,
          `family '${id}' targets another actor with '${clip.action}' — ram_actor pins the standoff to zero and always contacts`,
        ).not.toBe("ram_actor");
        expect(
          clip.following_distance_m,
          `family '${id}' pursuit clip must hold the target miss distance`,
        ).toBe(margin.targetMissDistanceM);
      }
    }
  });

  it("brackets the planned conflict time with the pursuit window", () => {
    for (const id of NEAR_MISS_FAMILY_IDS) {
      const template = COLLISION_TEMPLATES[id];
      const window = template.collisionTimeWindow;
      expect(window, `family '${id}' must declare a conflict window`).toBeDefined();
      expect(window!.min).toBeLessThanOrEqual(window!.ideal);
      expect(window!.ideal).toBeLessThanOrEqual(window!.max);
      expect(window!.max).toBeLessThanOrEqual(template.durationSeconds);
      // Closest approach can only happen while a pursuit clip is running, so
      // any family that has one must run it across the planned conflict time.
      for (const role of template.actorRecipe) {
        for (const clip of role.timeline) {
          if (clip.target_role == null) continue;
          expect(clip.start_time).toBeLessThanOrEqual(window!.ideal);
          expect(clip.end_time ?? template.durationSeconds).toBeGreaterThanOrEqual(
            window!.ideal,
          );
        }
      }
    }
  });

  it("leaves contact families free of near-miss timing fields", () => {
    for (const id of CONTACT_FAMILY_IDS) {
      const template = COLLISION_TEMPLATES[id];
      expect(template.nearMissMargin, `family '${id}'`).toBeUndefined();
      for (const role of template.actorRecipe) {
        for (const clip of role.timeline) {
          expect(
            clip.following_distance_m,
            `family '${id}' role '${role.role}'`,
          ).toBeUndefined();
        }
      }
    }
  });
});

describe("aggressiveness helpers", () => {
  it("scales target speeds for aggressive and hesitant", () => {
    expect(applyAggressivenessToSpeedKph(60, "aggressive")).toBe(75);
    expect(applyAggressivenessToSpeedKph(60, "hesitant")).toBe(42);
    expect(applyAggressivenessToSpeedKph(60, "steady")).toBe(60);
  });

  it("maps chip labels to canonical slot values", () => {
    expect(parseAggressivenessLabel("Aggressive — speeds up")).toBe("aggressive");
    expect(parseAggressivenessLabel("Steady — forces a tight gap")).toBe("steady");
    expect(parseAggressivenessLabel("Hesitant — late braking")).toBe("hesitant");
    expect(parseAggressivenessLabel("speeds up")).toBe("aggressive");
    expect(parseAggressivenessLabel("late braking")).toBe("hesitant");
    expect(parseAggressivenessLabel(null)).toBe("steady");
    expect(parseAggressivenessLabel("anything else")).toBe("steady");
  });
});
