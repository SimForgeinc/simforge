/**
 * `MapContext` over a real map — the implementation `scenario-model` declared
 * and deliberately did not write.
 *
 * The interface asks its questions in **AnchorFrame** coordinates (`k`, `s`),
 * which is exactly what a matched site provides: `frame.referencePath` turns
 * `s` into a lane, `frame.lateralLanes` turns `k` into a parallel lane, and
 * everything else is a lookup in `map-intel`'s derived index. That is the whole
 * reason the seam was drawn in frame coordinates: the validator never learns a
 * road id, and this file never learns what a template is.
 *
 * Without a site (`uniscenarios template validate --map` with no `--site`) there is no
 * frame, so there is no context: the map-dependent checks are skipped and the
 * report says `mapChecked: false` rather than passing checks it did not run.
 */

import type { DerivedMapIndex, MatchedSite } from './anchor/index.js';
import type {
  FeatureFacts,
  GateFacts,
  LaneChangePermissions,
  LaneFacts,
  LaneRsl,
  LaneType,
  MapContext,
  SignalFacts,
} from '@simforge/scenario';
import type { MapBundle } from './maps.js';
import { buildSiteSignalPlan, resolveSiteSignalProgram } from './map-signals.js';

const LANE_TYPES = new Set<LaneType>([
  'driving',
  'shoulder',
  'sidewalk',
  'biking',
  'parking',
  'median',
  'restricted',
  'crosswalk',
]);

function laneType(raw: string): LaneType {
  return LANE_TYPES.has(raw as LaneType) ? (raw as LaneType) : 'other';
}

