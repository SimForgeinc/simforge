/**
 * Browser-safe production map traffic-signal binding.
 *
 * RoadRunner's checked-in OpenDRIVE files provide physical head ids,
 * controller membership, junction/controller sequence order and concrete gate
 * geometry, but not authoritative phase durations. We therefore preserve the
 * real ids and movement bindings while marking the deterministic timing plan
 * as `synthetic-default`. An unsignalized map returns an empty catalog and the
 * materializer does not invent signal programs for it.
 */

import type { DerivedMapIndex, MatchedSite } from './anchor/index.js';
import type { LaneGraph, RoadControl, SignalProgram, TopologyGate, TopologyIndex } from '@simforge/engine';

export interface MapSignalHead {
  readonly id: string;
  readonly roadId: string;
  readonly s: number;
  readonly dynamic: boolean;
}

export interface MapRoadControlHead {
  readonly id: string;
  readonly kind: 'stop';
  readonly roadId: string;
  readonly s: number;
}

export interface MapSpeedLimitHead {
  readonly id: string;
  readonly roadId: string;
  readonly s: number;
  readonly speedLimitKph: number;
}

/** OpenDRIVE lane applicability for a physical signal head. A head can be
 * declared once and referenced from several junction movements. */
export interface MapSignalApplicability {
  readonly headId: string;
  readonly roadId: string;
  readonly fromLane: number | null;
  readonly toLane: number | null;
  readonly source: 'signal' | 'signal-reference';
}

export interface MapSignalController {
  readonly id: string;
  readonly sequence: number;
  readonly signalIds: readonly string[];
}

export interface MapSignalJunction {
  readonly junctionId: string;
  readonly controllerIds: readonly string[];
}

export interface MapSignalCatalog {
  readonly heads: readonly MapSignalHead[];
  readonly roadControls: readonly MapRoadControlHead[];
  readonly speedLimits: readonly MapSpeedLimitHead[];
  readonly applicability: readonly MapSignalApplicability[];
  readonly controllers: readonly MapSignalController[];
  readonly junctions: readonly MapSignalJunction[];
}

export interface SiteSignalPlan {
  readonly junctionId: string | null;
  readonly programs: readonly SignalProgram[];
  /** Physical map head id → concrete engine program id. */
  readonly programByHeadId: ReadonlyMap<string, string>;
  /** Junction connecting lane → concrete engine program ids. */
  readonly programsByConnectingLane: ReadonlyMap<string, readonly string[]>;
  readonly timingSource: 'synthetic-default' | 'none';
  /** Where the phase visible at t=0 comes from. The map has no live state. */
  readonly stateSource: 'synthetic-cycle' | 'none';
}

/** Map-wide physical controls used by the editor's scenario-independent
 * ambient world. Programs retain the exact OpenDRIVE head/controller ids; only
 * their timing is the documented deterministic fallback used by site plans. */
export interface MapControlPlan {
  readonly signalPrograms: readonly SignalProgram[];
  readonly roadControls: readonly RoadControl[];
}

/** Browser-safe structural subset needed to bind map controls. */
export interface SignalMapBundle {
  readonly index: DerivedMapIndex;
  readonly graph: LaneGraph;
  readonly topology: TopologyIndex;
  readonly signalCatalog: MapSignalCatalog;
}

interface SignalGeoJson {
  readonly features?: Array<{
    readonly properties?: {
      readonly id?: unknown;
      readonly road_id?: unknown;
      readonly s?: unknown;
      readonly signal_category?: unknown;
      readonly dynamic?: unknown;
      readonly speed_limit_mph?: unknown;
      readonly speed_limit_kph?: unknown;
    };
  }>;
}

/** Common junction-cycle offset: keeps every head synchronized. Clip duration
 * is deliberately not assumed here; a compact scenario must prove the phase
 * it uses from its own bound trace rather than being stretched to see a cycle
 * transition. */
export const SYNTHETIC_SIGNAL_OFFSET_S = 23;

