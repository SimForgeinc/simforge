/**
 * Tier-1 checks that need a map, asked through {@link MapContext}.
 *
 * These are the cheap geometric truths that catch the failure modes observed in
 * production scenario pipelines: actors spawned on top of each other, actors
 * spawned on a sidewalk, lane changes into lanes that do not exist, triggers
 * bound to signals the map does not have, and — the expensive one —
 * **runway_insufficient**, checked over the *whole clip* rather than the
 * labelled event window. It is a quality warning: reaching the end of an
 * authored route is a supported terminal condition and the actor stops there.
 *
 * Every check degrades to silence when the context cannot answer. A validator
 * that reports failures caused by an incomplete map index would be worse than
 * useless: it would train people to ignore it.
 */

import { tryEvaluateExpr, type ExprScope, type NumberOrExpr } from '../expr/index.js';
import { conditionLeaves } from '../schema/v2/interactions.js';
import { roleDims, rolePose, VRU_CLASSES, type RoleBinding } from '../schema/v2/roles.js';
import type { ScenarioTemplateV2 } from '../schema/v2/template.js';
import { issue, joinPath, type ClauseResult } from './issues.js';
import type { LaneFacts, MapContext } from './map-context.js';
import { staticScope } from './structural.js';

/** Lane surfaces a road vehicle may legally start on. */
const VEHICLE_LANES = new Set(['driving', 'parking', 'shoulder', 'restricted']);
/** Lane surfaces a VRU may legally start on. */
const VRU_LANES = new Set(['sidewalk', 'biking', 'crosswalk', 'shoulder', 'median', 'parking']);

/** Speeds above `limit * this` are flagged. Traffic runs a little over the limit. */
const SPEED_TOLERANCE = 1.15;

interface PlacedRole {
  role: RoleBinding;
  index: number;
  k: number;
  s: number;
  lane: LaneFacts | undefined;
}

function scopeFor(lane: LaneFacts | undefined, base: ExprScope, junctionSizeM?: number): ExprScope {
  return {
    ...base,
    lane: lane ? { speedLimitKph: lane.speedLimitKph ?? undefined, widthM: lane.widthM } : undefined,
    junction: junctionSizeM === undefined ? undefined : { sizeM: junctionSizeM },
  };
}

function num(value: NumberOrExpr | undefined, scope: ExprScope): number | undefined {
  if (value === undefined) return undefined;
  const outcome = tryEvaluateExpr(value, scope);
  return outcome.status === 'value' ? outcome.value : undefined;
}

/**
 * Run the map-dependent tier-1 checks.
 *
 * @param template A validated template.
 * @param map The bound site's view of the map.
 */
