"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import type { EditorDocument, ScenarioMapEntry } from "@simforge-oss/editor";
import {
  ACCELERATED_SIGNAL_CYCLES_EXTENSION_KEY,
  ALL_SUMO_SIGNALS_GREEN_EXTENSION_KEY,
  AMBIENT_TRAFFIC_EXTENSION_KEY,
  AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY,
  allSumoSignalsGreenFromExtensions,
  ambientSignalCycleSettingsFromExtensions,
  ambientTrafficProfileFromExtensions,
  ambientTrafficProviderFromExtensions,
  type AmbientTrafficProviderId,
  type SumoTrafficStatus,
} from "@simforge-oss/playback/traffic";
import {
  ActorRenderer,
  indexedWorldHeightSampler,
  type CityViewer,
} from "@simforge-oss/viewer";
import type { TruthFrame } from "@simforge-oss/training-env/browser";
import type { ResolvedAmbientTrafficProfile } from "@simforge-oss/engine";

import { playbackMapEntry } from "../maps";
import type { StudioSessionMode } from "../session/model";
import { AmbientTrafficPanel } from "./AmbientTrafficPanel";
import {
  useSumoTraffic,
  type SumoExternalActorView,
} from "./useSumoTraffic";

export interface DriveAmbientTrafficOptions {
  readonly document: EditorDocument | null;
  readonly map: ScenarioMapEntry;
  readonly viewer: CityViewer | null;
  readonly mapLoaded: boolean;
  readonly latestFrame: TruthFrame | null;
  readonly mode: StudioSessionMode;
  readonly time: number;
  readonly onFallback?: (reason: string) => void;
}

export interface DriveAmbientTrafficState {
  readonly sumoAvailable: boolean;
  readonly sumoUnavailableReason: string | null;
  readonly sumoStatus: SumoTrafficStatus;
  readonly trafficDetails: ReactElement | null;
}

/**
 * Reuses Studio's browser SUMO lifecycle on a Drive-style surface.
 *
 * The authored-world truth renderer remains responsible for authored actors.
 * This hook owns one separate ActorRenderer layer for SUMO actors, mirrors the
 * current truth frame into SUMO as external occupancy, and exposes the same
 * status and fine-tuning controls used by Scenario Studio.
 */
