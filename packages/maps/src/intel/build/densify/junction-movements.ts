/**
 * Densification: one location per junction gate.
 *
 * A junction is not a place you can put an actor — a *movement* through it is.
 * These records are what a `conflicting_gate` role binds to, so they carry the
 * conflict count and the protected/unprotected distinction inline rather than
 * making the consumer walk the descriptor.
 */

import { asLocationId } from '../../types/ids.js';
import type { Affordance, FactValue, LocationType } from '../../types/location.js';
import type { JunctionDescriptor } from '../../types/topology.js';
import { anchorFacts, anchorOnLane } from '../anchor-lift.js';
import { type BuildContext, roadNameFor } from '../context.js';
import type { LocationDraft } from '../draft.js';
import { makeLocationIdString } from '../hash.js';
import { conflictingGates } from '../junctions.js';
import { slugify } from '../slug.js';
import { compareStrings } from '../compare.js';

const TYPE: LocationType = 'junction_movement';

const TURN_WORD: Record<string, string> = {
  Left: 'left turn',
  Right: 'right turn',
  Straight: 'through',
  UTurnLeft: 'u-turn',
  UTurnRight: 'u-turn',
};

/** One draft per gate, across every junction. */
export function densifyJunctionMovements(
  ctx: BuildContext,
  descriptors: readonly JunctionDescriptor[],
): LocationDraft[] {
  const mapId = ctx.sources.mapId as string;
  const out: LocationDraft[] = [];
  const gatesByJunction = new Map<string, typeof ctx.sources.topology.gates>();
  for (const gate of ctx.sources.topology.gates) {
    const bucket = gatesByJunction.get(gate.junctionId);
    if (bucket) bucket.push(gate);
    else gatesByJunction.set(gate.junctionId, [gate]);
  }

  for (const descriptor of descriptors) {
    const gates = (gatesByJunction.get(descriptor.junctionId as string) ?? [])
      .slice()
      .sort((a, b) => compareStrings(a.id, b.id));
    for (const gate of gates) {
      const lane = ctx.graph.get(gate.connectingLaneRsl);
      if (!lane) continue;
      const lift = anchorOnLane(ctx, gate.connectingLaneRsl, lane.lengthM / 2, 0, gate.id);
      if (!lift) continue;

      const conflicts = conflictingGates(descriptor, gate.id as never);
      const approachRoad = roadNameFor(ctx, gate.approachLaneRsl);
      const exitRoad = gate.exitLaneRsls.map((e) => roadNameFor(ctx, e)).find(Boolean) ?? '';
      const turnWord = TURN_WORD[gate.turnRelation] ?? gate.turnRelation.toLowerCase();

      const facts: Record<string, FactValue> = {
        turn_relation: gate.turnRelation,
        heading_change_deg: Math.round((gate.headingChangeRad * 180) / Math.PI),
        movement_length_m: Math.round(lane.lengthM * 100) / 100,
        conflicting_movement_count: conflicts.length,
        is_protected: conflicts.length === 0,
        junction_control: descriptor.control,
        exit_count: gate.exitLaneRsls.length,
        arm_count: descriptor.armCount,
        road_name: approachRoad,
        speed_limit_kph: lane.speedLimitKph ?? 0,
        ...anchorFacts(lift.anchor),
      };
      if (exitRoad) facts['exit_road_name'] = exitRoad;

      const tags = ['JUNCTION_MOVEMENT', `TURN_${gate.turnRelation.toUpperCase()}`];
      if (conflicts.length > 0) tags.push('UNPROTECTED_MOVEMENT');
      if (gate.turnRelation === 'Left' && descriptor.control !== 'signalized') {
        tags.push('UNPROTECTED_LEFT');
      }

      const affordances: Affordance[] = ['route', 'vehicleSpawn'];
      if (conflicts.length > 0) affordances.push('conflictPoint');

      const identityKey = `gate:${gate.id}`;
      const label = approachRoad
        ? `${turnWord} from ${approachRoad}${exitRoad && exitRoad !== approachRoad ? ` onto ${exitRoad}` : ''}`
        : `${turnWord} movement`;

      out.push({
        id: asLocationId(makeLocationIdString(mapId, TYPE, identityKey)),
        name: capitalise(label),
        type: TYPE,
        subtype: gate.turnRelation.toLowerCase(),
        tags: tags.sort(),
        anchor: lift.anchor,
        affordances: affordances.sort(),
        facts,
        provenance: [
          { source: 'topology-index', ref: gate.id, confidence: 1 },
        ],
        quality: { anchor: 'exact', confidence: 1 },
        naming: {
          stems: [
            slugify(
              approachRoad
                ? `${approachRoad}-${gate.turnRelation}`
                : `movement-${gate.turnRelation}`,
            ),
          ],
          roadNames: [approachRoad, exitRoad].filter(Boolean).sort(),
        },
        identityKey,
      });
    }
  }
  return out;
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0]?.toUpperCase() + s.slice(1);
}