export function mapIssues(template: ScenarioTemplateV2, map: MapContext): ClauseResult[] {
  const out: ClauseResult[] = [];
  const base = staticScope(template);
  const junctionSize = firstJunctionSize(template, map);

  // --- role placement ------------------------------------------------------
  const placed: PlacedRole[] = [];
  template.roles.forEach((role, index) => {
    if (role.kind === 'scene_absolute') return; // not expressed in frame coordinates
    if (role.kind === 'at_lane_drop') return; // concrete k/lane is owned by the feature-aware matcher
    const pose = rolePose(role);
    if (!pose) return; // solver-placed kinds: nothing static to check yet
    const k = role.kind === 'lane_offset' ? role.k : pose.laneOffset;
    const s = num(pose.s, scopeFor(undefined, base, junctionSize));
    if (s === undefined) return; // depends on a site fact we cannot resolve here
    const lane = map.laneAt(k, s);
    placed.push({ role, index, k, s, lane });

    const path = joinPath('roles', index);
    if (!lane) {
      const severity =
        role.kind === 'lane_offset' && role.onMissing !== 'fail'
          ? role.onMissing === 'clamp'
            ? 'warning'
            : 'info'
          : 'error';
      out.push(
        issue(
          severity,
          'role_unbound',
          joinPath(path, 'pose'),
          `no lane at frame position (k=${k}, s=${s} m) on ${map.mapId}${
            role.kind === 'lane_offset' && role.onMissing !== 'fail'
              ? `; onMissing="${role.onMissing}" will handle it`
              : ''
          }`,
          { required: `lane at k=${k}`, actual: null },
        ),
      );
      return;
    }

    const isVru = VRU_CLASSES.has(role.actor.class);
    const legal = isVru ? VRU_LANES : VEHICLE_LANES;
    if (!legal.has(lane.type)) {
      out.push(
        issue(
          'error',
          'wrong_lane_type',
          joinPath(path, 'pose'),
          `role "${role.id}" is a ${role.actor.class} but frame position (k=${k}, s=${s} m) is a "${lane.type}" lane`,
          { required: [...legal].sort(), actual: lane.type },
        ),
      );
    }

    const scope = scopeFor(lane, base, junctionSize);
    const speedKph = num(role.initialSpeedKph, scope) ?? lane.speedLimitKph ?? undefined;
    if (
      role.initialSpeedKph !== undefined &&
      lane.speedLimitKph !== null &&
      (num(role.initialSpeedKph, scope) ?? 0) > lane.speedLimitKph * SPEED_TOLERANCE
    ) {
      out.push(
        issue(
          'warning',
          'speed_over_limit',
          joinPath(path, 'initialSpeedKph'),
          `role "${role.id}" starts at ${num(role.initialSpeedKph, scope)} kph where the limit is ${lane.speedLimitKph} kph`,
          { required: lane.speedLimitKph, actual: num(role.initialSpeedKph, scope) },
        ),
      );
    }

    if (speedKph !== undefined && speedKph > 0) {
      const needM = (speedKph / 3.6) * template.choreography.clipSeconds;
      const haveM = map.forwardRunwayM(k, s);
      if (haveM < needM) {
        out.push(
          issue(
            'warning',
            'runway_insufficient',
            path,
            `role "${role.id}" needs ${needM.toFixed(0)} m of road ahead to travel the whole ${template.choreography.clipSeconds}s clip at ${speedKph.toFixed(0)} kph, but only ${haveM.toFixed(0)} m is drivable`,
            { required: Math.round(needM), actual: Math.round(haveM) },
          ),
        );
      }
      const warmupM = (speedKph / 3.6) * template.choreography.warmupSeconds;
      const upstreamM = map.upstreamRunwayM(k, s);
      if (upstreamM < warmupM) {
        out.push(
          issue(
            'warning',
            'runway_insufficient',
            path,
            `role "${role.id}" has ${upstreamM.toFixed(0)} m of run-up but needs ${warmupM.toFixed(0)} m to reach ${speedKph.toFixed(0)} kph during the warm-up; it will appear already at speed`,
            { required: Math.round(warmupM), actual: Math.round(upstreamM) },
          ),
        );
      }
    }
  });

  // --- spawn overlap -------------------------------------------------------
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i] as PlacedRole;
      const b = placed[j] as PlacedRole;
      if (a.k !== b.k) continue;
      const clearance = (roleDims(a.role).length + roleDims(b.role).length) / 2;
      const gap = Math.abs(a.s - b.s);
      if (gap < clearance) {
        out.push(
          issue(
            'error',
            'spawn_overlap',
            joinPath('roles', a.index, 'pose'),
            `roles "${a.role.id}" and "${b.role.id}" start ${gap.toFixed(1)} m apart in lane k=${a.k}, but their footprints need ${clearance.toFixed(1)} m`,
            { required: Number(clearance.toFixed(1)), actual: Number(gap.toFixed(1)) },
          ),
        );
      }
    }
  }

  const placedById = new Map(placed.map((p) => [p.role.id, p] as const));

  // --- interactions --------------------------------------------------------
  template.choreography.interactions.forEach((interaction, index) => {
    const path = joinPath('choreography', 'interactions', index);
    const actor = placedById.get(interaction.actor);

    if (interaction.verb === 'changeLane' && actor) {
      const targetK =
        interaction.target.mode === 'relative'
          ? actor.k + interaction.target.dk
          : interaction.target.mode === 'absolute'
            ? interaction.target.k
            : placedById.get(interaction.target.role)?.k;
      if (targetK !== undefined) {
        if (!map.laneAt(targetK, actor.s)) {
          out.push(
            issue(
              'error',
              'illegal_lane_change',
              joinPath(path, 'target'),
              `"${interaction.actor}" changes into lane k=${targetK}, which does not exist at s=${actor.s} m`,
              { required: `lane k=${targetK}`, actual: null },
            ),
          );
        } else if (targetK !== actor.k) {
          const permissions = map.laneChangePermissions(actor.k, actor.s);
          const allowed = targetK > actor.k ? permissions.left : permissions.right;
          if (!allowed) {
            out.push(
              issue(
                'warning',
                'illegal_lane_change',
                joinPath(path, 'target'),
                `lane markings at s=${actor.s} m forbid a ${targetK > actor.k ? 'left' : 'right'} lane change; tier 2 confirms against the actual crossing point`,
                { required: targetK > actor.k ? 'left change allowed' : 'right change allowed', actual: false },
              ),
            );
          }
        }
      }
    }

    if (interaction.verb === 'route' && interaction.target.mode === 'turn') {
      if (!map.gate(interaction.target.feature, 'same', interaction.target.turn)) {
        out.push(
          issue(
            'error',
            'route_disconnected',
            joinPath(path, 'target'),
            `no ${interaction.target.turn} movement out of feature "${interaction.target.feature}" from the reference approach`,
            { required: interaction.target.turn, actual: null },
          ),
        );
      }
    }

    for (const trigger of [interaction.trigger, interaction.until]) {
      if (!trigger) continue;
      if (trigger.kind === 'when') {
        for (const leaf of conditionLeaves(trigger.condition)) {
          if (leaf.kind !== 'signal') continue;
          if ('control' in leaf.signal) continue;
          const facts = map.signal(
            'handle' in leaf.signal
              ? { handle: leaf.signal.handle }
              : { featureId: leaf.signal.feature, approach: leaf.signal.approach },
          );
          if (!facts) {
            out.push(
              issue(
                'error',
                'trigger_unbindable',
                joinPath(path, 'trigger', 'condition'),
                'the signal this condition waits on does not exist at the bound site',
                { actual: leaf.signal },
              ),
            );
          } else if (!facts.phases.includes(leaf.phase)) {
            out.push(
              issue(
                'error',
                'trigger_unbindable',
                joinPath(path, 'trigger', 'condition', 'phase'),
                `signal "${facts.handle}" never shows "${leaf.phase}"`,
                { required: [...facts.phases], actual: leaf.phase },
              ),
            );
          }
        }
      }
      if (trigger.kind === 'arrival' && 'feature' in trigger.at) {
        if (!map.feature(trigger.at.feature)) {
          out.push(
            issue(
              'error',
              'trigger_unbindable',
              joinPath(path, 'trigger', 'at'),
              `feature "${trigger.at.feature}" is not bound at this site, so the arrival point is unknown`,
            ),
          );
        }
      }
    }
  });

  // --- roles that name junction movements ----------------------------------
  template.roles.forEach((role, index) => {
    if (role.kind !== 'conflicting_gate') return;
    if (!map.gate(role.feature, role.from, role.turn)) {
      out.push(
        issue(
          'error',
          'role_unbound',
          joinPath('roles', index),
          `no ${role.turn} movement from the ${role.from} approach of feature "${role.feature}" at this site`,
          { required: `${role.from}/${role.turn}`, actual: null },
        ),
      );
    }
  });

  return out;
}

function firstJunctionSize(template: ScenarioTemplateV2, map: MapContext): number | undefined {
  for (const feature of template.anchor.features) {
    if (feature.kind !== 'junction') continue;
    const facts = map.feature(feature.id);
    if (facts?.sizeM != null) return facts.sizeM;
  }
  return undefined;
}
