import type { ScenePoint } from '../schema/input.js';

export type PedestrianProjectionSegmentKind = 'stationary' | 'walking' | 'invalid';

export interface PedestrianProjectionMovement {
  readonly interactionId: string;
  readonly triggerTimeS: number | null;
  readonly speedMps: number;
  readonly points: readonly ScenePoint[];
  readonly diagnostic?: string;
}

export interface PedestrianProjectionSegment {
  readonly interactionId: string | null;
  readonly kind: PedestrianProjectionSegmentKind;
  readonly startTimeS: number;
  readonly endTimeS: number;
  readonly points: readonly ScenePoint[];
  readonly diagnostic?: string;
}

export interface PedestrianProjection {
  readonly actorId: string;
  readonly segments: readonly PedestrianProjectionSegment[];
  readonly triggerPoints: readonly { interactionId: string; timeS: number; point: ScenePoint }[];
  readonly endpoint: ScenePoint;
  readonly planHash: string;
}

function hash(value: unknown): string {
  const text = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Shared preview/playback projection for authored pedestrian routes. */
export function resolvePedestrianProjection(input: {
  actorId: string;
  start: ScenePoint;
  clipSeconds: number;
  movements: readonly PedestrianProjectionMovement[];
}): PedestrianProjection {
  let point = input.start;
  let time = 0;
  const segments: PedestrianProjectionSegment[] = [];
  const triggerPoints: Array<{ interactionId: string; timeS: number; point: ScenePoint }> = [];
  const movements = [...input.movements].sort((a, b) => (a.triggerTimeS ?? Infinity) - (b.triggerTimeS ?? Infinity) || a.interactionId.localeCompare(b.interactionId));
  for (const movement of movements) {
    if (movement.triggerTimeS === null || movement.points.length < 2 || movement.speedMps <= 0) {
      segments.push({ interactionId: movement.interactionId, kind: 'invalid', startTimeS: time, endTimeS: time, points: [point], diagnostic: movement.diagnostic ?? 'unresolved pedestrian movement' });
      continue;
    }
    const trigger = Math.max(time, movement.triggerTimeS);
    if (trigger > time) segments.push({ interactionId: null, kind: 'stationary', startTimeS: time, endTimeS: trigger, points: [point, point] });
    const points = [point, ...movement.points.slice(1)];
    let length = 0;
    for (let i = 1; i < points.length; i++) length += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.z - points[i - 1]!.z);
    const end = Math.min(input.clipSeconds, trigger + length / movement.speedMps);
    segments.push({ interactionId: movement.interactionId, kind: 'walking', startTimeS: trigger, endTimeS: end, points });
    triggerPoints.push({ interactionId: movement.interactionId, timeS: trigger, point });
    point = points[points.length - 1]!;
    time = end;
  }
  if (time < input.clipSeconds) segments.push({ interactionId: null, kind: 'stationary', startTimeS: time, endTimeS: input.clipSeconds, points: [point, point] });
  const canonical = { actorId: input.actorId, segments, triggerPoints, endpoint: point };
  return { ...canonical, planHash: hash(canonical) };
}

