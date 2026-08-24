/**
 * `<Condition>` → `BehaviorTrigger`.
 *
 * The inverse of `xosc-writer/triggers.ts`, and like it a 1:1 table rather than
 * a translation layer: the trigger union was designed against the condition
 * allowlist one-for-one, so every condition the writer emits has an exact
 * trigger and the only reasons a condition fails to read back are referential.
 *
 * Two things the writer puts in a `<Condition>` are NOT triggers and are
 * recognised by name here so the caller can peel them off first:
 *
 * * `<clip>_cutin_gap` — the gap that makes a `lane_change` a `cut_in`. It is
 *   ANDed onto the clip's own start trigger rather than being one, which is why
 *   `readCondition` reports it separately instead of returning a `proximity`.
 * * `stop_on_duration` / `act_start` — the storyboard's own scaffolding.
 *
 * `conditionEdge` carries information on the way back that it does not carry on
 * the way out, but ONLY in combination with the condition family. The writer
 * emits `rising` for two unrelated reasons — the simulation-time conditions it
 * generates itself (the scenario's duration, and a clip's `duration` end), and
 * every `ByEntityCondition` start trigger (which needs an edge to avoid latching
 * tick-0 state; see the writer's module header). So `rising` alone means
 * nothing here: `isRisingSimulationTime` has to test the family too, and does.
 */

import type { BehaviorActorRef, BehaviorSignalState, BehaviorTrigger } from "../scenario-behavior";
import { attrNumber, attrString, childEl, descendantEl, type XmlElement } from "../xosc/xml-dom";

/** The writer's lamp strings, read backwards. A colour word is not accepted. */
const STATE_BY_LAMP_STRING: Readonly<Record<string, BehaviorSignalState>> = {
  "on;off;off": "red",
  "off;on;off": "yellow",
  "off;off;on": "green",
};

export function signalStateFromLampString(lamps: string | null): BehaviorSignalState | null {
  if (lamps === null) return null;
  return STATE_BY_LAMP_STRING[lamps] ?? null;
}

const MPS_TO_KPH = 3.6;

export type ReadConditionContext = {
  /**
   * The entity name `"self"` means for this condition's owner, or `null` for a
   * SCENE clip, which has no owning actor and must name every actor explicitly
   * (`signalPlanIssues` rejects a `self` ref on a scene clip).
   */
  selfEntity: string | null;
  /** `<Event>` name → the clip id it was reconstructed as, for `after_clip`. */
  clipIdForEventName: (eventName: string) => string | null;
  /**
   * `<Event>` name → the authored duration that event's clip was given back,
   * in seconds. A chain condition's delay is `upstream duration + delay_s`, so
   * the duration has to come back out of it to leave the author's own
   * `delay_s`. Defaults to 0, which reproduces the pre-chain-duration reading.
   */
  durationForEventName?: (eventName: string) => number;
};

export type ReadCondition =
  | { kind: "trigger"; trigger: BehaviorTrigger }
  /** A cut-in gap gate: not a trigger, an extra AND term the caller folds in. */
  | { kind: "cutin_gap"; actorRef: BehaviorActorRef; gapM: number }
  | { kind: "unsupported"; element: string };

function actorRefFor(entity: string | null, context: ReadConditionContext): BehaviorActorRef {
  if (entity !== null && entity === context.selfEntity) return "self";
  return { actor_id: entity ?? "" };
}

/** The entity a `ByEntityCondition` measures from. */
function triggeringEntity(condition: XmlElement): string | null {
  const byEntity = childEl(condition, "ByEntityCondition");
  return attrString(
    descendantEl(byEntity, "TriggeringEntities", "EntityRef"),
    "entityRef",
  );
}

function worldPoint(
  holder: XmlElement | null,
): { x: number; y: number; z: number } | null {
  const world = descendantEl(holder, "Position", "WorldPosition");
  const x = attrNumber(world, "x");
  const y = attrNumber(world, "y");
  if (x === null || y === null) return null;
  return { x, y, z: attrNumber(world, "z") ?? 0 };
}

/**
 * Read one `<Condition>`.
 *
 * Returns `unsupported` rather than throwing for anything outside the writer's
 * nine condition kinds — an import that drops one gate and says so is strictly
 * better than one that refuses the file.
 */
