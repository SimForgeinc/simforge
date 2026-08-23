/**
 * Mirroring (`policy.allowMirror`).
 *
 * A mirrored match is the *same choreography seen in a mirror*: a left-turn
 * conflict on a right-hand map becomes the right-turn conflict of the same
 * shape. Implemented as a pure transform of the anchor and the role list rather
 * than as a special case inside the matcher — the frame merely carries
 * `mirrored: true` and a sign-flipped lateral map, so nothing downstream needs
 * to know.
 */

import type {
  ApproachRelation,
  Clause,
  JunctionPredicate,
  LogicalAnchor,
  Side,
  Turn,
} from './types/anchor.js';
import type { RoleBinding } from './types/roles.js';

const flipTurn = (t: Turn): Turn => (t === 'left' ? 'right' : t === 'right' ? 'left' : t);
const flipSide = (s: Side): Side => (s === 'left' ? 'right' : s === 'right' ? 'left' : s);
const flipRelation = (r: ApproachRelation): ApproachRelation =>
  r === 'from_left' ? 'from_right' : r === 'from_right' ? 'from_left' : r;

function mapClause<T>(c: Clause<T> | undefined, fn: (v: T) => T): Clause<T> | undefined {
  return c ? { ...c, value: fn(c.value) } : undefined;
}

function stripUndefined<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}

function mirrorJunctionPredicate(jp: JunctionPredicate): JunctionPredicate {
  return stripUndefined({
    ...jp,
    egoTurn: mapClause(jp.egoTurn, flipTurn),
    conflictingApproach: mapClause(jp.conflictingApproach, (v) => ({
      from: flipRelation(v.from),
      turn: flipTurn(v.turn),
    })),
  });
}

/** Left/right-swapped copy of an anchor. Idempotent when applied twice. */
export function mirrorAnchor(anchor: LogicalAnchor): LogicalAnchor {
  return stripUndefined({
    ...anchor,
    corridor: anchor.corridor
      ? stripUndefined({
          ...anchor.corridor,
          laneChangeLegal: mapClause(anchor.corridor.laneChangeLegal, (v) => ({
            ...v,
            side: flipSide(v.side),
          })),
        })
      : undefined,
    features: anchor.features.map((f) =>
      stripUndefined({
        ...f,
        side: mapClause(f.side, flipSide),
        junction: f.junction ? mirrorJunctionPredicate(f.junction) : undefined,
      }),
    ),
  });
}

/** Left/right-swapped copy of a role list (lane indices included). */
export function mirrorRoleBindings(roles: RoleBinding[]): RoleBinding[] {
  return roles.map((role) => {
    switch (role.kind) {
      case 'lane_offset':
        return { ...role, k: -role.k };
      case 'at_lane_drop':
        return role;
      case 'relative_to':
        return { ...role, dLane: -role.dLane };
      case 'conflicting_gate':
        return { ...role, from: flipRelation(role.from), turn: flipTurn(role.turn) };
      case 'on_crossing':
        return {
          ...role,
          direction:
            role.direction === 'left_to_right'
              ? ('right_to_left' as const)
              : ('left_to_right' as const),
        };
      case 'in_parking_zone':
        return { ...role, side: role.side === 'left' ? ('right' as const) : ('left' as const) };
      default:
        return role;
    }
  });
}
