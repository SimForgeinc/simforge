/**
 * What the timeline dock's signal lane draws, and what painting on it produces.
 *
 * ## Two tiers, and the second one is new
 *
 * v1's lane had one tier: the junction's authored colour. It could not have had
 * two, because v1 had no map-owned baseline — its unplanned state was a forced
 * green with no timing at all.
 *
 * v2 does, so the lane shows both:
 *
 * - **authored** bands, from the plan's clips;
 * - **baseline** bands, from the map's own looping `SignalProgram`, wherever no
 *   clip covers — which is precisely what `compileMapSignalPlans` will run
 *   there.
 *
 * That makes the lane an accurate picture of the compiled result rather than of
 * the authored fragment, and it makes an intentional gap ("hand it back to map
 * timing") visually distinct from an unauthored junction.
 *
 * The baseline bands are drawn from `synthetic-default` timing on every
 * production map. `map-signals.ts` is explicit that RoadRunner supplies real
 * head ids, controller membership and stage order but *not* authoritative phase
 * durations. The lane must carry that provenance to the component
 * ({@link SignalTimelineBand.source}) so the UI can render baseline bands as
 * provisional; an author who reads them as surveyed timing will not author the
 * timing they actually need.
 *
 * ## One row per junction, not one per movement
 *
 * Eight rows for an ordinary four-way would bury the actor lanes, so the lane
 * shows the junction's DOMINANT indication — green over yellow over red — which
 * answers the question the lane exists for: is this junction letting anything
 * through, and when does that change. Per-head detail belongs to the
 * intersection panel, which has the room for it.
 *
 * Sampled at each interval's MIDPOINT rather than at its edges, so a zero-width
 * artefact at a boundary cannot produce a phantom band, and neighbouring
 * intervals that agree are merged.
 */

import type { MapSignalPlan } from "@uniscenarios/scenario-model";

import { canonicalStageForController, orderedStages, selectSignalHead, type EditorSignalIndex } from "./stages";
import type { ControlIndication, EditorSignalBaseline, MapSignalIndication } from "./types";

/** Grid the lane snaps drag and paint gestures to. Matches v1's 0.1 s. */
export const TIMELINE_TIME_GRID_S = 0.1;

/** Below this a band is not drawable and not worth emitting. */
export const TIMELINE_MIN_BAND_S = 0.2;

export function snapTimelineSeconds(seconds: number): number {
  const snapped = Math.round(seconds / TIMELINE_TIME_GRID_S) * TIMELINE_TIME_GRID_S;
  // The multiply-then-divide leaves values like 3.3000000000000003; one more
  // rounding pass makes band edges exactly representable, which is what keeps
  // `endS === next.startS` true after a drag.
  return Math.round(snapped * 10) / 10;
}

/**
 * Where a band's indication came from.
 *
 * `"authored"` is a clip. `"baseline"` is the map's own program showing through
 * an uncovered interval. The distinction is not cosmetic: an author can retime
 * the first and cannot retime the second.
 */
export type SignalBandSource = "authored" | "baseline";

export type SignalTimelineBand = {
  readonly startS: number;
  readonly endS: number
  readonly indication: ControlIndication;
  readonly source: SignalBandSource;
  /** The clip this band came from, for hit-testing a drag. Null for baseline. */
  readonly clipId: string | null;
};

export type SignalTimelineRow = {
  readonly junctionId: string;
  /** Whether a plan governs this junction at all. */
  readonly planned: boolean;
  readonly bands: readonly SignalTimelineBand[];
};

/**
 * Indication in force on one baseline program at scenario time `t`.
 *
 * The same walk `compileMapSignalPlans`' own `phaseAt` performs — including
 * `warmupSeconds`, which shifts the map's cycle so `t = 0` is the start of the
 * *clip* rather than of the simulation. Getting the warm-up wrong here would put
 * the lane's baseline out of step with playback by exactly the warm-up, which
 * looks like a plan-timing bug rather than a lane bug.
 */
