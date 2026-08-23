"use client";

import { useEffect, useState } from "react";
import type { CameraView, CityViewer } from "@uniscenarios/city-renderer";
import { LaneIndex } from "@uniscenarios/editor-core";
import type { UniScenarioMapOption } from "../list/document-map-groups";
import { interpolateMapView } from "./map-camera-transition";
import {
  buildStreetTour,
  droneTransferCameraView,
  streetTourCameraView,
  withCameraLookOffset,
  type StreetTour,
} from "./idle-street-tour";

const INITIAL_IDLE_MS = 2200;
const RESUME_IDLE_MS = 8000;
const ENTRY_FLIGHT_MS = 2800;
const DRONE_TRANSFER_MS = 5200;
const STREET_SPEED_MPS = 8;

function reducedMotionRequested(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
/** Runs a topology-bound street tour on the idle Datasets map. */
export function useIdleStreetTour({
  enabled,
  interruptible = true,
  map,
  viewer,
  loadedMapVersionId,
  cinematic = false,
  speedMultiplier = 1,
  allowLookAround = false,
}: {
  enabled: boolean;
  interruptible?: boolean;
  map: UniScenarioMapOption | null;
  viewer: CityViewer | null;
  loadedMapVersionId: string | null;
  /** Add gentle camera sway and aerial transfers between disconnected streets. */
  cinematic?: boolean;
  /** Multiplier over the standard 8 m/s ambient traversal speed. */
  speedMultiplier?: number;
  /** Preserve drag-to-look as an offset while the tour keeps moving. */
  allowLookAround?: boolean;
}) {
  const [laneIndex, setLaneIndex] = useState<LaneIndex | null>(null);

  useEffect(() => {
    setLaneIndex(null);
    if (!enabled || !map?.topologyUrl) return;
    const abort = new AbortController();
    void LaneIndex.load(map.topologyUrl, { signal: abort.signal })
      .then((index) => {
        if (!abort.signal.aborted) setLaneIndex(index);
      })
      .catch(() => {
        // The idle world remains fully usable when topology is unavailable.
      });
    return () => abort.abort();
  }, [enabled, map?.mapVersionId, map?.topologyUrl]);

  useEffect(() => {
    if (
      !enabled ||
      !map ||
      !viewer ||
      !laneIndex ||
      loadedMapVersionId !== map.mapVersionId ||
      reducedMotionRequested()
    ) {
      return;
    }

    let disposed = false;
    let timer = 0;
    let frame = 0;
    let tour: StreetTour | null = null;
    let startedAt = 0;
    let entryStartedAt = 0;
    let transitionKind: "entry" | "drone" = "entry";
    let transitionDurationMs = ENTRY_FLIGHT_MS;
    let lookYaw = 0;
    let lookPitch = 0;
    let lookPointerId: number | null = null;
    let lookPointerX = 0;
    let lookPointerY = 0;
    const activeViewer = viewer;
    let entryFrom = activeViewer.controls.getView();
    let entryTo = entryFrom;
    let ground = activeViewer.buildGroundIndex();

    const cancelMotion = () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
      timer = 0;
      frame = 0;
    };

    const schedule = (delay: number) => {
      cancelMotion();
      if (disposed || document.hidden) return;
      timer = window.setTimeout(start, delay);
    };

    const applyTourView = (baseView: CameraView) => {
      const view = allowLookAround
        ? withCameraLookOffset(baseView, lookYaw, lookPitch)
        : baseView;
      activeViewer.controls.applyView(view);
    };

    const beginTour = (now: number, kind: "entry" | "drone") => {
      tour = buildStreetTour(laneIndex.graph);
      if (!tour || !ground) {
        schedule(1500);
        return false;
      }
      entryFrom = activeViewer.controls.getView();
      entryTo = streetTourCameraView(tour, 0, ground.sample, cinematic ? 0 : undefined);
      entryStartedAt = now;
      transitionKind = kind;
      transitionDurationMs = kind === "drone" ? DRONE_TRANSFER_MS : ENTRY_FLIGHT_MS;
      startedAt = now + transitionDurationMs;
      return true;
    };

    const tick = (now: number) => {
      if (disposed || !tour || !ground) return;
      if (now < startedAt) {
        const progress = (now - entryStartedAt) / transitionDurationMs;
        applyTourView(transitionKind === "drone"
          ? droneTransferCameraView(entryFrom, entryTo, progress)
          : interpolateMapView(entryFrom, entryTo, progress));
      } else {
        const distanceM = ((now - startedAt) / 1000) * STREET_SPEED_MPS * speedMultiplier;
        if (distanceM >= tour.lengthM - 0.5) {
          if (!beginTour(now, cinematic ? "drone" : "entry")) return;
        } else {
          applyTourView(
            streetTourCameraView(
              tour,
              distanceM,
              ground.sample,
              cinematic ? (now - startedAt) / 1000 : undefined,
            ),
          );
        }
      }
      frame = window.requestAnimationFrame(tick);
    };

    function start() {
      if (disposed || document.hidden) return;
      ground ??= activeViewer.buildGroundIndex();
      const now = performance.now();
      if (!beginTour(now, "entry")) return;
      frame = window.requestAnimationFrame(tick);
    }

    const handleInteraction = () => schedule(RESUME_IDLE_MS);
    const handleLookStart = (event: PointerEvent) => {
      const target = event.target;
      if (
        event.button !== 0 ||
        !(target instanceof HTMLCanvasElement) ||
        !target.closest('[data-testid="uniscenario-world-host"]')
      ) {
        return;
      }
      lookPointerId = event.pointerId;
      lookPointerX = event.clientX;
      lookPointerY = event.clientY;
    };
    const handleLookMove = (event: PointerEvent) => {
      if (event.pointerId !== lookPointerId) return;
      const dx = event.clientX - lookPointerX;
      const dy = event.clientY - lookPointerY;
      lookPointerX = event.clientX;
      lookPointerY = event.clientY;
      lookYaw -= dx * 0.0022;
      lookPitch = Math.max(-1.25, Math.min(1.25, lookPitch + dy * 0.0018));
    };
    const handleLookEnd = (event: PointerEvent) => {
      if (event.pointerId === lookPointerId) lookPointerId = null;
    };
    const handleVisibility = () => {
      if (document.hidden) cancelMotion();
      else schedule(interruptible ? RESUME_IDLE_MS : 0);
    };

    if (interruptible) {
      window.addEventListener("pointerdown", handleInteraction, true);
      window.addEventListener("wheel", handleInteraction, { capture: true, passive: true });
      window.addEventListener("keydown", handleInteraction, true);
    }
    if (allowLookAround) {
      window.addEventListener("pointerdown", handleLookStart, true);
      window.addEventListener("pointermove", handleLookMove, true);
      window.addEventListener("pointerup", handleLookEnd, true);
      window.addEventListener("pointercancel", handleLookEnd, true);
    }
    document.addEventListener("visibilitychange", handleVisibility);
    schedule(interruptible ? INITIAL_IDLE_MS : 0);

    return () => {
      disposed = true;
      cancelMotion();
      if (interruptible) {
        window.removeEventListener("pointerdown", handleInteraction, true);
        window.removeEventListener("wheel", handleInteraction, true);
        window.removeEventListener("keydown", handleInteraction, true);
      }
      if (allowLookAround) {
        window.removeEventListener("pointerdown", handleLookStart, true);
        window.removeEventListener("pointermove", handleLookMove, true);
        window.removeEventListener("pointerup", handleLookEnd, true);
        window.removeEventListener("pointercancel", handleLookEnd, true);
      }
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [allowLookAround, cinematic, enabled, interruptible, laneIndex, loadedMapVersionId, map, speedMultiplier, viewer]);
}
