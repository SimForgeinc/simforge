"use client";

import { useId, useState } from "react";
import type { Interaction } from "@simforge/scenario";
import { Input } from "@/app/components/ui/input";
import type { EditorDocument } from "@simforge/editor";
import { InteractionTargetModeControls } from "./InteractionTargetControls";

export const MAX_AUTHORED_TARGET_SPEED_KPH = 130;
type NumericSemantic = "targetSpeedKph" | "laneDelta" | "durationS";
export type DrivingStylePreset = "cautious" | "normal" | "aggressive";

const DRIVING_STYLE_PRESETS: ReadonlyArray<{
  id: DrivingStylePreset;
  label: string;
  description: string;
}> = [
  { id: "cautious", label: "Cautious", description: "Slower and smoother." },
  { id: "normal", label: "Normal", description: "Balanced everyday driving." },
  { id: "aggressive", label: "Aggressive", description: "Quick and decisive." },
];

const DRIVING_STYLE_DYNAMICS = {
  speed: {
    cautious: { shape: "cubic", durationS: 2.5 },
    normal: { shape: "linear", durationS: 1 },
    aggressive: { shape: "linear", durationS: 0.5 },
  },
  changeLane: {
    cautious: { shape: "sinusoidal", durationS: 3.5 },
    normal: { shape: "sinusoidal", durationS: 2 },
    aggressive: { shape: "linear", durationS: 1 },
  },
} as const;

const MIN_ACTION_DURATION_S = 0.1;
const ACTION_DURATION_DECIMALS = 3;

/** Canonical persistence boundary for duration fields that must remain coupled. */
export function normalizeActionDurationS(value: number): number | null {
  if (!Number.isFinite(value) || value < MIN_ACTION_DURATION_S) return null;
  const normalized = Number(value.toFixed(ACTION_DURATION_DECIMALS));
  return normalized >= MIN_ACTION_DURATION_S ? normalized : null;
}

/** Fail-closed numeric authoring boundary shared by the visible controls and tests. */
export function withNumericActionSemantic(
  interaction: Interaction,
  field: NumericSemantic,
  value: number,
): Interaction | null {
  if (!Number.isFinite(value)) return null;
  const target = interaction.target as Record<string, unknown>;
  if (field === "targetSpeedKph") {
    if (interaction.verb !== "speed" || target.mode !== "absolute" || value < 0 || value > MAX_AUTHORED_TARGET_SPEED_KPH) return null;
    return { ...interaction, target: { ...target, valueKph: value } } as Interaction;
  }
  if (field === "laneDelta") {
    if (interaction.verb !== "changeLane" || !Number.isInteger(value) || value === 0 || value < -4 || value > 4) return null;
    return { ...interaction, target: { ...target, dk: value } } as Interaction;
  }
  if (interaction.verb !== "speed" && interaction.verb !== "changeLane") return null;
  const durationS = normalizeActionDurationS(value);
  if (durationS === null) return null;
  const dynamics = interaction.dynamics;
  if (!dynamics || dynamics.constraint !== "time") return null;
  const until = interaction.trigger.kind === "at" && typeof interaction.trigger.t === "number" && interaction.until?.kind === "at"
    ? { ...interaction.until, t: interaction.trigger.t + durationS }
    : interaction.until;
  return {
    ...interaction,
    dynamics: { ...dynamics, value: durationS },
    ...(interaction.verb === "changeLane" ? { maneuverDurationS: durationS } : {}),
    ...(until ? { until } : {}),
  } as Interaction;
}

/**
 * Applies a plain-language driving style while retaining canonical v2 fields.
 * Lane-change "Aggressive" maps to the model's equivalent `assertive` intent.
 */
export function withDrivingStylePreset(
  interaction: Interaction,
  style: DrivingStylePreset,
): Interaction | null {
  if (interaction.verb !== "speed" && interaction.verb !== "changeLane") return null;
  const preset = DRIVING_STYLE_DYNAMICS[interaction.verb][style];
  const withDynamics = {
    ...interaction,
    dynamics: {
      ...interaction.dynamics,
      shape: preset.shape,
      constraint: "time",
      value: preset.durationS,
    },
    ...(interaction.verb === "changeLane"
      ? { maneuverStyle: style === "aggressive" ? "assertive" : style }
      : {}),
  } as Interaction;
  return withNumericActionSemantic(withDynamics, "durationS", preset.durationS);
}