export function useDriveAmbientTraffic({
  document,
  map,
  viewer,
  mapLoaded,
  latestFrame,
  mode,
  time,
  onFallback = ignoreFallback,
}: DriveAmbientTrafficOptions): DriveAmbientTrafficState {
  const [actorRenderer, setActorRenderer] = useState<ActorRenderer | null>(null);
  const runtimeMap = useMemo(() => playbackMapEntry(map), [map]);
  const extensions = document?.data.extensions;
  const provider = ambientTrafficProviderFromExtensions(extensions);
  const profile = ambientTrafficProfileFromExtensions(extensions);
  const acceleratedSignalCycles = ambientSignalCycleSettingsFromExtensions(
    extensions,
  ).acceleratedSignalCycles;
  const allSignalsGreen = allSumoSignalsGreenFromExtensions(extensions);
  const hasAuthoredMapSignals = Boolean(document?.data.mapSignalPlans.length);
  const sumoUnavailableReason = driveSumoUnavailableReason(
    map,
    hasAuthoredMapSignals,
  );
  const sumoAvailable = sumoUnavailableReason === null;

  useEffect(() => {
    if (!viewer || !mapLoaded) {
      setActorRenderer(null);
      return;
    }
    const renderer = new ActorRenderer();
    renderer.group.name = "drive-sumo-traffic";
    viewer.scene.add(renderer.group);
    setActorRenderer(renderer);
    return () => {
      renderer.dispose();
      setActorRenderer((current) => (current === renderer ? null : current));
    };
  }, [mapLoaded, viewer]);

  const sampleHeight = useMemo(
    () => (viewer && mapLoaded ? indexedWorldHeightSampler(viewer) : null),
    [mapLoaded, viewer],
  );
  const externalActors = useMemo(
    () => truthFrameSumoExternalActors(latestFrame),
    [latestFrame],
  );
  const demandFocuses = useStableDemandFocuses(map.mapVersionId, externalActors);
  const focusActor = externalActors.find((actor) => actor.present && !actor.static);
  const focus = focusActor ? { x: focusActor.x, z: focusActor.z } : null;

  const sumoStatus = useSumoTraffic({
    enabled:
      provider === "sumo" &&
      sumoAvailable &&
      mapLoaded &&
      document !== null,
    map: runtimeMap,
    profile,
    renderer: actorRenderer,
    sampleHeight,
    mode,
    time,
    externalActors,
    focus,
    demandFocuses,
    onFallback,
    acceleratedSignalCycles,
    allSignalsGreen,
  });

  const updateProfile = (next: ResolvedAmbientTrafficProfile) =>
    document?.setAmbientTrafficExtension(AMBIENT_TRAFFIC_EXTENSION_KEY, next);
  const updateProvider = (next: AmbientTrafficProviderId) =>
    document?.setAmbientTrafficExtension(
      AMBIENT_TRAFFIC_PROVIDER_EXTENSION_KEY,
      next,
    );

  const trafficDetails = document ? (
    <section data-testid="drive-ambient-editor">
      <AmbientTrafficPanel
        alwaysOpen
        profile={profile}
        provenance={null}
        provider={provider}
        onProviderChange={updateProvider}
        onChange={updateProfile}
        acceleratedSignalCycles={acceleratedSignalCycles}
        onAcceleratedSignalCyclesChange={(enabled) =>
          document.setAmbientTrafficExtension(
            ACCELERATED_SIGNAL_CYCLES_EXTENSION_KEY,
            enabled ? true : undefined,
          )
        }
        allSignalsGreen={allSignalsGreen}
        onAllSignalsGreenChange={(enabled) =>
          document.setAmbientTrafficExtension(
            ALL_SUMO_SIGNALS_GREEN_EXTENSION_KEY,
            enabled ? true : undefined,
          )
        }
        sumoStatus={sumoStatus}
        sumoAvailable={sumoAvailable}
        sumoUnavailableReason={sumoUnavailableReason}
      />
    </section>
  ) : null;

  return {
    sumoAvailable,
    sumoUnavailableReason,
    sumoStatus,
    trafficDetails,
  };
}

export function driveSumoUnavailableReason(
  map: Pick<ScenarioMapEntry, "label" | "sumoNetworkSha256">,
  hasAuthoredMapSignals: boolean,
): string | null {
  if (!map.sumoNetworkSha256) {
    return `SUMO cannot run on ${map.label}: the published map is missing derived/sumo/sumo-network-manifest.json and its immutable network digest. Republish the map with SUMO artifacts.`;
  }
  if (hasAuthoredMapSignals) {
    return "SUMO cannot run while this scenario has authored traffic-light programs. Use City sim so the authored signal plan remains authoritative.";
  }
  return null;
}

export function truthFrameSumoExternalActors(
  frame: TruthFrame | null,
): readonly SumoExternalActorView[] {
  if (!frame) return [];
  const metadata = new Map(frame.actors.map((actor) => [actor.id, actor]));
  const actors: SumoExternalActorView[] = [];
  for (const current of frame.scene.actors) {
    if (current.kind === "despawn") continue;
    const actor = metadata.get(current.id);
    if (!actor) continue;
    actors.push({
      id: current.id,
      kind: actor.class === "prop" ? "static_object" : actor.class,
      x: current.position[0],
      z: current.position[2],
      headingRad: current.yawRad,
      speedMps: Math.hypot(current.velocity[0], current.velocity[2]),
      lengthM: actor.dims.l,
      widthM: actor.dims.w,
      static: actor.class === "prop",
      present: true,
    });
  }
  return actors;
}

function useStableDemandFocuses(
  mapVersionId: string,
  actors: readonly SumoExternalActorView[],
): readonly { readonly x: number; readonly z: number }[] {
  const movingActors = actors.filter((actor) => actor.present && !actor.static);
  const key = `${mapVersionId}:${movingActors.map((actor) => actor.id).sort().join(",")}`;
  const frozen = useRef<{
    readonly key: string;
    readonly focuses: readonly { readonly x: number; readonly z: number }[];
  } | null>(null);
  if (frozen.current?.key !== key) {
    frozen.current = {
      key,
      focuses: movingActors.map((actor) => ({ x: actor.x, z: actor.z })),
    };
  }
  return frozen.current.focuses;
}

function ignoreFallback(): void {}
