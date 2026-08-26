"use client";

/**
 * Screen-space badges over road vehicles that have no lane anchor.
 *
 * The drop resolver never refuses a placement: a road vehicle dropped or
 * pasted with no usable lane within 8 m lands free. That state is legal but
 * usually unintended, so each unanchored vehicle carries a visible badge with
 * a one-click re-snap to the nearest usable lane.
 */

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Vector3 } from "three";
import {
  isRoadBoundMotorVehicle,
  type EditorController,
  type EditorState,
} from "@simforge-oss/editor";
import type { CityViewer } from "@simforge-oss/viewer";

export function UnanchoredActorBadges({
  viewer,
  controller,
  state,
}: {
  viewer: CityViewer | null;
  controller: EditorController | null;
  state: EditorState | null;
}) {
  const unanchored = useMemo(
    () =>
      (state?.actors ?? []).filter(
        (actor) => !actor.static && !actor.laneRef && isRoadBoundMotorVehicle(actor.catalogId),
      ),
    [state?.actors],
  );
  const [positions, setPositions] = useState<Readonly<Record<string, {
    x: number;
    y: number;
    visible: boolean;
  }>>>({});

  useEffect(() => {
    if (!viewer || unanchored.length === 0) {
      setPositions({});
      return;
    }
    let frame = 0;
    const projected = new Vector3();
    const update = () => {
      const bounds = viewer.renderer.domElement.getBoundingClientRect();
      const next: Record<string, { x: number; y: number; visible: boolean }> = {};
      for (const actor of unanchored) {
        projected.set(actor.x, actor.y + actor.dims.h + 0.6, actor.z).project(viewer.camera);
        next[actor.id] = {
          x: Math.round(bounds.left + (projected.x + 1) * bounds.width / 2),
          y: Math.round(bounds.top + (1 - projected.y) * bounds.height / 2),
          visible: projected.z >= -1 && projected.z <= 1,
        };
      }
      setPositions((current) => {
        const keys = Object.keys(next);
        if (
          keys.length === Object.keys(current).length
          && keys.every((key) => current[key]?.x === next[key]?.x
            && current[key]?.y === next[key]?.y
            && current[key]?.visible === next[key]?.visible)
        ) return current;
        return next;
      });
      frame = window.requestAnimationFrame(update);
    };
    update();
    return () => window.cancelAnimationFrame(frame);
  }, [unanchored, viewer]);

  // Hidden while a modal gesture owns the scene: a mid-drag badge would sit on
  // the stale committed pose, not the preview.
  if (!viewer || unanchored.length === 0 || (state && state.mode !== "idle")) return null;
  return createPortal(
    <>
      {unanchored.map((actor) => {
        const position = positions[actor.id];
        if (!position?.visible) return null;
        return (
          <div
            className="pointer-events-none fixed z-[85] -translate-x-1/2 -translate-y-full"
            data-testid="unanchored-actor-badge"
            data-actor-id={actor.id}
            key={actor.id}
            style={{ left: position.x, top: position.y }}
          >
            <div className="pointer-events-auto flex items-center gap-2 rounded-md border border-amber-300/80 bg-black/90 px-2 py-1 text-[11px] font-medium leading-snug text-amber-100 shadow-lg backdrop-blur-md">
              <span>Unanchored</span>
              <button
                className="rounded-sm border border-amber-300/60 px-1.5 py-0.5 text-amber-50 transition-colors hover:bg-amber-300/20"
                data-testid="unanchored-resnap"
                onClick={() => controller?.resnapToLane([actor.id])}
                type="button"
              >
                Re-snap
              </button>
            </div>
          </div>
        );
      })}
    </>,
    document.body,
  );
}
