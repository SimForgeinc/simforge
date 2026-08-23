import type { ScenarioTemplateV2 } from './schema/v2/template.js';

/** Supported authored-actor envelope for editing and variation generation. */
export const MAX_AUTHORED_ACTORS = 32;

/** Stable machine-readable code shared by validation and operation failures. */
export const AUTHORED_ACTOR_LIMIT_CODE = 'authored_actor_limit_exceeded' as const;

/** Count authored actors without counting ambient traffic generated at runtime. */
export function authoredActorCount(template: Pick<ScenarioTemplateV2, 'roles'>): number {
  return template.roles.length;
}

export function authoredActorLimitMessage(actual: number): string {
  return `scenario has ${actual} authored actors; the supported maximum is ${MAX_AUTHORED_ACTORS}`;
}
