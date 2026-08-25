import type { ScenarioTemplateV2 } from '@simforge/scenario';
import { MATCH_SEMANTICS_VERSION, type FeatureBinding, type MatchedSite, type ReferenceSpan } from './anchor/index.js';
import { buildFollowRoute } from '@simforge/engine';
import { CliError } from './errors.js';
import { materialize, type MaterializeOptions, type MaterializeResult } from './materialize.js';
import type { MapBundle } from './types.js';

/**
 * First-class materialization for Studio's map-bound v2 document. It supplies
 * an exact synthetic site around the authored lane/pose, then delegates every
 * actor, choreography, trigger, dynamics, until, prop, and invariant mapping
 * to the same Materializer used by portable scenarios.
 */
export function materializeMapBound(
  template: ScenarioTemplateV2,
  bundle: MapBundle,
  options: MaterializeOptions = {},
): MaterializeResult {
  if (template.anchor.pin?.mapId !== bundle.mapId) {
    throw new CliError('map_pin_mismatch', `scenario is pinned to ${template.anchor.pin?.mapId ?? 'no map'}, not ${bundle.mapId}`, { path: 'anchor.pin.mapId' });
  }
  if (template.roles.some((role) => role.kind !== 'scene_absolute')) {
    throw new CliError('map_bound_roles_required', 'map-bound materialization cannot mix portable roles', { path: 'roles' });
  }
  return materialize(template, bundle, syntheticStudioSite(template, bundle), options);
}

function syntheticStudioSite(template: ScenarioTemplateV2, bundle: MapBundle): MatchedSite {
  const first = template.roles[0]!;
  if (!first) {
    return {
      siteId: `studio:${bundle.mapId}`,
      mapId: bundle.mapId,
      topologyDigest: bundle.index.topologyDigest,
      matchSemanticsVersion: MATCH_SEMANTICS_VERSION,
      anchorId: template.anchor.id ?? template.meta.name,
      score: 1,
      frame: {
        origin: { anchorFeatureId: 'studio-map-bound', kind: 'corridor', mapFeatureId: `map:${bundle.mapId}` },
        entryLaneRsl: 'studio:empty',
        referencePath: [],
        sOfLane: {},
        sRange: [0, 0],
        lateralLanes: {},
        opposingLanes: [],
        handedness: 'right',
        mirrored: false,
        runwayUpstreamM: 0,
        runwayDownstreamM: 0,
      },
      clauses: [],
      bindings: [],
      featureMatches: {},
      degradation: { verdict: 'exact', score: 1, repairs: [], failedRequiredClauses: [], summary: 'empty map-bound Studio scene', intentPreserved: true },
      matchedReasons: ['anchor.pin.mapId', 'empty-scene'],
      alternateFrames: 0,
    };
  }
  if (first.kind !== 'scene_absolute') throw new Error('unreachable');
  const firstLane = first.laneRef
    ? `${first.laneRef.roadId}:${first.laneRef.section}:${first.laneRef.laneId}`
    : null;
  const route = firstLane ? buildFollowRoute(bundle.graph, firstLane, [], 2_000) : null;
  if (route && !route.ok) {
    throw new CliError(route.error.code, route.error.reason, { path: `roles.${first.id}.laneRef`, detail: route.error.detail });
  }
  const lanes = route?.ok ? route.route.legs.map((leg) => leg.rsl) : [];
  const referencePath: ReferenceSpan[] = route?.ok
    ? route.route.legs.map((leg) => ({
        laneRsl: leg.rsl,
        sStart: leg.sStart,
        sEnd: leg.sStart + leg.lengthM,
        lengthM: leg.lengthM,
        isJunction: bundle.graph.geometry(leg.rsl)?.lane.isJunction ?? false,
        contiguous: true,
      }))
    : [];
  const entryLaneRsl = firstLane ?? 'studio:freeform';
  const bindings: FeatureBinding[] = template.roles.map((role) => {
    if (role.kind !== 'scene_absolute') throw new Error('unreachable');
    const rsl = role.laneRef
      ? `${role.laneRef.roadId}:${role.laneRef.section}:${role.laneRef.laneId}`
      : undefined;
    const ownRoute = rsl ? buildFollowRoute(bundle.graph, rsl, [], 2_000) : null;
    if (ownRoute && !ownRoute.ok) {
      throw new CliError(ownRoute.error.code, ownRoute.error.reason, { path: `roles.${role.id}.laneRef`, detail: ownRoute.error.detail });
    }
    return {
      role: role.id,
      kind: 'on_reference',
      status: 'bound',
      ...(rsl ? { laneRsl: rsl, routeLaneChain: ownRoute?.ok ? ownRoute.route.legs.map((leg) => leg.rsl) : [rsl] } : {}),
      notes: [],
    };
  });
  return {
    siteId: `studio:${bundle.mapId}`,
    mapId: bundle.mapId,
    topologyDigest: bundle.index.topologyDigest,
    matchSemanticsVersion: MATCH_SEMANTICS_VERSION,
    anchorId: template.anchor.id ?? template.meta.name,
    score: 1,
    frame: {
      origin: { anchorFeatureId: 'studio-map-bound', kind: 'corridor', mapFeatureId: `map:${bundle.mapId}` },
      entryLaneRsl,
      referencePath,
      sOfLane: Object.fromEntries(referencePath.map((span) => [span.laneRsl, span.sStart])),
      sRange: [0, route?.ok ? route.route.lengthM : 2_000],
      lateralLanes: firstLane ? { 0: firstLane } : {},
      opposingLanes: [],
      handedness: 'right',
      mirrored: false,
      runwayUpstreamM: first.laneRef?.s ?? 0,
      runwayDownstreamM: route?.ok ? Math.max(0, route.route.lengthM - (first.laneRef?.s ?? 0)) : 2_000,
    },
    clauses: [],
    bindings,
    featureMatches: {},
    degradation: { verdict: 'exact', score: 1, repairs: [], failedRequiredClauses: [], summary: 'exact map-bound Studio placement', intentPreserved: true },
    matchedReasons: ['anchor.pin.mapId', 'scene_absolute'],
    alternateFrames: 0,
  };
}
