/**
 * Signal programs: a repeating phase timeline per signal id, plus the stop-line
 * arc lengths it controls.
 *
 * The engine does not read signal geometry from the map — `signalPrograms` on
 * `SimScenarioInput` carries everything, so an adapter can bind a template's
 * `signal:*` references to whatever the site actually has (or synthesise a
 * program for an unsignalised study).
 *
 * The timeline starts at `t = -warmupSeconds + offsetS`, so a program is
 * already mid-cycle when the recorded clip begins — actors never see an
 * unnaturally fresh cycle at `t = 0`.
 */

import { angleDelta } from '../core/math.js';
import type { LaneGraph } from '../map/lane-graph.js';
import { buildLanePathRoute } from '../map/route.js';
import type { LaneRsl } from '../map/topology.js';
import type { ControlIndication, RoadControl, SignalProgram, SimScenarioInput } from '../schema/input.js';

const OVERLAPPING_CONTROL_LANE_TOLERANCE_M = 1.5;
const OVERLAPPING_CONTROL_HEADING_TOLERANCE_RAD = Math.PI / 8;

export interface ControlBindingRepair {
  readonly source: 'signalPrograms' | 'roadControls';
  readonly controlId: string;
  readonly sourceRsl: string;
  readonly routeRsl: string;
  readonly distanceM: number;
}

/** Bind physical controls across coincident, same-direction OpenDRIVE lane identities. */
export function resolveOverlappingControlLanes(
  input: SimScenarioInput,
  graph: LaneGraph,
): { input: SimScenarioInput; repairs: readonly ControlBindingRepair[] } {
  const actorLanePaths = input.actors.flatMap((actor) =>
    actor.behavior.route.kind === 'lanePath' ? [actor.behavior.route.lanes] : []);
  const routeRsls = [...new Set(actorLanePaths.flat())].sort();
  const routeByRsl = new Map(routeRsls.flatMap((rsl) => {
    const built = buildLanePathRoute(graph, [rsl]);
    return built.ok ? [[rsl, built.route] as const] : [];
  }));
  const repairs: ControlBindingRepair[] = [];

  const repairLines = <T extends { rsl: string; s: number; connectingLaneRsls: readonly string[] }>(
    sourceKind: ControlBindingRepair['source'],
    controlId: string,
    lines: readonly T[],
  ): T[] => {
    const repaired = [...lines];
    const keys = new Set(lines.map((line) => `${line.rsl}\0${line.connectingLaneRsls.join('\0')}`));
    for (const line of lines) {
      const sourceGeometry = graph.geometry(line.rsl);
      if (!sourceGeometry) continue;
      const source = graph.sampleStorage(sourceGeometry, line.s);
      const sourceHeading = graph.nominalReversed(line.rsl) ? source.headingRad + Math.PI : source.headingRad;
      for (const routeRsl of routeRsls) {
        if (routeRsl === line.rsl) continue;
        const key = `${routeRsl}\0${line.connectingLaneRsls.join('\0')}`;
        if (keys.has(key)) continue;
        if (line.connectingLaneRsls.length > 0 && !actorLanePaths.some((lanes) =>
          lanes.includes(routeRsl) && line.connectingLaneRsls.some((connector) => lanes.includes(connector)))) continue;
        const route = routeByRsl.get(routeRsl);
        if (!route) continue;
        const projection = route.projectPoint(source.point, 0.5);
        if (projection.d > OVERLAPPING_CONTROL_LANE_TOLERANCE_M) continue;
        const pose = route.poseAt(projection.s);
        if (Math.abs(angleDelta(sourceHeading, pose.headingRad)) > OVERLAPPING_CONTROL_HEADING_TOLERANCE_RAD) continue;
        repaired.push({ ...line, rsl: routeRsl, s: pose.storageS });
        keys.add(key);
        repairs.push({ source: sourceKind, controlId, sourceRsl: line.rsl, routeRsl, distanceM: projection.d });
      }
    }
    return repaired.sort((a, b) => a.rsl.localeCompare(b.rsl) || a.s - b.s) as T[];
  };

  const signalPrograms = input.signalPrograms.map((program) => ({
    ...program,
    stopLines: repairLines('signalPrograms', program.id, program.stopLines),
  }));
  const roadControls = input.roadControls.map((control) => ({
    ...control,
    stopLines: repairLines('roadControls', control.id, control.stopLines),
  }));
  return repairs.length === 0
    ? { input, repairs }
    : { input: { ...input, signalPrograms, roadControls }, repairs };
}

