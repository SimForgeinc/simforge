import {
  ScenarioEditorActorDraftSchema,
  type ScenarioEditorActorDraft,
} from "@simcloud/shared";

export const ACTOR_SETUP_HISTORY_VERSION = 1;
export const DEFAULT_ACTOR_SETUP_HISTORY_MAX_ENTRIES = 100;

export type ActorSetupHistorySnapshot = {
  id: string;
  label: string;
  createdAt: string;
  actors: ScenarioEditorActorDraft[];
  checksum: string;
};

export type ActorSetupHistoryEnvelope = {
  version: typeof ACTOR_SETUP_HISTORY_VERSION;
  scenarioId: string | null;
  maxEntries: number;
  presentChecksum: string;
  past: ActorSetupHistorySnapshot[];
  future: ActorSetupHistorySnapshot[];
};

export type ActorSetupHistoryState = {
  scenarioId: string | null;
  maxEntries: number;
  past: ActorSetupHistorySnapshot[];
  future: ActorSetupHistorySnapshot[];
};

type ActorSetupSelectionState = {
  selectedActorId: string | null;
  selectedTimelineNodeId?: string | null;
  timedPathPlacementActorId?: string | null;
  staticDistributionActorId?: string | null;
};

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortKeysDeep(item));
  if (!value || typeof value !== "object") return value;

  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      result[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
      return result;
    }, {});
}

export function stableSerializeActorSetup(value: unknown) {
  return JSON.stringify(sortKeysDeep(value));
}

function cloneActors(actors: ScenarioEditorActorDraft[]) {
  return actors.map((actor) => structuredClone(actor));
}

function parseActors(value: unknown): ScenarioEditorActorDraft[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.map((entry) => ScenarioEditorActorDraftSchema.safeParse(entry));
  if (parsed.some((entry) => !entry.success)) return null;
  return parsed.map((entry) => (entry as { success: true; data: ScenarioEditorActorDraft }).data);
}

function parseMaxEntries(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return DEFAULT_ACTOR_SETUP_HISTORY_MAX_ENTRIES;
  }
  return Math.min(250, Math.max(1, value));
}

export function actorSetupDocumentChecksum(actors: ScenarioEditorActorDraft[]) {
  return stableSerializeActorSetup(actors);
}

function makeSnapshot(
  label: string,
  actors: ScenarioEditorActorDraft[],
): ActorSetupHistorySnapshot {
  return {
    id: crypto.randomUUID(),
    label,
    createdAt: new Date().toISOString(),
    actors: cloneActors(actors),
    checksum: actorSetupDocumentChecksum(actors),
  };
}

function normalizeSnapshot(value: unknown): ActorSetupHistorySnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const actors = parseActors(record.actors);
  if (!actors) return null;
  const checksum = actorSetupDocumentChecksum(actors);
  if (record.checksum !== checksum) return null;
  return {
    id: typeof record.id === "string" && record.id ? record.id : crypto.randomUUID(),
    label: typeof record.label === "string" && record.label ? record.label : "Edit actor",
    createdAt:
      typeof record.createdAt === "string" && record.createdAt
        ? record.createdAt
        : new Date().toISOString(),
    actors,
    checksum,
  };
}

function emptyEnvelope(
  scenarioId: string | null,
  actors: ScenarioEditorActorDraft[],
  maxEntries = DEFAULT_ACTOR_SETUP_HISTORY_MAX_ENTRIES,
): ActorSetupHistoryEnvelope {
  return {
    version: ACTOR_SETUP_HISTORY_VERSION,
    scenarioId,
    maxEntries,
    presentChecksum: actorSetupDocumentChecksum(actors),
    past: [],
    future: [],
  };
}

export function normalizeActorSetupHistoryEnvelope({
  raw,
  scenarioId,
  actors,
}: {
  raw: unknown;
  scenarioId: string | null;
  actors: ScenarioEditorActorDraft[];
}): ActorSetupHistoryEnvelope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyEnvelope(scenarioId, actors);
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== ACTOR_SETUP_HISTORY_VERSION) {
    return emptyEnvelope(scenarioId, actors);
  }
  const rawScenarioId =
    typeof record.scenarioId === "string" ? record.scenarioId : null;
  if (rawScenarioId !== scenarioId) {
    return emptyEnvelope(scenarioId, actors);
  }
  const presentChecksum = actorSetupDocumentChecksum(actors);
  if (record.presentChecksum !== presentChecksum) {
    return emptyEnvelope(scenarioId, actors);
  }
  const maxEntries = parseMaxEntries(record.maxEntries);
  const past = Array.isArray(record.past)
    ? record.past.map(normalizeSnapshot)
    : [];
  const future = Array.isArray(record.future)
    ? record.future.map(normalizeSnapshot)
    : [];
  if (past.some((snapshot) => !snapshot) || future.some((snapshot) => !snapshot)) {
    return emptyEnvelope(scenarioId, actors, maxEntries);
  }

  return {
    version: ACTOR_SETUP_HISTORY_VERSION,
    scenarioId,
    maxEntries,
    presentChecksum,
    past: (past as ActorSetupHistorySnapshot[]).slice(-maxEntries),
    future: (future as ActorSetupHistorySnapshot[]).slice(-maxEntries),
  };
}

