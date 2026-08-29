import type { Interaction } from '@simforge-oss/scenario';
import type { EditorDocument } from './document';

const MOTION_VERBS: Partial<Record<Interaction['verb'], true>> = {
  speed: true,
  gap: true,
  changeLane: true,
  laneOffset: true,
  route: true,
};

/**
 * Make a custom timed route the actor's only motion instruction and lock it to
 * the complete authored clip.
 */
export function setExclusiveCustomTimedRoute(
  document: EditorDocument,
  interaction: Interaction,
): boolean {
  if (
    interaction.verb !== 'route'
    || interaction.target.mode !== 'customTimedRoute'
    || !Array.isArray(interaction.target.points)
  ) {
    return false;
  }

  const normalized: Interaction = {
    ...interaction,
    trigger: { kind: 'at', t: 0 },
    until: { kind: 'at', t: document.data.choreography.clipSeconds },
  };
  const existing = document.data.choreography.interactions.find(
    (candidate) => candidate.id === interaction.id,
  );
  for (const candidate of document.data.choreography.interactions) {
    if (
      candidate.id !== interaction.id
      && candidate.actor === interaction.actor
      && MOTION_VERBS[candidate.verb] === true
    ) {
      document.removeInteraction(candidate.id);
    }
  }
  if (existing) document.replaceInteraction(interaction.id, normalized);
  else document.addInteraction(normalized);
  return true;
}

/**
 * Replace one newly placed movable actor's compiler-provided motion with the
 * stationary two-point, full-clip route expected by Simple authoring mode.
 */
export function armActorSimpleTimedRoute(
  document: EditorDocument,
  actorId: string,
): boolean {
  const role = document.data.roles.find((candidate) => candidate.id === actorId);
  if (!role || role.actor.static) return false;

  const authored = document.actor(role.id);
  const pose = authored
    ?? (role.kind === 'scene_absolute'
      ? { x: role.pose.position.x, z: role.pose.position.z }
      : null);
  if (!pose) return false;

  const point = {
    x: Number(pose.x.toFixed(3)),
    z: Number(pose.z.toFixed(3)),
  };
  const second = Math.max(
    0.1,
    Math.min(1, Number(document.data.choreography.clipSeconds.toFixed(3))),
  );
  return setExclusiveCustomTimedRoute(document, {
    id: `simple_timed_route_${role.id}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64),
    actor: role.id,
    label: 'Simple timed route',
    trigger: { kind: 'at', t: 0 },
    until: { kind: 'at', t: document.data.choreography.clipSeconds },
    verb: 'route',
    target: {
      mode: 'customTimedRoute',
      points: [
        { timeS: 0, ...point },
        { timeS: second, ...point },
      ],
    },
  });
}