export type SignalPhase = ControlIndication;

/** The law a dark head reverts to when the author has not said otherwise. */
export const DEFAULT_DARK_FALLBACK = 'all_way_stop' as const;
/** Standstill required at a dark or flashing-red line when unspecified, seconds. */
export const DEFAULT_DARK_DWELL_S = 1;
/** Tick rate every tick-denominated {@link SignalSnapshot} field assumes when
 * the caller does not pass an explicit step; matches the env-server's engine Hz. */
export const SIGNAL_SNAPSHOT_TICK_HZ = 50;

/** Observable phase plus the source that currently owns it. Program timing
 * provenance remains on `SignalProgram.mapBinding.timingSource`; `source`
 * distinguishes that cycle from a runtime `set(signal:*.phase)` override. */
export interface SignalState {
  readonly phase: SignalPhase;
  readonly source: 'program' | 'override';
  readonly timingSource: 'map' | 'synthetic-default' | 'authored';
}

/**
 * What law a stop line is executing **right now**.
 *
 * Authority is a function of time, not a property fixed when the book is built.
 * A working signal is `signal` authority: obey the indication, and a forbidding
 * indication means wait for it to change. A *failed* signal is not a weaker
 * version of that — it is the other authority the engine already has,
 * `stop`: come to a complete standstill, dwell, and then be released by the
 * all-way arbitration in the engine. Modelling the failure as a phase inside
 * the first authority is what produced both halves of the signal-authority
 * defect (see `research/edge-case-corpus/tools/vista/newcaps/DEFECT-signal-authority.md`):
 * a dark head that meant "proceed", and a flashing red that deadlocked forever.
 */
export interface StopLineAuthority {
  readonly kind: 'signal' | 'stop' | 'none';
  /** Minimum continuous standstill before release. Meaningful when `kind` is `stop`. */
  readonly dwellS: number;
  /** Why this authority applies, for the trace and for a human reading a failure. */
  readonly reason: 'program' | 'blackout' | 'flashing_red' | 'static_stop' | 'blackout_uncontrolled';
}

/**
 * Public, wire-ready truth about one signal at one instant — everything a
 * consumer outside the engine (scene stream, SPaT encoder, renderer overlay)
 * needs to reproduce the head's behaviour without re-implementing the law.
 *
 * Tick-denominated fields assume the engine's fixed step via `dtS`; they are
 * integers derived from the same arithmetic `stateAt` uses, so a snapshot at
 * the simulation's own dt is exact at phase boundaries.
 */
export interface SignalSnapshot {
  readonly signalId: string;
  /** Physical heads this program drives, sorted (stop-line lanes for legacy inputs without a map binding). */
  readonly headIds: readonly string[];
  /** First OpenDRIVE controller id bound to this program, when known. */
  readonly controllerId: string | null;
  readonly junctionId: string | null;
  readonly phase: SignalPhase;
  /** `program` cycles on the authored timeline; `override` pins an external phase. */
  readonly source: 'program' | 'override';
  readonly timingSource: 'map' | 'synthetic-default' | 'authored';
  /**
   * Engine tick index (t × tickHz, rounded) of the current phase's boundaries,
   * in absolute simulation time. Null when no transition is scheduled from
   * this instant: under an override, or while a non-looping program is held on
   * its first/last phase outside its authored window.
   */
  readonly phaseStartTick: number | null;
  readonly phaseEndTick: number | null;
  readonly remainingTicks: number | null;
  readonly nextPhase: SignalPhase | null;
  readonly cycleLengthTicks: number | null;
  /** Present only while the head is dark (`off`) or flashing red. */
  readonly failureState?: 'off' | 'flashing-red';
}

const SNAPSHOT_EPS_S = 1e-9;

function failureStateOf(phase: SignalPhase): 'off' | 'flashing-red' | undefined {
  if (phase === 'off') return 'off';
  if (phase === 'flashing_red' || phase === 'flashing_red_arrow') return 'flashing-red';
  return undefined;
}

