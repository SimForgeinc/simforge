/**
 * Arrow lenses, and the one rule that governs them.
 *
 * ## Arrow lenses come from the PLAN, never from the signal type
 *
 * `<signal type="1000011" subtype="10">` claims to be an arrow variant in the
 * OpenDRIVE spec and is not one in these files. Measured across four dev maps
 * (the measurement is recorded in v1's
 * `app/lib/scenario-editor/signals/editor-traffic-lights.ts`), `1000011/10`
 * splits right 39% / uturn 21% / straight 20% / left 20% — the base rate, i.e.
 * no signal at all — and carries the same `Signal_3Light_*` asset names and the
 * same 1.08/1.16 m housings as plain `1000001`. RoadRunner exports one physical
 * asset under two codes. `1000011/20` is, on every map that has any, the
 * zero-geometry debris that same module documents.
 *
 * So a head's arrow glyph is **hardware derived from its protected turns**, and
 * protected turns are recoverable only from the movement bindings.
 *
 * ## The v2 derivation is direct, where v1's was a string parse
 *
 * v1 recovered the turn by splitting a composite `movement_id` on its last `":"`
 * — which worked only because v1 minted those ids itself, and which is exactly
 * the kind of coupling that made its ids fragile. Here `TopologyGate` carries
 * `turnRelation` and `approachLaneRsl` as first-class fields, and
 * `EditorSignalMovement` already joins them, so the derivation reads:
 *
 *     head -> its movements -> their gates -> (approachLaneRsl, turnRelation)
 *
 * with no id format assumed anywhere.
 *
 * ## What makes a turn PROTECTED
 *
 * A head is a protected-turn head when, within its own approach, the turns it
 * serves are all the same non-through turn AND at least one other head on that
 * approach serves a different turn. Both halves matter:
 *
 * - "all the same turn" is what makes it an arrow rather than a ball;
 * - "the approach has other turns too" is what makes it PROTECTED rather than
 *   merely a head on an approach where only one turn happens to exist. Without
 *   that clause every head on a one-movement approach sprouts an arrow.
 *
 * ## The lens is not the indication
 *
 * A protected-left head with a `left` lens showing `green` renders a green
 * arrow. It is authored as plain `green` — `MapSignalPlanClipSchema` permits only
 * the six non-arrow indications, and `green_arrow` belongs to a `lane_control`
 * gantry, not to a road signal. The eleven-indication support in the render
 * worker (`SIGNAL_LAMP_BY_INDICATION`) matters for `trafficControls`, and
 * usefully so — but authoring `green_arrow` on a map signal plan would be asking
 * the author to restate in the timing what the lens already says, and the schema
 * would reject it.
 */

import type { EditorSignalIndex } from "./stages";

/** The glyph a head's lens draws. `ball` is the default three-lens housing. */
export type SignalLensKind = "ball" | "left" | "right" | "straight";

/** `uturn` resolves to a left arrow: it is the closest true glyph, and a U-turn
 * head is a left-arrow variant on the street. */
const LENS_KIND_BY_TURN: Readonly<Record<string, SignalLensKind | undefined>> = {
  left: "left",
  right: "right",
  uturn: "left",
  straight: undefined,
  through: undefined,
};

/**
 * Turn relations that count as "through" for the protected-turn test.
 *
 * `TopologyGate.turnRelation` is a free-form string in the topology artifact, so
 * both spellings are accepted. A relation this module does not recognise
 * participates in the "approach has more than one turn" count but never produces
 * an arrow — an unknown turn is a reason to draw the default housing, not to
 * guess a glyph.
 */
const THROUGH_RELATIONS = new Set(["straight", "through"]);

/**
 * OpenDRIVE signal id → the arrow it should show, for protected turns only.
 *
 * Heads absent from the result draw the default `ball` housing; the map is
 * deliberately sparse rather than carrying `ball` for every head, so a caller
 * can tell "no arrow" from "not considered".
 */
export function signalLensKindIndex(
  index: EditorSignalIndex,
  junctionIds?: readonly string[],
): Map<string, SignalLensKind> {
  const wanted = junctionIds != null ? new Set(junctionIds) : null;
  const lenses = new Map<string, SignalLensKind>();

  // approach lane rsl -> head id -> the turn relations that head serves there
  const byApproach = new Map<string, Map<string, Set<string>>>();
  for (const movement of index.projection.movements) {
    if (wanted && !wanted.has(movement.junctionId)) continue;
    if (movement.turnRelations.length === 0) continue;
    for (const approachRsl of movement.approachLaneRsls) {
      let byHead = byApproach.get(approachRsl);
      if (!byHead) {
        byHead = new Map();
        byApproach.set(approachRsl, byHead);
      }
      for (const headId of movement.headIds) {
        const turns = byHead.get(headId) ?? new Set<string>();
        for (const relation of movement.turnRelations) turns.add(relation);
        byHead.set(headId, turns);
      }
    }
  }

  for (const byHead of byApproach.values()) {
    const turnsOnApproach = new Set<string>();
    for (const turns of byHead.values()) {
      for (const turn of turns) turnsOnApproach.add(turn);
    }
    // One turn across the whole approach is not a protected turn, it is an
    // approach with one movement. Nothing on it is an arrow.
    if (turnsOnApproach.size < 2) continue;
    for (const [headId, turns] of byHead) {
      if (turns.size !== 1) continue;
      const [only] = turns;
      if (only === undefined || THROUGH_RELATIONS.has(only)) continue;
      const lens = LENS_KIND_BY_TURN[only];
      // First binding wins: a head claimed by two approaches is an authoring
      // problem, and picking deterministically beats a glyph that changes
      // between frames.
      if (lens && !lenses.has(headId)) lenses.set(headId, lens);
    }
  }
  return lenses;
}

/** The lens a head draws, defaulting to the three-lens ball housing. */
export function lensKindForHead(
  lenses: ReadonlyMap<string, SignalLensKind>,
  headId: string,
): SignalLensKind {
  return lenses.get(headId) ?? "ball";
}
