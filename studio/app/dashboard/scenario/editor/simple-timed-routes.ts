import type { Interaction } from "@simforge-oss/scenario";
import {
  setExclusiveCustomTimedRoute,
  type EditorDocument,
} from "@simforge-oss/editor";
import type { SceneTrace } from "@simforge-oss/engine";

export type EditorExperience = "simple" | "advanced";

export const EDITOR_EXPERIENCE_STORAGE_KEY = "simcloud.uniscenario.editor-experience.v1";

const MOTION_VERBS: Partial<Record<Interaction["verb"], true>> = {
  speed: true,
  gap: true,
  changeLane: true,
  laneOffset: true,
  route: true,
};

function isMotionVerb(verb: Interaction["verb"]): boolean {
  return MOTION_VERBS[verb] === true;
}

export function readEditorExperience(storage: Pick<Storage, "getItem">): EditorExperience {
  try {
    return storage.getItem(EDITOR_EXPERIENCE_STORAGE_KEY) === "advanced"
      ? "advanced"
      : "simple";
  } catch {
    return "simple";
  }
}

export function writeEditorExperience(
  storage: Pick<Storage, "setItem">,
  experience: EditorExperience,
): void {
  try {
    storage.setItem(EDITOR_EXPERIENCE_STORAGE_KEY, experience);
  } catch {
    // Storage can be unavailable in embedded or privacy-hardened browsers.
  }
}

export function isCustomTimedRoute(
  interaction: Interaction,
): interaction is Interaction & {
  verb: "route";
  target: { mode: "customTimedRoute"; points: readonly TimedRoutePoint[] };
} {
  return interaction.verb === "route"
    && interaction.target.mode === "customTimedRoute"
    && Array.isArray(interaction.target.points);
}

export type TimedRoutePoint = { timeS: number; x: number; z: number };

const SIMPLE_ROUTE_TIME_EPSILON = 1e-9;

export function simpleRouteTimes(clipSeconds: number): number[] {
  const wholeSeconds = Math.floor(Math.max(0, clipSeconds));
  const times = Array.from({ length: wholeSeconds + 1 }, (_, index) => index);
  if (clipSeconds - wholeSeconds > 1e-9) times.push(Number(clipSeconds.toFixed(3)));
  return times.length >= 2 ? times : [0, Math.max(0.1, Number(clipSeconds.toFixed(3)))];
}

export function isClipLockedSimpleRoute(
  interaction: Interaction,
  clipSeconds: number,
): boolean {
  if (!isCustomTimedRoute(interaction)) return false;
  const points = interaction.target.points;
  return interaction.trigger.kind === "at"
    && typeof interaction.trigger.t === "number"
    && Math.abs(interaction.trigger.t) <= SIMPLE_ROUTE_TIME_EPSILON
    && interaction.until?.kind === "at"
    && typeof interaction.until.t === "number"
    && Math.abs(interaction.until.t - clipSeconds) <= SIMPLE_ROUTE_TIME_EPSILON
    && points.length >= 1;
}

function legacyExpandedPoints(
  interaction: Interaction,
  clipSeconds: number,
): TimedRoutePoint[] | null {
  if (!isCustomTimedRoute(interaction)) return null;
  const points = interaction.target.points;
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last
    || Math.abs(first.timeS) > SIMPLE_ROUTE_TIME_EPSILON
    || Math.abs(last.timeS - clipSeconds) > SIMPLE_ROUTE_TIME_EPSILON) return null;
  const firstPosition = points[0]!;
  const stationary = points.every((point) => Math.hypot(point.x - firstPosition.x, point.z - firstPosition.z) <= 0.05);
  if (stationary) {
    return points.slice(0, 2).map((point, index) => ({ ...point, timeS: index }));
  }
  if (points.length >= Math.floor(clipSeconds) + 1) return null;
  const evenlyStretched = points.every((point, index) => Math.abs(
    point.timeS - index * clipSeconds / (points.length - 1),
  ) <= 0.002);
  return evenlyStretched
    ? points.map((point, index) => ({ ...point, timeS: index }))
    : null;
}