export function readCondition(
  condition: XmlElement,
  context: ReadConditionContext,
): ReadCondition {
  const name = attrString(condition, "name") ?? "";
  const delay = attrNumber(condition, "delay") ?? 0;

  const byValue = childEl(condition, "ByValueCondition");
  if (byValue) {
    const simTime = childEl(byValue, "SimulationTimeCondition");
    if (simTime) {
      const t = attrNumber(simTime, "value");
      if (t === null) return { kind: "unsupported", element: "SimulationTimeCondition" };
      return { kind: "trigger", trigger: { kind: "at_time", t } };
    }
    const storyboard = childEl(byValue, "StoryboardElementStateCondition");
    if (storyboard) {
      const ref = attrString(storyboard, "storyboardElementRef") ?? "";
      const clipId = context.clipIdForEventName(ref);
      if (!clipId) return { kind: "unsupported", element: "StoryboardElementStateCondition" };
      // On a `startTransition` chain the delay carries the upstream clip's
      // authored duration; only what is left over is the author's `delay_s`.
      // A `completeState` chain has no duration folded in.
      const folded =
        attrString(storyboard, "state") === "startTransition"
          ? (context.durationForEventName?.(ref) ?? 0)
          : 0;
      const delayS = Math.max(0, Math.round((delay - folded) * 1000) / 1000);
      return {
        kind: "trigger",
        trigger: {
          kind: "after_clip",
          clip_id: clipId,
          // The writer emits `delay_s ?? 0`, so a zero delay is an absent one.
          ...(delayS === 0 ? {} : { delay_s: delayS }),
        },
      };
    }
    const signal = childEl(byValue, "TrafficSignalCondition");
    if (signal) {
      const state = signalStateFromLampString(attrString(signal, "state"));
      const signalId = attrString(signal, "name");
      if (!state || !signalId) return { kind: "unsupported", element: "TrafficSignalCondition" };
      // The junction is filled in by the caller, which is the only layer that
      // knows which reconstructed plan owns this head.
      return {
        kind: "trigger",
        trigger: { kind: "signal_state", signal: { junction_id: "", signal_id: signalId }, state },
      };
    }
    return {
      kind: "unsupported",
      element: byValue.children[0]?.name ?? "ByValueCondition",
    };
  }

  const entityCondition = descendantEl(condition, "ByEntityCondition", "EntityCondition");
  if (!entityCondition) return { kind: "unsupported", element: "Condition" };
  const entity = triggeringEntity(condition);
  const leaf = entityCondition.children[0];
  if (!leaf) return { kind: "unsupported", element: "EntityCondition" };

  switch (leaf.name) {
    case "ReachPositionCondition": {
      const point = worldPoint(leaf);
      const radius = attrNumber(leaf, "tolerance");
      if (!point || radius === null) return { kind: "unsupported", element: leaf.name };
      return {
        kind: "trigger",
        trigger: {
          kind: "reach",
          point,
          radius_m: radius,
          actor: actorRefFor(entity, context),
        },
      };
    }
    case "RelativeDistanceCondition": {
      const other = attrString(leaf, "entityRef");
      const distance = attrNumber(leaf, "value");
      if (other === null || distance === null) {
        return { kind: "unsupported", element: leaf.name };
      }
      if (name.endsWith("_cutin_gap")) {
        return {
          kind: "cutin_gap",
          actorRef: actorRefFor(other, context),
          gapM: distance,
        };
      }
      return {
        kind: "trigger",
        trigger: {
          kind: "proximity",
          other: actorRefFor(other, context),
          distance_m: distance,
          mode: attrString(leaf, "rule") === "greaterThan" ? "farther" : "closer",
          actor: actorRefFor(entity, context),
        },
      };
    }
    case "TimeToCollisionCondition": {
      const other = attrString(
        descendantEl(leaf, "TimeToCollisionConditionTarget", "EntityRef"),
        "entityRef",
      );
      const seconds = attrNumber(leaf, "value");
      if (other === null || seconds === null) {
        return { kind: "unsupported", element: leaf.name };
      }
      return {
        kind: "trigger",
        trigger: {
          kind: "ttc",
          other: actorRefFor(other, context),
          seconds,
          actor: actorRefFor(entity, context),
        },
      };
    }
    case "TimeHeadwayCondition": {
      const other = attrString(leaf, "entityRef");
      const seconds = attrNumber(leaf, "value");
      if (other === null || seconds === null) {
        return { kind: "unsupported", element: leaf.name };
      }
      return {
        kind: "trigger",
        trigger: {
          kind: "headway",
          other: actorRefFor(other, context),
          seconds,
          actor: actorRefFor(entity, context),
        },
      };
    }
    case "SpeedCondition": {
      const mps = attrNumber(leaf, "value");
      if (mps === null) return { kind: "unsupported", element: leaf.name };
      return {
        kind: "trigger",
        trigger: {
          kind: "speed",
          kph: mps * MPS_TO_KPH,
          rule: attrString(leaf, "rule") === "greaterThan" ? "above" : "below",
          actor: actorRefFor(entity, context),
        },
      };
    }
    case "StandStillCondition": {
      const seconds = attrNumber(leaf, "duration");
      if (seconds === null) return { kind: "unsupported", element: leaf.name };
      return {
        kind: "trigger",
        trigger: { kind: "standstill", seconds, actor: actorRefFor(entity, context) },
      };
    }
    default:
      return { kind: "unsupported", element: leaf.name };
  }
}

/** Every `<Condition>` of a `<StartTrigger>` / `<StopTrigger>`, in file order. */
export function triggerConditions(trigger: XmlElement | null): XmlElement[] {
  if (!trigger) return [];
  const out: XmlElement[] = [];
  for (const group of trigger.children) {
    if (group.name !== "ConditionGroup") continue;
    for (const condition of group.children) {
      if (condition.name === "Condition") out.push(condition);
    }
  }
  return out;
}

/**
 * True when this condition is the writer's own `rising`-edge time gate.
 *
 * Both halves are load-bearing. `ByEntityCondition` start triggers are also
 * `rising`, so the edge alone does not identify a generated time gate — the
 * `ByValueCondition/SimulationTimeCondition` shape is what does.
 */
export function isRisingSimulationTime(condition: XmlElement): boolean {
  if (attrString(condition, "conditionEdge") !== "rising") return false;
  return descendantEl(condition, "ByValueCondition", "SimulationTimeCondition") !== null;
}
