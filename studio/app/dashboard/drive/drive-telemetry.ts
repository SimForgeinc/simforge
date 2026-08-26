export function speedMpsToKph(speedMps: number): number {
  return Number.isFinite(speedMps) ? Math.max(0, speedMps) * 3.6 : 0;
}

export function actorSpeedKph(
  frame: { actors: readonly { id: string; speedMps: number }[] } | null,
  actorId: string | null,
): number {
  if (!frame || !actorId) return 0;
  return speedMpsToKph(frame.actors.find((actor) => actor.id === actorId)?.speedMps ?? 0);
}

export function formatClipTime(timeS: number, durationS: number): string {
  const duration = Number.isFinite(durationS) ? Math.max(0, durationS) : 0;
  const time = Number.isFinite(timeS) ? Math.min(duration, Math.max(0, timeS)) : 0;
  return `${time.toFixed(1)} / ${duration.toFixed(1)} s`;
}
