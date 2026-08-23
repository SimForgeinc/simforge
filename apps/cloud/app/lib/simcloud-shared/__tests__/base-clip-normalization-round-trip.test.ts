/**
 * Normalization may not emit a draft its own schema rejects.
 *
 * This is the invariant whose absence cost an actor. The load path parses first
 * and normalizes second (`draft-normalization.ts`), and the parse DROPS what it
 * cannot read. So the moment normalization started stamping `role: "interaction"`
 * on a clip the schema refuses in the interaction layer, every draft it had
 * already written became one actor short on its next open — and the next save
 * wrote that deletion to the database.
 *
 * Measured 2026-07-29 on dev: `[eval] S02`
 * (`68b1d66e-c43f-4c3b-9f29-446f4443b2ea`) persisted with `["ego"]` where it had
 * been authored with two cars, some `[eval] S02*` rows down to zero actors, and
 * 125 drafts across the workspace carrying the same shape.
 *
 * Three lines of assertion, run over every actor the product has ever been asked
 * to author. It would have failed the day `591de6b19` landed.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { normalizeActorBaseClip } from "../behavior-base-clip";
import { ActorBehaviorProgramSchema } from "../scenario-behavior";
import { ScenarioEditorActorDraftSchema } from "../scenario-editor";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const CASE_ROOTS = [
  "scripts/agent/scenario-eval/cases",
  "scripts/agent/scenario-eval/cases-stress",
  "scripts/agent/scenario-eval/cases-m4",
  "scripts/agent/scenario-eval/cases-calibration",
];

function corpusActors(): Array<{ where: string; actor: unknown }> {
  const found: Array<{ where: string; actor: unknown }> = [];
  for (const root of CASE_ROOTS) {
    const dir = path.join(repoRoot, root);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((file) => file.endsWith(".json"))) {
      const scenario = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as {
        id?: string;
        draft?: { actors?: unknown[] };
      };
      for (const actor of scenario.draft?.actors ?? []) {
        found.push({ where: `${scenario.id ?? name}:${(actor as { id?: string }).id}`, actor });
      }
    }
  }
  return found;
}

/**
 * The shape that caused it, stated directly so the invariant is pinned even if
 * the corpus is one day re-authored past it: a path actor holding at t=0 and
 * released onto its path by a later clip.
 */
const REGRESSION_ACTOR = {
  id: "runner",
  kind: "vehicle",
  role: "traffic",
  label: "Impaired red-light runner",
  blueprint: "vehicle.dodge.charger",
  placement_mode: "path",
  speed_kph: 30,
  spawn: { road_id: "", s_fraction: 0.5, world_anchor: { x: 0, y: 0, z: 0, yaw: 0 } },
  spawn_point: { x: 0, y: 0 },
  spawn_yaw: 0,
  path_placement: [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
  ],
  timed_waypoints: [
    { x: 0, y: 0, time: 0 },
    { x: 40, y: 0, time: 5 },
  ],
  behavior: {
    schema_version: "simforge.actor-behavior.v1",
    conflict_policy: "overwrite",
    clips: [
      {
        id: "wait",
        enabled: true,
        trigger: { kind: "at_time", t: 0 },
        end: { kind: "duration", seconds: 3 },
        action: { kind: "hold" },
      },
      {
        id: "run",
        enabled: true,
        trigger: { kind: "after_clip", clip_id: "wait" },
        end: { kind: "completion" },
        action: {
          kind: "follow_path",
          waypoints: [
            { x: 0, y: 0 },
            { x: 40, y: 0 },
          ],
        },
      },
    ],
  },
};

describe("normalization emits drafts the schema accepts", () => {
  it("holds for every actor in the eval corpus", () => {
    const actors = corpusActors();
    expect(actors.length).toBeGreaterThan(300);

    const illegal: string[] = [];
    for (const { where, actor } of actors) {
      const parsed = ScenarioEditorActorDraftSchema.parse(actor);
      const normalized = normalizeActorBaseClip(parsed);
      const reparsed = ScenarioEditorActorDraftSchema.safeParse(normalized);
      if (!reparsed.success) {
        illegal.push(`${where}: ${reparsed.error.issues[0]?.message}`);
      }
    }
    expect(illegal).toEqual([]);
  });

  it("holds for the shape that lost the car", () => {
    const parsed = ScenarioEditorActorDraftSchema.parse(REGRESSION_ACTOR);
    const normalized = normalizeActorBaseClip(parsed);
    expect(ScenarioEditorActorDraftSchema.safeParse(normalized).success).toBe(true);
    expect(ActorBehaviorProgramSchema.safeParse(normalized.behavior).success).toBe(true);
  });

  it("keeps the clip id when it rewrites the route action, so chains still resolve", () => {
    const normalized = normalizeActorBaseClip(
      ScenarioEditorActorDraftSchema.parse(REGRESSION_ACTOR),
    );
    const clips = normalized.behavior!.clips;
    expect(clips.map((clip) => clip.id)).toEqual(["wait", "run"]);
    // The baseline is the path (the actor is path-placed, so its baseline is
    // recompiled from its geometry); the release clip becomes the speed command
    // it always was.
    expect(clips[0]!.role).toBe("base");
    expect(clips[0]!.action.kind).toBe("follow_path");
    expect(clips[1]!.role).toBe("interaction");
    expect(clips[1]!.action).toEqual({ kind: "cruise", speed_kph: 30 });
  });

  it("is still idempotent", () => {
    const once = normalizeActorBaseClip(
      ScenarioEditorActorDraftSchema.parse(REGRESSION_ACTOR),
    );
    expect(normalizeActorBaseClip(once)).toEqual(once);
  });
});
