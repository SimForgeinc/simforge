/**
 * Structural validation — everything checkable from the document alone.
 *
 * These are the checks zod cannot express and should not: they are not "this
 * file is malformed" but "this scenario does not hold together", and their
 * output has to be a *list of repairable findings* rather than a parse failure,
 * because the primary consumer is an agent repair loop reading
 * `{code, path, message}` and editing the offending node.
 *
 * The rules, and why each one exists:
 *
 * | check | why |
 * |---|---|
 * | reference resolution | an id that names nothing is the commonest LLM error, and the only one a model can always fix from the message |
 * | `dynamics_required` | "brake" without a rate is not a scenario, it is a wish; the research makes dynamics mandatory for generated content |
 * | `bylatest_required` | a condition that never fires is a silent bug — the deadline turns it into a loud one |
 * | one axis, one owner | two owners of one axis is unresolvable *semantics*, not a runtime race |
 * | `set` key registry | a stringly-typed state channel is a channel no engine can implement completely |
 * | derived-param cycles | `a = b + 1, b = a - 1` evaluates forever |
 * | non-portable roles | a migrated v1 scene cannot retarget, and must say so |
 *
 * ## One axis, one owner — the decision procedure
 *
 * Semantics: later preempts earlier. So a *sequence* of differing start times
 * is legal by construction, and the analysis only has to find the cases where
 * "later" is not determinable or the author's own declaration contradicts it:
 *
 * 1. two statically **equal exact** start times on one `(actor, axis)` →
 *    `axis_conflict` (error). Nothing decides who wins. This subsumes the
 *    "two untriggered interactions on one axis" case, since every interaction
 *    has a trigger and untriggered means `at(0)`.
 * 2. an interaction with an explicit exact `until` that a later exact start
 *    truncates → `axis_conflict` (error). The `until` is a lie; either it is
 *    wrong or the later action is.
 * 3. two **windowed** starts (`when` / `arrival`) whose windows overlap →
 *    `axis_conflict_possible` (warning). At runtime one preempts the other,
 *    but which one is not knowable here — and if the author had known, they
 *    would have ordered them.
 *
 * Exact-vs-window pairs are deliberately *not* flagged: that is the normal
 * "cruise, then brake when close" shape, and warning on it would train people
 * to ignore the validator.
 */

import { collectParamRefs, tryEvaluateExpr, type Expr, type ExprScope } from '../expr/index.js';
import {
  AUTHORED_ACTOR_LIMIT_CODE,
  MAX_AUTHORED_ACTORS,
  authoredActorCount,
  authoredActorLimitMessage,
} from '../actor-limits.js';
import type { AnchorFeature } from '../schema/v2/anchor.js';
import type { Condition, Interaction, PointRef, Trigger } from '../schema/v2/interactions.js';
import { CONTINUOUS_VERBS, conditionLeaves } from '../schema/v2/interactions.js';
import { paramDefault } from '../schema/v2/params.js';
import { isPortableRole, rolePose, VRU_CLASSES, type RoleBinding } from '../schema/v2/roles.js';
import { checkSetValue, lookupSetKey, setKeyNamespace } from '../schema/v2/set-keys.js';
import type { ScenarioTemplateV2 } from '../schema/v2/template.js';
import { parseOverridePath } from '../schema/v2/variants.js';
import { WORLD_ROLE_REF } from '../schema/v2/common.js';
import { issue, joinPath, type ClauseResult } from './issues.js';
import {
  axisTimeline,
  earliestOf,
  latestOf,
  resolveTriggerTime,
  type TimingContext,
} from './timing.js';

/** Expression-node discriminants, for the generic template walk. */
const EXPR_KINDS = new Set(['num', 'ref', 'neg', 'bin', 'call']);

function isExprNode(value: unknown): value is Expr {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { kind?: unknown }).kind === 'string' &&
    EXPR_KINDS.has((value as { kind: string }).kind)
  );
}

/** Every expression in the document, with the path it sits at. */
export function collectExpressions(
  value: unknown,
  path: string[] = [],
): Array<{ path: string; expr: Expr }> {
  if (isExprNode(value)) return [{ path: path.join('.'), expr: value }];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectExpressions(item, [...path, String(index)]));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) =>
      collectExpressions(item, [...path, key]),
    );
  }
  return [];
}

/** Scope used for static analysis: parameters at their declared defaults. */
export function staticScope(template: ScenarioTemplateV2): ExprScope {
  const params: Record<string, number> = {};
  for (const decl of template.params.declarations) {
    const value = paramDefault(decl);
    if (value !== undefined) params[decl.id] = value;
  }
  return { params, clip: { seconds: template.choreography.clipSeconds } };
}

/**
 * Run every document-only check.
 *
 * Pure: same template in, same issue list out, sorted by the caller.
 */
