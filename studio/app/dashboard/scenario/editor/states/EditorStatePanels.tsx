"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/app/components/ui/button";
import {
  SCENARIO_AUTHORING_QUALITY_CHOICES,
  type ScenarioAuthoringQuality,
} from "@/app/lib/scenario/contracts";
import type { ScenarioMapEntry } from "@simforge-oss/editor";

const QUALITY_PREVIEW_IMAGES: Record<ScenarioAuthoringQuality, string> = {
  "roads-only": "/render-selection/roads-only.jpg",
  "ultra-low-3d": "/render-selection/ultra-low.jpg",
  minimal: "/render-selection/minimal.jpg",
  high: "/render-selection/high.jpg",
};

/**
 * The full-page panels that are genuine *content*, not boot states.
 *
 * The distinction matters and it is the one v2 got wrong. "Loading maps" and
 * "the document request failed" are transient conditions: they belong in the
 * status stream and paint through `ScenarioBootGate` as an overlay, so the
 * editor beneath them is never unmounted. What is left here is a real choice or
 * a real dead end — pick a quality, pick a map, this workspace has no maps —
 * where there is nothing to overlay because there is nothing to author yet.
 */
export function EditorEmptyState({
  title,
  detail,
  href,
  action,
}: {
  title: string;
  detail: string;
  href?: string;
  action?: string;
}) {
  return (
    <div
      aria-live="polite"
      className="grid h-full min-h-editor-shell place-items-center bg-background p-8"
      role="status"
    >
      <div className="max-w-md border border-border bg-card p-8 text-center">
        <div
          aria-hidden="true"
          className="mx-auto mb-5 grid size-12 place-items-center bg-primary font-bold text-primary-foreground"
        >
          U2
        </div>
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{detail}</p>
        {href && action ? (
          <Button asChild className="mt-6">
            <Link href={href}>{action}</Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** First-run choice of streaming budget. Persisted on the document once saved. */
export function QualityChooser({
  onChoose,
  titleId,
  descriptionId,
  benchmark,
  footer,
}: {
  onChoose: (quality: ScenarioAuthoringQuality) => void;
  titleId?: string;
  descriptionId?: string;
  benchmark?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="grid min-h-full place-items-center bg-transparent px-4 py-10 sm:px-6 sm:py-14">
      <div
        className="w-full max-w-6xl px-1 py-2 text-white sm:px-3"
        data-testid="render-selection-content"
        data-visual-treatment="flat"
      >
        <div className="text-center">
          <p className="font-meta text-[10px] font-bold uppercase tracking-[0.22em] text-[#E8E044]">
            First-time setup
          </p>
          <h1
            id={titleId}
            className="mt-2 text-3xl font-semibold tracking-tight text-white"
          >
            Render Selection
          </h1>
          <p id={descriptionId} className="mt-2 text-sm text-white/50">
            Find the best experience for this device.
          </p>
        </div>
        {benchmark}
        <div className="mt-7 flex items-center gap-4">
          <div className="h-px flex-1 bg-white/10" />
          <h2 className="font-meta text-[9px] font-bold uppercase tracking-[0.18em] text-white/30">
            Manual Selection
          </h2>
          <div className="h-px flex-1 bg-white/10" />
        </div>
        <div className="mt-4 grid grid-cols-4 gap-2 sm:gap-3">
          {SCENARIO_AUTHORING_QUALITY_CHOICES.map((choice) => (
            <button
              key={choice.id}
              type="button"
              onClick={() => onChoose(choice.id)}
              aria-label={`Use ${choice.label}`}
              className="group editor-motion text-left hover:-translate-y-1 focus-visible:rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]"
            >
              <span
                aria-hidden="true"
                className="relative block aspect-[16/9] overflow-hidden rounded-2xl ring-1 ring-inset ring-white/10"
              >
                <span
                  className="absolute inset-0 bg-cover bg-center bg-no-repeat transition-transform duration-500 group-hover:scale-[1.04]"
                  style={{
                    backgroundImage: `url(${QUALITY_PREVIEW_IMAGES[choice.id]})`,
                  }}
                />
                <span className="absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-transparent" />
                <span className="absolute bottom-2 left-2 font-meta text-[9px] font-bold uppercase tracking-meta text-white/80">
                  Belmont · same camera
                </span>
              </span>
              <span className="block px-1 py-3">
                <span className="flex items-center">
                  <span className="font-semibold text-white">
                    {choice.label}
                  </span>
                  {choice.recommended ? (
                    <span className="ml-auto text-[9px] font-bold uppercase tracking-meta text-[#E8E044]">
                      Recommended
                    </span>
                  ) : null}
                </span>
                <span className="mt-1.5 block text-xs text-white/45">
                  {choice.id === "roads-only"
                    ? "Core roads and traffic, without 3D scenery"
                    : choice.id === "ultra-low-3d"
                      ? "Lightweight 3D for lower-powered devices"
                      : choice.id === "minimal"
                        ? "Recommended for most devices"
                        : "Highest detail for powerful devices"}
                </span>
              </span>
            </button>
          ))}
        </div>
        {footer ? (
          <div className="mt-4 border-t border-white/10 pt-4">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}

/** Map choice for a new, unbound scenario. Once chosen, the draft follows new
 * compatible immutable builds of that same source map during release activation. */
export function MapChooser({
  maps,
  onChoose,
}: {
  maps: ScenarioMapEntry[];
  onChoose: (mapId: string) => void;
}) {
  return (
    <div className="grid min-h-editor-shell place-items-center bg-background p-8">
      <div className="w-full max-w-3xl">
        <div className="text-center">
          <p className="text-xs font-semibold uppercase tracking-meta-wider text-primary">
            Map-bound scenario
          </p>
          <h1 className="mt-2 text-2xl font-semibold">Choose a map</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This scenario will follow compatible new builds of the selected map.
            Choosing a different map creates a separate scenario.
          </p>
        </div>
        <div className="mt-8 grid gap-3 md:grid-cols-2">
          {maps.map((map) => (
            <button
              key={map.versionId}
              type="button"
              onClick={() => onChoose(map.versionId)}
              className="editor-motion border border-border bg-card p-5 text-left hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <span className="block font-semibold">{map.label}</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {map.locality || "Immutable map version"}
              </span>
              <span className="mt-3 block break-all font-mono text-micro text-muted-foreground">
                {map.versionId}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
