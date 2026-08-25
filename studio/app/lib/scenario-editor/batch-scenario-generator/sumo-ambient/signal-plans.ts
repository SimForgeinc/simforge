/**
 * The CARLA half of SUMO traffic-control obedience.
 *
 * SUMO ambient is baked into the spec as `timed_path` actors, so its obedience
 * to lights and stop signs is a property of the TRAJECTORY: the reel was
 * simulated on a net that carries the map's traffic control
 * (`scripts/sumo/signal_program.py` patches the stop signs netconvert drops and
 * writes the junction programs out). That makes the ambient stop at the right
 * places — but it does not make CARLA's own lights agree. CARLA would run its
 * map-default cycle, so a baked queue could sit still under a green head.
 *
 * This module closes that loop. It turns the emit-prep artifact into
 * `draft.signal_plans` in `program` mode, which the worker's
 * `SignalPlanExecutor` uses to FREEZE each junction's heads and drive them on
 * exactly the cycle SUMO ran.
 *
 * ## The offset is the whole trick
 *
 * SUMO ran the cycle from reel time 0; a clip is cut at reel time `windowT0S`;
 * the render's clock starts at 0. So CARLA has to ENTER the cycle where SUMO
 * was when the window opened — `offset_s = (windowT0S + netOffset) % cycle`,
 * matching `phase_index_at`'s `(sim_time + offset) % total`. Verified against a
 * live SUMO run over 7 window offsets × 4 junctions: 287/287 movement states
 * matched (2026-08-06, Yale).
 *
 * Movement ids are the repo's canonical `"<road>.<section>.<side>:<turn>"`
 * (`scenario-signals.ts`), so the worker's approach-lane fallback binds even
 * where a head could not be resolved to an OpenDRIVE `<signal>` id.
 */

import type { JunctionSignalPlan } from "@simforge/studio-shared";

/** One junction of `signal_program.json`, as written by scripts/sumo/signal_program.py. */
export interface SumoSignalProgramJunction {
  junction_id: string;
  tls_id?: string;
  net_offset_s?: number;
  cycle_duration_s?: number;
  movements: Array<{
    movement_id: string;
    approach_id: string;
    turn: "left" | "right" | "straight" | "uturn";
    label?: string;
    signal_ids?: string[];
    approach_lane_rsls?: string[];
    binding?: string;
  }>;
  cycle: Array<{ duration_s: number; states?: Record<string, string> }>;
}

/** The emit-prep artifact: one program per map, reused by every window. */
export interface SumoSignalProgram {
  schemaVersion?: string;
  junctions: SumoSignalProgramJunction[];
  stopControl?: Array<{ junction_id: string; node_type: string }>;
}

export const SUMO_SIGNAL_PROGRAM_SCHEMA_VERSION = "simforge.sumo-signal-program.v1";
const JUNCTION_SIGNAL_PLAN_SCHEMA_VERSION = "simforge.junction-signal-plan.v1";

/**
 * `draft.signal_plans` for a clip cut at `windowT0S` of the reel.
 *
 * A junction is skipped rather than half-authored when it has no cycle or no
 * movement the worker could bind (no `<signal>` id AND no approach lanes):
 * commanding a junction we cannot resolve would freeze its heads at bind time
 * and leave them stuck, which is worse than the map default.
 */
export function signalPlansForWindow(
  program: SumoSignalProgram | null | undefined,
  windowT0S: number,
): JunctionSignalPlan[] {
  if (!program || !Array.isArray(program.junctions)) return [];
  const plans: JunctionSignalPlan[] = [];
  for (const junction of program.junctions) {
    const cycle = Array.isArray(junction.cycle) ? junction.cycle : [];
    if (cycle.length === 0) continue;
    const movements = (junction.movements ?? []).filter(
      (movement) =>
        (movement.signal_ids?.length ?? 0) > 0 ||
        (movement.approach_lane_rsls?.length ?? 0) > 0,
    );
    if (movements.length === 0) continue;
    const known = new Set(movements.map((movement) => movement.movement_id));
    const cycleDurationS =
      junction.cycle_duration_s ??
      cycle.reduce((total, phase) => total + (Number(phase.duration_s) || 0), 0);
    const netOffsetS = junction.net_offset_s ?? 0;
    const offsetS =
      cycleDurationS > 0
        ? ((((windowT0S + netOffsetS) % cycleDurationS) + cycleDurationS) % cycleDurationS)
        : 0;
    plans.push({
      schema_version: JUNCTION_SIGNAL_PLAN_SCHEMA_VERSION,
      junction_id: String(junction.junction_id),
      mode: "program",
      movements: movements.map((movement) => ({
        movement_id: movement.movement_id,
        approach_id: movement.approach_id,
        turn: movement.turn,
        label: movement.label ?? movement.movement_id,
        approach_lane_rsls: movement.approach_lane_rsls ?? [],
        exit_lane_rsls: [],
        signal_ids: movement.signal_ids ?? [],
        approach_heading_deg: null,
        exit_heading_deg: null,
        conflicts_with: [],
      })),
      program: {
        offset_s: offsetS,
        cycle: cycle
          .filter((phase) => (Number(phase.duration_s) || 0) > 0)
          .map((phase) => ({
            duration_s: Number(phase.duration_s),
            states: Object.fromEntries(
              Object.entries(phase.states ?? {}).filter(([movementId]) => known.has(movementId)),
            ),
          })),
      },
    } as JunctionSignalPlan);
  }
  return plans;
}
