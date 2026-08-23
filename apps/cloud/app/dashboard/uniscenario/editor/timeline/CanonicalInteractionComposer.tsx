"use client";

import { useMemo, useState } from "react";
import {
  DYNAMICS_DEFAULTS,
  INTERACTION_PALETTE,
  TRIGGER_DEFAULTS,
  interactionFromTarget,
  requiresDynamics,
  type AnyTargetVariant,
  type EditorDocument,
  type SetTargetVariant,
} from "@uniscenarios/editor-core";
import {
  VRU_CLASSES,
  type ActorClass,
  type Dynamics,
  type Interaction,
  type Trigger,
} from "@uniscenarios/scenario-model";

import { snapToTimeGrid } from "@/app/lib/uniscenario/timeline";
import { uniqueTimelineInteractionId } from "./v1-timeline-model";

type Role = EditorDocument["data"]["roles"][number];
type TriggerKind = Trigger["kind"];

const VEHICLE_CLASSES = new Set<ActorClass>([
  "car",
  "truck",
  "bus",
  "van",
  "motorcycle",
  "bicycle",
]);
const VRU_CLASS_SET = VRU_CLASSES as ReadonlySet<ActorClass>;

const TRIGGER_LABELS: Readonly<Record<TriggerKind, string>> = {
  at: "At timeline time",
  after: "After another interaction",
  when: "When a condition is met",
  arrival: "On arrival",
};

const VERB_LABELS: Readonly<Record<Interaction["verb"], string>> = {
  speed: "Speed",
  gap: "Gap",
  changeLane: "Lane change",
  laneOffset: "Lane offset",
  route: "Route",
  exist: "Existence",
  set: "State / environment",
};

type CanonicalBuildOptions = {
  id: string;
  actor: string;
  label: string;
  trigger: Trigger;
  target: AnyTargetVariant["target"];
  verb: AnyTargetVariant["verb"];
  dynamics?: Dynamics;
};

const buildFromTarget = interactionFromTarget as unknown as (
  options: CanonicalBuildOptions,
) => Interaction;

function isSetVariant(variant: AnyTargetVariant): variant is SetTargetVariant {
  return variant.verb === "set";
}

function variantLabel(variant: AnyTargetVariant): string {
  return isSetVariant(variant) ? variant.target.key : variant.label;
}

function setVariantAppliesToRole(variant: SetTargetVariant, actorClass: ActorClass): boolean {
  const appliesTo = variant.declaration.appliesTo;
  return appliesTo === "world"
    || appliesTo === "any_actor"
    || (appliesTo === "vehicle" && VEHICLE_CLASSES.has(actorClass))
    || (appliesTo === "vru" && VRU_CLASS_SET.has(actorClass));
}

/**
 * The canonical package owns the palette. This filter only removes actor-state
 * keys that cannot apply to the selected actor; world keys remain reachable
 * from every actor lane so there is no second environment-only authoring UI.
 */
export function canonicalVariantsForRole(actorClass: ActorClass): readonly AnyTargetVariant[] {
  return INTERACTION_PALETTE.filter(
    (variant) => !isSetVariant(variant) || setVariantAppliesToRole(variant, actorClass),
  );
}

function replaceCatalogRefs(
  value: unknown,
  refs: { actor: string; peer: string; interaction: string },
): unknown {
  if (value === "actor_1") return refs.actor;
  if (value === "actor_2") return refs.peer;
  if (value === "interaction_1") return refs.interaction;
  if (Array.isArray(value)) return value.map((item) => replaceCatalogRefs(item, refs));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, replaceCatalogRefs(item, refs)]),
  );
}

function containsCatalogRef(value: unknown, reference: string): boolean {
  if (value === reference) return true;
  if (Array.isArray(value)) return value.some((item) => containsCatalogRef(item, reference));
  return Boolean(value && typeof value === "object" && Object.values(value).some(
    (item) => containsCatalogRef(item, reference),
  ));
}

/** Explain an unmet prerequisite instead of authoring a misleading self-reference. */
export function canonicalPaletteUnavailableReason({
  variant,
  triggerKind,
  otherRole,
  interactions,
}: {
  variant: AnyTargetVariant;
  triggerKind: TriggerKind;
  otherRole: Role | null;
  interactions: readonly Interaction[];
}): string | null {
  if (!otherRole && (
    containsCatalogRef(variant.target, "actor_2")
    || triggerKind === "when"
    || triggerKind === "arrival"
  )) {
    return "Add another actor before using this target or trigger.";
  }
  if (triggerKind === "after" && interactions.length === 0) {
    return "Add an earlier interaction before using an after trigger.";
  }
  return null;
}

function authoredTrigger(
  kind: TriggerKind,
  time: number,
  refs: { actor: string; peer: string; interaction: string },
): Trigger {
  const seeded = replaceCatalogRefs(TRIGGER_DEFAULTS[kind], refs) as Trigger;
  return seeded.kind === "at"
    ? { ...seeded, t: snapToTimeGrid(Math.max(0, time)) }
    : seeded;
}