/** Build a `MapContext` for one matched site. */
export function createMapContext(source: DerivedMapIndex | MapBundle, site: MatchedSite): MapContext {
  const bundle = 'index' in source && 'signalCatalog' in source ? source : null;
  const index = bundle?.index ?? (source as DerivedMapIndex);
  const frame = site.frame;
  const signalPlan = bundle ? buildSiteSignalPlan(bundle, site) : null;

  const laneFacts = (rsl: string, k: number, s: number): LaneFacts | undefined => {
    const lane = index.lanes[rsl];
    if (!lane) return undefined;
    const width =
      lane.widthSamples.length > 0
        ? (lane.widthSamples.reduce(
            (best, sample) => (Math.abs(sample.s - s) < Math.abs(best.s - s) ? sample : best),
            lane.widthSamples[0]!,
          ).widthM)
        : lane.representativeWidthM;
    return {
      rsl: rsl as LaneRsl,
      type: laneType(lane.laneType),
      k,
      widthM: width,
      speedLimitKph: Number.isFinite(lane.speedLimitKph) ? lane.speedLimitKph : null,
      isJunctionInternal: lane.isJunction,
    };
  };

  const spanAt = (s: number) => frame.referencePath.find((sp) => s >= sp.sStart && s <= sp.sEnd);

  const kOf = (rsl: string): number => {
    for (const [key, value] of Object.entries(frame.lateralLanes)) {
      if (value === rsl) return Number(key);
    }
    return 0;
  };

  /** Contiguous drivable metres from `(k, s)` in one direction. */
  const runway = (k: number, s: number, direction: 1 | -1): number => {
    if (k === 0) {
      return direction > 0 ? Math.max(0, frame.sRange[1] - s) : Math.max(0, s - frame.sRange[0]);
    }
    const rsl = frame.lateralLanes[k];
    if (!rsl) return 0;
    let total = index.lanes[rsl]?.lengthM ?? 0;
    let cursor = rsl;
    const seen = new Set<string>([cursor]);
    for (let step = 0; step < 32; step += 1) {
      const lane = index.lanes[cursor];
      if (!lane) break;
      const next = (direction > 0 ? lane.successors : lane.predecessors).find(
        (r) => !seen.has(r) && index.lanes[r]?.laneType === 'driving',
      );
      if (!next) break;
      seen.add(next);
      total += index.lanes[next]?.lengthM ?? 0;
      cursor = next;
    }
    return total;
  };

  return {
    mapId: index.mapId,
    topologyDigest: index.topologyDigest,

    laneAt(k, s) {
      if (k === 0) {
        const span = spanAt(s);
        if (!span) return undefined;
        return laneFacts(span.laneRsl, 0, s - span.sStart);
      }
      const rsl = frame.lateralLanes[k];
      if (!rsl) return undefined;
      // A parallel lane's own arc length is not the frame's; the origin
      // cross-section is where `k` is defined, so width is read there.
      return laneFacts(rsl, k, 0);
    },

    lane(rsl) {
      return laneFacts(rsl, kOf(rsl), 0);
    },

    successors(rsl) {
      return (index.lanes[rsl]?.successors ?? []) as unknown as readonly LaneRsl[];
    },

    laneChangePermissions(k, s): LaneChangePermissions {
      const rsl = k === 0 ? spanAt(s)?.laneRsl : frame.lateralLanes[k];
      const lane = rsl ? index.lanes[rsl] : undefined;
      if (!lane) return { left: false, right: false };
      const span = k === 0 ? spanAt(s) : undefined;
      const local = span ? s - span.sStart : 0;
      const at = (side: 'left' | 'right'): boolean => {
        const windows = lane.laneChangePermissions.filter((p) => p.side === side);
        if (windows.length === 0) return !lane.isJunction;
        return windows.some((p) => local >= p.startS && local <= p.endS && p.allowed);
      };
      return { left: at('left'), right: at('right') };
    },

    gate(featureId, from, turn): GateFacts | undefined {
      const match = site.featureMatches[featureId];
      if (!match?.mapFeatureId.startsWith('junction:')) return undefined;
      const junctionId = match.mapFeatureId.slice('junction:'.length);
      const descriptor = index.junctionDescriptors[junctionId];
      const egoGateId = frame.egoGateId;
      if (!descriptor || !egoGateId) return undefined;
      const byId = new Map(index.gates.map((g) => [g.id, g]));
      for (const pair of descriptor.conflictPairs) {
        if (pair.gateA !== egoGateId && pair.gateB !== egoGateId) continue;
        const otherId = pair.gateA === egoGateId ? pair.gateB : pair.gateA;
        const other = byId.get(otherId);
        if (!other || other.turnRelation !== turn) continue;
        const relation =
          pair.gateA === egoGateId
            ? pair.relation
            : pair.relation === 'from_left'
              ? 'from_right'
              : pair.relation === 'from_right'
                ? 'from_left'
                : pair.relation;
        if (relation !== from) continue;
        const sOnEgo = pair.gateA === egoGateId ? pair.sOnA : pair.sOnB;
        const egoConnecting = frame.egoGateId ? byId.get(frame.egoGateId)?.connectingLaneRsl : undefined;
        const base = egoConnecting ? (frame.sOfLane[egoConnecting] ?? 0) : 0;
        return {
          gateId: other.id,
          conflictS: base + sOnEgo,
          crossingAngleDeg: pair.crossingAngleDeg,
          lengthM: index.lanes[other.connectingLaneRsl]?.lengthM ?? 0,
        };
      }
      return undefined;
    },

    signal(ref): SignalFacts | undefined {
      if (!bundle || !signalPlan) return undefined;
      const handle = resolveSiteSignalProgram(bundle, site, signalPlan, ref);
      if (!handle) return undefined;
      const program = signalPlan.programs.find((candidate) => candidate.id === handle);
      if (!program) return undefined;
      return {
        handle,
        phases: [...new Set(program.phases.map((phase) => phase.phase))],
      };
    },

    feature(featureId): FeatureFacts | undefined {
      const match = site.featureMatches[featureId];
      if (!match) return undefined;
      const junctionId = match.mapFeatureId.startsWith('junction:')
        ? match.mapFeatureId.slice('junction:'.length)
        : null;
      const descriptor = junctionId ? index.junctionDescriptors[junctionId] : undefined;
      return {
        featureId,
        kind: match.kind,
        atM: match.s,
        lengthM: null,
        sizeM: descriptor?.sizeM ?? null,
      };
    },

    forwardRunwayM(k, s) {
      return runway(k, s, 1);
    },

    upstreamRunwayM(k, s) {
      return runway(k, s, -1);
    },
  };
}
