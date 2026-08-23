export function shouldShowRoutePointWarning(input: {
  readonly previousPointCount: number | null;
  readonly pointCount: number;
  readonly mode: string;
  readonly tool: string | null;
}): boolean {
  return input.mode === "drawingRoute"
    && input.tool === "add"
    && input.previousPointCount != null
    && input.pointCount > input.previousPointCount;
}

export function routePointWarningMessage(actorName?: string): string {
  const rawName = actorName?.trim().replaceAll("_", " ");
  const genericActor = rawName?.toLowerCase();
  const subject = genericActor && [
    "pedestrian",
    "vehicle",
    "sidewalk robot",
    "animal",
    "drone",
  ].includes(genericActor)
    ? `the ${genericActor}`
    : rawName || "the actor";
  return `This sequence of points may make ${subject} move too fast.`;
}

const MAX_ONE_SECOND_DISTANCE_M: Readonly<Record<string, number>> = {
  pedestrian: 2.2,
  sidewalk_robot: 1.8,
  animal: 8,
  bicycle: 10,
  scooter: 12,
  motorcycle: 16.7,
  vehicle: 13.9,
  drone: 20,
};

export function routePointMayBeTooFast(input: {
  readonly actorKind: string | undefined;
  readonly from: { readonly x: number; readonly z: number } | null;
  readonly to: { readonly x: number; readonly z: number };
}): boolean {
  if (!input.from || !input.actorKind) return false;
  const maxDistance = MAX_ONE_SECOND_DISTANCE_M[input.actorKind];
  if (maxDistance == null) return false;
  return Math.hypot(input.to.x - input.from.x, input.to.z - input.from.z) > maxDistance;
}
