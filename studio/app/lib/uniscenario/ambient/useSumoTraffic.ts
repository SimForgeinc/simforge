"use client";

/* eslint-disable react-hooks/exhaustive-deps -- vendored Studio runtime effects fence lifecycle on selected primitive identities */

import { useEffect, useRef, useState } from "react";
import {
  buildSumoAuthoredOccupancies,
  contentHash,
  type MaterializedTrafficArtifactEnvelope,
  type ResolvedAmbientTrafficProfile,
  type SumoAuthoredOccupancySource,
  type SumoRoadOccupancyIndex,
} from "@simforge/engine";
import type { ActorRenderer, ActorView } from "@simforge/viewer";
import type { MapEntry } from "../maps";
import {
  evaluateSumoPerformance,
  evaluateSumoStepWindow,
  sumoPerformanceFallbackReason,
  loadStaticMapCollidersBounded,
  type CollisionActorOverrides,
  type SumoStepTimingSample,
} from "@simforge/playback";
import type {
  ExternalTrafficActor,
  TrafficNetworkPayload,
  TrafficStepRequest,
  TrafficStepResult,
} from "@simforge/playback";
import { SumoWasmTrafficProvider } from "@simforge/playback";
import {
  decodeSumoSignalSnapshot,
  type SumoSignalTopology,
} from "@simforge/playback";
import type { StudioSessionMode } from "../session/model";
import {
  BrowserMaterializedTrafficCapture,
  DISABLED_SUMO_STATUS,
  SumoCollisionPhysics,
  SumoMotionSmoother,
  type SumoTrafficStatus,
} from "@simforge/playback/traffic";
import {
  decodeSumoActorViews,
  loadSumoAssets,
  signalNetworkForScenario,
  SUMO_RUNTIME_MODULE_URL,
} from "./sumoAssets";
import type { SumoDemandFocus } from "./sumoAssets";

export type SumoExternalActorView = SumoAuthoredOccupancySource & {
  readonly render?: ActorView;
};

export interface UseSumoTrafficOptions {
  readonly enabled: boolean;
  readonly map: MapEntry;
  readonly profile: ResolvedAmbientTrafficProfile;
  readonly renderer: ActorRenderer | null | undefined;
  readonly sampleHeight: ((x: number, z: number) => number | null) | null;
  readonly mode: StudioSessionMode;
  readonly time: number;
  readonly externalActors: readonly SumoExternalActorView[];
  readonly collisionActorOverrides?: CollisionActorOverrides;
  readonly focus: SumoDemandFocus | null;
  readonly demandFocuses: readonly SumoDemandFocus[];
  readonly onFallback: (reason: string) => void;
  readonly acceleratedSignalCycles: boolean;
  readonly allSignalsGreen: boolean;
  /** A fresh recorder owned by one explicit, full Play run. */
  readonly materializedTrafficCapture?: BrowserMaterializedTrafficCapture;
  readonly onMaterializedTrafficComplete?: (artifact: MaterializedTrafficArtifactEnvelope) => void;
}

export function isSumoTrafficBootstrapReady(
  options: Pick<
    UseSumoTrafficOptions,
    "enabled" | "profile" | "renderer" | "sampleHeight"
  >,
): boolean {
  return (
    options.enabled &&
    options.profile.preset !== "off" &&
    Boolean(options.renderer) &&
    Boolean(options.sampleHeight)
  );
}

/**
 * Only immutable execution inputs restart the expensive browser runtime.
 * Demand focuses are the authored actor positions at bundle creation; the live
 * metric focus and callback/object identities never abort asset loading.
 */
export function sumoTrafficBootstrapKey(
  options: Pick<
    UseSumoTrafficOptions,
    "enabled" | "map" | "profile" | "demandFocuses"
  >,
): string {
  return contentHash({
    enabled: options.enabled,
    mapVersionId: options.map.mapVersionId,
    sourceMapId: options.map.sourceMapId,
    sumoManifest: options.map.sumoManifest,
    sumoNetworkSha256: options.map.sumoNetworkSha256,
    profile: options.profile,
    demandFocuses: options.demandFocuses,
  });
}

/**
 * Owns browser SUMO independently of the authored timeline. The renderer layer
 * survives playback layer swaps, while every authored road user is mirrored as
 * an external proxy and is therefore never driven by SUMO state.
 */