export function baselineIndicationAt(
  baseline: EditorSignalBaseline,
  timeS: number,
  warmupSeconds: number,
): ControlIndication | null {
  const cycle = baseline.phases.reduce((sum, phase) => sum + phase.durationS, 0);
  if (cycle <= 0) return null;
  let elapsed = timeS + warmupSeconds + baseline.offsetS;
  if (baseline.loop) {
    elapsed = ((elapsed % cycle) + cycle) % cycle;
  } else if (elapsed <= 0) {
    return baseline.phases[0]!.indication;
  } else if (elapsed >= cycle) {
    return baseline.phases[baseline.phases.length - 1]!.indication;
  }
  let cursor = 0;
  for (const phase of baseline.phases) {
    cursor += phase.durationS;
    if (elapsed < cursor) return phase.indication;
  }
  return baseline.phases[baseline.phases.length - 1]!.indication;
}

/** Green over yellow over red: what a driver approaching the junction sees. */
const DOMINANCE: readonly ControlIndication[] = [
  "green",
  "green_arrow",
  "proceed",
  "yellow",
  "yellow_arrow",
  "flashing_yellow",
  "red",
  "red_x",
  "stop",
  "flashing_red",
  "off",
];

function dominant(indications: readonly ControlIndication[]): ControlIndication | null {
  for (const candidate of DOMINANCE) {
    if (indications.includes(candidate)) return candidate;
  }
  return null;
}

/**
 * Every boundary the compiled result can change at.
 *
 * Clip edges plus every baseline phase edge that falls inside the window — the
 * same boundary set `compileMapSignalPlans` builds, for the same reason: sampling
 * on a fixed grid would either miss a short phase or emit thousands of bands.
 */
function boundaries(
  clips: readonly { startS: number; endS: number }[],
  baselines: readonly EditorSignalBaseline[],
  clipSeconds: number,
  warmupSeconds: number,
): number[] {
  const points = new Set<number>([0, clipSeconds]);
  for (const clip of clips) {
    if (clip.startS > 0 && clip.startS < clipSeconds) points.add(clip.startS);
    if (clip.endS > 0 && clip.endS < clipSeconds) points.add(clip.endS);
  }
  for (const baseline of baselines) {
    const cycle = baseline.phases.reduce((sum, phase) => sum + phase.durationS, 0);
    if (cycle <= 0) continue;
    let cumulative = 0;
    for (const phase of baseline.phases) {
      cumulative += phase.durationS;
      const origin = cumulative - warmupSeconds - baseline.offsetS;
      if (baseline.loop) {
        const first = Math.ceil((0 - origin) / cycle);
        const last = Math.floor((clipSeconds - origin) / cycle);
        for (let turn = first; turn <= last; turn += 1) {
          const value = origin + turn * cycle;
          if (value > 0 && value < clipSeconds) points.add(value);
        }
      } else if (origin > 0 && origin < clipSeconds) {
        points.add(origin);
      }
    }
  }
  return [...points].sort((left, right) => left - right);
}

export type SignalTimelineInput = {
  readonly index: EditorSignalIndex;
  readonly plans: readonly MapSignalPlan[];
  readonly clipSeconds: number;
  readonly warmupSeconds: number;
  /**
   * Restrict to these junctions. Omitted means every junction that either has a
   * plan or has a baseline — i.e. every junction the lane could say something
   * about.
   */
  readonly junctionIds?: readonly string[];
};

/**
 * Build the lane's rows: one per junction, bands merged.
 *
 * A junction with neither a plan nor a baseline produces no row at all rather
 * than an empty one. An empty row reads as "authored to show nothing", and
 * nothing is exactly what this junction is not doing — it has no controllable
 * signal, which the panel says elsewhere.
 */