export function structuralIssues(template: ScenarioTemplateV2): ClauseResult[] {
  const out: ClauseResult[] = [];
  const actorCount = authoredActorCount(template);
  if (actorCount > MAX_AUTHORED_ACTORS) {
    out.push(issue(
      'error',
      AUTHORED_ACTOR_LIMIT_CODE,
      'roles',
      `${authoredActorLimitMessage(actorCount)}; delete actors until the scenario is within the supported envelope`,
      { required: { maximum: MAX_AUTHORED_ACTORS }, actual: actorCount },
    ));
  }
  const roles = new Map(template.roles.map((r) => [r.id, r] as const));
  const features = new Map(template.anchor.features.map((f) => [f.id, f] as const));
  const interactions = new Map(
    template.choreography.interactions.map((i) => [i.id, i] as const),
  );
  const trafficControls = new Set(template.trafficControls.map((control) => control.id));
  const params = new Set(template.params.declarations.map((p) => p.id));

  const needRole = (ref: string, path: string, allowWorld = false): boolean => {
    if (allowWorld && ref === WORLD_ROLE_REF) return true;
    if (roles.has(ref)) return true;
    out.push(
      issue('error', 'role_ref_unknown', path, `no role with id "${ref}"`, {
        required: [...roles.keys()].sort(),
        actual: ref,
      }),
    );
    return false;
  };

  const needFeature = (ref: string, path: string, kind?: AnchorFeature['kind']): void => {
    const feature = features.get(ref);
    if (!feature) {
      out.push(
        issue('error', 'feature_ref_unknown', path, `no anchor feature with id "${ref}"`, {
          required: [...features.keys()].sort(),
          actual: ref,
        }),
      );
      return;
    }
    if (kind && feature.kind !== kind) {
      out.push(
        issue(
          'error',
          'feature_kind_mismatch',
          path,
          `feature "${ref}" is a ${feature.kind}; this reference needs a ${kind}`,
          { required: kind, actual: feature.kind },
        ),
      );
    }
  };

  const needInteraction = (ref: string, path: string): void => {
    if (!interactions.has(ref)) {
      out.push(
        issue('error', 'interaction_ref_unknown', path, `no interaction with id "${ref}"`, {
          required: [...interactions.keys()].sort(),
          actual: ref,
        }),
      );
    }
  };

  const checkPointRef = (point: PointRef, path: string): void => {
    if ('role' in point) needRole(point.role, joinPath(path, 'role'));
    else if ('feature' in point) needFeature(point.feature, joinPath(path, 'feature'));
  };

  // --- expressions ---------------------------------------------------------
  const scope = staticScope(template);
  for (const { path, expr } of collectExpressions(template)) {
    for (const id of collectParamRefs(expr)) {
      if (!params.has(id)) {
        out.push(
          issue('error', 'param_ref_unknown', path, `expression reads undeclared parameter "${id}"`, {
            required: [...params].sort(),
            actual: id,
          }),
        );
      }
    }
    const outcome = tryEvaluateExpr(expr, scope);
    if (outcome.status === 'error') {
      out.push(issue('error', 'expr_error', path, `expression cannot be evaluated: ${outcome.reason}`));
    }
  }

  // Derived parameters must not depend on themselves, directly or through others.
  const derivedDeps = new Map<string, string[]>();
  for (const decl of template.params.declarations) {
    if (decl.type === 'derived') derivedDeps.set(decl.id, collectParamRefs(decl.expr));
  }
  for (const id of [...derivedDeps.keys()].sort()) {
    const cycle = findCycle(id, derivedDeps);
    if (cycle) {
      out.push(
        issue(
          'error',
          'derived_param_cycle',
          joinPath('params', 'declarations'),
          `derived parameter "${id}" depends on itself: ${cycle.join(' -> ')}`,
          { actual: cycle },
        ),
      );
    }
  }

  // --- roles ---------------------------------------------------------------
  const relDeps = new Map<string, string[]>();
  template.roles.forEach((role, index) => {
    const base = joinPath('roles', index);
    if (role.actor.static) {
      const speed = role.initialSpeedKph === undefined
        ? { status: 'value' as const, value: 0 }
        : tryEvaluateExpr(role.initialSpeedKph, scope);
      if (speed.status === 'value' && speed.value > 0) {
        out.push(issue(
          'error',
          'static_actor_motion',
          joinPath(base, 'initialSpeedKph'),
          `static role "${role.id}" must have zero initial speed`,
          { required: 0, actual: speed.value },
        ));
      }
      if (role.kind === 'scene_absolute' && role.initialRoute) {
        out.push(issue(
          'error',
          'static_actor_motion',
          joinPath(base, 'initialRoute'),
          `static role "${role.id}" cannot follow an initial route`,
        ));
      }
    }
    switch (role.kind) {
      case 'conflicting_gate':
        needFeature(role.feature, joinPath(base, 'feature'), 'junction');
        if (role.arriveAtConflict) {
          const ref = role.arriveAtConflict.relativeTo;
          if (ref === role.id) {
            out.push(
              issue(
                'error',
                'self_reference',
                joinPath(base, 'arriveAtConflict', 'relativeTo'),
                'a role cannot synchronise its arrival with itself',
              ),
            );
          } else {
            needRole(ref, joinPath(base, 'arriveAtConflict', 'relativeTo'));
          }
        } else {
          out.push(
            issue(
              'warning',
              'trigger_unbindable',
              joinPath(base, 'arriveAtConflict'),
              `role "${role.id}" occupies a conflicting gate with no arrival relation, so its timing is unconstrained; most such scenarios are trivially non-critical`,
            ),
          );
        }
        break;
      case 'on_crossing':
        needFeature(role.feature, joinPath(base, 'feature'), 'crossing');
        break;
      case 'at_lane_drop':
        needFeature(role.feature, joinPath(base, 'feature'), 'lane_drop');
        break;
      case 'in_parking_zone':
        needFeature(role.feature, joinPath(base, 'feature'), 'parking_zone');
        break;
      case 'relative_to':
        if (role.ref === role.id) {
          out.push(
            issue('error', 'self_reference', joinPath(base, 'ref'), 'a role cannot be placed relative to itself'),
          );
        } else if (needRole(role.ref, joinPath(base, 'ref'))) {
          relDeps.set(role.id, [role.ref]);
        }
        break;
      case 'scene_absolute':
        out.push(
          issue(
            'warning',
            'non_portable_role',
            base,
            `role "${role.id}" is placed in absolute scene coordinates and cannot be retargeted to another map; rebind it to the anchor frame to make the template portable`,
          ),
        );
        if (!template.anchor.pin) {
          out.push(
            issue(
              'error',
              'pin_required',
              joinPath('anchor', 'pin'),
              `role "${role.id}" uses absolute scene coordinates, which are only meaningful on one map; set anchor.pin`,
            ),
          );
        }
        if (role.initialRoute) {
          const placedLane = role.laneRef
            ? `${role.laneRef.roadId}:${role.laneRef.section}:${role.laneRef.laneId}`
            : null;
          if (!placedLane || role.initialRoute.lanes[0] !== placedLane) {
            out.push(issue(
              'error',
              'route_disconnected',
              joinPath(base, 'initialRoute'),
              placedLane
                ? `initial lanePath starts on "${role.initialRoute.lanes[0]}", not the actor's placed lane "${placedLane}"`
                : 'an initial lanePath requires a laneRef on its scene_absolute actor',
            ));
          }
        }
        break;
      default:
        break;
    }
  });
  for (const id of [...relDeps.keys()].sort()) {
    const cycle = findCycle(id, relDeps);
    if (cycle) {
      out.push(
        issue('error', 'relative_to_cycle', 'roles', `roles are placed relative to each other in a cycle: ${cycle.join(' -> ')}`, {
          actual: cycle,
        }),
      );
    }
  }

  // --- props ---------------------------------------------------------------
  template.props.forEach((prop, index) => {
    const base = joinPath('props', index);
    if (prop.feature) needFeature(prop.feature, joinPath(base, 'feature'));
    if (prop.attachment) {
      needRole(prop.attachment.role, joinPath(base, 'attachment', 'role'));
      if (prop.repeat) {
        out.push(issue(
          'error',
          'attached_prop_repeat_unsupported',
          joinPath(base, 'repeat'),
          'an attached prop is one rigid object; author separate attached props instead of repeat',
        ));
      }
    }
    if (prop.occludes) {
      needRole(prop.occludes.observer, joinPath(base, 'occludes', 'observer'));
      needRole(prop.occludes.target, joinPath(base, 'occludes', 'target'));
      if (prop.occludes.observer === prop.occludes.target) {
        out.push(
          issue(
            'error',
            'self_reference',
            joinPath(base, 'occludes'),
            'an occluder cannot hide a role from itself',
          ),
        );
      }
    }
    if (prop.targetRevealToConflictS !== undefined && !prop.occludes) {
      out.push(
        issue(
          'error',
          'occluder_pair_missing',
          joinPath(base, 'targetRevealToConflictS'),
          'reveal-to-conflict time is a relation between an observer and a target; set `occludes` to say who is hidden from whom',
        ),
      );
    }
    if (prop.occludes && prop.essentiality === 'cosmetic') {
      out.push(
        issue(
          'warning',
          'occluder_dropped',
          joinPath(base, 'essentiality'),
          'a cosmetic occluder may be dropped by degradation, which deletes the point of an occlusion scenario',
        ),
      );
    }
  });

  // --- interactions --------------------------------------------------------
  template.choreography.interactions.forEach((interaction, index) => {
    const base = joinPath('choreography', 'interactions', index);
    const setKey = interaction.verb === 'set' ? interaction.target.key : undefined;
    const worldKey =
      setKey !== undefined && ['env', 'signal', 'control'].includes(setKeyNamespace(setKey));
    needRole(interaction.actor, joinPath(base, 'actor'), worldKey);
    const interactionRole = roles.get(interaction.actor);
    if (
      interactionRole?.actor.static &&
      ['speed', 'gap', 'changeLane', 'laneOffset', 'route'].includes(interaction.verb)
    ) {
      out.push(issue(
        'error',
        'static_actor_motion',
        base,
        `static role "${interaction.actor}" cannot perform ${interaction.verb} motion`,
      ));
    }
    const controlSet = setKey === undefined ? null : /^control:(.+)\.indication$/.exec(setKey);
    if (controlSet && !trafficControls.has(controlSet[1]!)) {
      out.push(issue('error', 'control_ref_unknown', joinPath(base, 'target', 'key'), `no traffic control with id "${controlSet[1]}"`));
    }
    if (interaction.actor === WORLD_ROLE_REF && !worldKey) {
      out.push(
        issue(
          'error',
          'set_actor_mismatch',
          joinPath(base, 'actor'),
          `"${WORLD_ROLE_REF}" is only the actor for env.*, signal:*, and control:* sets; everything else is performed by a role`,
        ),
      );
    }

    checkTrigger(interaction.trigger, joinPath(base, 'trigger'));
    if (interaction.until) checkTrigger(interaction.until, joinPath(base, 'until'));

    if (CONTINUOUS_VERBS.includes(interaction.verb)) {
      const dynamics = (interaction as { dynamics?: unknown }).dynamics;
      if (dynamics === undefined) {
        out.push(
          issue(
            'error',
            'dynamics_required',
            joinPath(base, 'dynamics'),
            `"${interaction.verb}" is a continuous change and needs dynamics {shape, constraint, value}; a target with no rate is not reproducible`,
          ),
        );
      }
    }

    switch (interaction.verb) {
      case 'gap':
        if (interaction.target.role === interaction.actor) {
          out.push(
            issue('error', 'self_reference', joinPath(base, 'target', 'role'), 'an actor cannot keep a gap to itself'),
          );
        } else {
          needRole(interaction.target.role, joinPath(base, 'target', 'role'));
        }
        break;
      case 'speed':
        if (interaction.target.mode === 'match') {
          if (interaction.target.role === interaction.actor) {
            out.push(
              issue('error', 'self_reference', joinPath(base, 'target', 'role'), 'an actor cannot match its own speed'),
            );
          } else {
            needRole(interaction.target.role, joinPath(base, 'target', 'role'));
          }
        }
        break;
      case 'changeLane':
        if (interaction.target.mode === 'toRole') {
          needRole(interaction.target.role, joinPath(base, 'target', 'role'));
        }
        break;
      case 'route':
        if (interaction.target.mode === 'turn') {
          needFeature(interaction.target.feature, joinPath(base, 'target', 'feature'), 'junction');
        } else if (interaction.target.mode === 'crossing') {
          needFeature(interaction.target.feature, joinPath(base, 'target', 'feature'), 'crossing');
          if (interaction.target.fromFrac === interaction.target.toFrac) {
            out.push(
              issue(
                'warning',
                'route_disconnected',
                joinPath(base, 'target'),
                'crossing route starts and ends at the same point, so the actor never crosses',
              ),
            );
          }
        } else if (interaction.target.mode === 'toFeature') {
          needFeature(interaction.target.feature, joinPath(base, 'target', 'feature'));
        } else if (interaction.target.mode === 'lanePath') {
          const actor = roles.get(interaction.actor);
          if (!actor || actor.kind !== 'scene_absolute' || !template.anchor.pin) {
            out.push(issue(
              'error',
              'route_disconnected',
              joinPath(base, 'target'),
              'an exact lanePath is map-bound and may only drive a pinned scene_absolute actor',
            ));
          }
        } else if (interaction.target.mode === 'customRoute' || interaction.target.mode === 'customTimedRoute') {
          const actor = roles.get(interaction.actor);
          if (!actor || actor.kind !== 'scene_absolute' || !template.anchor.pin) {
            out.push(issue(
              'error',
              'route_disconnected',
              joinPath(base, 'target'),
              'a custom route is map-bound and may only drive a pinned scene_absolute actor',
            ));
          }
          if (interaction.target.mode === 'customTimedRoute') {
            const points = interaction.target.points;
            for (let index = 1; index < points.length; index += 1) {
              if (points[index]!.timeS <= points[index - 1]!.timeS) {
                out.push(issue(
                  'error',
                  'route_disconnected',
                  joinPath(base, 'target', 'points', index, 'timeS'),
                  'custom timed route times must be strictly increasing',
                ));
              }
            }
          }
        } else if (interaction.target.mode === 'nearMiss') {
          needRole(interaction.target.target, joinPath(base, 'target', 'target'));
          if (interaction.target.target === interaction.actor) {
            out.push(issue('error', 'self_reference', joinPath(base, 'target', 'target'), 'a near miss requires a distinct target actor'));
          }
          const actor = roles.get(interaction.actor);
          if (actor && actor.actor.class !== 'pedestrian') {
            out.push(issue('error', 'actor_class_mismatch', joinPath(base, 'actor'), 'nearMiss routes are only supported for pedestrians'));
          }
        }
        break;
      case 'set': {
        const key = interaction.target.key;
        const check = checkSetValue(key, interaction.target.value);
        if (!check.ok) {
          out.push(issue('error', check.code, joinPath(base, 'target'), check.message));
          break;
        }
        const declared = lookupSetKey(key);
        const role = roles.get(interaction.actor);
        if (declared && role) {
          const isVru = VRU_CLASSES.has(role.actor.class);
          const mismatch =
            (declared.appliesTo === 'vehicle' && isVru) ||
            (declared.appliesTo === 'vru' && !isVru) ||
            declared.appliesTo === 'world';
          if (mismatch) {
            out.push(
              issue(
                'error',
                'set_actor_mismatch',
                joinPath(base, 'target', 'key'),
                `"${key}" applies to ${declared.appliesTo}, but role "${role.id}" is a ${role.actor.class}`,
                { required: declared.appliesTo, actual: role.actor.class },
              ),
            );
          }
        }
        break;
      }
      default:
        break;
    }
  });

  function checkTrigger(trigger: Trigger, path: string): void {
    switch (trigger.kind) {
      case 'after':
        needInteraction(trigger.of, joinPath(path, 'of'));
        break;
      case 'when':
        if (trigger.byLatest === undefined) {
          out.push(
            issue(
              'error',
              'bylatest_required',
              joinPath(path, 'byLatest'),
              'every `when` trigger needs `byLatest`: a condition that never becomes true is otherwise a silent no-op',
            ),
          );
        }
        checkCondition(trigger.condition, joinPath(path, 'condition'));
        break;
      case 'arrival':
        needRole(trigger.of, joinPath(path, 'of'));
        needRole(trigger.syncWith, joinPath(path, 'syncWith'));
        if (trigger.of === trigger.syncWith) {
          out.push(
            issue('error', 'self_reference', joinPath(path, 'syncWith'), 'an arrival cannot be synchronised with itself'),
          );
        }
        checkPointRef(trigger.at, joinPath(path, 'at'));
        break;
      default:
        break;
    }
  }

  function checkCondition(condition: Condition, path: string): void {
    const logical = condition.kind === 'and' || condition.kind === 'or' || condition.kind === 'not';
    conditionLeaves(condition).forEach((leaf, i) => {
      const leafPath = logical
        ? condition.kind === 'not'
          ? joinPath(path, 'operand')
          : joinPath(path, 'operands', i)
        : path;
      switch (leaf.kind) {
        case 'distance':
          needRole(leaf.from, joinPath(leafPath, 'from'));
          checkPointRef(leaf.to, joinPath(leafPath, 'to'));
          break;
        case 'ttc':
        case 'headway':
          needRole(leaf.of, joinPath(leafPath, 'of'));
          needRole(leaf.to, joinPath(leafPath, 'to'));
          if (leaf.of === leaf.to) {
            out.push(
              issue('error', 'self_reference', leafPath, `${leaf.kind} between a role and itself is meaningless`),
            );
          }
          break;
        case 'reaches':
          needRole(leaf.of, joinPath(leafPath, 'of'));
          checkPointRef(leaf.region, joinPath(leafPath, 'region'));
          break;
        case 'speed':
        case 'standstill':
          needRole(leaf.of, joinPath(leafPath, 'of'));
          break;
        case 'visible':
          needRole(leaf.of, joinPath(leafPath, 'of'));
          needRole(leaf.to, joinPath(leafPath, 'to'));
          break;
        case 'detected': {
          needRole(leaf.of, joinPath(leafPath, 'of'));
          needRole(leaf.by, joinPath(leafPath, 'by'));
          // A sensor that nothing consumes is worse than no sensor at all, so
          // every reference here is checked rather than silently ignored.
          const observer = roles.get(leaf.by);
          if (observer && observer.actor.sensors.length === 0) {
            out.push(issue('error', 'sensor_ref_unknown', joinPath(leafPath, 'by'),
              `role "${leaf.by}" declares no sensors, so it can never detect anything`));
          } else if (observer && leaf.sensor !== undefined
            && !observer.actor.sensors.some((sensor) => sensor.id === leaf.sensor)) {
            out.push(issue('error', 'sensor_ref_unknown', joinPath(leafPath, 'sensor'),
              `role "${leaf.by}" has no sensor with id "${leaf.sensor}"`));
          }
          break;
        }
        case 'collision':
          needRole(leaf.of, joinPath(leafPath, 'of'));
          if (leaf.with !== 'any') needRole(leaf.with, joinPath(leafPath, 'with'));
          break;
        case 'signal':
          if ('feature' in leaf.signal) {
            needFeature(leaf.signal.feature, joinPath(leafPath, 'signal', 'feature'), 'junction');
          } else if ('control' in leaf.signal && !trafficControls.has(leaf.signal.control)) {
            out.push(issue('error', 'control_ref_unknown', joinPath(leafPath, 'signal', 'control'), `no traffic control with id "${leaf.signal.control}"`));
          }
          break;
      }
    });
  }

  // --- invariants ----------------------------------------------------------
  template.invariants.forEach((invariant, index) => {
    const base = joinPath('invariants', index);
    if (invariant.kind === 'event_order') {
      invariant.events.forEach((id, i) => needInteraction(id, joinPath(base, 'events', i)));
    } else if (invariant.kind === 'near_miss') {
      needRole(invariant.pedestrian, joinPath(base, 'pedestrian'));
      needRole(invariant.target, joinPath(base, 'target'));
      if (invariant.pedestrian === invariant.target) {
        out.push(issue('error', 'self_reference', base, 'a near miss requires two distinct roles'));
      }
    } else {
      needRole(invariant.of, joinPath(base, 'of'));
      if ('to' in invariant) {
        needRole(invariant.to, joinPath(base, 'to'));
        if (invariant.to === invariant.of) {
          out.push(issue('error', 'self_reference', base, 'an invariant cannot relate a role to itself'));
        }
      }
      if ('syncWith' in invariant) needRole(invariant.syncWith, joinPath(base, 'syncWith'));
      if ('at' in invariant) checkPointRef(invariant.at, joinPath(base, 'at'));
    }
    // Perception invariants carry references the generic role check cannot
    // see. An invariant that silently grades nothing is the failure mode this
    // whole layer exists to prevent, so each one is resolved here.
    if (
      invariant.kind === 'detection_gap'
      || invariant.kind === 'time_to_first_detection'
      || invariant.kind === 'perception_lag'
    ) {
      const observer = roles.get(invariant.of);
      if (observer && observer.actor.sensors.length === 0) {
        out.push(issue('error', 'sensor_ref_unknown', joinPath(base, 'of'),
          `role "${invariant.of}" declares no sensors, so there is no detection to grade`));
      } else if (observer && invariant.sensor !== undefined
        && !observer.actor.sensors.some((sensor) => sensor.id === invariant.sensor)) {
        out.push(issue('error', 'sensor_ref_unknown', joinPath(base, 'sensor'),
          `role "${invariant.of}" has no sensor with id "${invariant.sensor}"`));
      }
    }
    if (invariant.kind === 'map_divergence'
      && !template.perception.mapDivergences.some((entry) => entry.id === invariant.divergence)) {
      out.push(issue('error', 'divergence_ref_unknown', joinPath(base, 'divergence'),
        `no perception.mapDivergences entry with id "${invariant.divergence}"`));
    }
  });

  // --- declared map/percept divergence --------------------------------------
  template.perception.mapDivergences.forEach((divergence, index) => {
    const base = joinPath('perception', 'mapDivergences', index);
    divergence.observers.forEach((role, i) => needRole(role, joinPath(base, 'observers', i)));
    if (divergence.extent.kind === 'aroundRole') {
      needRole(divergence.extent.role, joinPath(base, 'extent', 'role'));
    }
  });

  // --- metric subject ------------------------------------------------------
  if (template.metricSubject === undefined) {
    if (template.roles.length > 0) {
      out.push(
        issue(
          'warning',
          'metric_subject_missing',
          'metricSubject',
          'no metricSubject: the criticality filters need one role whose episode metrics decide whether an instance is interesting',
        ),
      );
    }
  } else if (!roles.has(template.metricSubject)) {
    out.push(
      issue('error', 'metric_subject_unknown', 'metricSubject', `no role with id "${template.metricSubject}"`, {
        required: [...roles.keys()].sort(),
        actual: template.metricSubject,
      }),
    );
  }

  // --- anchor --------------------------------------------------------------
  const corridorClauses = template.anchor.corridor
    ? Object.values(template.anchor.corridor).filter((v) => v !== undefined).length
    : 0;
  if (corridorClauses === 0 && template.anchor.features.length === 0 && !template.anchor.pin) {
    out.push(
      issue(
        'warning',
        'anchor_unconstrained',
        'anchor',
        'this anchor constrains nothing, so it matches every corridor on every map; add a corridor clause, a feature, or a pin',
      ),
    );
  }
  if (template.anchor.pin && template.anchor.pin.siteId === undefined) {
    out.push(
      issue(
        'warning',
        'pin_site_unresolved',
        joinPath('anchor', 'pin'),
        `pinned to map "${template.anchor.pin.mapId}" but to no site; the matcher cannot bind a frame until a siteId is chosen`,
      ),
    );
  }

  // --- variants ------------------------------------------------------------
  template.variants.forEach((variant, vi) => {
    variant.overrides.forEach((override, oi) => {
      const path = joinPath('variants', vi, 'overrides', oi, 'path');
      const segments = parseOverridePath(override.path);
      if (!segments) {
        out.push(issue('error', 'variant_path_invalid', path, `"${override.path}" is not a valid override path`));
        return;
      }
      const [root, second] = segments;
      if (second?.kind === 'id' && root?.kind === 'key') {
        const pool =
          root.key === 'roles'
            ? roles
            : root.key === 'props'
              ? new Map(template.props.map((p) => [p.id, p] as const))
              : root.key === 'invariants'
                ? new Map(template.invariants.map((i) => [i.id, i] as const))
                : undefined;
        if (pool && !pool.has(second.id)) {
          out.push(
            issue('error', 'variant_target_unknown', path, `no ${root.key} entry with id "${second.id}"`, {
              required: [...pool.keys()].sort(),
              actual: second.id,
            }),
          );
        }
      }
    });
  });

  // --- timeline ------------------------------------------------------------
  out.push(...timelineIssues(template, interactions, scope));

  return out;
}