export function useSumoTraffic(
  options: UseSumoTrafficOptions,
): SumoTrafficStatus {
  const [status, setStatus] = useState<SumoTrafficStatus>(DISABLED_SUMO_STATUS);
  const run = useRef<SumoTrafficRun | null>(null);
  const externals = useRef(options.externalActors);
  const previousMode = useRef(options.mode);
  const onFallback = useRef(options.onFallback);
  const onMaterializedTrafficComplete = useRef(
    options.onMaterializedTrafficComplete,
  );
  const bootstrapKey = sumoTrafficBootstrapKey(options);
  externals.current = options.externalActors;
  onFallback.current = options.onFallback;
  onMaterializedTrafficComplete.current =
    options.onMaterializedTrafficComplete;

  useEffect(() => {
    const active = run.current;
    if (!active) return;
    active.requestedAcceleratedSignalCycles = options.acceleratedSignalCycles;
    active.requestedAllSignalsGreen = options.allSignalsGreen;
    if (active.payload && sumoSignalSettingsOutOfSync(active)) {
      reconfigureSignalCycles(
        active,
        options.acceleratedSignalCycles,
        options.allSignalsGreen,
      );
    }
  }, [options.acceleratedSignalCycles, options.allSignalsGreen]);

  useEffect(() => {
    const active = run.current;
    const resetForMode = shouldResetSumoForModeTransition(
      previousMode.current,
      options.mode,
      active?.timelineAdvanced ?? false,
    );
    const resetForPausedSeek = Boolean(
      active &&
        options.mode !== "playing" &&
        classifySumoTimelineStep(options.time - active.lastRequestedTime) ===
          "reset",
    );
    if ((resetForMode || resetForPausedSeek) && active?.occupancyRoads) {
      resetSumoRun(active, {
        targetTime: options.time,
        externalActors: externalTrafficActors(
          externals.current,
          active.occupancyRoads,
        ),
        focus: options.focus,
        renderer: options.renderer,
        sampleHeight: options.sampleHeight,
        phaseAfterReset: "ready",
        setStatus,
        onFallback: (reason) => onFallback.current(reason),
      });
    }
    previousMode.current = options.mode;
  }, [
    options.focus,
    options.mode,
    options.renderer,
    options.sampleHeight,
    options.time,
  ]);

  useEffect(() => {
    if (!isSumoTrafficBootstrapReady(options)) {
      options.renderer?.clearLayer("sumo-traffic");
      options.collisionActorOverrides?.clear();
      setStatus(DISABLED_SUMO_STATUS);
      return;
    }
    let cancelled = false;
    const assetsAbort = new AbortController();
    const provider = new SumoWasmTrafficProvider(SUMO_RUNTIME_MODULE_URL);
    const active: SumoTrafficRun = {
      provider,
      generation: 0,
      sequence: 0,
      // The provider may be created while the author is scrubbed away from t=0.
      // Establish the proxy baseline at that same editor instant; a later
      // rewind is classified explicitly and rebuilds from the new instant.
      lastRequestedTime: options.time,
      stepping: Promise.resolve(),
      stepSamples: [],
      failedPerformanceWindows: 0,
      performanceSamplesObserved: 0,
      samplesAtLastPerformanceEvaluation: 0,
      seenActorIds: new Set(),
      completedActorIds: new Set(),
      occupancyRoads: null,
      lastExternalActors: [],
      timelineAdvanced: false,
      resetting: false,
      disposed: false,
      requestedAcceleratedSignalCycles: options.acceleratedSignalCycles,
      appliedAcceleratedSignalCycles: options.acceleratedSignalCycles,
      requestedAllSignalsGreen: options.allSignalsGreen,
      appliedAllSignalsGreen: options.allSignalsGreen,
      reconfiguring: false,
      captureFinalized: false,
      captureInvalidated: false,
      capture: options.materializedTrafficCapture,
      lastStatusPublishedAt: 0,
      motionSmoother: new SumoMotionSmoother(options.renderer!),
      collisionPhysics: new SumoCollisionPhysics(),
    };
    run.current = active;
    void loadStaticMapCollidersBounded(options.map.manifest).then((bundle) => {
      if (!cancelled && bundle.diagnostics.status === "ready") {
        active.collisionPhysics.setStaticColliders(bundle.colliders);
      }
    });
    setStatus({
      phase: "loading",
      actorCount: 0,
      reason: "loading runtime and map assets",
    });
    void loadSumoAssets(
      options.map,
      options.profile,
      fetch,
      options.demandFocuses,
      active.appliedAcceleratedSignalCycles,
      assetsAbort.signal,
      undefined,
      options.allSignalsGreen,
    )
      .then(
        async ({
          payload,
          runtime,
          demand,
          signalTopology,
          adjustedSignalControllers,
          occupancyRoads,
          rawNetworkXml,
        }) => {
          if (cancelled) return;
          setStatus({
            phase: "loading",
            actorCount: 0,
            reason: "starting browser traffic engine",
          });
          const initialized = await provider.initialize(payload);
          if (cancelled) return;
          const initialGate = evaluateSumoPerformance({
            initMilliseconds: initialized.initMilliseconds,
            wasmBytes: runtime.wasmBytes,
            heapBytes: initialized.heapBytes,
            stepP95Milliseconds: 0,
            requestedStepMilliseconds: payload.stepSeconds * 1_000,
          });
          if (!initialGate.useSumo)
            throw new Error(`capability gate: ${initialGate.reason}`);
          // Warm the staggered departures before publishing the authoring preview.
          // This keeps the city populated before Play without a visible spawn burst.
          setStatus({
            phase: "loading",
            actorCount: 0,
            reason: "warming initial traffic",
            initMilliseconds: initialized.initMilliseconds,
            heapBytes: initialized.heapBytes,
            wasmBytes: runtime.wasmBytes,
          });
          const initialExternalActors = externalTrafficActors(
            externals.current,
            occupancyRoads,
          );
          const initialRequests = buildSumoBaselineRequests(
            active.generation,
            active.sequence,
            sumoBaselineAdvanceSeconds(
              demand.warmupSeconds,
              options.time,
            ),
            initialExternalActors,
          );
          active.sequence += initialRequests.length;
          let first: TrafficStepResult | null = null;
          for (const request of initialRequests)
            first = await provider.step(request);
          if (!first) throw new Error("SUMO warmup interval must be positive");
          if (cancelled) return;
          active.signalTopology = signalTopology;
          active.payload = payload;
          active.rawNetworkXml = rawNetworkXml;
          active.adjustedSignalControllers = adjustedSignalControllers;
          active.occupancyRoads = occupancyRoads;
          active.lastExternalActors = initialExternalActors;
          active.warmupSeconds = demand.warmupSeconds;
          active.statusBase = {
            initMilliseconds: initialized.initMilliseconds,
            heapBytes: initialized.heapBytes,
            wasmBytes: runtime.wasmBytes,
            requestedActorCount: demand.requestedActors,
            nearbyRouteStarts: demand.nearbyRouteStarts,
            detailedSafetyMetricsAvailable: false,
            adjustedSignalControllers,
          };
          const firstMetrics = trafficMetrics(first, options.focus, active);
          const signals = decodeSumoSignalSnapshot(
            first.signalStates,
            first.signalLinkCount,
            signalTopology,
          );
          // Unmapped/inactive controlled links are valid SUMO network detail.
          // Publish only states with physical-head provenance.
          active.lastResult = first;
          active.lastSignalHeads = signals.heads;
          active.motionSmoother.snap(
            decodeSumoActorViews(first, options.sampleHeight!),
          );
          setStatus({
            phase: "ready",
            actorCount: first.actorCount,
            initMilliseconds: initialized.initMilliseconds,
            heapBytes: initialized.heapBytes,
            wasmBytes: runtime.wasmBytes,
            stepP95Milliseconds: first.stepMilliseconds,
            ...firstMetrics,
            requestedActorCount: demand.requestedActors,
            simulatedActorCount: first.simulatedActorCount,
            nearbyRouteStarts: demand.nearbyRouteStarts,
            detailedSafetyMetricsAvailable: false,
            signalStates: signals.heads,
            mappedSignalHeads: signals.mappedHeadCount,
            unmappedSignalLinks: signals.unmappedLinkCount,
            adjustedSignalControllers,
          });
          if (sumoSignalSettingsOutOfSync(active)) {
            reconfigureSignalCycles(
              active,
              active.requestedAcceleratedSignalCycles,
              active.requestedAllSignalsGreen,
            );
          }
        },
      )
      .catch((reason: unknown) => {
        if (
          cancelled ||
          assetsAbort.signal.aborted ||
          (reason as { name?: string } | null)?.name === "AbortError"
        )
          return;
        const message =
          reason instanceof Error ? reason.message : String(reason);
        options.renderer?.clearLayer("sumo-traffic");
        setStatus({ phase: "fallback", actorCount: 0, reason: message });
        onFallback.current(message);
      });
    return () => {
      cancelled = true;
      assetsAbort.abort();
      active.disposed = true;
      active.captureInvalidated = true;
      active.motionSmoother.dispose();
      active.collisionPhysics.clear();
      options.collisionActorOverrides?.clear();
      active.generation += 1;
      if (run.current === active) run.current = null;
      options.renderer?.clearLayer("sumo-traffic");
      void provider.close();
    };
  }, [
    bootstrapKey,
    options.renderer,
    options.sampleHeight,
  ]);

  useEffect(() => {
    const active = run.current;
    if (
      !active ||
      !active.occupancyRoads ||
      active.resetting ||
      options.mode !== "playing"
    )
      return;
    const capture = options.materializedTrafficCapture;
    if (active.capture !== capture) {
      active.captureInvalidated = true;
      active.capture = capture;
      active.captureFinalized = false;
      active.captureInvalidated = !capture || Math.abs(options.time) > 1e-9;
    }
    if (capture && !active.captureInvalidated && capture.nextTime === 0 && active.lastResult) {
      capture.recordSumoFrame(0, active.lastResult, active.lastSignalHeads ?? {});
      finalizeMaterializedTrafficCapture(
        active,
        capture,
        onMaterializedTrafficComplete.current,
      );
    }
    const occupancyRoads = active.occupancyRoads;
    const delta = options.time - active.lastRequestedTime;
    const timing = classifySumoTimelineStep(delta);
    if (timing === "wait") return;
    active.lastRequestedTime = options.time;
    if (timing === "reset") {
      active.captureInvalidated = true;
      resetSumoRun(active, {
        targetTime: options.time,
        externalActors: externalTrafficActors(
          externals.current,
          occupancyRoads,
        ),
        focus: options.focus,
        renderer: options.renderer,
        sampleHeight: options.sampleHeight,
        phaseAfterReset: "running",
        setStatus,
        onFallback: (reason) => onFallback.current(reason),
      });
      return;
    }
    // Capture the pose at the same editor instant as `delta`. Reading the
    // mutable ref inside the queued promise pairs a future pose with an older
    // step interval whenever the worker is briefly backlogged, which makes
    // TraCI report physically impossible implied speeds.
    const targetAuthoredActors = externals.current;
    const targetExternalActors = [
      ...externalTrafficActors(
        active.collisionPhysics.composeAuthoredSources(targetAuthoredActors),
        occupancyRoads,
      ),
      ...active.collisionPhysics.externalActors(),
    ];
    const requests = buildSumoCatchUpRequests(
      active.generation,
      active.sequence,
      capture && !active.captureInvalidated
        ? capturableSumoDelta(options.time, capture)
        : Math.max(0.001, delta),
      active.lastExternalActors,
      targetExternalActors,
      capture && !active.captureInvalidated ? capture.options.fixedStepSeconds : undefined,
    );
    if (requests.length === 0) return;
    active.sequence += requests.length;
    active.lastExternalActors = targetExternalActors;
    active.timelineAdvanced = true;
    const generation = active.generation;
    active.stepping = active.stepping
      .then(async () => {
        let result: TrafficStepResult | null = null;
        const stepSamples: SumoStepTimingSample[] = [];
        for (const request of requests) {
          result = await active.provider.step(request);
          stepSamples.push({
            stepMilliseconds: result.stepMilliseconds,
            requestedStepMilliseconds: request.deltaSeconds * 1_000,
          });
          if (!isCurrentSumoGeneration(generation, active.generation, result.generation)) return;
          if (capture && !active.captureInvalidated && !capture.complete) {
            const frameSignals = active.signalTopology
              ? decodeSumoSignalSnapshot(result.signalStates, result.signalLinkCount, active.signalTopology).heads
              : {};
            capture.recordSumoFrame(capture.nextTime, result, frameSignals);
            finalizeMaterializedTrafficCapture(
              active,
              capture,
              onMaterializedTrafficComplete.current,
            );
          }
        }
        if (!result) return;
        if (
          active.disposed ||
          run.current !== active ||
          !isCurrentSumoGeneration(
            generation,
            active.generation,
            result.generation,
          )
        )
          return;
        active.stepSamples.push(...stepSamples);
        active.performanceSamplesObserved += stepSamples.length;
        while (active.stepSamples.length > 120) active.stepSamples.shift();
        const stepWindow = evaluateSumoStepWindow(active.stepSamples);
        if (
          active.stepSamples.length >= SUMO_PERFORMANCE_WINDOW_SAMPLES &&
          active.performanceSamplesObserved -
            active.samplesAtLastPerformanceEvaluation >=
            SUMO_PERFORMANCE_EVALUATION_INTERVAL
        ) {
          active.samplesAtLastPerformanceEvaluation =
            active.performanceSamplesObserved;
          if (stepWindow.useSumo) active.failedPerformanceWindows = 0;
          else active.failedPerformanceWindows += 1;
        }
        if (
          active.failedPerformanceWindows >=
          SUMO_FAILED_PERFORMANCE_WINDOWS_BEFORE_FALLBACK
        )
          throw new Error(
            sumoPerformanceFallbackReason(
              stepWindow.stepP95Milliseconds,
            ),
          );
        const signals = active.signalTopology
          ? decodeSumoSignalSnapshot(
              result.signalStates,
              result.signalLinkCount,
              active.signalTopology,
            )
          : {
              heads: {},
              mappedHeadCount: 0,
              unmappedLinkCount: result.signalLinkCount,
            };
        active.lastResult = result;
        active.lastSignalHeads = signals.heads;
        const sumoViews = decodeSumoActorViews(
          result,
          options.sampleHeight!,
        );
        const collisionCountBefore = active.collisionPhysics.actorCount;
        active.collisionPhysics.step(
          requests.reduce((total, request) => total + request.deltaSeconds, 0),
          targetAuthoredActors,
          sumoViews,
        );
        options.collisionActorOverrides?.replace(
          active.collisionPhysics.authoredViews(options.sampleHeight!),
        );
        const collisionViews = active.collisionPhysics.composeViews(
          sumoViews,
          options.sampleHeight!,
        );
        if (active.collisionPhysics.actorCount > collisionCountBefore) {
          // Contact ownership changes at one exact frame. Do not interpolate
          // the struck car from its now-stale SUMO pose into the physics pose.
          active.motionSmoother.snap(collisionViews);
        } else {
          active.motionSmoother.transition(collisionViews);
        }
        const metrics = trafficMetrics(result, options.focus, active);
        const statusNow = performance.now();
        if (statusNow - active.lastStatusPublishedAt >= 250) {
          active.lastStatusPublishedAt = statusNow;
          setStatus((current) => ({
            ...current,
            phase: "running",
            actorCount: result.actorCount,
            simulatedActorCount: result.simulatedActorCount,
            stepP95Milliseconds: stepWindow.stepP95Milliseconds,
            ...metrics,
            signalStates: signals.heads,
            mappedSignalHeads: signals.mappedHeadCount,
            unmappedSignalLinks: signals.unmappedLinkCount,
            adjustedSignalControllers: active.adjustedSignalControllers,
          }));
        }
      })
      .catch((reason: unknown) => {
        if (
          active.disposed ||
          run.current !== active ||
          active.generation !== generation
        )
          return;
        const message =
          reason instanceof Error ? reason.message : String(reason);
        options.renderer?.clearLayer("sumo-traffic");
        setStatus({ phase: "fallback", actorCount: 0, reason: message });
        onFallback.current(message);
      });
  }, [
    options.focus,
    options.mode,
    options.renderer,
    options.sampleHeight,
    options.time,
    options.materializedTrafficCapture,
  ]);

  function resetSumoRun(active: SumoTrafficRun, reset: SumoResetRequest): void {
    if (active.disposed || !active.signalTopology || !active.warmupSeconds)
      return;
    if (active.resetting || active.reconfiguring) {
      // A Stop can arrive while a rewind reset is already in flight. Retain the
      // latest authoring baseline and run it next without ever publishing the
      // superseded reset result.
      active.pendingReset = reset;
      return;
    }
    const generation = active.generation + 1;
    active.generation = generation;
    active.captureInvalidated = true;
    active.collisionPhysics.clear();
    options.collisionActorOverrides?.clear();
    const baselineRequests = buildSumoBaselineRequests(
      generation,
      0,
      sumoBaselineAdvanceSeconds(active.warmupSeconds, reset.targetTime),
      reset.externalActors,
    );
    active.sequence = baselineRequests.length;
    active.lastRequestedTime = reset.targetTime;
    active.lastExternalActors = reset.externalActors;
    resetSumoPerformanceWindow(active);
    active.seenActorIds.clear();
    active.completedActorIds.clear();
    active.timelineAdvanced = false;
    active.resetting = true;
    reset.setStatus({
      phase: "loading",
      actorCount: 0,
      reason: "resetting traffic",
      ...active.statusBase,
    });
    active.stepping = active.stepping
      .then(async () => {
        const [resetRequest, ...catchUpRequests] = baselineRequests;
        if (!resetRequest)
          throw new Error("SUMO reset interval must be positive");
        let result = await active.provider.reset(resetRequest);
        for (const request of catchUpRequests)
          result = await active.provider.step(request);
        if (
          active.disposed ||
          run.current !== active ||
          !isCurrentSumoGeneration(
            generation,
            active.generation,
            result.generation,
          )
        )
          return;
        const pendingReset = active.pendingReset;
        if (pendingReset) {
          active.pendingReset = undefined;
          active.resetting = false;
          resetSumoRun(active, pendingReset);
          return;
        }
        active.resetting = false;
        const signals = decodeSumoSignalSnapshot(
          result.signalStates,
          result.signalLinkCount,
          active.signalTopology!,
        );
        active.lastResult = result;
        active.lastSignalHeads = signals.heads;
        active.motionSmoother.snap(
          decodeSumoActorViews(result, reset.sampleHeight!),
        );
        reset.setStatus({
          phase: reset.phaseAfterReset,
          actorCount: result.actorCount,
          stepP95Milliseconds: result.stepMilliseconds,
          ...active.statusBase,
          ...trafficMetrics(result, reset.focus, active),
          simulatedActorCount: result.simulatedActorCount,
          signalStates: signals.heads,
          mappedSignalHeads: signals.mappedHeadCount,
          unmappedSignalLinks: signals.unmappedLinkCount,
        });
        if (sumoSignalSettingsOutOfSync(active)) {
          reconfigureSignalCycles(
            active,
            active.requestedAcceleratedSignalCycles,
            active.requestedAllSignalsGreen,
          );
        }
      })
      .catch((reason: unknown) => {
        if (
          active.disposed ||
          run.current !== active ||
          active.generation !== generation
        )
          return;
        active.resetting = false;
        const message =
          reason instanceof Error ? reason.message : String(reason);
        reset.renderer?.clearLayer("sumo-traffic");
        reset.setStatus({ phase: "fallback", actorCount: 0, reason: message });
        reset.onFallback(message);
      });
  }

  function reconfigureSignalCycles(
    active: SumoTrafficRun,
    accelerated: boolean,
    allSignalsGreen: boolean,
  ): void {
    if (
      active.disposed ||
      active.reconfiguring ||
      active.resetting ||
      !active.payload ||
      !active.rawNetworkXml ||
      !active.signalTopology ||
      !active.occupancyRoads ||
      !active.warmupSeconds
    )
      return;
    active.reconfiguring = true;
    const generation = active.generation + 1;
    active.generation = generation;
    active.captureInvalidated = true;
    active.collisionPhysics.clear();
    options.collisionActorOverrides?.clear();
    active.lastRequestedTime = options.time;
    active.lastExternalActors = externalTrafficActors(
      externals.current,
      active.occupancyRoads,
    );
    const baselineRequests = buildSumoBaselineRequests(
      generation,
      0,
      sumoBaselineAdvanceSeconds(active.warmupSeconds, options.time),
      active.lastExternalActors,
    );
    active.sequence = baselineRequests.length;
    resetSumoPerformanceWindow(active);
    active.seenActorIds.clear();
    active.completedActorIds.clear();
    active.timelineAdvanced = false;
    const synchronized = signalNetworkForScenario(
      active.rawNetworkXml,
      accelerated,
      20,
      allSignalsGreen,
    );
    const payload = {
      ...active.payload,
      network: new TextEncoder().encode(synchronized.xml).buffer,
      wasmBinary: undefined,
    };
    setStatus({
      phase: "loading",
      actorCount: 0,
      reason: "resetting signal cycles",
      ...active.statusBase,
      signalStates: {},
      adjustedSignalControllers: synchronized.adjustedControllers,
    });
    active.stepping = active.stepping
      .then(async () => {
        const [reconfigureRequest, ...catchUpRequests] = baselineRequests;
        if (!reconfigureRequest)
          throw new Error("SUMO reconfiguration interval must be positive");
        let result = await active.provider.reconfigure(
          payload,
          reconfigureRequest,
        );
        for (const request of catchUpRequests)
          result = await active.provider.step(request);
        if (
          active.disposed ||
          run.current !== active ||
          !isCurrentSumoGeneration(
            generation,
            active.generation,
            result.generation,
          )
        )
          return;
        active.payload = payload;
        active.appliedAcceleratedSignalCycles = accelerated;
        active.appliedAllSignalsGreen = allSignalsGreen;
        active.adjustedSignalControllers = synchronized.adjustedControllers;
        active.statusBase = {
          ...active.statusBase!,
          adjustedSignalControllers: synchronized.adjustedControllers,
        };
        active.reconfiguring = false;
        const signals = decodeSumoSignalSnapshot(
          result.signalStates,
          result.signalLinkCount,
          active.signalTopology!,
        );
        active.lastResult = result;
        active.lastSignalHeads = signals.heads;
        active.motionSmoother.snap(
          decodeSumoActorViews(result, options.sampleHeight!),
        );
        setStatus({
          phase: options.mode === "playing" ? "running" : "ready",
          actorCount: result.actorCount,
          stepP95Milliseconds: result.stepMilliseconds,
          ...active.statusBase,
          ...trafficMetrics(result, options.focus, active),
          simulatedActorCount: result.simulatedActorCount,
          signalStates: signals.heads,
          mappedSignalHeads: signals.mappedHeadCount,
          unmappedSignalLinks: signals.unmappedLinkCount,
        });
        const pendingReset = active.pendingReset;
        if (pendingReset) {
          active.pendingReset = undefined;
          resetSumoRun(active, pendingReset);
          return;
        }
        if (sumoSignalSettingsOutOfSync(active)) {
          reconfigureSignalCycles(
            active,
            active.requestedAcceleratedSignalCycles,
            active.requestedAllSignalsGreen,
          );
        }
      })
      .catch((reason: unknown) => {
        if (
          active.disposed ||
          run.current !== active ||
          active.generation !== generation
        )
          return;
        active.reconfiguring = false;
        const message =
          reason instanceof Error ? reason.message : String(reason);
        options.renderer?.clearLayer("sumo-traffic");
        setStatus({ phase: "fallback", actorCount: 0, reason: message });
        onFallback.current(message);
      });
  }

  return status;
}