/** Build one schema-checked interaction from the package's exact catalog entry. */
export function canonicalPaletteInteraction({
  variant,
  role,
  otherRole,
  interactions,
  time,
  triggerKind,
  dynamics,
}: {
  variant: AnyTargetVariant;
  role: Role;
  otherRole: Role | null;
  interactions: readonly Interaction[];
  time: number;
  triggerKind: TriggerKind;
  dynamics: Dynamics;
}): Interaction {
  const unavailableReason = canonicalPaletteUnavailableReason({
    variant,
    triggerKind,
    otherRole,
    interactions,
  });
  if (unavailableReason) throw new Error(unavailableReason);
  const actor = isSetVariant(variant) && variant.actor === "@world" ? "@world" : role.id;
  const refs = {
    actor: role.id,
    peer: otherRole?.id ?? role.id,
    interaction: interactions[0]?.id ?? "interaction_1",
  };
  const id = uniqueTimelineInteractionId(
    `${variant.id.replaceAll(".", "_")}_${actor.replaceAll("@", "")}`,
    interactions.map((item) => item.id),
  );
  return buildFromTarget({
    id,
    actor,
    label: variant.label,
    verb: variant.verb,
    target: replaceCatalogRefs(variant.target, refs) as AnyTargetVariant["target"],
    trigger: authoredTrigger(triggerKind, time, refs),
    ...(requiresDynamics(variant.verb) ? { dynamics } : {}),
  });
}

/**
 * Compact advanced composer shared by the persistent sidebar palette and the
 * timeline's right-click menu. It exposes every package-defined target, trigger
 * form, and required dynamics combination without copying their registries.
 */
export function CanonicalInteractionComposer({
  document,
  role,
  otherRole,
  interactions,
  time,
  onAdded,
  testIdPrefix = "canonical-interaction",
}: {
  document: EditorDocument;
  role: Role;
  otherRole: Role | null;
  interactions: readonly Interaction[];
  time: number;
  onAdded?: (interaction: Interaction) => void;
  testIdPrefix?: string;
}) {
  const variants = useMemo(
    () => canonicalVariantsForRole(role.actor.class),
    [role.actor.class],
  );
  const [variantId, setVariantId] = useState(variants[0]?.id ?? "");
  const [triggerKind, setTriggerKind] = useState<TriggerKind>("at");
  const [dynamicsIndex, setDynamicsIndex] = useState(0);
  const variant = variants.find((candidate) => candidate.id === variantId) ?? variants[0];
  const dynamics = DYNAMICS_DEFAULTS[dynamicsIndex] ?? DYNAMICS_DEFAULTS[0];

  if (!variant || !dynamics) return null;
  const needsDynamics = requiresDynamics(variant.verb);
  const unavailableReason = canonicalPaletteUnavailableReason({
    variant,
    triggerKind,
    otherRole,
    interactions,
  });
  const availabilityId = `${testIdPrefix}-availability`;

  const add = () => {
    const interaction = canonicalPaletteInteraction({
      variant,
      role,
      otherRole,
      interactions,
      time,
      triggerKind,
      dynamics,
    });
    document.addInteraction(interaction);
    onAdded?.(interaction);
  };

  return (
    <fieldset
      className="grid gap-2 rounded-xl border border-[#E8E044]/20 bg-[#E8E044]/[0.04] p-2"
      data-testid={`${testIdPrefix}-composer`}
    >
      <legend className="px-1 text-[9px] font-semibold uppercase tracking-[0.15em] text-[#E8E044]">
        All interactions
      </legend>
      <label className="grid gap-1 text-[9px] font-semibold uppercase tracking-wider text-white/45">
        Target
        <select
          aria-label="Canonical interaction target"
          className="min-h-8 rounded-lg border border-white/15 bg-black/40 px-2 text-[10px] font-normal normal-case tracking-normal text-white"
          data-testid={`${testIdPrefix}-target`}
          value={variant.id}
          onChange={(event) => setVariantId(event.currentTarget.value)}
        >
          {variants.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {VERB_LABELS[candidate.verb]} · {variantLabel(candidate)}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-[9px] font-semibold uppercase tracking-wider text-white/45">
        Starts
        <select
          aria-label="Canonical interaction trigger"
          className="min-h-8 rounded-lg border border-white/15 bg-black/40 px-2 text-[10px] font-normal normal-case tracking-normal text-white"
          data-testid={`${testIdPrefix}-trigger`}
          value={triggerKind}
          onChange={(event) => setTriggerKind(event.currentTarget.value as TriggerKind)}
        >
          {(Object.keys(TRIGGER_DEFAULTS) as TriggerKind[]).map((kind) => (
            <option key={kind} value={kind}>{TRIGGER_LABELS[kind]}</option>
          ))}
        </select>
      </label>
      {needsDynamics ? (
        <label className="grid gap-1 text-[9px] font-semibold uppercase tracking-wider text-white/45">
          Transition
          <select
            aria-label="Canonical interaction dynamics"
            className="min-h-8 rounded-lg border border-white/15 bg-black/40 px-2 text-[10px] font-normal normal-case tracking-normal text-white"
            data-testid={`${testIdPrefix}-dynamics`}
            value={dynamicsIndex}
            onChange={(event) => setDynamicsIndex(Number(event.currentTarget.value))}
          >
            {DYNAMICS_DEFAULTS.map((candidate, index) => (
              <option key={`${candidate.shape}-${candidate.constraint}`} value={index}>
                {candidate.shape} · {candidate.constraint}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <button
        className="min-h-8 rounded-lg border border-[#E8E044]/35 bg-[#E8E044]/10 px-2 text-[10px] font-semibold text-[#E8E044] hover:bg-[#E8E044]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]"
        data-testid={`${testIdPrefix}-add`}
        aria-describedby={unavailableReason ? availabilityId : undefined}
        disabled={Boolean(unavailableReason)}
        onClick={add}
        type="button"
      >
        Add {variantLabel(variant)}
      </button>
      {unavailableReason ? (
        <p className="text-[9px] leading-4 text-amber-200/80" id={availabilityId}>
          {unavailableReason}
        </p>
      ) : null}
    </fieldset>
  );
}