function timelineIssues(
  template: ScenarioTemplateV2,
  byId: ReadonlyMap<string, Interaction>,
  scope: ExprScope,
): ClauseResult[] {
  const out: ClauseResult[] = [];
  const ctx: TimingContext = {
    clipStart: -template.choreography.warmupSeconds,
    clipEnd: template.choreography.clipSeconds,
    scope,
    byId,
  };
  const indexOf = new Map(template.choreography.interactions.map((i, index) => [i.id, index] as const));

  // `after` cycles.
  const afterDeps = new Map<string, string[]>();
  for (const interaction of template.choreography.interactions) {
    if (interaction.trigger.kind === 'after' && byId.has(interaction.trigger.of)) {
      afterDeps.set(interaction.id, [interaction.trigger.of]);
    }
  }
  const reportedCycles = new Set<string>();
  for (const id of [...afterDeps.keys()].sort()) {
    const cycle = findCycle(id, afterDeps);
    if (cycle) {
      // One cycle, one issue: `a -> b -> a` and `b -> a -> b` are the same
      // finding, so key on the *set* of members rather than the walk order.
      const key = [...new Set(cycle)].sort().join('|');
      if (reportedCycles.has(key)) continue;
      reportedCycles.add(key);
      out.push(
        issue(
          'error',
          'trigger_cycle',
          joinPath('choreography', 'interactions', indexOf.get(id) ?? 0, 'trigger'),
          `\`after\` triggers form a cycle: ${cycle.join(' -> ')}`,
          { actual: cycle },
        ),
      );
    }
  }

  // Triggers outside the clip, and `until` before its own trigger.
  template.choreography.interactions.forEach((interaction, index) => {
    const base = joinPath('choreography', 'interactions', index);
    const start = resolveTriggerTime(interaction.trigger, ctx);
    if (start.kind === 'exact' && (start.t < ctx.clipStart || start.t > ctx.clipEnd)) {
      out.push(
        issue(
          'error',
          'trigger_out_of_clip',
          joinPath(base, 'trigger'),
          `fires at t=${start.t}s, outside the clip [${ctx.clipStart}, ${ctx.clipEnd}]s`,
          { required: [ctx.clipStart, ctx.clipEnd], actual: start.t },
        ),
      );
    }
    if (interaction.trigger.kind === 'when' && interaction.trigger.byLatest !== undefined) {
      const deadline = latestOf(start);
      if (deadline > ctx.clipEnd) {
        out.push(
          issue(
            'warning',
            'trigger_out_of_clip',
            joinPath(base, 'trigger', 'byLatest'),
            `deadline t=${deadline}s is after the clip ends at ${ctx.clipEnd}s, so the deadline can never be reached`,
            { required: ctx.clipEnd, actual: deadline },
          ),
        );
      }
    }
    if (interaction.until) {
      const end = resolveTriggerTime(interaction.until, ctx);
      if (start.kind === 'exact' && end.kind === 'exact' && end.t <= start.t) {
        out.push(
          issue(
            'error',
            'until_before_trigger',
            joinPath(base, 'until'),
            `ends at t=${end.t}s, at or before its own start at t=${start.t}s`,
            { required: `> ${start.t}`, actual: end.t },
          ),
        );
      }
    }
  });

  // One axis, one owner. See the module docs for the decision procedure.
  for (const timeline of axisTimeline(template.choreography.interactions, ctx)) {
    for (let i = 0; i < timeline.slots.length; i++) {
      const a = timeline.slots[i];
      if (!a) continue;
      for (let j = i + 1; j < timeline.slots.length; j++) {
        const b = timeline.slots[j];
        if (!b) continue;
        const pathA = joinPath('choreography', 'interactions', a.index);
        if (a.start.kind === 'exact' && b.start.kind === 'exact') {
          if (a.start.t === b.start.t) {
            out.push(
              issue(
                'error',
                'axis_conflict',
                pathA,
                `"${a.interaction.id}" and "${b.interaction.id}" both take the ${timeline.axis} axis of "${timeline.actor}" at t=${a.start.t}s; one axis has one owner`,
                { required: 'distinct trigger times', actual: [a.interaction.id, b.interaction.id] },
              ),
            );
          } else if (a.declaredEnd?.kind === 'exact' && b.start.t < a.declaredEnd.t) {
            out.push(
              issue(
                'error',
                'axis_conflict',
                joinPath(pathA, 'until'),
                `"${a.interaction.id}" declares it holds the ${timeline.axis} axis until t=${a.declaredEnd.t}s, but "${b.interaction.id}" takes it at t=${b.start.t}s`,
                { required: `until <= ${b.start.t}`, actual: a.declaredEnd.t },
              ),
            );
          }
          continue;
        }
        if (a.start.kind === 'window' && b.start.kind === 'window') {
          const overlaps =
            earliestOf(a.start) <= latestOf(b.start) && earliestOf(b.start) <= latestOf(a.start);
          if (overlaps) {
            out.push(
              issue(
                'warning',
                'axis_conflict_possible',
                pathA,
                `"${a.interaction.id}" and "${b.interaction.id}" can both take the ${timeline.axis} axis of "${timeline.actor}" in the same window; their order is not statically determined`,
                {
                  actual: [
                    [earliestOf(a.start), latestOf(a.start)],
                    [earliestOf(b.start), latestOf(b.start)],
                  ],
                },
              ),
            );
          }
        }
      }
    }
  }

  // Event order that the static times already contradict.
  template.invariants.forEach((invariant, index) => {
    if (invariant.kind !== 'event_order') return;
    let previous: { id: string; t: number } | undefined;
    invariant.events.forEach((id) => {
      const interaction = byId.get(id);
      if (!interaction) return;
      const bound = resolveTriggerTime(interaction.trigger, ctx);
      if (bound.kind !== 'exact') {
        previous = undefined;
        return;
      }
      if (previous && bound.t < previous.t) {
        out.push(
          issue(
            'error',
            'event_order_inconsistent',
            joinPath('invariants', index, 'events'),
            `"${id}" is declared after "${previous.id}" but fires earlier (t=${bound.t}s vs t=${previous.t}s)`,
            { required: `>= ${previous.t}`, actual: bound.t },
          ),
        );
      }
      previous = { id, t: bound.t };
    });
  });

  return out;
}