export function classifySumoTimelineStep(
  deltaSeconds: number,
): "wait" | "step" | "reset" {
  if (deltaSeconds < -0.001 || deltaSeconds > 5) return "reset";
  return deltaSeconds >= 0.04 ? "step" : "wait";
}

export function sumoBaselineAdvanceSeconds(
  warmupSeconds: number,
  timelineSeconds: number,
): number {
  return warmupSeconds + Math.max(0, timelineSeconds);
}

// The browser SUMO bridge rejects any individual interval above five seconds.
// Warmup and editor-time reconstruction can be much longer, so every baseline
// operation must cross the provider boundary in bounded requests.
export const SUMO_MAX_STEP_INTERVAL_SECONDS = 5;

export function buildSumoBaselineRequests(
  generation: number,
  firstSequence: number,
  totalSeconds: number,
  externalActors: readonly ExternalTrafficActor[],
): readonly TrafficStepRequest[] {
  if (!(totalSeconds > 0) || !Number.isFinite(totalSeconds)) return [];
  const count = Math.ceil(totalSeconds / SUMO_MAX_STEP_INTERVAL_SECONDS);
  const deltaSeconds = totalSeconds / count;
  return Array.from({ length: count }, (_, index) => ({
    generation,
    sequence: firstSequence + index,
    deltaSeconds,
    externalActors,
  }));
}

