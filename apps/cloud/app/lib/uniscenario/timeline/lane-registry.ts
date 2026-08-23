import type { TimelineMark, TimelineRange } from "./geometry";

/**
 * How a lane gets onto the timeline without the timeline knowing what it is.
 *
 * This is the seam between this lane and the signals lane. `signal-timeline-model.ts` and
 * `SceneSignalLane` belong to `signals-porter`; the timeline renders a signal lane but must never
 * import from `lib/uniscenario/signals/**`. Three properties make that hold:
 *
 *  1. `datum` is generic, so a lane carries state the timeline has no type for.
 *  2. `spans(window)` is a PULL, so each lane keeps ownership of its own sampling. The timeline asks
 *     "what is in this window", it does not subscribe to signal internals or reimplement phase
 *     evaluation.
 *  3. Registration is one-directional — signals import this module, never the reverse.
 *
 * v1 had already started down this road: `SignalTriggerTarget` in `timeline-model.ts` is purely
 * structural (`junction_id`, `label`, `movements`), and the `signal_state` blocker was deliberately
 * deleted from `runtimeBlockReason` because "its evaluator shipped with the signal plans". This
 * formalises the direction rather than inventing it.
 */
export type TimelineLaneKind = "actor" | "signal" | "annotation";

/** One positioned thing on a lane. The timeline lays these out and never inspects `datum`. */
export type TimelineLaneSpan<TDatum = unknown> = {
  id: string;
  startMs: number;
  endMs: number;
  /** Presentation hint chosen by the lane's owner, not by the timeline. */
  className?: string;
  datum: TDatum;
};

export type TimelineLaneSource<TDatum = unknown> = {
  laneId: string;
  kind: TimelineLaneKind;
  label: string;
  /** Ascending. Ties break on `laneId` so ordering is stable across renders. */
  order: number;
  /** Everything intersecting `window`. Called on scroll and zoom, so keep it cheap. */
  spans(window: TimelineRange): ReadonlyArray<TimelineLaneSpan<TDatum>>;
  /** Point-in-time ticks — signal phase changes, trigger fires. */
  marks?(window: TimelineRange): ReadonlyArray<TimelineMark>;
};

export type TimelineLaneRegistry = {
  /** Returns a dispose function; calling it twice is safe. */
  register(source: TimelineLaneSource): () => void;
  /** Sorted by `order`, then `laneId`. */
  lanes(): ReadonlyArray<TimelineLaneSource>;
  subscribe(listener: () => void): () => void;
};

/**
 * Deliberately not a React store and not a zustand slice.
 *
 * A plain object keeps the domain testable without a renderer and lets the dock own its own
 * subscription strategy. `subscribe` exists so a `useSyncExternalStore` can sit on top without this
 * module importing React.
 */
export function createTimelineLaneRegistry(): TimelineLaneRegistry {
  const sources = new Map<string, TimelineLaneSource>();
  const listeners = new Set<() => void>();

  function emit() {
    for (const listener of listeners) listener();
  }

  return {
    register(source) {
      if (sources.has(source.laneId)) {
        throw new Error(
          `Timeline lane "${source.laneId}" is already registered. Lane ids must be unique — a ` +
            `duplicate silently hides one lane behind the other.`,
        );
      }
      sources.set(source.laneId, source);
      emit();
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        sources.delete(source.laneId);
        emit();
      };
    },

    lanes() {
      return [...sources.values()].sort(
        (a, b) => a.order - b.order || a.laneId.localeCompare(b.laneId),
      );
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