export function buildSignalTimelineRows(input: SignalTimelineInput): SignalTimelineRow[] {
  const clipSeconds = input.clipSeconds;
  if (!(clipSeconds > 0)) return [];

  const baselinesByJunction = new Map<string, EditorSignalBaseline[]>();
  for (const baseline of input.index.projection.baselines) {
    const list = baselinesByJunction.get(baseline.junctionId);
    if (list) list.push(baseline);
    else baselinesByJunction.set(baseline.junctionId, [baseline]);
  }

  const wanted =
    input.junctionIds != null
      ? new Set(input.junctionIds)
      : new Set([
          ...input.plans.map((plan) => plan.binding.junctionId),
          ...baselinesByJunction.keys(),
        ]);

  const rows: SignalTimelineRow[] = [];
  for (const junctionId of [...wanted].sort()) {
    const plan = input.plans.find((candidate) => candidate.binding.junctionId === junctionId);
    const baselines = baselinesByJunction.get(junctionId) ?? [];
    if (!plan && baselines.length === 0) continue;
    const clips = plan?.clips ?? [];
    const edges = boundaries(clips, baselines, clipSeconds, input.warmupSeconds);

    const merged: SignalTimelineBand[] = [];
    for (let at = 0; at < edges.length - 1; at += 1) {
      const startS = edges[at]!;
      const endS = edges[at + 1]!;
      if (endS - startS < 1e-9) continue;
      const sample = startS + (endS - startS) / 2;
      const clip = clips.find(
        (candidate) => sample >= candidate.startS && sample < candidate.endS,
      );
      const indication = clip
        ? clip.indication
        : dominant(
            baselines
              .map((baseline) => baselineIndicationAt(baseline, sample, input.warmupSeconds))
              .filter((value): value is ControlIndication => value !== null),
          );
      if (!indication) continue;
      const source: SignalBandSource = clip ? "authored" : "baseline";
      const clipId = clip?.id ?? null;
      const previous = merged[merged.length - 1];
      if (
        previous &&
        previous.indication === indication &&
        previous.source === source &&
        previous.clipId === clipId &&
        Math.abs(previous.endS - startS) < 1e-9
      ) {
        merged[merged.length - 1] = { ...previous, endS };
        continue;
      }
      merged.push({ startS, endS, indication, source, clipId });
    }
    if (merged.length === 0) continue;
    rows.push({
      junctionId,
      planned: plan != null,
      bands: merged.filter((band) => band.endS - band.startS >= TIMELINE_MIN_BAND_S),
    });
  }
  return rows;
}

/**
 * The sibling indication a non-referenced head holds while a clip is in force.
 *
 * Re-stated here rather than imported because `evaluateSignalReferencePhase`
 * lives in the materializer and this module must stay browser-safe — but it is
 * the SAME rule, and it is the rule that makes the junction row honest: a red
 * reference holds the whole junction red (an all-red clearance), and a flashing
 * yellow reference puts the crossing approaches on flashing red, which is what a
 * real dark-mode intersection does.
 *
 * If `evaluateSignalReferencePhase` ever changes, this must change with it; the
 * per-stage rows would otherwise show a state the compiler will not produce.
 * Pinned by `test/uniscenario/signals/signal-authoring.test.ts`.
 */
export function siblingIndication(reference: ControlIndication): ControlIndication {
  if (reference === "flashing_red" || reference === "flashing_yellow") return "flashing_red";
  return "red";
}

/**
 * Resolve the exact state each physical head should show at the editor playhead.
 *
 * The authoring viewport cannot wait for autosave and background recompilation:
 * changing green from 10 s to 6 s must recolor the 3D light immediately. Start
 * with the map baseline for every resolved head, then apply authored clips with
 * the same controller-stage rule used by the compiler. This keeps the scene,
 * timeline, and details panel on one document revision.
 */
export function editorSignalStatesAt(input: {
  readonly index: EditorSignalIndex;
  readonly plans: readonly MapSignalPlan[];
  readonly timeS: number;
  readonly clipSeconds: number;
  readonly warmupSeconds: number;
}): Readonly<Record<string, ControlIndication>> {
  const states: Record<string, ControlIndication> = {};
  const sampleTime = input.clipSeconds > 0
    ? Math.min(Math.max(0, input.timeS), Math.max(0, input.clipSeconds - 1e-6))
    : 0;

  for (const baseline of input.index.projection.baselines) {
    const indication = baselineIndicationAt(baseline, sampleTime, input.warmupSeconds);
    if (!indication) continue;
    for (const headId of baseline.headIds) states[headId] = indication;
  }

  for (const plan of input.plans) {
    if (plan.binding.mapId !== input.index.projection.mapId) continue;
    const clip = plan.clips.find(
      (candidate) => sampleTime >= candidate.startS && sampleTime < candidate.endS,
    );
    if (!clip) continue;
    const selection = selectSignalHead(input.index, clip.reference.headId, {
      controllerId: clip.reference.controllerId,
    });
    if (!selection || selection.junctionId !== plan.binding.junctionId) continue;
    const stageHeads = new Set(selection.movementHeadIds);
    for (const headId of selection.intersectionHeadIds) {
      states[headId] = stageHeads.has(headId)
        ? clip.indication
        : siblingIndication(clip.indication);
    }
  }
  return states;
}

