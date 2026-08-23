import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { GateState } from "./manifest";
import type {
  ConflictClassification,
  GeneratorClassification,
  NominalClassification,
} from "../scenario-catalog";

/**
 * Reading an offline run's evidence tree.
 *
 * All knowledge of how the fleet lays out its output lives here, so the bundle
 * builder never walks directories itself and a new run shape is a change to one
 * module rather than to the orchestration.
 */

// ---------------------------------------------------------------------------
// Publication policy
// ---------------------------------------------------------------------------

/**
 * The authoritative publication verdicts, mirroring `PUBLISHABLE_VERDICTS` in
 * `services/carla-worker/carla_worker/review_compose.py`.
 *
 * This list must not drift from the worker's. The compositor already refuses to
 * publish anything outside it, so a bundle that accepted more would ship
 * scenarios whose review video the pipeline itself declined to produce, and a
 * bundle that accepted fewer would silently drop valid intended-collision and
 * edge-case runs. Both failures are invisible until a customer notices.
 *
 * In particular: `collision`, `avoided`, `near_miss`, `valid` and
 * `valid_resume` are NOT publication verdicts. They belong to the contact,
 * maneuver and stop vocabularies, which answer different questions about the
 * same run.
 */
export const PUBLISHABLE_VERDICTS: ReadonlySet<string> = new Set([
  "intended_collision",
  "edge_case",
  "clean_miss",
]);

// ---------------------------------------------------------------------------
// Run tree
// ---------------------------------------------------------------------------

