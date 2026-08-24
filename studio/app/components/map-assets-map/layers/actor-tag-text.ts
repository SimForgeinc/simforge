import type { RuntimeActorMarker } from "./RuntimeActorLayers";

const MPS_TO_KPH = 3.6;

/**
 * What the floating tag over a 3D actor reads.
 *
 * The name always; the speed only while a playback is driving the actor.
 * `speedMps` is present on exactly the markers built from a preview frame
 * (`useScenarioEditorMapModel`), so its presence IS the "is there a playback"
 * test — an authored car no run has touched reads "Subject", not "Subject 0 km/h",
 * because 0 would be a claim about a simulation that never happened.
 *
 * Returns null for actors whose label is suppressed (parked road cars, the
 * cross-map variation sheet), so 3D honours the same `hideLabel` the 2D marker
 * layer does rather than inventing a second rule.
 */
export function actorTagText(actor: RuntimeActorMarker): string | null {
  if (actor.hideLabel) return null;
  const name = actor.label?.trim();
  if (!name) return null;
  const speedMps = actor.speedMps;
  if (speedMps == null || !Number.isFinite(speedMps)) return name;
  return `${name}  ${Math.round(speedMps * MPS_TO_KPH)} km/h`;
}
