import type { Interaction, ScenarioTemplateV2, Verb } from '@simforge-oss/scenario';

export type ActorClass = ScenarioTemplateV2['roles'][number]['actor']['class'];
export type ActionFamily = 'vehicle' | 'pedestrian' | 'robot' | 'drone' | 'cyclist' | 'static';
export type ActionResource = 'longitudinal' | 'lateral' | 'topology' | 'existence' | 'indicator' | 'horn' | 'lights' | 'state';
export interface ActionDefinition { readonly id: string; readonly label: string; readonly group: string; readonly verb: Verb; readonly target: Record<string, unknown>; readonly resource: ActionResource; readonly durationS: number; }

const speed = (id: string, label: string, target: Record<string, unknown>, durationS = 1): ActionDefinition => ({ id, label, group: 'Speed', verb: 'speed', target, resource: 'longitudinal', durationS });
const lateral = (id: string, label: string, verb: 'changeLane' | 'laneOffset' | 'route', target: Record<string, unknown>, durationS = 2): ActionDefinition => ({ id, label, group: 'Direction', verb, target, resource: 'lateral', durationS });
const route = (id: string, label: string, turn: 'straight' | 'left' | 'right', durationS = 2): ActionDefinition => ({ id, label, group: 'Direction', verb: 'route', target: { mode: 'nextJunction', turn }, resource: 'topology', durationS });
const customRoute = (): ActionDefinition => ({
  id: 'custom_route',
  label: 'Custom route',
  group: 'Routes',
  verb: 'route',
  // Replaced with clicked scene points before the drawing gesture commits, and
  // re-seeded onto the actor by the document if it is added without one. One
  // point is the whole placeholder: an untimed route has no time axis, so a
  // lone point says "stands here" and a second copy would add nothing.
  target: { mode: 'customRoute', points: [{ x: 0, z: 0 }] },
  resource: 'topology',
  durationS: 1,
});
const customTimedRoute = (): ActionDefinition => ({
  id: 'custom_timed_route',
  label: 'Custom timed route',
  group: 'Routes',
  verb: 'route',
  // The drawing gesture replaces this placeholder with one-second keyframes.
  // A timed route is the harsher of the two to get wrong: its points are
  // absolute positions at absolute times, so a committed placeholder pins the
  // actor to the map centre at t=0. One keyframe holds the spot for the clip.
  target: { mode: 'customTimedRoute', points: [{ timeS: 0, x: 0, z: 0 }] },
  resource: 'topology',
  durationS: 1,
});
const signal = (id: string, label: string, key: string, value: unknown, resource: ActionResource): ActionDefinition => ({ id, label, group: 'Signals', verb: 'set', target: { key, value }, resource, durationS: .35 });

const VEHICLE: readonly ActionDefinition[] = [
  speed('accelerate', 'Accelerate to target speed', { mode: 'absolute', valueKph: 48 }), speed('increase_speed', 'Increase speed by 10 km/h', { mode: 'delta', deltaKph: 10 }), speed('decelerate', 'Decrease speed by 10 km/h', { mode: 'delta', deltaKph: -10 }), speed('brake_stop', 'Brake to stop', { mode: 'stop' }, 1.5), speed('resume', 'Resume default speed', { mode: 'resume' }),
  lateral('lane_left', 'Change lane left (if available)', 'changeLane', { mode: 'relative', dk: 1 }), lateral('lane_right', 'Change lane right (if available)', 'changeLane', { mode: 'relative', dk: -1 }), route('keep_lane', 'Go straight at next junction', 'straight'), route('turn_left', 'Turn left at next junction', 'left'), route('turn_right', 'Turn right at next junction', 'right'), customRoute(), customTimedRoute(), lateral('pull_over', 'Pull over', 'laneOffset', { tFrac: -.8, reference: 'lane_center' }, 3),
  signal('indicator_left', 'Left blinker', 'lights.indicator', 'left', 'indicator'), signal('indicator_right', 'Right blinker', 'lights.indicator', 'right', 'indicator'), signal('indicator_hazard', 'Hazard lights', 'lights.indicator', 'hazard', 'indicator'), signal('indicator_off', 'Blinkers off', 'lights.indicator', 'off', 'indicator'), signal('horn_on', 'Sound horn', 'audio.horn', true, 'horn'), signal('horn_off', 'Stop horn', 'audio.horn', false, 'horn'), signal('lights_on', 'Headlights on', 'lights.headlights', 'low', 'lights'), signal('lights_off', 'Headlights off', 'lights.headlights', 'off', 'lights'),
];
const PEDESTRIAN: readonly ActionDefinition[] = [
  speed('walk', 'Walk', { mode: 'absolute', valueKph: 5 }, .6), speed('wait', 'Wait', { mode: 'stop' }, .4), speed('pace_faster', 'Walk faster', { mode: 'delta', deltaKph: 2 }), speed('pace_slower', 'Walk slower', { mode: 'delta', deltaKph: -2 }),
  customRoute(), customTimedRoute(),
];
const ROBOT: readonly ActionDefinition[] = [
  speed('robot_drive', 'Drive', { mode: 'absolute', valueKph: 6 }, .6), speed('robot_wait', 'Wait', { mode: 'stop' }, .4), speed('robot_faster', 'Drive faster', { mode: 'delta', deltaKph: 2 }), speed('robot_slower', 'Drive slower', { mode: 'delta', deltaKph: -2 }),
  customRoute(), customTimedRoute(),
];
const DRONE: readonly ActionDefinition[] = [
  speed('drone_fly', 'Fly', { mode: 'absolute', valueKph: 18 }, .6), speed('drone_hover', 'Hover', { mode: 'stop' }, .4), speed('drone_faster', 'Fly faster', { mode: 'delta', deltaKph: 5 }), speed('drone_slower', 'Fly slower', { mode: 'delta', deltaKph: -5 }),
  customRoute(), customTimedRoute(),
];
const CYCLIST: readonly ActionDefinition[] = [
  speed('cycle_faster', 'Pedal faster', { mode: 'delta', deltaKph: 5 }), speed('cycle_slower', 'Slow down', { mode: 'delta', deltaKph: -5 }), speed('cycle_stop', 'Stop', { mode: 'stop' }, 1.2), speed('cycle_resume', 'Resume default speed', { mode: 'resume' }), speed('cycle_target_speed', 'Set target speed', { mode: 'absolute', valueKph: 18 }), lateral('cycle_lane_left', 'Move left (if available)', 'changeLane', { mode: 'relative', dk: 1 }), lateral('cycle_lane_right', 'Move right (if available)', 'changeLane', { mode: 'relative', dk: -1 }), route('cycle_keep_lane', 'Go straight at next junction', 'straight'), route('cycle_turn_left', 'Turn left at next junction', 'left'), route('cycle_turn_right', 'Turn right at next junction', 'right'), customRoute(), customTimedRoute(),
];

