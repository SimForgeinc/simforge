/**
 * OS-clipboard actor payloads for the scenario editor.
 *
 * Copy serialises actors and their routes relative to the group centroid into a
 * namespaced JSON envelope. Paste enters free-form group placement so every
 * actor follows the cursor as one ghost group while preserving its layout.
 */

import {
  interactionDraftId,
  isRoadBoundMotorVehicle,
  type ActorRecord,
  type EditorController,
  type EditorDocument,
  type GroupPlacementActor,
  type GroupPlacementPose,
  type NewActor,
} from "@simforge-oss/editor";
import type { CatalogId } from "@simforge-oss/asset-catalog";
import type { Interaction } from "@simforge-oss/scenario";

export const SIMFORGE_CLIPBOARD_SCHEMA = "simcloud.simforge-oss-actors/v1";
// historical name retained for stored-data compat
const HISTORICAL_CLIPBOARD_SCHEMA = "simcloud.uniscenario-actors/v1";

export interface ClipboardRoutePoint {
  readonly timeS?: number;
  readonly dx: number;
  readonly dz: number;
}

export interface ClipboardRouteClip {
  readonly mode: "customRoute" | "customTimedRoute";
  readonly label?: string;
  readonly points: readonly ClipboardRoutePoint[];
}

export interface ClipboardActor {
  readonly catalogId: string;
  readonly dx: number;
  readonly dz: number;
  readonly y: number;
  readonly headingRad: number;
  readonly lateralT?: number;
  readonly label?: string;
  readonly bodyColor?: string;
  readonly initialSpeedKph?: number;
  readonly driverProfile?: ActorRecord["driverProfile"];
  readonly static?: boolean;
  readonly routes: readonly ClipboardRouteClip[];
}

export interface SimForgeClipboardPayload {
  readonly schema: typeof SIMFORGE_CLIPBOARD_SCHEMA;
  readonly sourceMapId: string;
  readonly sourceDocumentId: string | null;
  readonly anchor: { readonly x: number; readonly z: number };
  readonly actors: readonly ClipboardActor[];
}

export function selectionCentroid(actors: readonly { x: number; z: number }[]): { x: number; z: number } {
  let x = 0;
  let z = 0;
  for (const actor of actors) {
    x += actor.x;
    z += actor.z;
  }
  const count = Math.max(1, actors.length);
  return { x: x / count, z: z / count };
}

export function buildClipboardPayload(options: {
  actors: readonly ActorRecord[];
  interactions: readonly Interaction[];
  sourceMapId: string;
  sourceDocumentId?: string | null;
}): SimForgeClipboardPayload | null {
  if (options.actors.length === 0) return null;
  const anchor = selectionCentroid(options.actors);
  return {
    schema: SIMFORGE_CLIPBOARD_SCHEMA,
    sourceMapId: options.sourceMapId,
    sourceDocumentId: options.sourceDocumentId ?? null,
    anchor: { x: round3(anchor.x), z: round3(anchor.z) },
    actors: options.actors.map((actor) => ({
      catalogId: actor.catalogId,
      dx: round3(actor.x - anchor.x),
      dz: round3(actor.z - anchor.z),
      y: round3(actor.y),
      headingRad: actor.headingRad,
      ...(actor.laneRef ? { lateralT: actor.laneRef.t } : {}),
      ...(actor.label === undefined ? {} : { label: actor.label }),
      ...(actor.bodyColor === undefined ? {} : { bodyColor: actor.bodyColor }),
      ...(actor.initialSpeedKph === undefined ? {} : { initialSpeedKph: actor.initialSpeedKph }),
      ...(actor.driverProfile === undefined ? {} : { driverProfile: actor.driverProfile }),
      ...(actor.static === undefined ? {} : { static: actor.static }),
      routes: options.interactions.flatMap((interaction): ClipboardRouteClip[] => {
        if (interaction.actor !== actor.id || interaction.verb !== "route") return [];
        const target = interaction.target;
        if (target.mode !== "customRoute" && target.mode !== "customTimedRoute") return [];
        return [{
          mode: target.mode,
          ...(interaction.label === undefined ? {} : { label: interaction.label }),
          points: target.points.map((point) => ({
            ...("timeS" in point && typeof point.timeS === "number" ? { timeS: point.timeS } : {}),
            dx: round3(point.x - anchor.x),
            dz: round3(point.z - anchor.z),
          })),
        }];
      }),
    })),
  };
}

