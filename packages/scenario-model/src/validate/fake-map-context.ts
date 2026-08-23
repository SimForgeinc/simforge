/**
 * An in-memory {@link MapContext} — the reference implementation of the seam.
 *
 * Shipped rather than kept in `__tests__` for two reasons: it is how
 * `sim-engine` and `apps/cloud` can exercise the validator before `map-intel`
 * lands, and it is the executable specification of what an implementation has
 * to answer. A straight corridor with a couple of features is enough to reach
 * every map-dependent check.
 *
 * Not a simulation of anything: lanes are declared as `[from, to]` intervals
 * per lane index, runway is arithmetic on those intervals, and a gate exists if
 * the caller said it does.
 */

import type {
  FeatureFacts,
  GateFacts,
  LaneChangePermissions,
  LaneFacts,
  LaneRsl,
  LaneType,
  MapContext,
  SignalFacts,
} from './map-context.js';

/** One lane of the fake corridor. */
export interface FakeLane {
  /** Frame lane index; 0 is the reference lane. */
  k: number;
  /** Where the lane exists along the frame, metres `[from, to]`. */
  extentM: [number, number];
  type?: LaneType;
  widthM?: number;
  speedLimitKph?: number | null;
  isJunctionInternal?: boolean;
  /** Lane-change legality out of this lane. Defaults to both allowed. */
  changeLeft?: boolean;
  changeRight?: boolean;
}

/** Options for {@link createFakeMapContext}. */
export interface FakeMapOptions {
  mapId?: string;
  topologyDigest?: string;
  lanes: FakeLane[];
  /** Junction movements that exist: `"<featureId>/<from>/<turn>"`. */
  gates?: Record<string, Partial<GateFacts>>;
  signals?: Record<string, string[]>;
  features?: Record<string, Partial<FeatureFacts> & { kind: string }>;
}

/** Build a {@link MapContext} over a straight declared corridor. */
export function createFakeMapContext(options: FakeMapOptions): MapContext {
  const lanes = [...options.lanes].sort((a, b) => a.k - b.k || a.extentM[0] - b.extentM[0]);
  const mapId = options.mapId ?? 'fake-map';

  const findLane = (k: number, s: number): FakeLane | undefined =>
    lanes.find((lane) => lane.k === k && s >= lane.extentM[0] && s <= lane.extentM[1]);

  const factsFor = (lane: FakeLane): LaneFacts => ({
    rsl: `${mapId}:${lane.k}:${lane.extentM[0]}` as LaneRsl,
    type: lane.type ?? 'driving',
    k: lane.k,
    widthM: lane.widthM ?? 3.5,
    speedLimitKph: lane.speedLimitKph === undefined ? 50 : lane.speedLimitKph,
    isJunctionInternal: lane.isJunctionInternal ?? false,
  });

  /** Contiguous drivable run through abutting intervals of the same lane index. */
  const runway = (k: number, s: number, direction: 1 | -1): number => {
    let cursor = s;
    for (;;) {
      const lane = findLane(k, direction === 1 ? cursor : cursor - 1e-6);
      if (!lane) return Math.max(0, direction === 1 ? cursor - s : s - cursor);
      const edge = direction === 1 ? lane.extentM[1] : lane.extentM[0];
      if (edge === cursor) return Math.max(0, direction === 1 ? cursor - s : s - cursor);
      cursor = edge;
    }
  };

  return {
    mapId,
    topologyDigest: options.topologyDigest ?? 'fake-digest',
    laneAt(k, s) {
      const lane = findLane(k, s);
      return lane ? factsFor(lane) : undefined;
    },
    lane(rsl) {
      const lane = lanes.find((l) => factsFor(l).rsl === rsl);
      return lane ? factsFor(lane) : undefined;
    },
    successors(rsl) {
      const lane = lanes.find((l) => factsFor(l).rsl === rsl);
      if (!lane) return [];
      return lanes
        .filter((l) => l.k === lane.k && l.extentM[0] === lane.extentM[1])
        .map((l) => factsFor(l).rsl);
    },
    laneChangePermissions(k, s): LaneChangePermissions {
      const lane = findLane(k, s);
      return { left: lane?.changeLeft ?? true, right: lane?.changeRight ?? true };
    },
    gate(featureId, from, turn) {
      const entry = options.gates?.[`${featureId}/${from}/${turn}`];
      if (!entry) return undefined;
      return {
        gateId: `${featureId}/${from}/${turn}`,
        conflictS: entry.conflictS ?? 0,
        crossingAngleDeg: entry.crossingAngleDeg ?? 90,
        lengthM: entry.lengthM ?? 20,
      };
    },
    signal(ref) {
      const handle = 'handle' in ref ? ref.handle : `${ref.featureId}:${ref.approach}`;
      const phases = options.signals?.[handle];
      return phases ? ({ handle, phases } satisfies SignalFacts) : undefined;
    },
    feature(featureId) {
      const entry = options.features?.[featureId];
      if (!entry) return undefined;
      return {
        featureId,
        kind: entry.kind,
        atM: entry.atM ?? 0,
        lengthM: entry.lengthM ?? null,
        sizeM: entry.sizeM ?? null,
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