export interface StopLineBinding {
  readonly controlId: string;
  /** Shared junction arbitration key for static all-way-stop approaches. */
  readonly coordinationId: string;
  readonly kind: 'signal' | 'stop';
  readonly signalId: string | null;
  readonly dwellS: number;
  readonly rsl: LaneRsl;
  /** Arc length in the lane's **storage** direction. */
  readonly s: number;
  /** Empty means every movement; otherwise the route must contain one. */
  readonly connectingLaneRsls: readonly LaneRsl[];
}

export class SignalBook {
  private readonly programs: SignalProgram[];
  private readonly byId = new Map<string, SignalProgram>();
  private readonly cycleLength = new Map<string, number>();
  readonly stopLines: StopLineBinding[] = [];
  private readonly stopLinesByLane = new Map<LaneRsl, StopLineBinding[]>();
  private readonly overrides = new Map<string, SignalPhase>();

  constructor(
    programs: readonly SignalProgram[],
    private readonly warmupSeconds: number,
    roadControls: readonly RoadControl[] = [],
  ) {
    this.programs = [...programs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const p of this.programs) {
      this.byId.set(p.id, p);
      this.cycleLength.set(
        p.id,
        p.phases.reduce((sum, ph) => sum + ph.durationS, 0),
      );
      for (const sl of [...p.stopLines].sort((a, b) => (a.rsl < b.rsl ? -1 : a.rsl > b.rsl ? 1 : a.s - b.s))) {
        const binding: StopLineBinding = {
          controlId: p.id,
          // A junction whose four heads all black out is ONE all-way stop, not
          // four independent ones, so signal-derived lines coordinate on the
          // junction exactly as static stop controls already do.
          coordinationId: p.mapBinding?.junctionId ?? p.id,
          kind: 'signal',
          signalId: p.id,
          dwellS: 0,
          rsl: sl.rsl,
          s: sl.s,
          connectingLaneRsls: [...sl.connectingLaneRsls].sort(),
        };
        this.stopLines.push(binding);
        const arr = this.stopLinesByLane.get(sl.rsl);
        if (arr) arr.push(binding);
        else this.stopLinesByLane.set(sl.rsl, [binding]);
      }
    }
    for (const control of [...roadControls].sort((a, b) => a.id.localeCompare(b.id))) {
      for (const sl of [...control.stopLines].sort((a, b) => (a.rsl < b.rsl ? -1 : a.rsl > b.rsl ? 1 : a.s - b.s))) {
        const binding: StopLineBinding = {
          controlId: control.id,
          coordinationId: control.mapBinding?.junctionId ?? control.id,
          kind: 'stop',
          signalId: null,
          dwellS: control.dwellS,
          rsl: sl.rsl,
          s: sl.s,
          connectingLaneRsls: [...sl.connectingLaneRsls].sort(),
        };
        this.stopLines.push(binding);
        const arr = this.stopLinesByLane.get(sl.rsl);
        if (arr) arr.push(binding);
        else this.stopLinesByLane.set(sl.rsl, [binding]);
      }
    }
  }

  get isEmpty(): boolean {
    return this.stopLines.length === 0 && this.programs.length === 0;
  }

  ids(): string[] {
    return this.programs.map((p) => p.id);
  }

  /** Phase of `signalId` at simulation time `t` (which may be negative). */
  phaseAt(signalId: string, t: number): SignalPhase | null {
    return this.stateAt(signalId, t)?.phase ?? null;
  }