export function sumoSignalSettingsOutOfSync(
  settings: Pick<
    SumoTrafficRun,
    | "requestedAcceleratedSignalCycles"
    | "appliedAcceleratedSignalCycles"
    | "requestedAllSignalsGreen"
    | "appliedAllSignalsGreen"
  >,
): boolean {
  return (
    settings.requestedAcceleratedSignalCycles !==
      settings.appliedAcceleratedSignalCycles ||
    settings.requestedAllSignalsGreen !== settings.appliedAllSignalsGreen
  );
}

export function shouldResetSumoForModeTransition(
  previousMode: StudioSessionMode,
  mode: StudioSessionMode,
  timelineAdvanced: boolean,
): boolean {
  return (
    mode === "authoring" && previousMode !== "authoring" && timelineAdvanced
  );
}

export function isCurrentSumoGeneration(
  expected: number,
  active: number,
  result: number,
): boolean {
  return expected === active && result === active;
}

interface SumoTrafficRun {
  readonly provider: SumoWasmTrafficProvider;
  generation: number;
  sequence: number;
  lastRequestedTime: number;
  stepping: Promise<void>;
  readonly stepSamples: SumoStepTimingSample[];
  failedPerformanceWindows: number;
  performanceSamplesObserved: number;
  samplesAtLastPerformanceEvaluation: number;
  readonly seenActorIds: Set<number>;
  readonly completedActorIds: Set<number>;
  signalTopology?: SumoSignalTopology;
  adjustedSignalControllers?: number;
  occupancyRoads: SumoRoadOccupancyIndex | null;
  lastExternalActors: readonly ExternalTrafficActor[];
  warmupSeconds?: number;
  statusBase?: Pick<
    SumoTrafficStatus,
    | "initMilliseconds"
    | "heapBytes"
    | "wasmBytes"
    | "requestedActorCount"
    | "nearbyRouteStarts"
    | "detailedSafetyMetricsAvailable"
    | "adjustedSignalControllers"
  >;
  timelineAdvanced: boolean;
  resetting: boolean;
  pendingReset?: SumoResetRequest;
  disposed: boolean;
  payload?: TrafficNetworkPayload;
  rawNetworkXml?: string;
  requestedAcceleratedSignalCycles: boolean;
  appliedAcceleratedSignalCycles: boolean;
  requestedAllSignalsGreen: boolean;
  appliedAllSignalsGreen: boolean;
  reconfiguring: boolean;
  captureFinalized: boolean;
  captureInvalidated: boolean;
  capture?: BrowserMaterializedTrafficCapture;
  lastResult?: TrafficStepResult;
  lastSignalHeads?: Readonly<Record<string, "green" | "yellow" | "red" | "off">>;
  lastStatusPublishedAt: number;
  readonly motionSmoother: SumoMotionSmoother;
  readonly collisionPhysics: SumoCollisionPhysics;
}