function attrs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of text.matchAll(/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*"([^"]*)"/g)) {
    out[match[1]!] = match[2]!;
  }
  return out;
}

function finite(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

interface XodrSignalElement {
  readonly kind: 'signal' | 'signalReference';
  readonly attributes: string;
  readonly body: string;
}

/** Match self-closing elements before paired elements without double-capturing. */
function xodrSignalElements(roadBody: string): XodrSignalElement[] {
  const elements: XodrSignalElement[] = [];
  const pattern = /<(signal|signalReference)\b([^>]*?)\/\s*>|<(signal|signalReference)\b([^>]*)>([\s\S]*?)<\/\3\s*>/g;
  for (const match of roadBody.matchAll(pattern)) {
    elements.push({
      kind: (match[1] ?? match[3]) as XodrSignalElement['kind'],
      attributes: match[2] ?? match[4] ?? '',
      body: match[5] ?? '',
    });
  }
  return elements;
}

/** Parse only the small controller seam needed by the CLI; no XML mutation. */
export function parseMapSignalCatalog(xodr: string, geojson: SignalGeoJson): MapSignalCatalog {
  const heads = (geojson.features ?? [])
    .map((feature): MapSignalHead | null => {
      const p = feature.properties ?? {};
      if (p.signal_category !== 'traffic_light' || (p.dynamic !== 'yes' && p.dynamic !== true)) return null;
      const id = String(p.id ?? '');
      const roadId = String(p.road_id ?? '');
      if (!id || !roadId) return null;
      return { id, roadId, s: finite(p.s), dynamic: true };
    })
    .filter((head): head is MapSignalHead => head !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
  const roadControls = (geojson.features ?? [])
    .map((feature): MapRoadControlHead | null => {
      const p = feature.properties ?? {};
      if (p.signal_category !== 'stop_sign') return null;
      const id = String(p.id ?? '');
      const roadId = String(p.road_id ?? '');
      if (!id || !roadId) return null;
      return { id, kind: 'stop', roadId, s: finite(p.s) };
    })
    .filter((head): head is MapRoadControlHead => head !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
  const speedLimits = (geojson.features ?? [])
    .map((feature): MapSpeedLimitHead | null => {
      const p = feature.properties ?? {};
      if (p.signal_category !== 'speed_limit_sign') return null;
      const id = String(p.id ?? '');
      const roadId = String(p.road_id ?? '');
      const mph = finite(p.speed_limit_mph, Number.NaN);
      const kph = finite(p.speed_limit_kph, Number.NaN);
      const speedLimitKph = Number.isFinite(kph) && kph > 0 ? kph : mph * 1.609344;
      if (!id || !roadId || !Number.isFinite(speedLimitKph) || speedLimitKph <= 0) return null;
      return { id, roadId, s: finite(p.s), speedLimitKph };
    })
    .filter((head): head is MapSpeedLimitHead => head !== null)
    .sort((a, b) => a.roadId.localeCompare(b.roadId) || a.s - b.s || a.id.localeCompare(b.id));

  const applicability: MapSignalApplicability[] = [];
  const dynamicHeadIds = new Set(heads.map((head) => head.id));
  for (const road of xodr.matchAll(/<road\b([^>]*)>([\s\S]*?)<\/road>/g)) {
    const roadId = attrs(road[1]!)['id'];
    if (!roadId) continue;
    for (const signal of xodrSignalElements(road[2]!)) {
      const headId = attrs(signal.attributes)['id'];
      if (!headId || !dynamicHeadIds.has(headId)) continue;
      const validities = [...signal.body.matchAll(/<validity\b([^>]*)\/?\s*>/g)]
        .map((entry) => attrs(entry[1]!))
        .map((entry) => ({
          fromLane: Number(entry['fromLane']),
          toLane: Number(entry['toLane']),
        }))
        .filter((entry) => Number.isInteger(entry.fromLane) && Number.isInteger(entry.toLane));
      if (validities.length === 0) {
        applicability.push({
          headId,
          roadId,
          fromLane: null,
          toLane: null,
          source: signal.kind === 'signalReference' ? 'signal-reference' : 'signal',
        });
      } else {
        for (const validity of validities) {
          applicability.push({
            headId,
            roadId,
            fromLane: validity.fromLane,
            toLane: validity.toLane,
            source: signal.kind === 'signalReference' ? 'signal-reference' : 'signal',
          });
        }
      }
    }
  }
  applicability.sort(
    (a, b) =>
      a.headId.localeCompare(b.headId) ||
      a.roadId.localeCompare(b.roadId) ||
      (a.fromLane ?? Number.NEGATIVE_INFINITY) - (b.fromLane ?? Number.NEGATIVE_INFINITY) ||
      (a.toLane ?? Number.POSITIVE_INFINITY) - (b.toLane ?? Number.POSITIVE_INFINITY) ||
      a.source.localeCompare(b.source),
  );
  const uniqueApplicability = applicability.filter(
    (entry, index, all) =>
      index === 0 ||
      entry.headId !== all[index - 1]!.headId ||
      entry.roadId !== all[index - 1]!.roadId ||
      entry.fromLane !== all[index - 1]!.fromLane ||
      entry.toLane !== all[index - 1]!.toLane ||
      entry.source !== all[index - 1]!.source,
  );

  const controllers: MapSignalController[] = [];
  for (const match of xodr.matchAll(/<controller\b([^>]*)>([\s\S]*?)<\/controller>/g)) {
    const a = attrs(match[1]!);
    if (!a['id']) continue;
    const signalIds = [...match[2]!.matchAll(/<control\b([^>]*)\/?\s*>/g)]
      .map((entry) => attrs(entry[1]!)['signalId'])
      .filter((id): id is string => Boolean(id));
    controllers.push({ id: a['id'], sequence: finite(a['sequence']), signalIds: [...new Set(signalIds)].sort() });
  }
  controllers.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));

  const junctions: MapSignalJunction[] = [];
  for (const match of xodr.matchAll(/<junction\b([^>]*)>([\s\S]*?)<\/junction>/g)) {
    const a = attrs(match[1]!);
    if (!a['id']) continue;
    const controllerIds = [...match[2]!.matchAll(/<controller\b([^>]*)\/?\s*>/g)]
      .map((entry) => attrs(entry[1]!)['id'])
      .filter((id): id is string => Boolean(id));
    if (controllerIds.length > 0) {
      junctions.push({ junctionId: a['id'], controllerIds: [...new Set(controllerIds)] });
    }
  }
  junctions.sort((a, b) => a.junctionId.localeCompare(b.junctionId));
  return { heads, roadControls, speedLimits, applicability: uniqueApplicability, controllers, junctions };
}

/** Apply physical speed-limit signs before the LaneGraph is built. The current
 * maps use one posted value per OpenDRIVE road; preserving the helper as a
 * pure topology transform keeps parsing, preview and CLI execution identical. */
export function topologyWithMapSpeedLimits(
  topology: TopologyIndex,
  catalog: MapSignalCatalog,
): TopologyIndex {
  const byRoad = new Map<string, number>();
  for (const sign of catalog.speedLimits) {
    const previous = byRoad.get(sign.roadId);
    if (previous === undefined || sign.speedLimitKph < previous) byRoad.set(sign.roadId, sign.speedLimitKph);
  }
  if (byRoad.size === 0) return topology;
  let changed = false;
  const lanes = Object.fromEntries(Object.entries(topology.lanes).map(([rsl, lane]) => {
    const speedLimitKph = byRoad.get(String(lane.roadId));
    if (speedLimitKph === undefined || Math.abs((lane.speedLimitKph ?? 0) - speedLimitKph) < 1e-9) {
      return [rsl, lane];
    }
    changed = true;
    return [rsl, { ...lane, speedLimitKph }];
  }));
  return changed ? { ...topology, lanes } : topology;
}

function coalescePhases(
  phases: Array<{ phase: 'green' | 'yellow' | 'red'; durationS: number }>,
): Array<{ phase: 'green' | 'yellow' | 'red'; durationS: number }> {
  const out: Array<{ phase: 'green' | 'yellow' | 'red'; durationS: number }> = [];
  for (const phase of phases) {
    const previous = out[out.length - 1];
    if (previous?.phase === phase.phase) previous.durationS += phase.durationS;
    else out.push({ ...phase });
  }
  return out;
}

/** Deterministic fallback cycle derived from controller sequence membership. */
export function defaultPhasesForHead(
  headId: string,
  controllers: readonly MapSignalController[],
): Array<{ phase: 'green' | 'yellow' | 'red'; durationS: number }> {
  if (controllers.length <= 1) {
    // The source declares no competing sequence. Keep the head observable and
    // useful for trigger/export testing without claiming this is field timing.
    return [
      { phase: 'green', durationS: 27 },
      { phase: 'yellow', durationS: 3 },
      { phase: 'red', durationS: 30 },
    ];
  }
  const raw: Array<{ phase: 'green' | 'yellow' | 'red'; durationS: number }> = [];
  for (let index = 0; index < controllers.length; index += 1) {
    const active = controllers[index]!.signalIds.includes(headId);
    const nextActive = controllers[(index + 1) % controllers.length]!.signalIds.includes(headId);
    if (!active) raw.push({ phase: 'red', durationS: 15 });
    else if (nextActive) raw.push({ phase: 'green', durationS: 15 });
    else raw.push({ phase: 'green', durationS: 12 }, { phase: 'yellow', durationS: 3 });
  }
  return coalescePhases(raw);
}

function stopLineFor(bundle: SignalMapBundle, gate: TopologyGate): { rsl: string; s: number; connectingLaneRsls: string[] } | null {
  const geometry = bundle.graph.geometry(gate.approachLaneRsl);
  if (!geometry) return null;
  const reversed = bundle.graph.nominalReversed(gate.approachLaneRsl) ?? false;
  return {
    rsl: gate.approachLaneRsl,
    // One metre before the downstream endpoint, expressed in storage s.
    s: reversed ? Math.min(1, geometry.lengthM) : Math.max(0, geometry.lengthM - 1),
    connectingLaneRsls: [gate.connectingLaneRsl],
  };
}

function applicationIncludesLane(
  application: MapSignalApplicability,
  lane: { roadId: string | number; laneId: number } | undefined,
): boolean {
  if (!lane || String(lane.roadId) !== application.roadId) return false;
  if (application.fromLane === null || application.toLane === null) return true;
  const low = Math.min(application.fromLane, application.toLane);
  const high = Math.max(application.fromLane, application.toLane);
  return lane.laneId >= low && lane.laneId <= high;
}

/** Resolve the actual OpenDRIVE signal/reference applicability for a gate. */
function gatesForHead(bundle: SignalMapBundle, gates: readonly TopologyGate[], headId: string): TopologyGate[] {
  const applications = bundle.signalCatalog.applicability.filter((entry) => entry.headId === headId);
  return gates
    .filter((gate) => {
      const connecting = bundle.topology.lanes[gate.connectingLaneRsl];
      const approach = bundle.topology.lanes[gate.approachLaneRsl];
      return applications.some(
        (application) =>
          applicationIncludesLane(application, connecting) || applicationIncludesLane(application, approach),
      );
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Bind the site's real map heads/controllers to engine programs and movements. */
function buildSignalPlanForJunction(bundle: SignalMapBundle, junctionId: string | null): SiteSignalPlan {
  const none = (): SiteSignalPlan => ({
    junctionId,
    programs: [],
    programByHeadId: new Map(),
    programsByConnectingLane: new Map(),
    timingSource: 'none',
    stateSource: 'none',
  });
  if (!junctionId) return none();
  const junction = bundle.signalCatalog.junctions.find((candidate) => candidate.junctionId === junctionId);
  if (!junction) return none();
  const controllerById = new Map(bundle.signalCatalog.controllers.map((controller) => [controller.id, controller]));
  const controllers = junction.controllerIds
    .map((id) => controllerById.get(id))
    .filter((controller): controller is MapSignalController => controller !== undefined)
    .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  if (controllers.length === 0) return none();

  const selectedHeadIds = new Set(controllers.flatMap((controller) => controller.signalIds));
  const heads = bundle.signalCatalog.heads.filter((head) => selectedHeadIds.has(head.id));
  if (heads.length === 0) return none();
  const gates = bundle.topology.gates.filter((gate) => gate.junctionId === junctionId);
  const programByHeadId = new Map<string, string>();
  const programsByConnectingLane = new Map<string, string[]>();
  const programs: SignalProgram[] = [];

  // A program is one phase timeline. Heads with the same ordered OpenDRIVE
  // controller-stage membership have exactly the same fallback timeline and
  // can be represented together without losing physical identity. Keeping a
  // head in two independent programs would make a red stage in either program
  // incorrectly stop the movement and would duplicate export ownership.
  const headsByControllerSignature = new Map<string, MapSignalHead[]>();
  for (const head of heads) {
    const signature = controllers
      .filter((controller) => controller.signalIds.includes(head.id))
      .map((controller) => controller.id)
      .join('\u0000');
    if (!signature) continue;
    const group = headsByControllerSignature.get(signature);
    if (group) group.push(head);
    else headsByControllerSignature.set(signature, [head]);
  }

  for (const groupedHeads of [...headsByControllerSignature.values()].sort((a, b) => a[0]!.id.localeCompare(b[0]!.id))) {
    groupedHeads.sort((a, b) => a.id.localeCompare(b.id));
    const headIds = groupedHeads.map((head) => head.id);
    const matchingGates = [
      ...new Map(
        groupedHeads
          .flatMap((head) => gatesForHead(bundle, gates, head.id))
          .map((gate) => [gate.id, gate]),
      ).values(),
    ].sort((a, b) => a.id.localeCompare(b.id));
    const stopLines = matchingGates
      .map((gate) => stopLineFor(bundle, gate))
      .filter((line): line is NonNullable<typeof line> => line !== null)
      .filter(
        (line, index, all) =>
          all.findIndex((candidate) => candidate.rsl === line.rsl && candidate.connectingLaneRsls[0] === line.connectingLaneRsls[0]) === index,
      )
      .sort((a, b) => a.rsl.localeCompare(b.rsl) || a.connectingLaneRsls[0]!.localeCompare(b.connectingLaneRsls[0]!));
    const id = `signal:${headIds[0]}`;
    const owningControllers = controllers.filter((controller) => controller.signalIds.includes(headIds[0]!));
    const controllerIds = owningControllers.map((controller) => controller.id);
    programs.push({
      id,
      phases: defaultPhasesForHead(headIds[0]!, controllers),
      offsetS: SYNTHETIC_SIGNAL_OFFSET_S,
      loop: true,
      stopLines,
      mapBinding: {
        junctionId,
        controllerIds,
        headIds,
        controllerHeadGroups: owningControllers.map((controller) => ({
          controllerId: controller.id,
          headIds,
        })),
        timingSource: 'synthetic-default',
      },
    });
    for (const headId of headIds) programByHeadId.set(headId, id);
    for (const gate of matchingGates) {
      const existing = programsByConnectingLane.get(gate.connectingLaneRsl);
      if (existing) existing.push(id);
      else programsByConnectingLane.set(gate.connectingLaneRsl, [id]);
    }
  }
  for (const ids of programsByConnectingLane.values()) ids.sort();
  programs.sort((a, b) => a.id.localeCompare(b.id));
  return {
    junctionId,
    programs,
    programByHeadId,
    programsByConnectingLane,
    timingSource: 'synthetic-default',
    stateSource: 'synthetic-cycle',
  };
}

export function buildSiteSignalPlan(bundle: SignalMapBundle, site: MatchedSite): SiteSignalPlan {
  const junctionId = site.frame.origin.mapFeatureId.startsWith('junction:')
    ? site.frame.origin.mapFeatureId.slice('junction:'.length)
    : null;
  return buildSignalPlanForJunction(bundle, junctionId);
}

/** Bind static OpenDRIVE stop-sign furniture to the junction movements whose
 * connecting road carries that sign. Runtime dwell/release is actor-local. */
function buildRoadControlsForJunction(bundle: SignalMapBundle, junctionId: string | null): RoadControl[] {
  if (!junctionId) return [];
  const gates = bundle.topology.gates
    .filter((gate) => gate.junctionId === junctionId)
    .sort((a, b) => a.id.localeCompare(b.id));
  const controls: RoadControl[] = [];
  for (const head of bundle.signalCatalog.roadControls) {
    const seedGates = gates.filter((gate) => {
      // Most RoadRunner stop furniture is attached to the connecting road,
      // while some source maps attach it directly to the incoming approach.
      // Both are exact OpenDRIVE road identities; accepting both avoids
      // silently dropping the latter without making a proximity guess.
      const connectingRoad = String(bundle.topology.lanes[gate.connectingLaneRsl]?.roadId ?? '');
      const approachRoad = String(bundle.topology.lanes[gate.approachLaneRsl]?.roadId ?? '');
      return connectingRoad === head.roadId || approachRoad === head.roadId;
    });
    const descriptor = bundle.index.junctionDescriptors[junctionId];
    const controlledGateIds = new Set(seedGates.map((gate) => gate.id));
    for (const seed of seedGates) {
      const approach = descriptor?.approaches.find((candidate) => candidate.gateIds.includes(seed.id));
      for (const gateId of approach?.gateIds ?? []) controlledGateIds.add(gateId);
    }
    const matchingGates = gates.filter((gate) => controlledGateIds.has(gate.id));
    const stopLines = matchingGates
      .map((gate) => stopLineFor(bundle, gate))
      .filter((line): line is NonNullable<typeof line> => line !== null)
      .filter(
        (line, index, all) =>
          all.findIndex(
            (candidate) =>
              candidate.rsl === line.rsl &&
              candidate.connectingLaneRsls[0] === line.connectingLaneRsls[0],
          ) === index,
      )
      .sort((a, b) => a.rsl.localeCompare(b.rsl) || a.connectingLaneRsls[0]!.localeCompare(b.connectingLaneRsls[0]!));
    if (stopLines.length === 0) continue;
    controls.push({
      id: `road-control:${head.id}`,
      kind: 'stop',
      dwellS: 1,
      stopLines,
      mapBinding: { junctionId, controlIds: [head.id], source: 'map' },
    });
  }
  // RoadRunner often models one physical sign per lane even when the signs
  // protect the same approach movement. Treating each head as an independent
  // stop would make a car dwell repeatedly at one painted line. Coalesce only
  // exact movement sets, retaining every source control id as provenance.
  const grouped = new Map<string, RoadControl[]>();
  for (const control of controls) {
    const key = JSON.stringify(control.stopLines);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(control);
    else grouped.set(key, [control]);
  }
  return [...grouped.values()]
    .map((group) => {
      group.sort((a, b) => a.id.localeCompare(b.id));
      const first = group[0]!;
      const controlIds = [...new Set(group.flatMap((entry) => entry.mapBinding?.controlIds ?? []))].sort();
      return {
        ...first,
        id: `road-control:${controlIds[0] ?? first.id}`,
        mapBinding: first.mapBinding ? { ...first.mapBinding, controlIds } : undefined,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function buildSiteRoadControls(bundle: SignalMapBundle, site: MatchedSite): RoadControl[] {
  const junctionId = site.frame.origin.mapFeatureId.startsWith('junction:')
    ? site.frame.origin.mapFeatureId.slice('junction:'.length)
    : null;
  return buildRoadControlsForJunction(bundle, junctionId);
}

/** Bind every physical signalized junction and stop control on a loaded map.
 * This is intentionally separate from authored site binding: ambient traffic
 * is a world layer and must obey controls even when no scenario exists. */
export function buildMapControlPlan(bundle: SignalMapBundle): MapControlPlan {
  const junctionIds = new Set([
    ...bundle.signalCatalog.junctions.map((junction) => junction.junctionId),
    ...bundle.topology.gates.map((gate) => gate.junctionId),
  ]);
  const signalPrograms = [...junctionIds]
    .sort()
    .flatMap((junctionId) => buildSignalPlanForJunction(bundle, junctionId).programs);
  const roadControls = [...junctionIds]
    .sort()
    .flatMap((junctionId) => buildRoadControlsForJunction(bundle, junctionId));
  return {
    signalPrograms: signalPrograms.filter(
      (program, index, all) => all.findIndex((candidate) => candidate.id === program.id) === index,
    ),
    roadControls: roadControls.filter(
      (control, index, all) => all.findIndex((candidate) => candidate.id === control.id) === index,
    ),
  };
}

export type SiteSignalRef =
  | { readonly handle: string }
  | { readonly featureId: string; readonly approach: 'subject' | 'opposing' | 'left' | 'right' };

/** Resolve an authored signal reference against the concrete map movement.
 * Multiple physical heads can protect one movement; the stable program id sort
 * is the deterministic tie-break, never catalog or object insertion order. */
export function resolveSiteSignalProgram(
  bundle: SignalMapBundle,
  site: MatchedSite,
  plan: SiteSignalPlan,
  ref: SiteSignalRef,
): string | null {
  if ('handle' in ref) {
    return (
      plan.programs.find((program) => program.id === ref.handle)?.id ??
      plan.programByHeadId.get(ref.handle) ??
      null
    );
  }

  const match = site.featureMatches[ref.featureId];
  const expectedJunction = match?.mapFeatureId.startsWith('junction:')
    ? match.mapFeatureId.slice('junction:'.length)
    : null;
  if (!expectedJunction || expectedJunction !== plan.junctionId) return null;

  const gateById = new Map(bundle.index.gates.map((gate) => [gate.id, gate]));
  let gateId: string | undefined;
  if (ref.approach === 'subject') {
    gateId = site.frame.egoGateId;
  } else {
    const relation = ref.approach === 'opposing' ? 'opposing' : `from_${ref.approach}`;
    gateId = site.bindings.find((binding) => binding.conflict?.relation === relation)?.conflict?.gateId;
    if (!gateId && site.frame.egoGateId) {
      const descriptor = bundle.index.junctionDescriptors[expectedJunction];
      for (const pair of descriptor?.conflictPairs ?? []) {
        if (pair.gateA !== site.frame.egoGateId && pair.gateB !== site.frame.egoGateId) continue;
        const pairRelation =
          pair.gateA === site.frame.egoGateId
            ? pair.relation
            : pair.relation === 'from_left'
              ? 'from_right'
              : pair.relation === 'from_right'
                ? 'from_left'
                : pair.relation;
        if (pairRelation === relation) {
          gateId = pair.gateA === site.frame.egoGateId ? pair.gateB : pair.gateA;
          break;
        }
      }
    }
  }

  const connectingLane = gateId ? gateById.get(gateId)?.connectingLaneRsl : undefined;
  let candidates = connectingLane ? plan.programsByConnectingLane.get(connectingLane) : undefined;
  if ((!candidates || candidates.length === 0) && gateId) {
    // An unprotected movement follows another head on the same physical
    // approach. This is still map-derived; it is not a junction-wide guess.
    const descriptor = bundle.index.junctionDescriptors[expectedJunction];
    const approach = descriptor?.approaches.find((candidate) => candidate.gateIds.includes(gateId!));
    candidates = [
      ...new Set(
        (approach?.gateIds ?? []).flatMap((candidateGateId) => {
          const candidateLane = gateById.get(candidateGateId)?.connectingLaneRsl;
          return candidateLane ? [...(plan.programsByConnectingLane.get(candidateLane) ?? [])] : [];
        }),
      ),
    ].sort();
  }
  return candidates && candidates.length > 0 ? [...candidates].sort()[0]! : null;
}