  /** Phase and provenance of `signalId` at simulation time `t`. */
  stateAt(signalId: string, t: number): SignalState | null {
    const forced = this.overrides.get(signalId);
    const p = this.byId.get(signalId);
    if (!p) return null;
    const timingSource = p.mapBinding?.timingSource ?? 'authored';
    if (forced) return { phase: forced, source: 'override', timingSource };
    const cycle = this.cycleLength.get(signalId)!;
    let elapsed = t + this.warmupSeconds + p.offsetS;
    if (p.loop) {
      elapsed = ((elapsed % cycle) + cycle) % cycle;
    } else if (elapsed < 0) {
      return { phase: p.phases[0]!.phase, source: 'program', timingSource };
    } else if (elapsed >= cycle) {
      return { phase: p.phases[p.phases.length - 1]!.phase, source: 'program', timingSource };
    }
    let acc = 0;
    for (const ph of p.phases) {
      acc += ph.durationS;
      if (elapsed < acc) return { phase: ph.phase, source: 'program', timingSource };
    }
    return { phase: p.phases[p.phases.length - 1]!.phase, source: 'program', timingSource };
  }
  /**
   * The full observable snapshot for `signalId` at simulation time `t`
   * (which may be negative), with timing boundaries denominated in engine
   * ticks of `dtS` seconds (default: the 50 Hz engine step).
   *
   * Deterministic and allocation-light per call; derived from exactly the
   * arithmetic {@link stateAt} uses, so the phase can never disagree between
   * the two. An active override reports the forced phase with all scheduled
   * boundaries null — the program timeline is suspended, not shifted.
   */
  snapshotAt(signalId: string, t: number, dtS = 1 / SIGNAL_SNAPSHOT_TICK_HZ): SignalSnapshot | null {
    const p = this.byId.get(signalId);
    if (!p) return null;
    const hz = 1 / dtS;
    const cycleS = this.cycleLength.get(signalId)!;
    const headIds = p.mapBinding
      ? [...p.mapBinding.headIds].sort()
      : [...new Set(p.stopLines.map((sl) => sl.rsl))].sort();
    const base = {
      signalId,
      headIds,
      controllerId: p.mapBinding && p.mapBinding.controllerIds.length > 0 ? p.mapBinding.controllerIds[0]! : null,
      junctionId: p.mapBinding?.junctionId ?? null,
      timingSource: p.mapBinding?.timingSource ?? ('authored' as const),
      cycleLengthTicks: Math.round(cycleS * hz),
    };

    const forced = this.overrides.get(signalId);
    if (forced !== undefined) {
      return {
        ...base,
        phase: forced,
        source: 'override',
        phaseStartTick: null,
        phaseEndTick: null,
        remainingTicks: null,
        nextPhase: null,
        ...(failureStateOf(forced) !== undefined ? { failureState: failureStateOf(forced) } : {}),
      };
    }

    // Locate the phase containing `t` plus its in-cycle boundaries, mirroring
    // stateAt's walk exactly (same clamping semantics for non-loop programs).
    const elapsedAbs = t + this.warmupSeconds + p.offsetS;
    let index = p.phases.length - 1;
    let startCycS = 0;
    let endCycS = cycleS;
    let clamped = false;
    if (p.loop) {
      const e = ((elapsedAbs % cycleS) + cycleS) % cycleS;
      let acc = 0;
      for (let i = 0; i < p.phases.length; i++) {
        acc += p.phases[i]!.durationS;
        if (e < acc) {
          index = i;
          endCycS = acc;
          startCycS = acc - p.phases[i]!.durationS;
          break;
        }
      }
    } else if (elapsedAbs < 0 || elapsedAbs >= cycleS) {
      clamped = true;
      index = elapsedAbs < 0 ? 0 : p.phases.length - 1;
      if (elapsedAbs >= cycleS) startCycS = cycleS - p.phases[index]!.durationS;
    } else {
      let acc = 0;
      for (let i = 0; i < p.phases.length; i++) {
        acc += p.phases[i]!.durationS;
        if (elapsedAbs < acc) {
          index = i;
          endCycS = acc;
          startCycS = acc - p.phases[i]!.durationS;
          break;
        }
      }
    }

    const phase = p.phases[index]!.phase;
    if (clamped) {
      return {
        ...base,
        phase,
        source: 'program',
        phaseStartTick: null,
        phaseEndTick: null,
        remainingTicks: null,
        nextPhase: null,
        ...(failureStateOf(phase) !== undefined ? { failureState: failureStateOf(phase) } : {}),
      };
    }

    // Absolute simulation time of the current phase's end: the first boundary
    // at or after `t`. Remaining ticks derive from the same rounded fields the
    // boundaries publish, so consumers never see a 1-tick rounding seam.
    const endBaseS = endCycS - this.warmupSeconds - p.offsetS;
    const k = Math.ceil((t - endBaseS) / cycleS - SNAPSHOT_EPS_S);
    const phaseEndT = endBaseS + k * cycleS;
    const phaseStartT = phaseEndT - p.phases[index]!.durationS;
    const nextPhase = p.phases[(index + 1) % p.phases.length]!.phase;
    const phaseStartTick = Math.round(phaseStartT * hz);
    const phaseEndTick = Math.round(phaseEndT * hz);
    return {
      ...base,
      phase,
      source: 'program',
      phaseStartTick,
      phaseEndTick,
      remainingTicks: Math.max(0, phaseEndTick - Math.round(t * hz)),
      nextPhase,
      ...(failureStateOf(phase) !== undefined ? { failureState: failureStateOf(phase) } : {}),
    };
  }