export function actionFamily(actorClass: ActorClass, catalogId?: string): ActionFamily { if (actorClass === 'static_object') return 'static'; if (actorClass === 'sidewalk_robot') return 'robot'; if (actorClass === 'drone') return 'drone'; if (actorClass === 'pedestrian' || actorClass === 'animal') return 'pedestrian'; if (actorClass === 'bicycle' || actorClass === 'scooter' || /bicycle|cyclist/.test(catalogId ?? '')) return 'cyclist'; return 'vehicle'; }
export function actionsForActor(actorClass: ActorClass, catalogId?: string): readonly ActionDefinition[] { const family = actionFamily(actorClass, catalogId); return family === 'vehicle' ? VEHICLE : family === 'pedestrian' ? PEDESTRIAN : family === 'robot' ? ROBOT : family === 'drone' ? DRONE : family === 'cyclist' ? CYCLIST : []; }
export function defaultSpeedKph(actorClass: ActorClass, catalogId?: string): number { const family = actionFamily(actorClass, catalogId); return family === 'vehicle' ? 48.28032 : family === 'cyclist' || family === 'drone' ? 18 : family === 'robot' ? 6 : family === 'pedestrian' ? 5 : 0; }
export function actionResource(interaction: Interaction): ActionResource { if (interaction.verb === 'speed' || interaction.verb === 'gap') return 'longitudinal'; if (interaction.verb === 'changeLane' || interaction.verb === 'laneOffset') return 'lateral'; if (interaction.verb === 'route') return 'topology'; if (interaction.verb === 'exist') return 'existence'; const key = String(interaction.target.key); if (key === 'lights.indicator') return 'indicator'; if (key === 'audio.horn') return 'horn'; if (key === 'lights.headlights') return 'lights'; return 'state'; }
/** A quick-action menu is narrower than the canonical editor API; never use it to discard a valid command. */
export function isActionCompatible(interaction: Interaction, actorClass: ActorClass, catalogId?: string): boolean { if (actionFamily(actorClass, catalogId) === 'static') return false; const resource = actionResource(interaction); if (!resource) return false; return actionsForActor(actorClass, catalogId).some((item) => item.verb === interaction.verb && item.resource === resource); }
export function definitionForInteraction(interaction: Interaction, actorClass: ActorClass, catalogId?: string): ActionDefinition | undefined { return actionsForActor(actorClass, catalogId).find((item) => item.verb === interaction.verb && JSON.stringify(item.target) === JSON.stringify(interaction.target)); }
/** Build an interaction on the editor's single non-negative playback clock. */
export function interactionForAction(definition: ActionDefinition, actor: string, time: number, ordinal: number, maneuver?: { durationS: number; style: 'cautious' | 'normal' | 'assertive' }): Interaction { const start = Math.max(0, Number(time.toFixed(3))); const lateral = definition.verb === 'changeLane' || definition.verb === 'laneOffset'; const maneuverDurationS = maneuver?.durationS ?? definition.durationS; return { id: `${definition.id}_${actor}_${ordinal}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64), actor, label: definition.label, trigger: { kind: 'at', t: start }, until: { kind: 'at', t: Number((start + Math.max(.1, definition.durationS)).toFixed(3)) }, verb: definition.verb, target: definition.target, ...(['speed', 'gap', 'changeLane', 'laneOffset'].includes(definition.verb) ? { dynamics: { shape: lateral ? 'sinusoidal' as const : 'linear' as const, constraint: 'time' as const, value: lateral ? maneuverDurationS : definition.durationS } } : {}), ...(lateral ? { maneuverDurationS, maneuverStyle: maneuver?.style ?? 'normal' as const } : {}) } as Interaction; }