function sampleTraceActor(
  trace: SceneTrace | null | undefined,
  actorId: string,
  timeS: number,
): { x: number; z: number } | null {
  const track = trace?.ticks.actors[actorId];
  const times = trace?.ticks.t;
  if (!track || !times?.length || track.x.length < times.length || track.z.length < times.length) return null;
  let right = times.findIndex((time) => time >= timeS - 1e-9);
  if (right < 0) right = times.length - 1;
  const left = Math.max(0, right - 1);
  const fromT = times[left]!;
  const toT = times[right]!;
  const fraction = right === left || toT <= fromT
    ? 0
    : Math.max(0, Math.min(1, (timeS - fromT) / (toT - fromT)));
  const x = track.x[left]! + (track.x[right]! - track.x[left]!) * fraction;
  const z = track.z[left]! + (track.z[right]! - track.z[left]!) * fraction;
  return { x: Number(x.toFixed(3)), z: Number(z.toFixed(3)) };
}

function routeId(actorId: string): string {
  return `simple_timed_route_${actorId}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

export function needsSimpleRouteConversion(document: EditorDocument): boolean {
  const clipSeconds = document.data.choreography.clipSeconds;
  const movableActorIds = new Set(
    document.data.roles
      .filter((role) => !role.actor.static)
      .map((role) => role.id),
  );
  for (const actorId of movableActorIds) {
    const motion = document.data.choreography.interactions.filter(
      (interaction) => interaction.actor === actorId && isMotionVerb(interaction.verb),
    );
    if (motion.length !== 1
      || !isClipLockedSimpleRoute(motion[0]!, clipSeconds)
      || legacyExpandedPoints(motion[0]!, clipSeconds)) return true;
  }
  return false;
}

export function hasAdvancedMotion(document: EditorDocument): boolean {
  return document.data.choreography.interactions.some(
    (interaction) => isMotionVerb(interaction.verb) && !isCustomTimedRoute(interaction),
  );
}

/**
 * Give each movable actor one simple timed route. Existing authored timed
 * points are preserved exactly; only the locked full-width timeline shell is
 * normalized. Advanced motion can still be baked from its trace when the user
 * deliberately switches editor modes.
 */
export function convertDocumentToSimpleTimedRoutes(
  document: EditorDocument,
  trace?: SceneTrace | null,
): void {
  const clipSeconds = document.data.choreography.clipSeconds;
  const times = simpleRouteTimes(clipSeconds);
  for (const role of document.data.roles) {
    if (role.actor.static) continue;
    const existingMotion = document.data.choreography.interactions.filter(
      (interaction) => interaction.actor === role.id && isMotionVerb(interaction.verb),
    );
    if (existingMotion.length === 1 && isCustomTimedRoute(existingMotion[0]!)) {
      const existingRoute = existingMotion[0];
      const repairedPoints = legacyExpandedPoints(existingRoute, clipSeconds);
      if (isClipLockedSimpleRoute(existingRoute, clipSeconds) && !repairedPoints) continue;
      setExclusiveCustomTimedRoute(document, {
        ...existingRoute,
        ...(repairedPoints ? { target: { ...existingRoute.target, points: repairedPoints } } : {}),
      });
      continue;
    }

    for (const interaction of existingMotion) document.removeInteraction(interaction.id);
    const authored = document.actor(role.id);
    const pose = authored
      ?? (role.kind === "scene_absolute" ? { x: role.pose.position.x, z: role.pose.position.z } : null);
    // A lane-relative role has no pose until the scene resolves it. Seeding at
    // the scene origin would park the actor at the middle of the map, so leave
    // it routeless and seed on the revision that does resolve a pose.
    if (!pose) continue;
    const fallback = {
      x: Number(pose.x.toFixed(3)),
      z: Number(pose.z.toFixed(3)),
    };
    const actorTimes = trace?.ticks.actors[role.id]
      ? times
      : [0, Math.max(0.1, Math.min(1, Number(clipSeconds.toFixed(3))))];
    const points = actorTimes.map((timeS) => ({
      timeS,
      ...(sampleTraceActor(trace, role.id, timeS) ?? fallback),
    }));
    setExclusiveCustomTimedRoute(document, {
      id: routeId(role.id),
      actor: role.id,
      label: "Simple timed route",
      trigger: { kind: "at", t: 0 },
      until: { kind: "at", t: clipSeconds },
      verb: "route",
      target: { mode: "customTimedRoute", points },
    });
  }
}
