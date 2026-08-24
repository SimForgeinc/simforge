"use client";

import { useEffect, useState, type CSSProperties, type ReactElement } from "react";

import {
  nextParkedCarsSeed,
  type ParkedCarsSettings,
} from "./extension";
import { MAX_PARKED_CARS, type ParkedCarPlan } from "./fill";
import type { ParkingStallsStatus } from "./useParkedCars";

export interface ParkedCarsPanelProps {
  readonly settings: ParkedCarsSettings;
  readonly onChange: (settings: ParkedCarsSettings) => void;
  readonly plan: ParkedCarPlan;
  readonly stallCount: number;
  readonly status: ParkingStallsStatus;
  /** Why the map cannot offer parked cars, when it cannot. */
  readonly reason: string | null;
  /** Cars already committed to the document. */
  readonly bakedCount: number;
}

/**
 * Parked cars, in the Traffic panel next to ambient traffic.
 *
 * Stall supply is a property of the map, not of the scenario, so the section
 * disables itself and says why rather than offering a control that can only
 * ever produce zero cars.
 *
 * The generator alone is a preview: the cars are drawn and nothing else knows
 * about them. Baking commits them to the document, which is what makes them
 * collide and reach a render — so that button, not the toggle, is the point
 * where the scenario changes meaning.
 */
