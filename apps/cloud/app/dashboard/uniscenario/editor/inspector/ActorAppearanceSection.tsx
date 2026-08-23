"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { SelectMenuField } from "@/app/components/ui/select-menu";
import { CarlaCompatibilityPill } from "@/app/components/CarlaCompatibilityPill";
import {
  carlaCompatibilityFor,
  loadCarlaCompatibility,
  type CarlaCompatibilityTable,
} from "@/app/lib/uniscenario/carla-compatibility";
import { AUTHORING_CATALOG as CATALOG, getEntry, type CatalogId } from "@uniscenarios/prop-catalog";
import type { ActorRecord, EditorController } from "@uniscenarios/editor-core";
import { Heading, NumberField } from "../authoring/fields";
import { Readout } from "../regions/Readout";

/**
 * Eight paints that stay legible against asphalt at authoring distance and read
 * as distinct in a rendered frame. The point of authoring a colour is telling two
 * otherwise identical sedans apart, so near-duplicates would defeat it.
 */
const PAINTS: readonly { value: string; label: string }[] = [
  { value: "#2f4f74", label: "Navy" },
  { value: "#b4b8bd", label: "Silver" },
  { value: "#0d0f12", label: "Black" },
  { value: "#e8e9ea", label: "White" },
  { value: "#8c2f2f", label: "Red" },
  { value: "#2f6b3f", label: "Green" },
  { value: "#c98a2e", label: "Amber" },
  { value: "#4a3f6b", label: "Violet" },
];

/**
 * Appearance and kinematics: catalog model, paint, and initial speed.
 *
 * The catalog swap is restricted to entries of the same class. Turning a sedan
 * into a traffic cone would silently invalidate its route, its sensors and any
 * interaction that targets it — a different object is a delete plus a place, and
 * should cost the author that.
 *
 * `bodyColor` is Studio presentation state persisted with the role and carried
 * through browser preview/playback. It remains outside the OSC 1.4/CARLA export
 * contract, where paint needs a separate renderer-facing representation.
 */
