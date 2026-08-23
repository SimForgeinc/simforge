/**
 * The NL→schema extraction prompt.
 *
 * The extractor's ONLY job is parsing prose into claims.v1 — it never judges
 * truth. The prompt therefore describes the schema, the scenario's actor
 * inventory (ids are engine-assigned and must be used verbatim), the decision
 * grid, and the strict output contract. Truth judgment stays in the
 * deterministic checkers by construction.
 */

import { CLAIMS_V1_JSON_SCHEMA, CLAIMS_SCHEMA_ID } from '../claims.js';

export const EXTRACTION_SYSTEM_PROMPT = `You convert natural-language descriptions of autonomous-driving scenario episodes into typed propositions over engine state.

Output: exactly one JSON object conforming to the claims_v1 JSON Schema. No prose, no markdown fences.

Proposition types:
- visibility: an actor's line-of-sight state ("visible" | "occluded") to an observer (default the ego) over a half-open tick range [fromTS, toTS) in seconds.
- causal-trigger: an ordered event->event proposition. cause/effect reference engine events by kind (trigger-fired, trigger-skipped, preemption, released, completed, conflict-genesis), optionally narrowed by interactionId and actorId. relation "causes" means the effect followed within ~2 s with nothing intervening on the same actor; "precedes" means ordering only.
- intent: one actor's executed maneuver intent, as one of the interaction verbs: speed, gap, changeLane, laneOffset, route, exist-present, exist-absent, set.
- spatial: a relation of one actor to a reference actor (default the ego): ahead-of, behind, left-of, right-of, same-lane, within-distance (requires valueM).

Rules:
- Use ONLY the actor ids given in the scenario context. Never invent actor ids.
- Every claim needs: id (stable slug), type, actorIds (>=1), tickRange, checkable.
- checkable is "deterministic" when the proposition is fully stated by the description (state, order, relation, intent). Use "extracted" for hedged or subjective statements that reference the scene but cannot be pinned to engine state.
- Decompose fully: one proposition per atomic statement. Prefer more small claims over one compound claim.
- If the description asserts nothing of a type, emit no claim of that type.`;

/** The user turn: scenario context + the description to parse. */
export function extractionUserPrompt(description: string, scenarioContext: string): string {
  return [
    'SCENARIO CONTEXT (authoritative actor ids and timing):',
    scenarioContext,
    '',
    'DESCRIPTION TO PARSE:',
    description,
    '',
    `Return one JSON object with "schema": "${CLAIMS_SCHEMA_ID}".`,
  ].join('\n');
}

/** Exported for clients that wire native structured-output requests. */
export const EXTRACTION_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: CLAIMS_V1_JSON_SCHEMA.name,
    schema: CLAIMS_V1_JSON_SCHEMA.schema,
    strict: true,
  },
} as const;

/** Compact scenario context line for the prompt (actor inventory + duration). */
export function scenarioContextLine(scenario: {
  readonly id: string;
  readonly egoId: string;
  readonly actorKinds: Record<string, string>;
  readonly clipSeconds: number;
  readonly decisionHz: number;
}): string {
  const actors = Object.entries(scenario.actorKinds)
    .map(([id, kind]) => `${id} (${kind})`)
    .sort();
  return `scenarioId=${scenario.id}; ego=${scenario.egoId}; otherActors=[${actors.join(', ')}]; clipSeconds=${scenario.clipSeconds}; decisionHz=${scenario.decisionHz}`;
}