export type StageTimelineRow = {
  readonly junctionId: string;
  readonly controllerId: string;
  readonly headIds: readonly string[];
  readonly bands: readonly SignalTimelineBand[];
};

/**
 * One row per controller stage — the expanded view behind the junction row.
 *
 * v1's lane had three tiers (`junction | group | movement`) because its plan
 * carried a per-movement state map and each movement genuinely needed its own
 * row to be editable. Here only two tiers are meaningful: the junction's dominant
 * indication, and the stage, because a stage is the smallest thing a clip can
 * command. There is no per-movement row to paint, which is why roughly 400 lines
 * of v1's per-movement painting (`paintRows`, `retimeRowsAt`, `primaryRowId`,
 * `cycleBand`, `withAutoYellow`) have no analogue: a clip states one stage's
 * indication and the rest is derived.
 *
 * These rows are read-only. Editing happens on the clips — a stage row shows
 * what a stage WILL show, including the states derived for it, and derived states
 * are not editable by definition.
 */
export function buildStageTimelineRows(input: SignalTimelineInput & { readonly junctionId: string }): StageTimelineRow[] {
  const { clipSeconds, warmupSeconds, junctionId } = input;
  if (!(clipSeconds > 0)) return [];
  const stages = orderedStages(input.index, junctionId);
  if (stages.length === 0) return [];
  const plan = input.plans.find((candidate) => candidate.binding.junctionId === junctionId);
  const clips = plan?.clips ?? [];
  const baselines = input.index.projection.baselines.filter(
    (baseline) => baseline.junctionId === junctionId,
  );
  const edges = boundaries(clips, baselines, clipSeconds, warmupSeconds);
  const intervals = edges.slice(0, -1).flatMap((startS, at) => {
    const endS = edges[at + 1]!;
    if (endS - startS < 1e-9) return [];
    const sample = startS + (endS - startS) / 2;
    return [{
      startS,
      endS,
      clip: clips.find((candidate) => sample >= candidate.startS && sample < candidate.endS),
      states: editorSignalStatesAt({
        index: input.index,
        plans: input.plans,
        timeS: sample,
        clipSeconds,
        warmupSeconds,
      }),
    }];
  });

  return stages.map((stage) => {
    const merged: SignalTimelineBand[] = [];
    for (const interval of intervals) {
      const indication = dominant(
        stage.headIds
          .map((headId) => interval.states[headId])
          .filter((value): value is ControlIndication => value !== undefined),
      );
      if (!indication) continue;
      const source: SignalBandSource = interval.clip ? "authored" : "baseline";
      const activeStage = interval.clip
        ? canonicalStageForController(
            input.index,
            junctionId,
            interval.clip.reference.controllerId,
          )
        : null;
      const clipId = interval.clip && activeStage?.id === stage.id
        ? interval.clip.id
        : null;
      const previous = merged[merged.length - 1];
      if (
        previous
        && previous.indication === indication
        && previous.source === source
        && previous.clipId === clipId
        && Math.abs(previous.endS - interval.startS) < 1e-9
      ) {
        merged[merged.length - 1] = { ...previous, endS: interval.endS };
        continue;
      }
      merged.push({
        startS: interval.startS,
        endS: interval.endS,
        indication,
        source,
        clipId,
      });
    }
    return {
      junctionId,
      controllerId: stage.id,
      headIds: stage.headIds,
      bands: merged.filter((band) => band.endS - band.startS >= TIMELINE_MIN_BAND_S),
    };
  });
}

export type ReferenceSignalTimelineRow = StageTimelineRow & {
  readonly referenceHeadId: string;
};

/**
 * Project one persisted junction plan to exactly one physical-light lane.
 *
 * Controller stages can overlap: Yale junction 447 has a crossing stage that
 * shares two heads with the selected head's stage. A stage-level majority
 * therefore says "green" while the selected physical head is red. The visible
 * lane is labelled with a head id, so derive every band from that exact head's
 * renderer state rather than from its controller's other heads.
 */