export function parseClipboardPayload(text: string): SimForgeClipboardPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !isRecord(raw)
    || (raw.schema !== SIMFORGE_CLIPBOARD_SCHEMA && raw.schema !== HISTORICAL_CLIPBOARD_SCHEMA)
  ) return null;
  if (typeof raw.sourceMapId !== "string" || !isRecord(raw.anchor) || !Array.isArray(raw.actors)) return null;
  if (typeof raw.anchor.x !== "number" || typeof raw.anchor.z !== "number") return null;
  for (const actor of raw.actors) {
    if (!isRecord(actor)) return null;
    if (typeof actor.catalogId !== "string") return null;
    if (typeof actor.dx !== "number" || typeof actor.dz !== "number") return null;
    if (typeof actor.headingRad !== "number" || typeof actor.y !== "number") return null;
    if (!Array.isArray(actor.routes)) return null;
    for (const route of actor.routes) {
      if (!isRecord(route)) return null;
      if (route.mode !== "customRoute" && route.mode !== "customTimedRoute") return null;
      if (!Array.isArray(route.points)) return null;
      for (const point of route.points) {
        if (!isRecord(point) || typeof point.dx !== "number" || typeof point.dz !== "number") return null;
      }
    }
  }
  return { ...raw, schema: SIMFORGE_CLIPBOARD_SCHEMA } as unknown as SimForgeClipboardPayload;
}

export interface PastePlanActor {
  readonly source: ClipboardActor;
  readonly x: number;
  readonly z: number;
}

export function planPaste(
  payload: SimForgeClipboardPayload,
  target: { x: number; z: number },
): PastePlanActor[] {
  return payload.actors.map((source) => ({
    source,
    x: round3(target.x + source.dx),
    z: round3(target.z + source.dz),
  }));
}

export function pastedRoutePoints(
  route: ClipboardRouteClip,
  source: ClipboardActor,
  resolved: { x: number; z: number },
): Array<{ timeS?: number; x: number; z: number }> {
  const dx = resolved.x - source.dx;
  const dz = resolved.z - source.dz;
  return route.points.map((point, index) => {
    const timed = typeof point.timeS === "number" ? { timeS: point.timeS } : {};
    if (route.mode === "customTimedRoute" && index === 0) {
      return { ...timed, x: round3(resolved.x), z: round3(resolved.z) };
    }
    return { ...timed, x: round3(point.dx + dx), z: round3(point.dz + dz) };
  });
}

export interface ExecutedPaste {
  readonly ids: readonly string[];
  readonly unanchored: number;
}

export function pastePlacementActors(payload: SimForgeClipboardPayload): GroupPlacementActor[] {
  return payload.actors.map((actor) => ({
    catalogId: actor.catalogId as CatalogId,
    dx: actor.dx,
    dz: actor.dz,
    fallbackY: actor.y,
    headingRad: actor.headingRad,
  }));
}

export function executePaste(options: {
  controller: EditorController;
  document: EditorDocument;
  payload: SimForgeClipboardPayload;
  placements: readonly GroupPlacementPose[];
}): ExecutedPaste {
  const { controller, document, payload, placements } = options;
  if (placements.length !== payload.actors.length) {
    throw new Error("Paste placement count does not match clipboard actor count");
  }
  const clipSeconds = document.data.choreography.clipSeconds;
  const inputs: NewActor[] = [];
  const interactions: Interaction[] = [];
  const usedIds = new Set<string>();
  let unanchored = 0;
  for (let index = 0; index < payload.actors.length; index++) {
    const source = payload.actors[index]!;
    const resolved = placements[index]!;
    const catalogId = source.catalogId as CatalogId;
    let id = document.allocateActorId(catalogId);
    while (usedIds.has(id)) id = document.allocateActorId(catalogId);
    usedIds.add(id);
    if (!source.static && isRoadBoundMotorVehicle(catalogId)) unanchored++;
    inputs.push({
      id,
      catalogId,
      x: resolved.x,
      y: resolved.y,
      z: resolved.z,
      headingRad: resolved.headingRad,
      ...(source.label === undefined ? {} : { label: source.label }),
      ...(source.bodyColor === undefined ? {} : { bodyColor: source.bodyColor }),
      ...(source.initialSpeedKph === undefined ? {} : { initialSpeedKph: source.initialSpeedKph }),
      ...(source.driverProfile === undefined ? {} : { driverProfile: source.driverProfile }),
      ...(source.static === undefined ? {} : { static: source.static }),
    });
    let ordinal = 0;
    for (const route of source.routes) {
      const points = pastedRoutePoints(route, source, resolved);
      if (points.length === 0) continue;
      if (route.mode === "customTimedRoute") {
        interactions.push({
          id: interactionDraftId("route", id, ordinal++),
          actor: id,
          ...(route.label === undefined ? {} : { label: route.label }),
          verb: "route",
          trigger: { kind: "at", t: 0 },
          until: { kind: "at", t: clipSeconds },
          target: {
            mode: "customTimedRoute",
            points: points.map((point, pointIndex) => ({
              timeS: typeof point.timeS === "number" ? point.timeS : pointIndex,
              x: point.x,
              z: point.z,
            })),
          },
        } as Interaction);
        continue;
      }
      interactions.push({
        id: interactionDraftId("route", id, ordinal++),
        actor: id,
        ...(route.label === undefined ? {} : { label: route.label }),
        verb: "route",
        trigger: { kind: "at", t: 0 },
        target: { mode: "customRoute", points: points.map(({ x, z }) => ({ x, z })) },
      } as Interaction);
    }
  }
  const ids = document.addWithInteractions(inputs, interactions);
  controller.setSelection(ids);
  return { ids, unanchored };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}
