"use client";

import { useEffect, useMemo, useState } from "react";
import type { CityViewer } from "@simforge-oss/viewer";
import type { ActorRenderer, ActorView } from "@simforge-oss/viewer";
import type { CatalogId } from "@simforge-oss/asset-catalog";

import {
  carlaCompatibilityFor,
  loadCarlaCompatibility,
  type CarlaCompatibilityTable,
} from "@/app/lib/scenario/carla-compatibility";
import type { SumoExternalActorView } from "@/app/lib/scenario/ambient/useSumoTraffic";
import { planParkedCars, type ParkedCarPlan, type ParkingExclusion } from "./fill";
import type { ParkedCar } from "@/app/lib/studio-shared/parked-cars";
import type { ParkedCarsSettings } from "./extension";
import type { ParkingStall, ParkingStallArtifact } from "./stalls";

/** The render layer parked cars own. Never the editor or playback layer. */
export const PARKED_CARS_LAYER = "parked-cars";

const EMPTY_PLAN: ParkedCarPlan = {
  cars: [],
  eligibleStallCount: 0,
  excludedStallCount: 0,
  unfittableStallCount: 0,
  requestedCarCount: 0,
};

export type ParkingStallsStatus = "idle" | "loading" | "ready" | "unavailable";

export interface ParkingStallsState {
  readonly stalls: readonly ParkingStall[];
  readonly status: ParkingStallsStatus;
  /** Why the map has no stalls, when it has none. Shown in the panel. */
  readonly reason: string | null;
}

const stallCache = new Map<string, Promise<ParkingStallArtifact>>();

/**
 * Stalls for one map asset, fetched once per asset per session.
 *
 * A published map version's road network is immutable, so the derived stall set
 * is cached in-module rather than refetched per editor mount.
 */
