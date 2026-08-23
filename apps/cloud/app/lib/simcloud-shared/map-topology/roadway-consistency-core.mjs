/** Canonical dependency-free roadway-consistency scanner (plain Node ESM). */
export const ROADWAY_CONSISTENCY_FORMAT = 'simforge.roadway-consistency.v1';

const DEFAULTS = Object.freeze({
  sampleStepM: 1,
  spatialCellM: 10,
  maxCenterDistanceM: 7,
  maxHeadingDeltaDeg: 22.5,
  maxElevationDeltaM: 1.5,
  minIntervalLengthM: 4,
});
const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const pair = (a, b) => a.localeCompare(b) <= 0 ? [a, b] : [b, a];

function samplesFor(lane, stepM, elevations) {
  if (lane.polyline.length < 2) return [];
  const cumulative = [0];
  for (let i = 1; i < lane.polyline.length; i += 1) {
    cumulative.push(cumulative[i - 1] + distance(lane.polyline[i - 1], lane.polyline[i]));
  }
  const totalDistance = cumulative.at(-1);
  if (!(totalDistance > 0)) return [];
  const count = Math.max(2, Math.ceil(totalDistance / stepM) + 1);
  const samples = [];
  let segment = 0;
  for (let index = 0; index < count; index += 1) {
    const along = index === count - 1 ? totalDistance : index * totalDistance / (count - 1);
    while (segment + 1 < cumulative.length - 1 && cumulative[segment + 1] < along) segment += 1;
    const segmentLength = cumulative[segment + 1] - cumulative[segment];
    const fraction = segmentLength > 0 ? (along - cumulative[segment]) / segmentLength : 0;
    const a = lane.polyline[segment];
    const b = lane.polyline[segment + 1];
    const tangentLength = Math.max(distance(a, b), Number.EPSILON);
    const za = elevations?.[Math.min(segment, elevations.length - 1)];
    const zb = elevations?.[Math.min(segment + 1, elevations.length - 1)];
    samples.push({
      rsl: lane.rsl,
      index,
      point: { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction },
      tangent: { x: (b.x - a.x) / tangentLength, y: (b.y - a.y) / tangentLength },
      along,
      totalDistance,
      elevation: Number.isFinite(za) && Number.isFinite(zb) ? za + (zb - za) * fraction : null,
    });
  }
  return samples;
}

function semanticNeighbor(lane, otherRsl) {
  return lane.adjacentLanes?.left?.laneRsl === otherRsl
    || lane.adjacentLanes?.right?.laneRsl === otherRsl;
}

function changeAllowed(lane, otherRsl) {
  const adjacent = lane.adjacentLanes?.left?.laneRsl === otherRsl
    ? lane.adjacentLanes.left
    : lane.adjacentLanes?.right?.laneRsl === otherRsl ? lane.adjacentLanes.right : null;
  if (!adjacent?.sameDirection) return false;
  const ids = new Set(adjacent.permissionIds);
  return (lane.laneChangePermissions ?? []).some((permission) => permission.allowed && ids.has(permission.id));
}

function junctionContinuity(a, b, lanes) {
  if (!a.isJunction || !b.isJunction || a.junctionId !== b.junctionId) return false;
  for (const edge of ['predecessors', 'successors']) {
    for (const arsl of a[edge]) for (const brsl of b[edge]) {
      const alane = lanes[arsl];
      const blane = lanes[brsl];
      if (alane && blane && (semanticNeighbor(alane, brsl) || semanticNeighbor(blane, arsl))) return true;
    }
  }
  return false;
}

/**
 * Infers sustained mutual lateral adjacency in O(N log N + K) expected time
 * via a spatial hash, then compares it with the OpenDRIVE-derived contract.
 */
