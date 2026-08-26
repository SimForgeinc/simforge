"use client";

import { useEffect, useMemo, useState } from "react";
import { primaryActor, type MapAsset, type ScenarioEditorActorDraft } from "@simforge-oss/studio-shared";
import {
  buildActorTrajectoryGeoJSON,
  buildActorTrajectoryScenePaths,
} from "@/app/lib/maps/frontend/scenario-trajectories";
import {
  deriveCollisionPointLngLat,
  deriveCollisionPointScene,
} from "@/app/lib/maps/frontend/scenario-collision-point";
import {
  buildActorSpawns2D,
  buildActorSpawns3D,
} from "@/app/lib/maps/frontend/scenario-actor-spawns";
import {
  buildScenarioFocus2D,
  buildScenarioFocus3D,
} from "@/app/lib/maps/frontend/scenario-focus";
import { buildEsminiTrajectoryGeoJSON } from "@/app/lib/maps/frontend/esmini-trajectories";
import { useScenarioValidation } from "@/app/lib/maps/frontend/use-scenario-validation";
import type { UseMapSearchLlmResult } from "@/app/lib/maps/frontend/use-map-search-llm";

interface UseScenarioOverlayStateInput {
  currentAsset: MapAsset;
  aiSearchMessages: UseMapSearchLlmResult["messages"];
  viewMode: "2d" | "3d";
}