function capturableSumoDelta(editorTime: number, capture: BrowserMaterializedTrafficCapture): number {
  const step = capture.options.fixedStepSeconds;
  const completedTime = Math.max(0, capture.nextTime - step);
  const targetTime = Math.min(editorTime, capture.options.durationSeconds);
  const intervals = Math.max(0, Math.floor((targetTime - completedTime + 1e-9) / step));
  return intervals * step;
}

function finalizeMaterializedTrafficCapture(
  run: SumoTrafficRun,
  capture: BrowserMaterializedTrafficCapture,
  onComplete: ((artifact: MaterializedTrafficArtifactEnvelope) => void) | undefined,
): void {
  if (!capture.complete || run.captureFinalized || run.captureInvalidated) return;
  run.captureFinalized = true;
  onComplete?.(capture.finalize());
}

interface SumoResetRequest {
  readonly targetTime: number;
  readonly externalActors: readonly ExternalTrafficActor[];
  readonly focus: SumoDemandFocus | null;
  readonly renderer: ActorRenderer | null | undefined;
  readonly sampleHeight: ((x: number, z: number) => number | null) | null;
  readonly phaseAfterReset: "ready" | "running";
  readonly setStatus: (status: SumoTrafficStatus) => void;
  readonly onFallback: (reason: string) => void;
}

