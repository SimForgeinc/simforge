import { create } from "zustand";
import {
  normalizeActorBaseClip,
  type ScenarioEditorActorDraft,
} from "@simcloud/shared";
import type { UnloadableActor } from "@/app/lib/scenario-editor/draft-normalization";
import type { EditorActorRecord } from "@/app/lib/scenario-editor/types";
import {
  DEFAULT_ACTOR_SETUP_HISTORY_MAX_ENTRIES,
  applyActorSetupChange,
  normalizeActorSetupHistoryEnvelope,
  redoActorSetupHistory,
  serializeActorSetupHistoryEnvelope,
  undoActorSetupHistory,
  type ActorSetupHistoryEnvelope,
  type ActorSetupHistorySnapshot,
} from "@/app/lib/scenario-editor/actor-setup-history";

type SaveState = "idle" | "saving" | "saved" | "error";

type DerivedActorRecordsUpdater = (
  current: EditorActorRecord[],
) => EditorActorRecord[];

type ActorRecordsChange = (current: EditorActorRecord[]) => EditorActorRecord[];

function recordsToDrafts(records: EditorActorRecord[]) {
  return records.map((record) => record.draft);
}

/**
 * Every actor mutation funnels through `applyActorsChange`, so this is where an
 * actor's baseline locomotion is kept in agreement with the rest of its draft.
 *
 * Doing it here rather than at each of the ~20 call sites is deliberate: the
 * ones that matter are the map ones (adding, moving, and deleting timed points
 * changes the geometry the base `follow_path` clip mirrors), and requiring each
 * of them to remember is exactly how the two control surfaces drifted apart in
 * the first place. `normalizeActorBaseClip` is pure and idempotent, so running
 * it over every actor on every edit costs a shallow copy and can never fight an
 * edit that already did the right thing.
 */
function withNormalizedBaseClips(
  records: EditorActorRecord[],
): EditorActorRecord[] {
  return records.map((record) => {
    const draft = normalizeActorBaseClip(record.draft);
    return draft === record.draft ? record : { ...record, draft };
  });
}

function reconcileRecords(
  current: EditorActorRecord[],
  nextDrafts: ScenarioEditorActorDraft[],
): EditorActorRecord[] {
  return nextDrafts.map((draft) => {
    const existing = current.find((record) => record.draft.id === draft.id);
    if (!existing) {
      return {
        draft,
        lng: 0,
        lat: 0,
        placementLabel: "Actor placement",
      };
    }
    return {
      ...existing,
      draft,
    };
  });
}

interface EditorDocumentState {
  actors: EditorActorRecord[];
  scenarioId: string | null;
  past: ActorSetupHistorySnapshot[];
  future: ActorSetupHistorySnapshot[];
  maxEntries: number;
  draftSaveState: SaveState;
  /**
   * Actors the loaded scenario declares that this build could not parse.
   *
   * Non-empty means the document in memory is INCOMPLETE. It is recorded on the
   * document rather than shown and forgotten because two different things need
   * it: the blocking notification that tells the author what is missing, and
   * `useDraftPersistenceController`, which must refuse to save. Saving an
   * incomplete document is what turned a display bug into the deletion of a car
   * (`[eval] S02`, 2026-07-29).
   */
  unloadableActors: UnloadableActor[];
  saveRevision: number;
  canUndo: boolean;
  canRedo: boolean;
  replaceDerivedActorRecords: (updater: DerivedActorRecordsUpdater) => void;
  applyActorsChange: (label: string, updater: ActorRecordsChange) => void;
  replaceFromServer: (input: {
    scenarioId: string | null;
    actors: EditorActorRecord[];
    history: unknown;
    unloadableActors?: UnloadableActor[];
  }) => void;
  setDraftSaveState: (state: SaveState) => void;
  noteSaveStarted: () => number;
  noteSaveSucceeded: (revision: number) => boolean;
  noteSaveFailed: (revision: number) => boolean;
  undo: () => void;
  redo: () => void;
  reset: () => void;
  historyEnvelope: () => ActorSetupHistoryEnvelope;
}