/** Where each piece of a scene's evidence was found. */
export type SceneSources = {
  sceneId: string;
  map: string;
  family: string;
  /** Under `<run>/_fleet-out-3d-<n>/gpu<n>/<map>__<family>__<sceneId>`. */
  threeDDir: string;
  summaryPath: string;
  runDir: string;
  reviewVideoPath: string | null;
  replayPath: string | null;
  twoDSummaryPath: string | null;
};

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listDirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function readJson(
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Scene directories are named `<map>__<family>__<sceneId>`. The scene id can
 * contain hyphens but not the `__` separator, so splitting on `__` is safe and
 * does not depend on parsing the id itself.
 */
export function parseSceneDirName(
  name: string,
): { map: string; family: string; sceneId: string } | null {
  const parts = name.split("__");
  const map = parts[0];
  const family = parts[1];
  if (parts.length < 3 || map === undefined || family === undefined) return null;
  return { map, family, sceneId: parts.slice(2).join("__") };
}

export async function discoverScenes(
  runRoot: string,
): Promise<Map<string, SceneSources>> {
  const found = new Map<string, SceneSources>();

  const fleetDirs = (await listDirs(runRoot)).filter((d) =>
    d.startsWith("_fleet-out-3d"),
  );

  for (const fleetDir of fleetDirs) {
    const fleetPath = join(runRoot, fleetDir);
    for (const gpuDir of await listDirs(fleetPath)) {
      const gpuPath = join(fleetPath, gpuDir);
      for (const sceneDir of await listDirs(gpuPath)) {
        const parsed = parseSceneDirName(sceneDir);
        if (!parsed) continue;
        const threeDDir = join(gpuPath, sceneDir);
        const summaryPath = join(threeDDir, "summary.json");
        const runDir = join(threeDDir, "run");
        if (!(await exists(summaryPath)) || !(await exists(runDir))) continue;

        // A scene can appear in more than one fleet pass (a re-render); the
        // later pass supersedes, and directory listing order is stable.
        found.set(parsed.sceneId, {
          sceneId: parsed.sceneId,
          map: parsed.map,
          family: parsed.family,
          threeDDir,
          summaryPath,
          runDir,
          reviewVideoPath: null,
          replayPath: null,
          twoDSummaryPath: null,
        });
      }
    }
  }

  // The composed review video has been written under two different names
  // across runs — bare `<sceneId>.mp4` and family-prefixed
  // `<family>__<sceneId>.mp4` — and a run can be recomposed from one to the
  // other in place. Resolving only one form reports every scene as
  // compose-missing, which fails closed but presents as a broken batch rather
  // than a naming mismatch. Read the directory once and try both.
  const reviewDir = join(runRoot, "videos-review");
  const reviewFiles = new Set(
    (await readdir(reviewDir).catch(() => [] as string[])).filter((f) =>
      f.endsWith(".mp4"),
    ),
  );

  for (const scene of found.values()) {
    for (const name of [
      `${scene.family}__${scene.sceneId}.mp4`,
      `${scene.sceneId}.mp4`,
    ]) {
      if (reviewFiles.has(name)) {
        scene.reviewVideoPath = join(reviewDir, name);
        break;
      }
    }

    const replay = join(
      runRoot,
      scene.map,
      scene.family,
      `${scene.sceneId}.replay.json`,
    );
    if (await exists(replay)) scene.replayPath = replay;

    const twoD = join(
      runRoot,
      "_2d-work",
      scene.map,
      scene.family,
      "runs",
      scene.sceneId,
      "summary.json",
    );
    if (await exists(twoD)) scene.twoDSummaryPath = twoD;
  }

  return found;
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/**
 * Read the authoritative outcome from a run summary.
 *
 * The verdict lives at `sceneOutcome.verdict`. There is NO top-level `verdict`
 * key, so a reader that looks for one gets `undefined` and — if it treats
 * undefined as "not failed" — passes every scene including the broken ones.
 * A missing verdict is therefore an explicit error here, never a pass.
 */
export function readVerdict(summary: Record<string, unknown>): {
  verdict: string | null;
  terminalStatus: string | null;
} {
  const sceneOutcome = asRecord(summary.sceneOutcome);
  const verdict =
    sceneOutcome && typeof sceneOutcome.verdict === "string"
      ? sceneOutcome.verdict
      : null;
  const terminalStatus =
    typeof summary.terminalStatus === "string" ? summary.terminalStatus : null;
  return { verdict, terminalStatus };
}

export function gateFromSummary(summary: Record<string, unknown> | null): {
  state: GateState;
  verdict: string | null;
} {
  if (!summary) return { state: "missing", verdict: null };
  const { verdict, terminalStatus } = readVerdict(summary);
  if (!verdict) return { state: "missing", verdict: null };
  if (terminalStatus && terminalStatus !== "succeeded") {
    return { state: "fail", verdict };
  }
  return {
    state: PUBLISHABLE_VERDICTS.has(verdict) ? "pass" : "fail",
    verdict,
  };
}

/**
 * The CoT self-gate, matching `_cot_passed_its_gate` in the worker's
 * `review_compose.py`: a document passes only when it records `self_gate.ok
 * === true`.
 *
 * An ABSENT self_gate block is not a pass. Documents without one predate the
 * gate and are explicitly not trusted — the generator used to write the
 * document before checking it, so an ungated file may be exactly the failed
 * narration the gate exists to catch. Treating absence as success would
 * package that as customer-facing reasoning evidence.
 */
export function cotGateState(cot: Record<string, unknown> | null): GateState {
  if (!cot) return "missing";
  if (cot.schema !== "simforge.cot.v1") return "fail";
  const segments = Array.isArray(cot.segments) ? cot.segments : [];
  if (segments.length === 0) return "fail";
  const gate = asRecord(cot.self_gate);
  if (!gate) return "missing";
  return gate.ok === true ? "pass" : "fail";
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Build the generator classification from the replay sidecar, the only artifact
 * that records what was ASKED for (family plus the dimensions that split it
 * into categories). Directory names cannot be used: `pedavoid` covers adult and
 * child, occluded and visible.
 */
export function classificationFrom(
  replay: Record<string, unknown> | null,
  cot: Record<string, unknown> | null,
): GeneratorClassification | null {
  const request = replay ? asRecord(replay.request) : null;
  const family =
    (typeof replay?.emittedFamily === "string" ? replay.emittedFamily : null) ??
    (typeof request?.scenarioFamily === "string"
      ? request.scenarioFamily
      : null) ??
    (typeof cot?.family === "string" ? cot.family : null);

  if (!family) return null;

  // Nominal batches record a strategy; conflict batches record a family.
  const strategy =
    typeof request?.strategy === "string"
      ? request.strategy
      : typeof replay?.strategy === "string"
        ? replay.strategy
        : null;

  if (strategy) {
    const stopVariant =
      typeof request?.stopVariant === "string"
        ? request.stopVariant
        : typeof replay?.stopVariant === "string"
          ? replay.stopVariant
          : null;
    return {
      kind: "nominal",
      strategy,
      stopVariant,
    } satisfies NominalClassification;
  }

  const npc = request?.npcVehicleType;
  const walker = request?.walkerProfile;
  return {
    kind: "conflict",
    family,
    npcVehicleType:
      npc === "car" || npc === "bicycle" || npc === "motorcycle" ? npc : null,
    walkerProfile: walker === "adult" || walker === "child" ? walker : null,
    requireOccluder:
      typeof request?.requireOccluder === "boolean"
        ? request.requireOccluder
        : null,
  } satisfies ConflictClassification;
}

/** Raw generator dimensions, kept so a later taxonomy can re-derive categories. */
export function dimensionsFrom(
  classification: GeneratorClassification,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (classification.kind === "nominal") {
    if (classification.stopVariant) out.stopVariant = classification.stopVariant;
    return out;
  }
  if (classification.npcVehicleType) {
    out.npcVehicleType = classification.npcVehicleType;
  }
  if (classification.walkerProfile) {
    out.walkerProfile = classification.walkerProfile;
  }
  if (typeof classification.requireOccluder === "boolean") {
    out.requireOccluder = classification.requireOccluder;
  }
  return out;
}