/** Depth-first cycle search. Returns the cycle including the repeated node. */
function findCycle(start: string, edges: ReadonlyMap<string, string[]>): string[] | undefined {
  const path: string[] = [];
  const seen = new Set<string>();
  const walk = (node: string): string[] | undefined => {
    if (path.includes(node)) return [...path.slice(path.indexOf(node)), node];
    if (seen.has(node)) return undefined;
    seen.add(node);
    path.push(node);
    for (const next of edges.get(node) ?? []) {
      const found = walk(next);
      if (found) return found;
    }
    path.pop();
    return undefined;
  };
  return walk(start);
}

/** Roles that no interaction ever mentions — informational, not an error. */
export function unusedRoles(template: ScenarioTemplateV2): string[] {
  const used = new Set<string>();
  for (const interaction of template.choreography.interactions) used.add(interaction.actor);
  for (const role of template.roles) {
    if (role.kind === 'relative_to') used.add(role.ref);
    if (role.kind === 'conflicting_gate' && role.arriveAtConflict) {
      used.add(role.arriveAtConflict.relativeTo);
    }
  }
  return template.roles
    .filter((r) => !used.has(r.id))
    .map((r) => r.id)
    .sort();
}

/** True when every role can be re-placed on another map. */
export function isPortableTemplate(template: ScenarioTemplateV2): boolean {
  return template.roles.every(isPortableRole);
}

/** Re-exported for the map checks, which need the same pose accessor. */
export { rolePose };
export type { RoleBinding };
