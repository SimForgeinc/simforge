"use client";

import Image from "next/image";
import { useEffect, useId, useState } from "react";
import { Box, CarFront, Crosshair, PersonStanding } from "lucide-react";
import {
  DRIVER_PROFILE_IDS,
  DRIVER_PROFILES,
  type DriverProfile,
} from "@simforge-oss/scenario";

import { Input } from "@/app/components/ui/input";
import { CarlaCompatibilityPill } from "@/app/components/CarlaCompatibilityPill";
import {
  carlaCompatibilityFor,
  loadCarlaCompatibility,
  type CarlaCompatibilityTable,
} from "@/app/lib/scenario/carla-compatibility";
import { getEntry, type CatalogId } from "@simforge-oss/asset-catalog";
import type {
  ActorRecord,
  EditorController,
  EditorDocument,
} from "@simforge-oss/editor";
import {
  OBJECT_CATALOG_IDS,
  ObjectCatalogIcon,
  type ObjectCatalogId,
} from "../regions/ObjectCatalogIcon";
import {
  PEDESTRIAN_CATALOG_IDS,
  PedestrianCatalogIcon,
  type PedestrianCatalogId,
} from "../regions/PedestrianCatalogIcon";
import {
  VEHICLE_CATALOG_IDS,
  VehicleCatalogIcon,
  type VehicleCatalogId,
} from "../regions/VehicleCatalogIcon";
import {
  DynamicActorCatalogIcon,
  isDynamicActorCatalogId,
} from "../regions/DynamicActorCatalogIcon";
import { EditorDetailsPanel } from "./EditorDetailsPanel";
import { ActorSensorsSection } from "./ActorSensorsSection";

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

const DRIVER_PROFILE_ICONS: Readonly<Record<DriverProfile, string>> = {
  lawful: "/scenario-editor/driver-behaviors/lawful.png",
  cautious: "/scenario-editor/driver-behaviors/cautious.png",
  assertive: "/scenario-editor/driver-behaviors/assertive.png",
  violator: "/scenario-editor/driver-behaviors/violator.png",
};

