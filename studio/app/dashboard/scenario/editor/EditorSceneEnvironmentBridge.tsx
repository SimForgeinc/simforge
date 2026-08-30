"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { CityViewer } from "@simforge-oss/viewer";
import type { EditorDocument } from "@simforge-oss/editor";
import { editorLightingSignature } from "@simforge-oss/scenario/contracts";
import type { ScenarioAuthoringQuality } from "@/app/lib/scenario/contracts";
import { applyEditorSceneEnvironment } from "./scene-environment";
import { sceneTimeSignature } from "./scene-time";
import { editorWeatherControlSignature } from "./weather-controls";

const EMPTY_UNSUBSCRIBE = () => undefined;

/** Keeps the authored environment and the already-mounted Three.js world in sync. */
export function EditorSceneEnvironmentBridge({
  active,
  document,
  quality,
  viewer,
}: {
  readonly active: boolean;
  readonly document: EditorDocument | null;
  readonly quality: ScenarioAuthoringQuality;
  readonly viewer: CityViewer | null;
}) {
  const subscribe = useCallback(
    (listener: () => void) => document?.subscribe(listener) ?? EMPTY_UNSUBSCRIBE,
    [document],
  );
  const getSnapshot = useCallback(() => document?.revision ?? 0, [document]);
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const weather = document?.data.environment.weather;
  const timeOfDay = document?.data.environment.timeOfDay;
  const weatherControls = document
    ? editorWeatherControlSignature(document.data.environment)
    : null;
  const lighting = document
    ? editorLightingSignature(document.data.environment)
    : null;
  const sceneTime = document
    ? sceneTimeSignature(document.data.environment)
    : null;

  useEffect(() => {
    if (!active || !document || !viewer || !weather || !timeOfDay) return;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ?? false;
    return applyEditorSceneEnvironment(viewer, document.data.environment, {
      quality,
      reducedMotion,
    });
  }, [active, document, lighting, quality, sceneTime, timeOfDay, viewer, weather, weatherControls]);

  return null;
}
