import type { ScenarioTemplateV2 } from "@simforge-oss/scenario";
import type {
  ActorRecord,
  EditorState,
  ScenarioMapEntry,
} from "@simforge-oss/editor";
import type {
  ScenarioAuthoringQuality,
  ScenarioDocumentDto,
} from "@/app/lib/scenario/contracts";
import type { PlaybackBundle } from "@simforge-oss/playback";
import type { SimulationIssue } from "./simulation-issues";

export interface EditorDebugInformationInput {
  datasetId: string | null;
  record: ScenarioDocumentDto | null;
  map: ScenarioMapEntry;
  quality: ScenarioAuthoringQuality;
  scenarioConfiguration: ScenarioTemplateV2 | null;
  selectedActor: ActorRecord | null;
  state: EditorState | null;
  simulationIssues: readonly SimulationIssue[];
  documentRevision: number | null;
  saveError: string | null;
  validation: unknown;
  preview: PlaybackBundle | null;
}

const PREVIEW_SAMPLE_INTERVAL_S = 1;
const STOPPED_SPEED_MPS = 0.05;

function round(value: number, places = 4): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function routeLengthM(route: unknown): number | null {
  if (!route || typeof route !== "object") return null;
  const points = (route as { points?: unknown }).points;
  if (!Array.isArray(points)) return null;
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1] as { x?: unknown; z?: unknown };
    const current = points[index] as { x?: unknown; z?: unknown };
    if (
      typeof previous?.x !== "number"
      || typeof previous?.z !== "number"
      || typeof current?.x !== "number"
      || typeof current?.z !== "number"
    ) continue;
    length += Math.hypot(current.x - previous.x, current.z - previous.z);
  }
  return round(length);
}

function previewEventActorIds(event: unknown): string[] {
  if (!event || typeof event !== "object") return [];
  const candidate = event as Record<string, unknown>;
  return [candidate.actorId, candidate.a, candidate.b]
    .filter((value): value is string => typeof value === "string");
}

/** Compact canonical-preview evidence suitable for a clipboard support report. */
export function buildPreviewDebugInformation(bundle: PlaybackBundle | null): unknown {
  if (!bundle) return null;
  const trace = bundle.trace;
  const times = trace.ticks.t;
  const concreteActors = new Map(bundle.instance.input.actors.map((actor) => [actor.id, actor]));
  const actors = Object.entries(trace.ticks.actors).map(([actorId, track]) => {
    const sampleIndexes: number[] = [];
    let nextSampleTime = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < times.length; index += 1) {
      const time = times[index] ?? 0;
      if (index === 0 || index === times.length - 1 || time + 1e-9 >= nextSampleTime) {
        sampleIndexes.push(index);
        nextSampleTime = Math.floor(time / PREVIEW_SAMPLE_INTERVAL_S + 1) * PREVIEW_SAMPLE_INTERVAL_S;
      }
    }

    let distanceTraveledM = 0;
    let lastMovingIndex = -1;
    for (let index = 0; index < times.length; index += 1) {
      if ((track.speedMps[index] ?? 0) > STOPPED_SPEED_MPS) lastMovingIndex = index;
      if (index === 0 || !track.present[index] || !track.present[index - 1]) continue;
      distanceTraveledM += Math.hypot(
        (track.x[index] ?? 0) - (track.x[index - 1] ?? 0),
        (track.z[index] ?? 0) - (track.z[index - 1] ?? 0),
      );
    }
    const actor = concreteActors.get(actorId);
    const route = actor?.behavior.route ?? null;
    const relevantEvents = trace.events.filter((event) => previewEventActorIds(event).includes(actorId));
    const stoppedAtS = lastMovingIndex < times.length - 1
      ? times[Math.max(0, lastMovingIndex + 1)] ?? null
      : null;

    return {
      actorId,
      kind: actor?.kind ?? trace.header.actorMetadata?.[actorId]?.kind ?? null,
      configuredInitialSpeedKph: actor ? round(actor.initial.speedMps * 3.6) : null,
      resolvedRoute: route,
      resolvedRouteLengthM: routeLengthM(route),
      distanceTraveledM: round(distanceTraveledM),
      finalDisplacementM: track.x.length > 0
        ? round(Math.hypot(
            (track.x.at(-1) ?? 0) - (track.x[0] ?? 0),
            (track.z.at(-1) ?? 0) - (track.z[0] ?? 0),
          ))
        : 0,
      stoppedAtS: stoppedAtS === null ? null : round(stoppedAtS),
      finalRouteS: round(track.s.at(-1) ?? 0),
      samples: sampleIndexes.map((index) => ({
        t: round(times[index] ?? 0),
        x: round(track.x[index] ?? 0),
        z: round(track.z[index] ?? 0),
        routeS: round(track.s[index] ?? 0),
        speedKph: round((track.speedMps[index] ?? 0) * 3.6),
        present: Boolean(track.present[index]),
      })),
      events: relevantEvents,
      crash: trace.header.physics.crashes?.[actorId] ?? null,
    };
  });

  return {
    inputHash: trace.header.inputHash,
    engineVersion: trace.header.engineVersion,
    traceVersion: trace.header.traceVersion,
    dt: trace.header.dt,
    clipSeconds: trace.header.clipSeconds,
    complete: times.at(-1) === trace.header.clipSeconds,
    sampleCount: times.length,
    mapCollisions: bundle.mapCollisions ?? null,
    actors,
  };
}

/** Build a support-safe snapshot without cookies, credentials, or signed asset URLs. */
export function buildEditorDebugInformation(input: EditorDebugInformationInput): string {
  const search = typeof window === "undefined"
    ? null
    : new URLSearchParams(window.location.search);
  const browser = typeof window === "undefined"
    ? null
    : {
        path: window.location.pathname,
        query: {
          dataset: search?.get("dataset") ?? null,
          document: search?.get("document") ?? null,
        },
        userAgent: window.navigator.userAgent,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
        },
      };

  return JSON.stringify(
    {
      format: "simforge.uniscenario.support-debug.v1",
      capturedAt: new Date().toISOString(),
      identifiers: {
        datasetId: input.datasetId ?? input.record?.datasetId ?? null,
        scenarioId: input.record?.id ?? null,
        latestRevisionId: input.record?.latestRevisionId ?? null,
        selectedActorId: input.selectedActor?.id ?? null,
        mapVersionId: input.map.versionId,
        sourceMapId: input.map.sourceMapId,
      },
      scenario: {
        title: input.record?.title ?? input.scenarioConfiguration?.meta.name ?? null,
        draftVersion: input.record?.draftVersion ?? null,
        schemaVersion: input.record?.schemaVersion ?? null,
        authoringQuality: input.quality,
        documentRevision: input.documentRevision,
        configuration: input.scenarioConfiguration,
      },
      selectedActor: input.selectedActor,
      editor: input.state
        ? {
            mode: input.state.mode,
            selection: input.state.selection,
            dirty: input.state.dirty,
            savedAt: input.state.savedAt,
            placementWarning: input.state.placementWarning,
            message: input.state.message,
            laneLabel: input.state.laneLabel,
            actorCount: input.state.actors.length,
          }
        : null,
      map: {
        label: input.map.label,
        locality: input.map.locality,
        coordinateSystemId: input.map.coordinateSystemId,
      },
      diagnostics: {
        saveError: input.saveError,
        validation: input.validation,
        simulationIssues: input.simulationIssues,
      },
      preview: buildPreviewDebugInformation(input.preview),
      browser,
    },
    null,
    2,
  );
}