export function trafficMetrics(
  result: { readonly states: ArrayBuffer; readonly actorCount: number },
  focus: SumoDemandFocus | null,
  run: Pick<SumoTrafficRun, "seenActorIds" | "completedActorIds">,
): Pick<
  SumoTrafficStatus,
  | "nearbyActorCount"
  | "queuedActorCount"
  | "completedActorCount"
  | "emergencyStoppingActorCount"
> {
  const view = new DataView(result.states);
  const current = new Set<number>();
  let nearbyActorCount = 0;
  let queuedActorCount = 0;
  let emergencyStoppingActorCount = 0;
  for (let index = 0; index < result.actorCount; index += 1) {
    const offset = index * 32;
    const id = view.getUint32(offset, true);
    const x = view.getFloat32(offset + 4, true);
    const z = view.getFloat32(offset + 8, true);
    const speed = view.getFloat32(offset + 16, true);
    const acceleration = view.getFloat32(offset + 20, true);
    current.add(id);
    run.seenActorIds.add(id);
    if (focus && Math.hypot(x - focus.x, z - focus.z) <= 300)
      nearbyActorCount += 1;
    if (speed < 0.5) queuedActorCount += 1;
    if (acceleration <= -7) emergencyStoppingActorCount += 1;
  }
  for (const id of run.seenActorIds)
    if (!current.has(id)) run.completedActorIds.add(id);
  return {
    nearbyActorCount,
    queuedActorCount,
    completedActorCount: run.completedActorIds.size,
    emergencyStoppingActorCount,
  };
}