export function buildReferenceSignalTimelineRow(
  input: SignalTimelineInput & { readonly plan: MapSignalPlan },
): ReferenceSignalTimelineRow | null {
  let referenceClip = input.plan.clips[0];
  for (let at = 1; at < input.plan.clips.length; at += 1) {
    const candidate = input.plan.clips[at]!;
    if (
      !referenceClip
      || candidate.startS < referenceClip.startS
      || (candidate.startS === referenceClip.startS && candidate.id < referenceClip.id)
    ) {
      referenceClip = candidate;
    }
  }
  if (!referenceClip || !(input.clipSeconds > 0)) return null;
  const junctionId = input.plan.binding.junctionId;
  const stage = canonicalStageForController(
    input.index,
    junctionId,
    referenceClip.reference.controllerId,
  );
  if (!stage) return null;
  const baselines = input.index.projection.baselines.filter(
    (baseline) => baseline.junctionId === junctionId,
  );
  const edges = boundaries(
    input.plan.clips,
    baselines,
    input.clipSeconds,
    input.warmupSeconds,
  );
  const merged: SignalTimelineBand[] = [];
  for (let at = 0; at < edges.length - 1; at += 1) {
    const startS = edges[at]!;
    const endS = edges[at + 1]!;
    if (endS - startS < 1e-9) continue;
    const sample = startS + (endS - startS) / 2;
    const clip = input.plan.clips.find(
      (candidate) => sample >= candidate.startS && sample < candidate.endS,
    );
    const indication = editorSignalStatesAt({
      index: input.index,
      plans: input.plans,
      timeS: sample,
      clipSeconds: input.clipSeconds,
      warmupSeconds: input.warmupSeconds,
    })[referenceClip.reference.headId];
    if (!indication) continue;
    const source: SignalBandSource = clip ? "authored" : "baseline";
    const clipId = clip?.id ?? null;
    const previous = merged[merged.length - 1];
    if (
      previous
      && previous.indication === indication
      && previous.source === source
      && previous.clipId === clipId
      && Math.abs(previous.endS - startS) < 1e-9
    ) {
      merged[merged.length - 1] = { ...previous, endS };
      continue;
    }
    merged.push({ startS, endS, indication, source, clipId });
  }
  return {
    junctionId,
    controllerId: stage.id,
    headIds: [referenceClip.reference.headId],
    bands: merged.filter((band) => band.endS - band.startS >= TIMELINE_MIN_BAND_S),
    referenceHeadId: referenceClip.reference.headId,
  };
}

/**
 * Move one clip boundary, carrying its neighbour with it.
 *
 * Clips are contiguous and non-overlapping, so dragging an edge is a two-clip
 * edit: the clip ending there and the clip starting there both move, and neither
 * may collapse below {@link TIMELINE_MIN_BAND_S}. Returns the clips unchanged
 * when the drag would violate either rule — silently clamping produces an edge
 * that does not follow the pointer, which reads as a broken drag.
 */
export function retimeClipBoundary(
  clips: readonly { id: string; startS: number; endS: number; reference: { controllerId: string; headId: string }; indication: MapSignalIndication }[],
  boundaryS: number,
  nextS: number,
): typeof clips {
  const snapped = snapTimelineSeconds(nextS);
  const before = clips.find((clip) => Math.abs(clip.endS - boundaryS) < 1e-9);
  const after = clips.find((clip) => Math.abs(clip.startS - boundaryS) < 1e-9);
  if (!before && !after) return clips;
  if (before && snapped - before.startS < TIMELINE_MIN_BAND_S) return clips;
  if (after && after.endS - snapped < TIMELINE_MIN_BAND_S) return clips;
  return clips.map((clip) => {
    if (before && clip.id === before.id) return { ...clip, endS: snapped };
    if (after && clip.id === after.id) return { ...clip, startS: snapped };
    return clip;
  });
}

/** Distinct interior boundaries of a clip run, for drawing drag handles. */
export function clipBoundaries(
  clips: readonly { startS: number; endS: number }[],
): number[] {
  const starts = new Set(clips.map((clip) => clip.startS));
  return [...new Set(clips.map((clip) => clip.endS))]
    .filter((value) => starts.has(value))
    .sort((left, right) => left - right);
}