  /** Snapshots for every program, in sorted signal-id order. */
  snapshotsAt(t: number, dtS?: number): SignalSnapshot[] {
    return this.ids().map((id) => this.snapshotAt(id, t, dtS)!);
  }

  /**
   * The law this stop line is executing at `t`.
   *
   * Static stop controls are always `stop`. A signal is `signal` while it is
   * working, and degrades to `stop` when it is dark (unless the author declared
   * the blackout uncontrolled or a yield) or while it shows a flashing red —
   * which *is* a stop sign, not a red that never clears.
   *
   * `coordinationId` is deliberately the program's junction where one is known,
   * so an intersection whose four heads black out arbitrates as one all-way
   * stop rather than as four independent ones.
   */
  authorityAt(line: StopLineBinding, t: number): StopLineAuthority {
    if (line.kind === 'stop') return { kind: 'stop', dwellS: line.dwellS, reason: 'static_stop' };
    const program = line.signalId === null ? null : this.byId.get(line.signalId);
    if (!program) return { kind: 'signal', dwellS: 0, reason: 'program' };
    const phase = this.phaseAt(line.signalId!, t);
    // Defaults applied at read time so an older document keeps its input hash.
    const dwellS = program.darkDwellS ?? DEFAULT_DARK_DWELL_S;
    const fallback = program.darkFallback ?? DEFAULT_DARK_FALLBACK;
    if (phase === 'flashing_red' || phase === 'flashing_red_arrow') {
      return { kind: 'stop', dwellS, reason: 'flashing_red' };
    }
    if (phase === 'off') {
      if (fallback === 'uncontrolled') {
        return { kind: 'none', dwellS: 0, reason: 'blackout_uncontrolled' };
      }
      if (fallback === 'yield') {
        // A yield keeps the `signal` authority: `phaseForbidsEntry('off')` is
        // false, so the actor is not stopped by the line, and the ordinary
        // conflict governor is what makes it give way. That is exactly what a
        // yield is, and the engine already has it.
        return { kind: 'none', dwellS: 0, reason: 'blackout_uncontrolled' };
      }
      return { kind: 'stop', dwellS, reason: 'blackout' };
    }
    return { kind: 'signal', dwellS: 0, reason: 'program' };
  }

  /** Force a world signal phase through `set(signal:<id>.phase, ...)`. */
  setOverride(signalId: string, phase: SignalPhase | null): boolean {
    if (!this.byId.has(signalId)) return false;
    if (phase === null) this.overrides.delete(signalId);
    else this.overrides.set(signalId, phase);
    return true;
  }

  /** Stop lines on a lane, in storage-`s` order. */
  onLane(rsl: LaneRsl): readonly StopLineBinding[] {
    return this.stopLinesByLane.get(rsl) ?? [];
  }
}

/** May an actor enter the intersection on this phase? Yellow is treated as
 * "stop if you comfortably can", which the governor resolves with the
 * comfort-decel test rather than here. */
export function phaseForbidsEntry(phase: SignalPhase): boolean {
  // Flashing yellow — round or arrow — is caution, not a boundary: the driver
  // proceeds and the conflict governor owns giving way. That is the whole point
  // of the flashing yellow arrow, which turns a protected left permissive.
  //
  // `off` is NOT in this list, and that is the correction to the original
  // defect. A dark head does not mean "proceed"; it means the stop line has
  // degraded to `stop` AUTHORITY (see `SignalBook.authorityAt`), which is
  // resolved before this predicate is ever reached. A blackout an author has
  // explicitly declared uncontrolled resolves to `none` authority and likewise
  // never reaches here. Leaving `off` permissive here as well would let a dark
  // head be waved through by whichever check ran first.
  return !['green', 'green_arrow', 'proceed', 'flashing_yellow', 'flashing_yellow_arrow'].includes(phase);
}

/** Free-function form of {@link SignalBook.snapshotAt} — the public
 * `signalSnapshotAt(book, signalId, t)` entry point consumers outside the
 * engine call when they hold a book but should not depend on its class. */
export function signalSnapshotAt(
  book: SignalBook,
  signalId: string,
  t: number,
  dtS?: number,
): SignalSnapshot | null {
  return book.snapshotAt(signalId, t, dtS);
}