export function externalTrafficActors(
  actors: readonly SumoExternalActorView[],
  roads: SumoRoadOccupancyIndex,
): readonly ExternalTrafficActor[] {
  return buildSumoAuthoredOccupancies(actors, roads).map((actor) => ({
    id: `external:${actor.id}`,
    kind: actor.kind,
    routeId: "proxy-route",
    x: actor.x,
    z: actor.z,
    headingDegrees: 90 + (actor.headingRad * 180) / Math.PI,
    speedMetersPerSecond: actor.speedMps,
    lengthMeters: actor.lengthM,
    widthMeters: actor.widthM,
  }));
}

const SUMO_PROXY_SUBSTEP_SECONDS = 0.05;

/**
 * A delayed render may advance the editor by several SUMO ticks at once.
 * Preserve the full elapsed duration and interpolate external poses at every
 * 50 ms traffic step so moveToXY never observes the whole displacement in the
 * first substep. Actor births/removals occur only on the final boundary.
 */
export function buildSumoCatchUpRequests(
  generation: number,
  firstSequence: number,
  deltaSeconds: number,
  previous: readonly ExternalTrafficActor[],
  current: readonly ExternalTrafficActor[],
  maximumStepSeconds = SUMO_PROXY_SUBSTEP_SECONDS,
): readonly TrafficStepRequest[] {
  if (!(deltaSeconds > 0)) return [];
  const count = Math.max(
    1,
    Math.ceil(deltaSeconds / maximumStepSeconds),
  );
  const stepSeconds = deltaSeconds / count;
  const previousById = new Map(
    previous.map((actor) => [actor.id, actor] as const),
  );
  const currentById = new Map(
    current.map((actor) => [actor.id, actor] as const),
  );
  return Array.from({ length: count }, (_, index) => {
    const alpha = (index + 1) / count;
    const final = index === count - 1;
    const externalActors: ExternalTrafficActor[] = [];
    for (const before of previous) {
      const after = currentById.get(before.id);
      if (!after) {
        if (!final) externalActors.push(before);
        continue;
      }
      externalActors.push(interpolateExternalActor(before, after, alpha));
    }
    if (final) {
      for (const after of current)
        if (!previousById.has(after.id)) externalActors.push(after);
    }
    return {
      generation,
      sequence: firstSequence + index,
      deltaSeconds: stepSeconds,
      externalActors,
    };
  });
}