/** Returns the authored preset when the canonical fields match one. */
export function drivingStyleForInteraction(
  interaction: Interaction,
): DrivingStylePreset | null {
  if (interaction.verb !== "speed" && interaction.verb !== "changeLane") return null;
  if (interaction.verb === "changeLane" && interaction.maneuverStyle) {
    return interaction.maneuverStyle === "assertive" ? "aggressive" : interaction.maneuverStyle;
  }
  const dynamics = interaction.dynamics;
  if (!dynamics || dynamics.constraint !== "time" || typeof dynamics.value !== "number") return null;
  const dynamicsValue = dynamics.value;
  const match = DRIVING_STYLE_PRESETS.find(({ id }) => {
    const preset = DRIVING_STYLE_DYNAMICS[interaction.verb][id];
    return dynamics.shape === preset.shape && Math.abs(dynamicsValue - preset.durationS) < 0.001;
  });
  return match?.id ?? null;
}

/** Numeric action semantics that the palette cannot know at creation time. */
export function InteractionSemanticsControls({
  document,
  interaction,
}: {
  document: EditorDocument;
  interaction: Interaction;
}) {
  const [error, setError] = useState<string | null>(null);
  if (interaction.verb !== "speed" && interaction.verb !== "changeLane") return null;
  const target = interaction.target as Record<string, unknown>;
  const activeStyle = drivingStyleForInteraction(interaction);

  const apply = (field: NumericSemantic, raw: string, label: string) => {
    const next = withNumericActionSemantic(interaction, field, raw.trim() === "" ? Number.NaN : Number(raw));
    if (!next) {
      setError(`${label} is outside the supported authoring range.`);
      return;
    }
    setError(null);
    document.replaceInteraction(interaction.id, next);
  };

  const applyStyle = (style: DrivingStylePreset) => {
    const next = withDrivingStylePreset(interaction, style);
    if (!next) {
      setError("This driving style is not available for this action.");
      return;
    }
    setError(null);
    document.replaceInteraction(interaction.id, next);
  };

  return (
    <fieldset className="grid min-w-0 grid-cols-1 gap-3 border-t border-white/10 pt-3">
      <legend className="text-meta font-semibold uppercase tracking-wider text-muted-foreground">
        Driving behavior
      </legend>
      <InteractionTargetModeControls
        document={document}
        interaction={interaction}
      />
      {interaction.verb === "speed" && target.mode === "absolute" ? (
        <SemanticNumberField
          label="Target speed (kph)"
          min={0}
          max={MAX_AUTHORED_TARGET_SPEED_KPH}
          step={0.1}
          value={Number(target.valueKph ?? 0)}
          onChange={(raw) => apply("targetSpeedKph", raw, "Target speed")}
        />
      ) : null}
      {interaction.verb === "changeLane" && target.mode === "relative" ? (
        <SemanticNumberField
          label="Lanes to move"
          min={-4}
          max={4}
          step={1}
          value={Number(target.dk ?? 0)}
          onChange={(raw) => apply("laneDelta", raw, "Lanes to move")}
        />
      ) : null}
      <div>
        <p className="text-muted-foreground">Driving style</p>
        <p className="mt-0.5 text-meta leading-4 text-white/35" id={`${interaction.id}-driving-style-help`}>
          Choose how smoothly and quickly this action happens.
        </p>
        <div
          aria-describedby={`${interaction.id}-driving-style-help`}
          aria-label="Driving style choices"
          className="mt-2 grid grid-cols-1 gap-1.5"
          role="radiogroup"
        >
          {DRIVING_STYLE_PRESETS.map((preset) => {
            const active = activeStyle === preset.id;
            return (
              <button
                aria-checked={active}
                className={`rounded-lg border px-2 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044] ${active ? "border-[#E8E044]/70 bg-[#E8E044]/10 text-[#E8E044]" : "border-white/10 bg-white/[0.025] text-white/60 hover:border-white/25 hover:bg-white/[0.06] hover:text-white/90"}`}
                key={preset.id}
                onClick={() => applyStyle(preset.id)}
                role="radio"
                type="button"
              >
                <span className="block text-[10px] font-medium">{preset.label}</span>
                <span className="mt-0.5 block text-[9px] leading-3.5 opacity-70">{preset.description}</span>
              </button>
            );
          })}
        </div>
        {activeStyle === null ? (
          <p className="mt-1.5 text-meta leading-4 text-white/35">
            Choose a style to replace the action&apos;s custom timing.
          </p>
        ) : null}
      </div>
      {error ? <p className="text-meta text-red-300" role="alert">{error}</p> : null}
    </fieldset>
  );
}

function SemanticNumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  value: number;
  onChange: (raw: string) => void;
  min?: number;
  max?: number;
  step: number;
}) {
  const id = useId();
  return (
    <div className="min-w-0">
      <label className="block text-muted-foreground" htmlFor={id}>{label}</label>
      <Input
        id={id}
        className="mt-1 h-8"
        max={max}
        min={min}
        step={step}
        type="number"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
