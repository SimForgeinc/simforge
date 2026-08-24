import type { Condition, Interaction, Trigger } from "@simforge/scenario";

export const TRIGGER_KINDS: readonly Trigger["kind"][] = [
  "at",
  "after",
  "when",
  "arrival",
];

export const CONDITION_KINDS = [
  "distance",
  "ttc",
  "headway",
  "reaches",
  "speed",
  "signal",
  "visible",
  "detected",
  "standstill",
  "collision",
  "and",
  "or",
  "not",
] as const;

export type ConditionKind = (typeof CONDITION_KINDS)[number];

/**
 * A schema-valid trigger of the requested kind.
 *
 * Every branch has to parse under `TriggerSchema`, because switching kinds in the
 * UI replaces the trigger wholesale — there is no partial state where the author
 * fills in the rest. `editor-trigger-builders.test.ts` asserts exactly that for
 * all four kinds and every declared condition.
 */
export function buildDefaultScenarioTrigger(
  kind: Trigger["kind"],
  actor: string,
  peer: string,
  interactions: readonly Interaction[],
): Trigger {
  if (kind === "at") return { kind, t: 1 };
  if (kind === "after") {
    return {
      kind,
      of: interactions[0]?.id ?? "prior-action",
      event: "end",
      delayS: 0,
    };
  }
  if (kind === "arrival") {
    return { kind, of: actor, at: { role: peer }, syncWith: peer, deltaT: 0 };
  }
  return {
    kind,
    condition: buildDefaultScenarioCondition("speed", actor, peer),
    byLatest: 10,
    ifNever: "skip",
  };
}

export function buildDefaultScenarioCondition(
  kind: ConditionKind,
  actor: string,
  peer: string,
): Condition {
  switch (kind) {
    case "distance":
      return {
        kind,
        from: actor,
        to: { role: peer },
        measure: "euclidean",
        op: "<=",
        valueM: 10,
      };
    case "ttc":
      return { kind, of: actor, to: peer, op: "<=", valueS: 2.5 };
    case "headway":
      return { kind, of: actor, to: peer, op: "<=", valueS: 2 };
    case "reaches":
      return { kind, of: actor, region: { role: peer }, toleranceM: 2 };
    case "speed":
      return { kind, of: actor, op: ">=", valueKph: 30 };
    case "signal":
      return { kind, signal: { control: "signal-1" }, phase: "green" };
    case "visible":
      return { kind, of: actor, to: peer, visible: true, minFraction: 0.5 };
    case "detected":
      return { kind, of: peer, by: actor, detected: true };
    case "standstill":
      return { kind, of: actor, forS: 1 };
    case "collision":
      return { kind, of: actor, with: "any" };
    case "and":
      return {
        kind,
        operands: [
          buildDefaultScenarioCondition("speed", actor, peer),
          buildDefaultScenarioCondition("distance", actor, peer),
        ] as [never, never],
      };
    case "or":
      return {
        kind,
        operands: [
          buildDefaultScenarioCondition("speed", actor, peer),
          buildDefaultScenarioCondition("standstill", actor, peer),
        ] as [never, never],
      };
    case "not":
      return {
        kind,
        operand: buildDefaultScenarioCondition("collision", actor, peer) as never,
      };
  }
}

export function triggerLabel(trigger: Trigger) {
  return trigger.kind === "at" ? `${numeric(trigger.t)}s` : trigger.kind;
}

export function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
