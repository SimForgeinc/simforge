import type { Interaction } from "@uniscenarios/scenario-model";

const ROUTE_MOVEMENT_EPSILON_METERS = 0.05;

/**
 * A newly placed actor receives a short two-point timed-route placeholder at
 * its starting pose. Treat it as unfinished until the author draws at least
 * one point with meaningful movement.
 */
export function isUnconfiguredSimpleTimedRoute(interaction: Interaction): boolean {
  if (interaction.verb !== "route" || interaction.target.mode !== "customTimedRoute") {
    return false;
  }

  const first = interaction.target.points[0];
  if (!first || interaction.target.points.length < 2) return true;

  const epsilonSquared = ROUTE_MOVEMENT_EPSILON_METERS ** 2;
  return interaction.target.points.every((point) => {
    const dx = point.x - first.x;
    const dz = point.z - first.z;
    return dx * dx + dz * dz <= epsilonSquared;
  });
}