export function ActorAppearanceSection({
  actor,
  controller,
}: {
  actor: ActorRecord;
  controller: EditorController | null;
}) {
  const [carlaTable, setCarlaTable] = useState<CarlaCompatibilityTable | null>(null);
  const [carlaLoadFailed, setCarlaLoadFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void loadCarlaCompatibility()
      .then((table) => {
        if (active) setCarlaTable(table);
      })
      .catch(() => {
        if (active) setCarlaLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const entry = getEntry(actor.catalogId);
  const siblings = CATALOG.filter((candidate) => candidate.class === entry.class);
  const galleryAsset = actor.catalogId.startsWith("gallery.");
  const galleryVersion = galleryAsset
    ? actor.catalogId.match(/\.v(\d+)$/)?.[1] ?? "Unknown"
    : null;
  // `defaultParams` is a loose param bag (`ParamValue`), so the catalog default
  // is only a usable paint when it is actually a string.
  const catalogPaint = entry.defaultParams?.color;
  const paint =
    actor.bodyColor ?? (typeof catalogPaint === "string" ? catalogPaint : null);
  // Props are placed as fixed bodies and cannot carry motion; every role can.
  // Gating this on a catalog-class allowlist also hid the switch from
  // `static_object` roles — a static car, or a custom gallery upload — so they
  // could never be released into motion and given a route.
  const mobile = actor.kind !== "prop";
  const fixedByCatalog = actor.kind === "prop";
  const carlaCompatibility = carlaTable
    ? carlaCompatibilityFor(actor.catalogId, carlaTable)
    : null;

  return (
    <section aria-labelledby="uniscenario-appearance-heading" className="space-y-3">
      <Heading>
        <span id="uniscenario-appearance-heading">Appearance</span>
      </Heading>

      {galleryAsset ? (
        <div className="space-y-2">
          <Readout label="Gallery asset" value={entry.label} />
          <Readout label="Version" value={galleryVersion ?? "Unknown"} />
          <Link
            className="inline-flex text-micro font-medium text-primary underline-offset-4 hover:underline"
            href="/dashboard/assets"
          >
            Open asset gallery
          </Link>
        </div>
      ) : siblings.length > 1 ? (
        <SelectMenuField
          className="h-8 text-xs"
          label={`Model (${entry.class})`}
          value={actor.catalogId}
          options={siblings.map((candidate) => ({
            value: candidate.id,
            label: candidate.label,
          }))}
          onChange={(catalogId) =>
            controller?.updateActorAppearance(actor.id, {
              catalogId: catalogId as CatalogId,
            })
          }
        />
      ) : (
        <Readout label="Model" value={entry.label} />
      )}
      {carlaCompatibility === null ? (
        <p className="text-micro leading-relaxed text-muted-foreground">
          {carlaLoadFailed
            ? "CARLA compatibility is unavailable."
            : "Checking CARLA compatibility…"}
        </p>
      ) : carlaCompatibility.status === "native" ? null : (
        <div className="space-y-1.5" data-testid={`actor-carla-compatibility-${actor.id}`}>
          <CarlaCompatibilityPill compatibility={carlaCompatibility} size="sm" />
          <p className="text-micro leading-relaxed text-muted-foreground">
            {carlaCompatibility.reason}
          </p>
        </div>
      )}

      <fieldset>
        <legend className="text-muted-foreground">Paint</legend>
        <div className="mt-1 flex flex-wrap gap-1">
          {PAINTS.map((option) => {
            const active = paint?.toLowerCase() === option.value.toLowerCase();
            return (
              <button
                key={option.value}
                type="button"
                aria-label={option.label}
                aria-pressed={active}
                title={option.label}
                onClick={() =>
                  controller?.updateActorAppearance(actor.id, {
                    bodyColor: option.value,
                  })
                }
                className={`editor-motion size-6 border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card ${
                  active ? "border-primary ring-1 ring-primary" : "border-border"
                }`}
                // The swatch *is* the colour, so this is data, not decoration —
                // the one place a literal belongs. Every other colour in the
                // editor comes from the token layer.
                style={{ backgroundColor: option.value }}
              />
            );
          })}
        </div>
      </fieldset>

      {mobile ? (
        <>
          <label
            className="flex items-center justify-between gap-3 border border-border px-2 py-2 text-foreground"
            data-testid={`actor-static-control-${actor.id}`}
          >
            <span>
              <span className="block font-medium">Static / parked</span>
              <span className="block text-micro text-muted-foreground">
                Fixed in playback; still collides and occludes.
              </span>
            </span>
            <input
              aria-label="Static / parked"
              checked={actor.static}
              data-testid={`actor-static-toggle-${actor.id}`}
              type="checkbox"
              onChange={(event) =>
                controller?.updateActorAppearance(actor.id, {
                  static: event.currentTarget.checked,
                })
              }
            />
          </label>
          {!actor.static ? (
            <NumberField
              label="Initial speed (kph)"
              min={0}
              step={1}
              value={actor.initialSpeedKph ?? 0}
              onChange={(initialSpeedKph) =>
                controller?.updateActorAppearance(actor.id, { initialSpeedKph })
              }
            />
          ) : null}
        </>
      ) : null}

      {fixedByCatalog ? (
        <p className="text-micro leading-relaxed text-muted-foreground" data-testid={`actor-static-fixed-${actor.id}`}>
          Static catalog objects are always fixed in playback and export.
        </p>
      ) : null}

      <dl className="grid grid-cols-3 gap-2">
        <Readout label="Length" value={`${actor.dims.l} m`} />
        <Readout label="Width" value={`${actor.dims.w} m`} />
        <Readout label="Height" value={`${actor.dims.h} m`} />
      </dl>
    </section>
  );
}