export function validateRoadwayConsistency(topology, options = {}) {
  const config = Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => [key, options[key] ?? value]));
  const lanes = Object.values(topology.lanes)
    .filter((lane) => lane.laneType === 'driving' && lane.polyline?.length >= 2)
    .sort((a, b) => a.rsl.localeCompare(b.rsl));
  const lanesByRsl = Object.fromEntries(lanes.map((lane) => [lane.rsl, lane]));
  const samplesByLane = new Map();
  const grid = new Map();
  for (const lane of lanes) {
    const samples = samplesFor(lane, config.sampleStepM, options.laneElevationsM?.[lane.rsl]);
    samplesByLane.set(lane.rsl, samples);
    for (const sample of samples) {
      const key = `${Math.floor(sample.point.x / config.spatialCellM)},${Math.floor(sample.point.y / config.spatialCellM)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(sample);
    }
  }

  const nearest = new Map();
  const candidatePairs = new Set();
  const radius = Math.ceil(config.maxCenterDistanceM / config.spatialCellM);
  for (const samples of samplesByLane.values()) for (const source of samples) {
    const cx = Math.floor(source.point.x / config.spatialCellM);
    const cy = Math.floor(source.point.y / config.spatialCellM);
    for (let dx = -radius; dx <= radius; dx += 1) for (let dy = -radius; dy <= radius; dy += 1) {
      for (const target of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
        if (target.rsl === source.rsl) continue;
        const centerDistance = distance(source.point, target.point);
        if (centerDistance < 1 || centerDistance > config.maxCenterDistanceM) continue;
        const sourceWidth = lanesByRsl[source.rsl].representativeWidthM;
        const targetWidth = lanesByRsl[target.rsl].representativeWidthM;
        if (Number.isFinite(sourceWidth) && Number.isFinite(targetWidth)) {
          const expectedCenterDistance = (sourceWidth + targetWidth) / 2;
          if (Math.abs(centerDistance - expectedCenterDistance)
            > Math.max(1, expectedCenterDistance * 0.35)) continue;
        }
        const dot = clamp(source.tangent.x * target.tangent.x + source.tangent.y * target.tangent.y, -1, 1);
        const headingDeltaDeg = Math.acos(dot) * 180 / Math.PI;
        if (headingDeltaDeg > config.maxHeadingDeltaDeg) continue;
        if (source.elevation !== null && target.elevation !== null
          && Math.abs(source.elevation - target.elevation) > config.maxElevationDeltaM) continue;
        const delta = { x: target.point.x - source.point.x, y: target.point.y - source.point.y };
        const longitudinal = Math.abs(delta.x * source.tangent.x + delta.y * source.tangent.y);
        if (longitudinal > Math.max(config.sampleStepM * 1.5, 1.5)) continue;
        const cross = source.tangent.x * delta.y - source.tangent.y * delta.x;
        if (Math.abs(cross) < 0.5) continue;
        const side = cross > 0 ? 'left' : 'right';
        const [pa, pb] = pair(source.rsl, target.rsl);
        candidatePairs.add(`${pa}|${pb}`);
        const key = `${source.rsl}:${source.index}:${side}`;
        const old = nearest.get(key);
        if (!old || centerDistance < old.centerDistance
          || (centerDistance === old.centerDistance && target.rsl.localeCompare(old.target.rsl) < 0)) {
          nearest.set(key, { source, target, side, centerDistance, headingDeltaDeg });
        }
      }
    }
  }

  const observationsByPair = new Map();
  for (const observation of nearest.values()) {
    const reverseSide = observation.side === 'left' ? 'right' : 'left';
    const reverse = nearest.get(`${observation.target.rsl}:${observation.target.index}:${reverseSide}`);
    if (!reverse || reverse.target.rsl !== observation.source.rsl) continue;
    const [a, b] = pair(observation.source.rsl, observation.target.rsl);
    if (observation.source.rsl !== a) continue;
    const key = `${a}|${b}`;
    if (!observationsByPair.has(key)) observationsByPair.set(key, []);
    observationsByPair.get(key).push(observation);
  }

  const intervals = [];
  for (const [key, observations] of [...observationsByPair.entries()].sort()) {
    const [laneARsl, laneBRsl] = key.split('|');
    const laneA = lanesByRsl[laneARsl];
    const laneB = lanesByRsl[laneBRsl];
    observations.sort((a, b) => a.source.along - b.source.along);
    const runs = [];
    for (const observation of observations) {
      const run = runs.at(-1);
      if (!run || observation.source.along - run.at(-1).source.along > config.sampleStepM * 2.1) runs.push([observation]);
      else run.push(observation);
    }
    for (const run of runs) {
      const start = run[0].source.along;
      const end = run.at(-1).source.along;
      const lengthM = Math.max(0, end - start);
      if (lengthM < config.minIntervalLengthM) continue;
      const continuity = junctionContinuity(laneA, laneB, lanesByRsl);
      const maxHeadingDeltaDeg = Math.max(...run.map((value) => value.headingDeltaDeg));
      const semanticAdjacent = semanticNeighbor(laneA, laneBRsl) && semanticNeighbor(laneB, laneARsl);
      intervals.push({
        laneARsl, laneBRsl, sideFromA: run[0].side,
        startDistanceA: start, endDistanceA: end,
        startFractionA: start / run[0].source.totalDistance,
        endFractionA: end / run[0].source.totalDistance,
        lengthM,
        meanCenterDistanceM: run.reduce((sum, value) => sum + value.centerDistance, 0) / run.length,
        maxHeadingDeltaDeg,
        sampleCount: run.length,
        junctionContinuity: continuity,
        semanticAdjacent,
        semanticLaneChangeAllowed: changeAllowed(laneA, laneBRsl) || changeAllowed(laneB, laneARsl),
        confidence: clamp(0.55 + Math.min(1, lengthM / 12) * 0.35
          - maxHeadingDeltaDeg / config.maxHeadingDeltaDeg * 0.1 + (continuity ? 0.1 : 0), 0, 1),
      });
    }
  }
  intervals.sort((a, b) => a.laneARsl.localeCompare(b.laneARsl)
    || a.laneBRsl.localeCompare(b.laneBRsl) || a.startDistanceA - b.startDistanceA);

  const issues = [];
  intervals.forEach((interval, intervalIndex) => {
    if (interval.semanticAdjacent) return;
    const code = interval.junctionContinuity ? 'JUNCTION_ADJACENCY_DROPPED' : 'GEOMETRIC_ADJACENCY_SEMANTIC_MISSING';
    issues.push({
      id: `${code}:${interval.laneARsl}:${interval.laneBRsl}:${intervalIndex}`,
      code,
      severity: interval.junctionContinuity && interval.confidence >= 0.8 ? 'error' : 'warning',
      laneARsl: interval.laneARsl,
      laneBRsl: interval.laneBRsl,
      intervalIndex,
      message: interval.junctionContinuity
        ? `${interval.laneARsl} and ${interval.laneBRsl} remain mutually adjacent through junction ${lanesByRsl[interval.laneARsl].junctionId}, but topology drops their lateral relationship.`
        : `${interval.laneARsl} and ${interval.laneBRsl} are sustained mutually-nearest lanes, but topology declares no mutual lateral relationship.`,
    });
  });
  const geometricallyPaired = new Set(intervals.map((value) => `${value.laneARsl}|${value.laneBRsl}`));
  for (const laneA of lanes) for (const neighbor of [laneA.adjacentLanes?.left, laneA.adjacentLanes?.right]) {
    if (!neighbor?.laneRsl || !lanesByRsl[neighbor.laneRsl]) continue;
    const [a, b] = pair(laneA.rsl, neighbor.laneRsl);
    if (laneA.rsl !== a || geometricallyPaired.has(`${a}|${b}`)) continue;
    issues.push({ id: `SEMANTIC_ADJACENCY_NOT_GEOMETRIC:${a}:${b}`, code: 'SEMANTIC_ADJACENCY_NOT_GEOMETRIC', severity: 'warning', laneARsl: a, laneBRsl: b, intervalIndex: null, message: `${a} and ${b} are authored as adjacent, but no sustained mutually-nearest geometric interval was found.` });
  }
  issues.sort((a, b) => a.id.localeCompare(b.id));
  return {
    format: ROADWAY_CONSISTENCY_FORMAT,
    mapName: topology.mapName,
    sourceXodrSha256: topology.source?.xodrSha256 ?? null,
    config,
    stats: { eligibleLaneCount: lanes.length, candidatePairCount: candidatePairs.size, inferredIntervalCount: intervals.length, issueCount: issues.length },
    intervals,
    issues,
  };
}