export function ParkedCarsPanel({
  settings,
  onChange,
  plan,
  stallCount,
  status,
  reason,
  bakedCount,
}: ParkedCarsPanelProps): ReactElement {
  const [seedDraft, setSeedDraft] = useState(settings.seed);
  useEffect(() => setSeedDraft(settings.seed), [settings.seed]);

  const unavailable = settings.enabled && status !== "loading" && stallCount === 0;
  const controlsDisabled = !settings.enabled || unavailable;
  const cappedBack = plan.requestedCarCount - plan.cars.length;

  return (
    <section style={styles.root} data-testid="parked-cars-panel">
      <div style={styles.toggleBlock}>
        <label style={styles.toggleLabel}>
          <input
            checked={settings.enabled}
            data-testid="parked-cars-enabled"
            onChange={(event) => onChange({ ...settings, enabled: event.target.checked })}
            type="checkbox"
          />
          <span>Parked cars</span>
          <span style={settings.enabled || bakedCount > 0 ? styles.active : styles.muted}>
            {bakedCount > 0
              ? `${bakedCount} baked in`
              : settings.enabled
                ? `${plan.cars.length} preview`
                : "off"}
          </span>
        </label>
        <p style={styles.toggleHint}>
          {bakedCount > 0
            ? "Baked into the scenario: these collide, occlude, and export as stationary actors. They are not roles, so they never count against the 32-actor limit."
            : "Stationary vehicles dropped into the map's painted parking stalls. A preview until you bake them — nothing else in the world sees them yet."}
        </p>
      </div>

      {settings.enabled ? (
        <>
          {status === "loading" ? (
            <p style={styles.hint} data-testid="parked-cars-loading">
              Reading this map&apos;s parking stalls…
            </p>
          ) : null}
          {unavailable ? (
            <p style={styles.warningText} data-testid="parked-cars-unavailable">
              {reason ?? "This map has no parking stalls."}
            </p>
          ) : null}

          <label style={styles.range}>
            <span>
              Occupancy<b>{`${Math.round(settings.occupancy * 100)}%`}</b>
            </span>
            <input
              data-testid="parked-cars-occupancy"
              disabled={controlsDisabled}
              max={1}
              min={0}
              onChange={(event) =>
                onChange({ ...settings, occupancy: Number(event.target.value) })
              }
              step={0.05}
              type="range"
              value={settings.occupancy}
            />
          </label>

          <label style={styles.label}>
            <span>Seed</span>
            <span style={styles.seedRow}>
              <input
                data-testid="parked-cars-seed"
                disabled={controlsDisabled}
                onBlur={() => {
                  const seed = seedDraft.trim();
                  if (seed && seed !== settings.seed) onChange({ ...settings, seed });
                  else setSeedDraft(settings.seed);
                }}
                onChange={(event) => setSeedDraft(event.target.value)}
                style={styles.input}
                value={seedDraft}
              />
              <button
                aria-label="Reroll parked cars"
                data-testid="parked-cars-reroll"
                disabled={controlsDisabled}
                onClick={() => onChange({ ...settings, seed: nextParkedCarsSeed(settings.seed) })}
                style={styles.regenerate}
                type="button"
              >
                ↻
              </button>
            </span>
          </label>
          <p style={styles.hint}>
            The same seed always produces the same cars, so a render reproduces what you
            previewed here.
          </p>

          <label style={styles.label}>
            <span>Facing</span>
            <select
              data-testid="parked-cars-facing"
              disabled={controlsDisabled}
              onChange={(event) =>
                onChange({
                  ...settings,
                  facing: event.target.value === "mixed" ? "mixed" : "nose_in",
                })
              }
              style={styles.select}
              value={settings.facing}
            >
              <option value="nose_in">Nose in</option>
              <option value="mixed">Mixed</option>
            </select>
          </label>

          <label style={styles.label}>
            <span>Models</span>
            <select
              data-testid="parked-cars-models"
              disabled={controlsDisabled}
              onChange={(event) =>
                onChange({
                  ...settings,
                  models: event.target.value === "any" ? "any" : "carla_ready",
                })
              }
              style={styles.select}
              value={settings.models}
            >
              <option value="carla_ready">CARLA ready only</option>
              <option value="any">Any parkable model</option>
            </select>
          </label>
          <p style={styles.hint}>
            Browser-only models preview correctly but disappear from a CARLA render.
          </p>

          {stallCount > 0 ? (
            <div style={styles.status} data-testid="parked-cars-stats">
              <div>
                {plan.cars.length} of {plan.eligibleStallCount} eligible stalls filled
              </div>
              <div>
                {stallCount} stalls on this map
                {plan.unfittableStallCount > 0
                  ? ` · ${plan.unfittableStallCount} too small for any model`
                  : ""}
                {plan.excludedStallCount > 0
                  ? ` · ${plan.excludedStallCount} kept clear`
                  : ""}
              </div>
            </div>
          ) : null}

          {cappedBack > 0 ? (
            <p style={styles.warningText} data-testid="parked-cars-capped">
              Capped at {MAX_PARKED_CARS} of the {plan.requestedCarCount} this occupancy asks
              for. Parked cars are cheap to export but every one is still an actor the
              simulation carries and a render has to spawn.
            </p>
          ) : null}

          <button
            data-testid="parked-cars-bake"
            disabled={controlsDisabled || plan.cars.length === 0}
            onClick={() => onChange({ ...settings, baked: plan.cars })}
            style={styles.action}
            type="button"
          >
            {bakedCount > 0
              ? `Re-bake ${plan.cars.length} parked cars`
              : `Bake ${plan.cars.length} parked cars into the scenario`}
          </button>
          <p style={styles.hint}>
            Baking commits the current cars to the document. Until then they are drawn but
            the simulation drives through them and a render will not show them.
          </p>
          {bakedCount > 0 ? (
            <button
              data-testid="parked-cars-clear-bake"
              onClick={() => onChange({ ...settings, baked: [] })}
              style={styles.action}
              type="button"
            >
              Remove {bakedCount} baked cars
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

const styles: Record<string, CSSProperties> = {
  root: { marginTop: 10, borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 8 },
  label: { display: "grid", gap: 4, marginBottom: 8, color: "#8f98a6", fontSize: 11 },
  select: { width: "100%", padding: 6, borderRadius: 6, border: "1px solid rgba(255,255,255,0.13)", background: "#171b22", color: "#edf1f7", font: "inherit" },
  input: { minWidth: 0, flex: 1, padding: 6, borderRadius: 6, border: "1px solid rgba(255,255,255,0.13)", background: "#171b22", color: "#edf1f7", font: "inherit" },
  seedRow: { display: "flex", gap: 5 },
  regenerate: { width: 31, borderRadius: 6, border: "1px solid rgba(255,255,255,0.13)", background: "rgba(255,255,255,0.06)", color: "#edf1f7", cursor: "pointer" },
  hint: { margin: "-2px 0 10px", color: "#707a89", fontSize: 10, lineHeight: 1.35 },
  toggleBlock: { margin: "1px 0 10px" },
  toggleLabel: { display: "flex", alignItems: "center", gap: 7, color: "#c8d0dc", fontSize: 11, cursor: "pointer" },
  toggleHint: { margin: "4px 0 0 22px", color: "#707a89", fontSize: 10, lineHeight: 1.35 },
  range: { display: "grid", gap: 1, margin: "7px 0", color: "#9da6b5", fontSize: 11 },
  active: { color: "#7fcf9b" },
  muted: { color: "#707a89" },
  status: { marginTop: 8, padding: 7, borderRadius: 6, background: "rgba(0,0,0,.22)", color: "#aeb7c4", fontSize: 10, fontVariantNumeric: "tabular-nums" },
  warningText: { margin: "-2px 0 10px", color: "#ffbd70", fontSize: 10, lineHeight: 1.35 },
};