export function useParkingStalls(mapAssetId: string | null): ParkingStallsState {
  const [state, setState] = useState<ParkingStallsState>({
    stalls: [],
    status: "idle",
    reason: null,
  });

  useEffect(() => {
    if (!mapAssetId) {
      setState({ stalls: [], status: "idle", reason: null });
      return;
    }
    let cancelled = false;
    setState({ stalls: [], status: "loading", reason: null });

    let request = stallCache.get(mapAssetId);
    if (!request) {
      request = fetch(`/api/map-assets/${encodeURIComponent(mapAssetId)}/parking-stalls`)
        .then(async (response) => {
          if (!response.ok) {
            const detail = (await response.json().catch(() => null)) as { error?: string } | null;
            throw new Error(detail?.error ?? `Parking stalls unavailable (${response.status})`);
          }
          return (await response.json()) as ParkingStallArtifact;
        });
      stallCache.set(mapAssetId, request);
    }

    request
      .then((artifact) => {
        if (cancelled) return;
        setState({
          stalls: artifact.stalls,
          status: "ready",
          reason: artifact.stalls.length === 0 ? "This map has no parking stalls." : null,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // A failed fetch must not be cached: the next mount should retry.
        stallCache.delete(mapAssetId);
        setState({
          stalls: [],
          status: "unavailable",
          reason: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [mapAssetId]);

  return state;
}

/** The CARLA compatibility table, loaded only when the model policy needs it. */
function useCarlaTable(needed: boolean): CarlaCompatibilityTable | null {
  const [table, setTable] = useState<CarlaCompatibilityTable | null>(null);
  useEffect(() => {
    if (!needed || table) return;
    let cancelled = false;
    void loadCarlaCompatibility()
      .then((loaded) => {
        if (!cancelled) setTable(loaded);
      })
      .catch(() => {
        // Leaving the table null keeps every parkable model in the pool, which
        // is a visible scene rather than an empty one.
      });
    return () => {
      cancelled = true;
    };
  }, [needed, table]);
  return table;
}

export interface UseParkedCarsOptions {
  readonly mapAssetId: string | null;
  readonly settings: ParkedCarsSettings;
  readonly exclusions?: readonly ParkingExclusion[];
}

export interface ParkedCarsState extends ParkingStallsState {
  readonly plan: ParkedCarPlan;
  /**
   * What is actually in the scene.
   *
   * Baked cars win: they are the document's, they are already simulated actors,
   * and re-deriving them from the live generator would let the drawn scene
   * disagree with the one that compiles.
   */
  readonly cars: readonly ParkedCar[];
  readonly isBaked: boolean;
}

/** Stalls plus the deterministic plan for the current settings. */
export function useParkedCars(options: UseParkedCarsOptions): ParkedCarsState {
  const stalls = useParkingStalls(options.settings.enabled ? options.mapAssetId : null);
  const needsCarlaTable = options.settings.enabled && options.settings.models === "carla_ready";
  const carlaTable = useCarlaTable(needsCarlaTable);

  const allowModel = useMemo(() => {
    if (!needsCarlaTable || !carlaTable) return undefined;
    const table = carlaTable;
    return (catalogId: CatalogId) =>
      carlaCompatibilityFor(catalogId, table).status === "native";
  }, [carlaTable, needsCarlaTable]);

  const plan = useMemo(() => {
    if (!options.settings.enabled || stalls.stalls.length === 0) return EMPTY_PLAN;
    return planParkedCars({
      stalls: stalls.stalls,
      occupancy: options.settings.occupancy,
      seed: options.settings.seed,
      facing: options.settings.facing,
      exclusions: options.exclusions,
      allowModel,
    });
  }, [
    allowModel,
    options.exclusions,
    options.settings.enabled,
    options.settings.facing,
    options.settings.occupancy,
    options.settings.seed,
    stalls.stalls,
  ]);

  const baked = options.settings.baked;
  return { ...stalls, plan, cars: baked.length > 0 ? baked : plan.cars, isBaked: baked.length > 0 };
}

/**
 * Ground-contact views for the parked-car layer.
 *
 * Takes a car list rather than a plan so baked cars — which are the document's,
 * not the generator's — draw through exactly the same path.
 */
export function parkedCarViews(
  cars: readonly ParkedCar[],
  sampleHeight: ((x: number, z: number) => number | null) | null,
): readonly ActorView[] {
  return cars.map((car) => ({
    id: car.id,
    // Every car came from PARKABLE_MODELS, whose ids are catalog ids; the shared
    // type widens it to string only to keep `@simforge-oss/studio-shared` free of
    // `@simforge-oss/*`.
    catalogId: car.catalogId as CatalogId,
    x: car.x,
    // The sampled scene surface wins over the stall polygon's own elevation:
    // the polygon and the rendered mesh do not share a datum on every map, and
    // a car floating above the tarmac is immediately visible.
    y: sampleHeight?.(car.x, car.z) ?? car.y,
    z: car.z,
    headingRad: car.headingRad,
    dims: { l: car.lengthM, w: car.widthM, h: car.heightM },
    kind: "car" as const,
  }));
}

/**
 * Parked cars as stationary occupancy for SUMO.
 *
 * `buildSumoAuthoredOccupancies` keeps only shapes whose footprint touches a
 * driveable lane, so a curb stall blocks ambient traffic while an off-street lot
 * car is correctly ignored — this function does not need to make that judgement,
 * only to report the footprint honestly.
 */
export function parkedCarOccupancySources(
  cars: readonly ParkedCar[],
): readonly SumoExternalActorView[] {
  return cars.map((car) => ({
    id: car.id,
    kind: "car" as const,
    x: car.x,
    z: car.z,
    headingRad: car.headingRad,
    // A parked car never moves, and it is always there.
    speedMps: 0,
    lengthM: car.lengthM,
    widthM: car.widthM,
    static: true,
    present: true,
  }));
}

/**
 * Draw the parked population in its own renderer layer.
 *
 * Mirrors `useAmbientTrafficPreview`: parked cars are not editable, not
 * selectable as roles, and must never enter the `editor` layer that
 * `EditorController` owns.
 */
export function useParkedCarLayer(
  viewer: CityViewer | null,
  renderer: ActorRenderer | null | undefined,
  cars: readonly ParkedCar[],
  sampleHeight: ((x: number, z: number) => number | null) | null,
  visible: boolean,
): void {
  useEffect(() => {
    if (!viewer || !renderer) return;
    if (!visible || cars.length === 0) {
      renderer.clearLayer(PARKED_CARS_LAYER);
      return;
    }
    renderer.syncLayer(PARKED_CARS_LAYER, parkedCarViews(cars, sampleHeight));
    return () => {
      renderer.clearLayer(PARKED_CARS_LAYER);
    };
  }, [cars, renderer, sampleHeight, viewer, visible]);
}
