export function speedMpsToKph(speedMps: number): number {
  return Number.isFinite(speedMps) ? Math.max(0, speedMps) * 3.6 : 0;
}

export function actorSpeedKph(
  frame: {
    scene: {
      actors: readonly {
        id: string;
        velocity: readonly [number, number, number];
      }[];
    };
  } | null,
  actorId: string | null,
): number {
  if (!frame || !actorId) return 0;
  const velocity = frame.scene.actors.find((actor) => actor.id === actorId)?.velocity;
  return speedMpsToKph(velocity ? Math.hypot(velocity[0], velocity[2]) : 0);
}

export function formatClipTime(timeS: number, durationS: number): string {
  const duration = Number.isFinite(durationS) ? Math.max(0, durationS) : 0;
  const time = Number.isFinite(timeS) ? Math.min(duration, Math.max(0, timeS)) : 0;
  return `${time.toFixed(1)} / ${duration.toFixed(1)} s`;
}