export function useScenarioOverlayState({
  currentAsset,
  aiSearchMessages,
  viewMode,
}: UseScenarioOverlayStateInput) {
  // Most recently AI-proposed scenario across the chat thread.
  const latestProposedScenario = useMemo(() => {
    for (let i = aiSearchMessages.length - 1; i >= 0; i -= 1) {
      const message = aiSearchMessages[i];
      if (
        message &&
        message.role === "assistant" &&
        message.proposedScenarios.length > 0
      ) {
        const rec =
          message.proposedScenarios[message.proposedScenarios.length - 1]!;
        return { scenarioId: rec.scenarioId, mapAssetId: rec.mapAssetId };
      }
    }
    return null;
  }, [aiSearchMessages]);

  // Single-select highlight state.
  const [selectedScenarioId, setSelectedScenarioId] = useState<string | null>(null);

  // Camera-fit nonce — bumped ONLY when the user clicks a scenario card.
  const [scenarioFocusNonce, setScenarioFocusNonce] = useState(0);

  // Always-latest-wins auto-selection.
  useEffect(() => {
    if (latestProposedScenario) {
      setSelectedScenarioId(latestProposedScenario.scenarioId);
    } else {
      setSelectedScenarioId(null);
    }
  }, [latestProposedScenario]);

  // Toggle handler.
  const handleSelectScenario = (scenarioId: string) => {
    setSelectedScenarioId((current) =>
      current === scenarioId ? null : scenarioId,
    );
    setScenarioFocusNonce((n) => n + 1);
  };

  // Resolve the active selection back to its source metadata.
  const selectedScenarioMeta = useMemo(() => {
    if (!selectedScenarioId) return null;
    for (const message of aiSearchMessages) {
      if (message.role !== "assistant") continue;
      for (const draft of message.proposedScenarios) {
        if (draft.scenarioId === selectedScenarioId) {
          return { scenarioId: draft.scenarioId, mapAssetId: draft.mapAssetId };
        }
      }
    }
    return null;
  }, [selectedScenarioId, aiSearchMessages]);

  const [proposedDraftActors, setProposedDraftActors] = useState<
    ScenarioEditorActorDraft[] | null
  >(null);

  const activeMapAssetId = currentAsset.map_asset_id;

  // Fetch draft actors for the selected scenario.
  useEffect(() => {
    if (
      !selectedScenarioMeta ||
      selectedScenarioMeta.mapAssetId !== activeMapAssetId
    ) {
      setProposedDraftActors(null);
      return;
    }
    let cancelled = false;
    fetch(
      `/api/scenarios/${encodeURIComponent(selectedScenarioMeta.scenarioId)}/draft`,
      { cache: "no-store" },
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((draft: { actors?: unknown } | null) => {
        if (cancelled) return;
        setProposedDraftActors(
          Array.isArray(draft?.actors)
            ? (draft!.actors as ScenarioEditorActorDraft[])
            : null,
        );
      })
      .catch(() => {
        if (!cancelled) setProposedDraftActors(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedScenarioMeta, activeMapAssetId]);

  const actorTrajectoryOverlay = useMemo(
    () => buildActorTrajectoryGeoJSON(proposedDraftActors, currentAsset),
    [proposedDraftActors, currentAsset],
  );

  // esmini validation for the highlighted draft.
  const validationScenarioId =
    selectedScenarioMeta && selectedScenarioMeta.mapAssetId === activeMapAssetId
      ? selectedScenarioMeta.scenarioId
      : null;
  const validation = useScenarioValidation(validationScenarioId);

  const esminiTrajectoryOverlay = useMemo(
    () => buildEsminiTrajectoryGeoJSON(
      validation.metrics,
      currentAsset,
      proposedDraftActors ? primaryActor(proposedDraftActors)?.id ?? null : null,
    ),
    [validation.metrics, currentAsset, proposedDraftActors],
  );

  const scenarioFocusBounds = useMemo(() => {
    if (scenarioFocusNonce === 0) return null;
    if (!selectedScenarioId) return null;
    if (!proposedDraftActors) return null;
    void scenarioFocusNonce;
    return buildScenarioFocus2D(proposedDraftActors, currentAsset);
  }, [
    scenarioFocusNonce,
    selectedScenarioId,
    proposedDraftActors,
    currentAsset,
  ]);

  const collisionPointOverlay = useMemo(
    () => deriveCollisionPointLngLat(proposedDraftActors, currentAsset),
    [proposedDraftActors, currentAsset],
  );

  const actorSpawnOverlay = useMemo(
    () => buildActorSpawns2D(proposedDraftActors, currentAsset),
    [proposedDraftActors, currentAsset],
  );

  const actorTrajectories3D = useMemo(() => {
    if (viewMode !== "3d") return [];
    const coordRef = currentAsset.map_coordinate_ref;
    if (
      !coordRef ||
      coordRef.origin_lon == null ||
      coordRef.origin_lat == null
    ) {
      return [];
    }
    return buildActorTrajectoryScenePaths(
      proposedDraftActors,
      currentAsset,
      coordRef.origin_lon,
      coordRef.origin_lat,
    );
  }, [viewMode, proposedDraftActors, currentAsset]);

  const collisionMarker3D = useMemo(() => {
    if (viewMode !== "3d") return null;
    const coordRef = currentAsset.map_coordinate_ref;
    if (
      !coordRef ||
      coordRef.origin_lon == null ||
      coordRef.origin_lat == null
    ) {
      return null;
    }
    return deriveCollisionPointScene(
      proposedDraftActors,
      currentAsset,
      coordRef.origin_lon,
      coordRef.origin_lat,
    );
  }, [viewMode, proposedDraftActors, currentAsset]);

  const scenarioFocusTarget3D = useMemo(() => {
    if (viewMode !== "3d") return null;
    if (scenarioFocusNonce === 0) return null;
    if (!selectedScenarioId) return null;
    if (!proposedDraftActors) return null;
    const coordRef = currentAsset.map_coordinate_ref;
    if (
      !coordRef ||
      coordRef.origin_lon == null ||
      coordRef.origin_lat == null
    ) {
      return null;
    }
    void scenarioFocusNonce;
    return buildScenarioFocus3D(
      proposedDraftActors,
      currentAsset,
      coordRef.origin_lon,
      coordRef.origin_lat,
    );
  }, [
    viewMode,
    scenarioFocusNonce,
    selectedScenarioId,
    proposedDraftActors,
    currentAsset,
  ]);

  const actorSpawns3D = useMemo(() => {
    if (viewMode !== "3d") return [];
    const coordRef = currentAsset.map_coordinate_ref;
    if (
      !coordRef ||
      coordRef.origin_lon == null ||
      coordRef.origin_lat == null
    ) {
      return [];
    }
    return buildActorSpawns3D(
      proposedDraftActors,
      currentAsset,
      coordRef.origin_lon,
      coordRef.origin_lat,
    );
  }, [viewMode, proposedDraftActors, currentAsset]);

  return {
    selectedScenarioId,
    handleSelectScenario,
    validation,
    actorTrajectoryOverlay,
    esminiTrajectoryOverlay,
    collisionPointOverlay,
    actorSpawnOverlay,
    scenarioFocusBounds,
    actorTrajectories3D,
    collisionMarker3D,
    scenarioFocusTarget3D,
    actorSpawns3D,
  };
}