/** Fixed, viewport-level actor inspector shared by map and timeline selection. */
export function ActorDetailsPanel({
  actor,
  controller,
  document,
  onClose,
  showMotionControls = true,
}: {
  actor: ActorRecord;
  controller: EditorController | null;
  document: EditorDocument;
  onClose: () => void;
  showMotionControls?: boolean;
}) {
  const nameId = useId();
  const rotationId = useId();
  const speedId = useId();
  const entry = getEntry(actor.catalogId);
  const initialSpeedKph = Math.round(actor.initialSpeedKph ?? 0);
  const paint = actor.bodyColor ?? (
    typeof entry.defaultParams.color === "string" ? entry.defaultParams.color : "#E8E044"
  );
  // A vehicle earns its recording status by carrying sensors; there is nothing
  // to designate. `roles` holds the authored sensors, `actor` only a projection.
  const sensorCount = document.data.roles.find((role) => role.id === actor.id)?.actor.sensors.length ?? 0;
  // Whether this actor survives a CARLA render is the question an author asks
  // right before queueing a job, so it belongs on the actor, not only in the
  // Assets compatibility table. The lookup table loads once per session and
  // never blocks the inspector.
  const [carlaTable, setCarlaTable] = useState<CarlaCompatibilityTable | null>(null);
  const [carlaLoadFailed, setCarlaLoadFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void loadCarlaCompatibility()
      .then((table) => { if (active) setCarlaTable(table); })
      .catch(() => { if (active) setCarlaLoadFailed(true); });
    return () => { active = false; };
  }, []);
  const carlaCompatibility = carlaTable
    ? carlaCompatibilityFor(actor.catalogId, carlaTable)
    : null;

  return (
    <EditorDetailsPanel
      ariaLabel={`${entry.label} actor details`}
      closeLabel="Close actor details"
      closeTestId="actor-details-close"
      headerFooter={(
        <fieldset className="border-t border-white/[0.07] bg-black/15 px-3 py-2">
          <legend className="sr-only">Color</legend>
          <div className="flex items-center justify-between gap-1">
            {PAINTS.map((option) => {
              const active = paint.toLowerCase() === option.value.toLowerCase();
              return (
                <button
                  aria-label={option.label}
                  aria-pressed={active}
                  className={`size-[18px] shrink-0 rounded-full border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044] ${active ? "border-[#E8E044] ring-1 ring-[#E8E044]" : "border-white/20"}`}
                  key={option.value}
                  onClick={() => controller?.updateActorAppearance(actor.id, { bodyColor: option.value })}
                  style={{ backgroundColor: option.value }}
                  title={option.label}
                  type="button"
                />
              );
            })}
          </div>
        </fieldset>
      )}
      maxHeight="min(560px, calc(100vh - 96px))"
      onClose={onClose}
      preview={(
        <div
          className="grid h-14 w-full place-items-center"
          data-testid="actor-details-model-preview"
          style={{ color: paint }}
        >
          <ActorModelArtwork actor={actor} />
        </div>
      )}
      previewClassName="h-20 px-8 py-2.5"
      testId="scenario-actor-details-panel"
    >
        {sensorCount > 0 ? (
          <div
            className="flex items-center gap-2 rounded-xl border border-[#E8E044]/45 bg-[#E8E044]/[0.08] px-2.5 py-2"
            data-testid="actor-records-scenario"
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-[#E8E044]/25 bg-[#E8E044]/10 text-[#E8E044]">
              <Crosshair aria-hidden="true" className="size-4" />
            </span>
            <span className="min-w-0">
              <strong className="block text-[10px] font-semibold text-white">Records this scenario</strong>
              <span className="block text-[8px] leading-3 text-white/40">
                {sensorCount} sensor{sensorCount === 1 ? "" : "s"} fitted
              </span>
            </span>
          </div>
        ) : null}

        <label className="block" htmlFor={nameId}>
          <span className="text-[9px] uppercase tracking-[0.12em] text-white/40">Name</span>
          <Input
            id={nameId}
            className="mt-1 h-8 border-white/10 bg-white/[0.04] text-xs text-white"
            placeholder={entry.label}
            value={actor.label ?? ""}
            onChange={(event) => controller?.setLabel(actor.id, event.target.value)}
          />
        </label>

        {carlaCompatibility?.status === "native" ? null : (
          <div className="space-y-1" data-testid={`actor-carla-compatibility-${actor.id}`}>
            <span className="text-[9px] uppercase tracking-[0.12em] text-white/40">CARLA</span>
            {carlaCompatibility ? (
              <div className="space-y-1">
                <CarlaCompatibilityPill compatibility={carlaCompatibility} size="sm" />
                <p className="text-[9px] leading-3 text-white/35">{carlaCompatibility.reason}</p>
              </div>
            ) : (
              <p className="text-[9px] leading-3 text-white/35">
                {carlaLoadFailed ? "CARLA compatibility is unavailable." : "Checking CARLA compatibility…"}
              </p>
            )}
          </div>
        )}

        {actor.kind === "prop" ? (
          <label className="block" htmlFor={rotationId}>
            <span className="text-[9px] uppercase tracking-[0.12em] text-white/40">Rotation</span>
            <div className="relative mt-1">
              <Input
                aria-label="Rotation"
                id={rotationId}
                className="h-8 border-white/10 bg-white/[0.04] pr-8 text-xs text-white"
                step={5}
                type="number"
                value={roundDegrees(actor.headingRad)}
                onChange={(event) => {
                  const headingDeg = Number(event.target.value);
                  if (Number.isFinite(headingDeg)) {
                    controller?.setWorldPose(actor.id, { headingDeg });
                  }
                }}
              />
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-white/35">°</span>
            </div>
          </label>
        ) : null}

        {showMotionControls ? (
          <label className="block" htmlFor={speedId}>
            <span className="flex items-baseline justify-between gap-2">
              <span className="text-[9px] uppercase tracking-[0.12em] text-white/40">Initial speed</span>
              <output className="font-mono text-[10px] tabular-nums text-[#E8E044]" htmlFor={speedId}>
                {initialSpeedKph} <span className="text-[8px] text-white/35">kph</span>
              </output>
            </span>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-[8px] tabular-nums text-white/30">0</span>
              <input
                aria-label="Initial speed"
                id={speedId}
                className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-white/10 accent-[#E8E044] [&::-moz-range-progress]:h-1.5 [&::-moz-range-progress]:rounded-full [&::-moz-range-progress]:bg-[#E8E044] [&::-moz-range-thumb]:size-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-neutral-950 [&::-moz-range-thumb]:bg-[#E8E044] [&::-webkit-slider-thumb]:mt-[-4px] [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-neutral-950 [&::-webkit-slider-thumb]:bg-[#E8E044] [&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full"
                max={160}
                min={0}
                step={1}
                type="range"
                value={initialSpeedKph}
                onChange={(event) => {
                  const nextSpeedKph = Number(event.target.value);
                  if (Number.isFinite(nextSpeedKph)) {
                    controller?.updateActorAppearance(actor.id, { initialSpeedKph: nextSpeedKph });
                  }
                }}
              />
              <span className="text-[8px] tabular-nums text-white/30">160</span>
            </div>
          </label>
        ) : null}

        {showMotionControls && actor.kind === "vehicle" ? (
          <fieldset aria-label="Driver behavior" data-testid="actor-driver-profile">
            <legend className="text-[9px] uppercase tracking-[0.12em] text-white/40">Driver behavior</legend>
            <div aria-label="Driver behavior choices" className="mt-1.5 grid grid-cols-1 gap-1.5" role="radiogroup">
              {DRIVER_PROFILE_IDS.map((id) => {
                const active = (actor.driverProfile ?? "lawful") === id;
                return (
                  <button
                    aria-checked={active}
                    aria-label={`${DRIVER_PROFILES[id].label} behavior`}
                    className={`group flex min-w-0 items-center gap-1.5 rounded-lg border px-1.5 py-1 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044] ${active ? "border-[#E8E044]/70 bg-[#E8E044]/10 text-[#E8E044]" : "border-white/10 bg-white/[0.025] text-white/55 hover:border-white/25 hover:bg-white/[0.06] hover:text-white/85"}`}
                    key={id}
                    onClick={() => controller?.updateActorAppearance(actor.id, { driverProfile: id })}
                    role="radio"
                    type="button"
                  >
                    <Image
                      alt=""
                      aria-hidden="true"
                      className={`size-8 shrink-0 object-contain transition ${active ? "opacity-100" : "opacity-55 group-hover:opacity-90"}`}
                      height={32}
                      src={DRIVER_PROFILE_ICONS[id]}
                      unoptimized
                      width={32}
                    />
                    <span className="truncate text-[9px] font-medium">{DRIVER_PROFILES[id].label}</span>
                  </button>
                );
              })}
            </div>
            <span className="mt-1.5 block text-[9px] leading-3.5 text-white/35">
              {DRIVER_PROFILES[actor.driverProfile ?? "lawful"].description}
            </span>
          </fieldset>
        ) : null}

        {actor.kind === "vehicle" ? (
          <ActorSensorsSection actor={actor} document={document} />
        ) : null}

    </EditorDetailsPanel>
  );
}

function ActorModelArtwork({ actor }: { actor: ActorRecord }) {
  const catalogId = actor.catalogId;
  if (isVehicleCatalogId(catalogId)) {
    return <VehicleCatalogIcon id={catalogId} />;
  }
  if (isPedestrianCatalogId(catalogId)) {
    return <div className="h-14 w-14"><PedestrianCatalogIcon id={catalogId} /></div>;
  }
  if (isObjectCatalogId(catalogId)) {
    return <ObjectCatalogIcon id={catalogId} />;
  }
  if (isDynamicActorCatalogId(catalogId)) {
    return <DynamicActorCatalogIcon id={catalogId} />;
  }
  if (actor.kind === "pedestrian") return <PersonStanding aria-hidden="true" className="size-10" />;
  if (actor.kind === "prop") return <Box aria-hidden="true" className="size-10" />;
  return <CarFront aria-hidden="true" className="size-10" />;
}

function roundDegrees(radians: number) {
  return Math.round((radians * 180 / Math.PI) * 10) / 10;
}

function isVehicleCatalogId(id: CatalogId): id is VehicleCatalogId {
  return (VEHICLE_CATALOG_IDS as readonly string[]).includes(id);
}

function isPedestrianCatalogId(id: CatalogId): id is PedestrianCatalogId {
  return (PEDESTRIAN_CATALOG_IDS as readonly string[]).includes(id);
}

function isObjectCatalogId(id: CatalogId): id is ObjectCatalogId {
  return (OBJECT_CATALOG_IDS as readonly string[]).includes(id);
}
