/**
 * Anchors used by more than one suite.
 *
 * `WORKED_EXAMPLE` is the anchor from `docs/research/retargeting.md`:
 * *"3-lane arterial approaching a signalized 4-way, ego left, opposing straight
 * conflict"*.
 */

import { parseLogicalAnchor, type LogicalAnchor } from '../../types/anchor.js';
import { parseRoleBindings, type RoleBinding } from '../../types/roles.js';

export function workedExampleAnchor(
  overrides: {
    laneRange?: [number, number];
    controlEssentiality?: 'required' | 'preferred';
    control?: Array<'signalized' | 'all_way_stop' | 'minor_stop' | 'yield' | 'uncontrolled' | 'roundabout'>;
    allowMirror?: boolean;
    minScore?: number;
  } = {},
): LogicalAnchor {
  return parseLogicalAnchor({
    id: 'arterial-left-turn-across-opposing',
    corridor: {
      throughLanesSameDir: { value: overrides.laneRange ?? [3, 4], essentiality: 'preferred' },
      speedLimitKph: { value: [40, 70], essentiality: 'preferred' },
      runwayUpstreamM: { value: 80, essentiality: 'required' },
    },
    features: [
      {
        id: 'jx',
        kind: 'junction',
        atM: { value: [0, 0], essentiality: 'required' },
        junction: {
          arms: { value: [4, 4], essentiality: 'required' },
          control: {
            value: overrides.control ?? ['signalized'],
            essentiality: overrides.controlEssentiality ?? 'required',
          },
          egoTurn: { value: 'left', essentiality: 'required' },
          conflictingApproach: {
            value: { from: 'opposing', turn: 'straight' },
            essentiality: 'required',
          },
        },
      },
    ],
    policy: {
      maxSitesPerMap: 10,
      diversity: 'junction',
      minScore: overrides.minScore ?? 0.3,
      allowMirror: overrides.allowMirror ?? false,
    },
  });
}

export function workedExampleRoles(): RoleBinding[] {
  return parseRoleBindings([
    { role: 'ego', kind: 'on_reference', dsM: -40 },
    {
      role: 'challenger',
      kind: 'conflicting_gate',
      feature: 'jx',
      from: 'opposing',
      turn: 'straight',
      templateCrossingAngleDeg: 120,
      arriveAtConflict: { relativeTo: 'ego', deltaT: -0.5 },
    },
  ]);
}

/** Nothing on any of our maps looks like this. */
export function impossibleAnchor(): LogicalAnchor {
  return parseLogicalAnchor({
    id: 'impossible',
    corridor: {
      throughLanesSameDir: { value: [9, 12], essentiality: 'required' },
      speedLimitKph: { value: [180, 220], essentiality: 'required' },
    },
    features: [
      {
        id: 'jx',
        kind: 'junction',
        atM: { value: [0, 0], essentiality: 'required' },
        junction: {
          arms: { value: [8, 8], essentiality: 'required' },
          control: { value: ['roundabout'], essentiality: 'required' },
          egoTurn: { value: 'uturn', essentiality: 'required' },
        },
      },
    ],
    policy: { minScore: 0.5 },
  });
}