function withAvailability(
  state: Omit<Partial<EditorDocumentState>, "canUndo" | "canRedo"> & {
    past?: ActorSetupHistorySnapshot[];
    future?: ActorSetupHistorySnapshot[];
  },
) {
  const past = state.past ?? [];
  const future = state.future ?? [];
  return {
    ...state,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
  };
}

const initialState = {
  actors: [],
  scenarioId: null,
  past: [],
  future: [],
  maxEntries: DEFAULT_ACTOR_SETUP_HISTORY_MAX_ENTRIES,
  draftSaveState: "idle" as SaveState,
  unloadableActors: [] as UnloadableActor[],
  saveRevision: 0,
  canUndo: false,
  canRedo: false,
};

export const useEditorDocumentStore = create<EditorDocumentState>()((set, get) => ({
  ...initialState,
  replaceDerivedActorRecords: (updater) =>
    set((state) => {
      const proposedRecords = updater(state.actors);
      return {
        actors: state.actors.map((record) => {
          const proposed = proposedRecords.find(
            (candidate) => candidate.draft.id === record.draft.id,
          );
          if (!proposed) return record;
          return {
            ...record,
            lng: proposed.lng,
            lat: proposed.lat,
            placementLabel: proposed.placementLabel,
            draft: record.draft,
          };
        }),
      };
    }),
  applyActorsChange: (label, updater) =>
    set((state) => {
      const nextRecords = withNormalizedBaseClips(updater(state.actors));
      const currentDrafts = recordsToDrafts(state.actors);
      const nextDrafts = recordsToDrafts(nextRecords);
      const result = applyActorSetupChange({
        actors: currentDrafts,
        history: state,
        label,
        updater: () => nextDrafts,
      });
      if (!result.changed) return {};
      return withAvailability({
        actors: reconcileRecords(nextRecords, result.actors),
        past: result.past,
        future: result.future,
        saveRevision: state.saveRevision + 1,
        draftSaveState: "idle",
      });
    }),
  replaceFromServer: ({ scenarioId, actors, history, unloadableActors }) =>
    set(() => {
      const normalized = normalizeActorSetupHistoryEnvelope({
        raw: history,
        scenarioId,
        actors: recordsToDrafts(actors),
      });
      return withAvailability({
        actors,
        scenarioId,
        past: normalized.past,
        future: normalized.future,
        maxEntries: normalized.maxEntries,
        draftSaveState: "saved",
        unloadableActors: unloadableActors ?? [],
        saveRevision: 0,
      });
    }),
  setDraftSaveState: (draftSaveState) => set({ draftSaveState }),
  noteSaveStarted: () => {
    const revision = get().saveRevision;
    set({ draftSaveState: "saving" });
    return revision;
  },
  noteSaveSucceeded: (revision) => {
    if (revision !== get().saveRevision) return false;
    set({ draftSaveState: "saved" });
    return true;
  },
  noteSaveFailed: (revision) => {
    if (revision !== get().saveRevision) return false;
    set({ draftSaveState: "error" });
    return true;
  },
  undo: () =>
    set((state) => {
      const result = undoActorSetupHistory({
        actors: recordsToDrafts(state.actors),
        history: state,
      });
      if (!result.changed) return {};
      return withAvailability({
        actors: reconcileRecords(state.actors, result.actors),
        past: result.past,
        future: result.future,
        saveRevision: state.saveRevision + 1,
        draftSaveState: "idle",
      });
    }),
  redo: () =>
    set((state) => {
      const result = redoActorSetupHistory({
        actors: recordsToDrafts(state.actors),
        history: state,
      });
      if (!result.changed) return {};
      return withAvailability({
        actors: reconcileRecords(state.actors, result.actors),
        past: result.past,
        future: result.future,
        saveRevision: state.saveRevision + 1,
        draftSaveState: "idle",
      });
    }),
  reset: () => set(initialState),
  historyEnvelope: () => {
    const state = get();
    return serializeActorSetupHistoryEnvelope({
      scenarioId: state.scenarioId,
      actors: recordsToDrafts(state.actors),
      history: state,
    });
  },
}));