function interpolateExternalActor(
  before: ExternalTrafficActor,
  after: ExternalTrafficActor,
  alpha: number,
): ExternalTrafficActor {
  let headingDelta = (after.headingDegrees - before.headingDegrees) % 360;
  if (headingDelta > 180) headingDelta -= 360;
  if (headingDelta < -180) headingDelta += 360;
  return {
    ...after,
    x: before.x + (after.x - before.x) * alpha,
    z: before.z + (after.z - before.z) * alpha,
    headingDegrees: before.headingDegrees + headingDelta * alpha,
    speedMetersPerSecond:
      before.speedMetersPerSecond +
      (after.speedMetersPerSecond - before.speedMetersPerSecond) * alpha,
    lengthMeters:
      before.lengthMeters + (after.lengthMeters - before.lengthMeters) * alpha,
    widthMeters:
      before.widthMeters + (after.widthMeters - before.widthMeters) * alpha,
  };
}

const SUMO_PERFORMANCE_WINDOW_SAMPLES = 40;
const SUMO_PERFORMANCE_EVALUATION_INTERVAL = 20;
const SUMO_FAILED_PERFORMANCE_WINDOWS_BEFORE_FALLBACK = 3;

function resetSumoPerformanceWindow(active: SumoTrafficRun): void {
  active.stepSamples.length = 0;
  active.failedPerformanceWindows = 0;
  active.performanceSamplesObserved = 0;
  active.samplesAtLastPerformanceEvaluation = 0;
}
