/**
 * OpenSCENARIO fidelity checks: does an actor compile to the writer-supported
 * subset, and does the emitted `.xosc` round-trip back to the same
 * worker-effective motion? These are the checks that make "OSC is identical to
 * our scenario format" observable per-actor in the post-run checklist.
 *
 * The caller compiles the draft with the in-house writer (`compileDraftToXosc`,
 * apps/web) and passes the source actors + emitted XML here; this module owns
 * the parse-back and comparison so it stays in `@simforge/studio-shared`.
 */
import { computeEffectiveMotion, diffEffectiveMotion, type EffectiveMotionActorInput } from "../xosc/effective-motion";
import { parseXoscToActors } from "../xosc/importer";
import type { ScenarioCheck } from "./types";

/** Placement modes the in-house OSC 1.0 writer can currently emit. */
export const OSC_SUPPORTED_PLACEMENT_MODES = ["path", "timed_path", "point"] as const;

export type OscCheckSourceActor = { id: string; label?: string } & EffectiveMotionActorInput;

export interface OscRoundTripOptions {
  /** Tolerances forwarded to diffEffectiveMotion. */
  positionTolerance?: number;
  scalarTolerance?: number;
}

/**
 * Compare each source actor's worker-effective motion against the motion
 * recovered from the emitted `.xosc`. Emits, per actor:
 *   - osc.placement_supported (fail if the writer cannot represent the mode)
 *   - osc.round_trip (fail if the parsed-back motion diverges)
 */
export function runOscRoundTripChecks(
  sourceActors: OscCheckSourceActor[],
  xml: string,
  options: OscRoundTripOptions = {},
): ScenarioCheck[] {
  const checks: ScenarioCheck[] = [];

  let imported;
  try {
    imported = parseXoscToActors(xml);
  } catch (err) {
    checks.push({
      id: "osc.parse",
      category: "osc",
      status: "fail",
      label: "OSC parse",
      detail: `failed to parse emitted .xosc: ${(err as Error).message}`,
      actorId: null,
      measuredValue: null,
      threshold: null,
    });
    return checks;
  }

  const importedById = new Map(imported.actors.map((a) => [a.id, a]));

  for (const source of sourceActors) {
    const mode = String(source.placement_mode ?? "point");
    const supported = (OSC_SUPPORTED_PLACEMENT_MODES as readonly string[]).includes(mode);
    checks.push({
      id: "osc.placement_supported",
      category: "osc",
      status: supported ? "pass" : "fail",
      label: "Placement supported",
      detail: supported
        ? `placement_mode "${mode}" is representable in OpenSCENARIO 1.0`
        : `placement_mode "${mode}" is NOT representable by the writer — the .xosc would drop this actor's routing`,
      actorId: source.id,
      measuredValue: null,
      threshold: null,
    });
    if (!supported) continue;

    const back = importedById.get(source.id);
    if (!back) {
      checks.push({
        id: "osc.round_trip",
        category: "osc",
        status: "fail",
        label: "OSC round-trip",
        detail: `actor "${source.id}" is absent from the parsed-back .xosc`,
        actorId: source.id,
        measuredValue: null,
        threshold: null,
      });
      continue;
    }

    const diff = diffEffectiveMotion(computeEffectiveMotion(source), computeEffectiveMotion(back), {
      position: options.positionTolerance,
      scalar: options.scalarTolerance,
    });
    checks.push({
      id: "osc.round_trip",
      category: "osc",
      status: diff.equal ? "pass" : "fail",
      label: "OSC round-trip",
      detail: diff.equal
        ? `draft -> .xosc -> job_spec preserves effective motion (byte-faithful behavior in CARLA)`
        : `effective motion diverged after round-trip: ${diff.reasons.join("; ")}`,
      actorId: source.id,
      measuredValue: diff.reasons.length,
      threshold: 0,
    });
  }

  return checks;
}
