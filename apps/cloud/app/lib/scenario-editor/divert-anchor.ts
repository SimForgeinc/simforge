/**
 * Where an actor will BE when a clip fires.
 *
 * A divert starts from wherever the car has got to several seconds in, not from
 * its spawn — "the freeform points depend on the time". Nothing in the draft
 * records that position, because it is not authored: it is the result of driving
 * everything before the clip. What does know it is the local preview simulation,
 * which the editor is already running continuously and which produces a frame per
 * actor per timestamp.
 *
 * So this is a read of the preview, and it inherits the preview's honesty
 * problems on purpose:
 *
 *   - `null` when there are no frames yet, or none for this actor, or none at or
 *     after the time asked for. A caller that invents a position instead would
 *     anchor the manoeuvre somewhere the car never goes.
 *   - the frames may be one edit stale. That is visible to the author (the car
 *     is drawn where the frames say) and self-corrects on the next re-sim, which
 *     is a much better failure than a silently wrong anchor.
 */

/**
 * Structural, not `PreviewFrame`. The editor and the shared engine each declare
 * their own frame type and they differ in ways this does not care about (actor
 * `id` is `string | number` on one side), so naming either would make this
 * readable from only half the app for no gain.
 */
type AnchorFrame = {
  timestamp: number;
  actors?: ReadonlyArray<{
    id?: string | number;
    actor_spec_id?: string | null;
    x?: number;
    y?: number;
    z?: number;
  }>;
};

export type DivertAnchor = { x: number; y: number; z: number };

/**
 * The actor's position at `seconds`, from the frames on stage.
 *
 * Takes the first frame AT or AFTER the time rather than interpolating: frames
 * are 20 Hz, the clip trigger is quantized to 0.1 s, and half a tick of error
 * (~0.25 m at 50 kph) is far inside the 3 m the runtime's cursor tolerates.
 * Interpolating would imply a precision the anchor does not have.
 */
export function divertAnchorAt(
  frames: readonly AnchorFrame[] | null | undefined,
  actorId: string,
  seconds: number,
): DivertAnchor | null {
  if (!frames || frames.length === 0) return null;
  if (!Number.isFinite(seconds)) return null;
  for (const frame of frames) {
    if (frame.timestamp < seconds - 1e-6) continue;
    const actor = frame.actors?.find(
      (candidate) =>
        candidate.actor_spec_id === actorId || candidate.id === actorId,
    );
    if (!actor) continue;
    if (!Number.isFinite(actor.x) || !Number.isFinite(actor.y)) return null;
    return {
      x: actor.x as number,
      y: actor.y as number,
      z: Number.isFinite(actor.z) ? (actor.z as number) : 0,
    };
  }
  return null;
}