export function serializeActorSetupHistoryEnvelope({
  scenarioId,
  actors,
  history,
}: {
  scenarioId: string | null;
  actors: ScenarioEditorActorDraft[];
  history: ActorSetupHistoryState;
}): ActorSetupHistoryEnvelope {
  const maxEntries = parseMaxEntries(history.maxEntries);
  return {
    version: ACTOR_SETUP_HISTORY_VERSION,
    scenarioId,
    maxEntries,
    presentChecksum: actorSetupDocumentChecksum(actors),
    past: history.past.slice(-maxEntries),
    future: history.future.slice(-maxEntries),
  };
}

export function applyActorSetupChange({
  actors,
  history,
  label,
  updater,
}: {
  actors: ScenarioEditorActorDraft[];
  history: ActorSetupHistoryState;
  label: string;
  updater: (actors: ScenarioEditorActorDraft[]) => ScenarioEditorActorDraft[];
}): {
  actors: ScenarioEditorActorDraft[];
  past: ActorSetupHistorySnapshot[];
  future: ActorSetupHistorySnapshot[];
  changed: boolean;
} {
  const before = cloneActors(actors);
  const after = updater(before);
  if (actorSetupDocumentChecksum(actors) === actorSetupDocumentChecksum(after)) {
    return {
      actors,
      past: history.past,
      future: history.future,
      changed: false,
    };
  }
  const maxEntries = parseMaxEntries(history.maxEntries);
  return {
    actors: cloneActors(after),
    past: [...history.past, makeSnapshot(label, actors)].slice(-maxEntries),
    future: [],
    changed: true,
  };
}

export function undoActorSetupHistory({
  actors,
  history,
}: {
  actors: ScenarioEditorActorDraft[];
  history: ActorSetupHistoryState;
}): {
  actors: ScenarioEditorActorDraft[];
  past: ActorSetupHistorySnapshot[];
  future: ActorSetupHistorySnapshot[];
  changed: boolean;
} {
  const previous = history.past[history.past.length - 1];
  if (!previous) {
    return { actors, past: history.past, future: history.future, changed: false };
  }
  const past = history.past.slice(0, -1);
  const future = [
    ...history.future,
    makeSnapshot(previous.label, actors),
  ].slice(-parseMaxEntries(history.maxEntries));
  return {
    actors: cloneActors(previous.actors),
    past,
    future,
    changed: true,
  };
}

export function redoActorSetupHistory({
  actors,
  history,
}: {
  actors: ScenarioEditorActorDraft[];
  history: ActorSetupHistoryState;
}): {
  actors: ScenarioEditorActorDraft[];
  past: ActorSetupHistorySnapshot[];
  future: ActorSetupHistorySnapshot[];
  changed: boolean;
} {
  const next = history.future[history.future.length - 1];
  if (!next) {
    return { actors, past: history.past, future: history.future, changed: false };
  }
  const maxEntries = parseMaxEntries(history.maxEntries);
  return {
    actors: cloneActors(next.actors),
    past: [...history.past, makeSnapshot(next.label, actors)].slice(-maxEntries),
    future: history.future.slice(0, -1),
    changed: true,
  };
}

export function repairActorSetupSelections<T extends ActorSetupSelectionState>(
  selections: T,
  actors: ScenarioEditorActorDraft[],
): T {
  const actorIds = new Set(actors.map((actor) => actor.id));
  const selectedActorId =
    selections.selectedActorId && actorIds.has(selections.selectedActorId)
      ? selections.selectedActorId
      : null;
  const selectedActor = selectedActorId
    ? actors.find((actor) => actor.id === selectedActorId) ?? null
    : null;
  // The dock's nodes are the behavior program's clips — the only motion
  // system. Legacy timeline ids (now riding the migration's wire envelope)
  // stay resolvable so a selection made before an upgrade survives it.
  const timelineIds = new Set([
    ...(selectedActor?.behavior?.clips?.map((clip) => clip.id) ?? []),
    ...(selectedActor?.legacy_wire?.timeline?.map((clip) => clip.id) ?? []),
  ]);

  return {
    ...selections,
    selectedActorId,
    selectedTimelineNodeId:
      selections.selectedTimelineNodeId && timelineIds.has(selections.selectedTimelineNodeId)
        ? selections.selectedTimelineNodeId
        : null,
    timedPathPlacementActorId:
      selections.timedPathPlacementActorId && actorIds.has(selections.timedPathPlacementActorId)
        ? selections.timedPathPlacementActorId
        : null,
    staticDistributionActorId:
      selections.staticDistributionActorId && actorIds.has(selections.staticDistributionActorId)
        ? selections.staticDistributionActorId
        : null,
  };
}
