import { create } from "zustand";
import type { AdvancedTabId } from "@/app/lib/scenario-editor/advanced-types";
import type {
  ActorDragState,
  CameraPaletteDragState,
  PaletteDragState,
  SceneObjectType,
  SidebarMode,
  SlidePanelMode,
  WorkspaceTab,
} from "@/app/lib/scenario-editor/types";

const ADVANCED_MODE_ENABLED_STORAGE_KEY = "simcloud.editor.advancedModeEnabled";

interface UiState {
  workspaceTab: WorkspaceTab;
  sidebarMode: SidebarMode;
  sceneObjectType: SceneObjectType;
  slidePanel: SlidePanelMode;
  paletteDrag: PaletteDragState | null;
  actorDrag: ActorDragState | null;
  cameraPaletteDrag: CameraPaletteDragState | null;
  advancedPanelOpen: boolean;
  advancedPanelTab: AdvancedTabId | null;
  advancedModeEnabled: boolean;
  logsDrawerOpen: boolean;
  templateComposerOpen: boolean;
  templateName: string;
  setWorkspaceTab: (tab: WorkspaceTab) => void;
  setSidebarMode: (mode: SidebarMode) => void;
  setSceneObjectType: (type: SceneObjectType) => void;
  setSlidePanel: (panel: SlidePanelMode) => void;
  setPaletteDrag: (
    drag:
      | PaletteDragState
      | null
      | ((current: PaletteDragState | null) => PaletteDragState | null),
  ) => void;
  setActorDrag: (
    drag:
      | ActorDragState
      | null
      | ((current: ActorDragState | null) => ActorDragState | null),
  ) => void;
  setCameraPaletteDrag: (
    drag:
      | CameraPaletteDragState
      | null
      | ((current: CameraPaletteDragState | null) => CameraPaletteDragState | null),
  ) => void;
  setAdvancedPanelOpen: (open: boolean) => void;
  setAdvancedPanelTab: (tab: AdvancedTabId | null) => void;
  setAdvancedModeEnabled: (enabled: boolean) => void;
  setLogsDrawerOpen: (open: boolean | ((current: boolean) => boolean)) => void;
  setTemplateComposerOpen: (
    open: boolean | ((current: boolean) => boolean),
  ) => void;
  setTemplateName: (name: string) => void;
}

export const useUiStateStore = create<UiState>()((set) => ({
  workspaceTab: "editor",
  sidebarMode: "manual",
  sceneObjectType: "actor",
  slidePanel: null,
  paletteDrag: null,
  actorDrag: null,
  cameraPaletteDrag: null,
  advancedPanelOpen: false,
  advancedPanelTab: null,
  advancedModeEnabled: false,
  logsDrawerOpen: false,
  templateComposerOpen: false,
  templateName: "",
  setWorkspaceTab: (tab) => set({ workspaceTab: tab }),
  setSidebarMode: (mode) => set({ sidebarMode: mode }),
  setSceneObjectType: (type) => set({ sceneObjectType: type }),
  setSlidePanel: (panel) => set({ slidePanel: panel }),
  setPaletteDrag: (dragOrFn) =>
    set((state) => ({
      paletteDrag:
        typeof dragOrFn === "function"
          ? dragOrFn(state.paletteDrag)
          : dragOrFn,
    })),
  setActorDrag: (dragOrFn) =>
    set((state) => ({
      actorDrag:
        typeof dragOrFn === "function" ? dragOrFn(state.actorDrag) : dragOrFn,
    })),
  setCameraPaletteDrag: (dragOrFn) =>
    set((state) => ({
      cameraPaletteDrag:
        typeof dragOrFn === "function"
          ? dragOrFn(state.cameraPaletteDrag)
          : dragOrFn,
    })),
  setAdvancedPanelOpen: (open) => set({ advancedPanelOpen: open }),
  setAdvancedPanelTab: (tab) => set({ advancedPanelTab: tab }),
  setAdvancedModeEnabled: (enabled) =>
    set((state) => {
      if (typeof window !== "undefined") {
        localStorage.setItem(
          ADVANCED_MODE_ENABLED_STORAGE_KEY,
          enabled ? "true" : "false",
        );
      }
      return {
        advancedModeEnabled: enabled,
        sidebarMode: enabled ? state.sidebarMode : "manual",
      };
    }),
  setLogsDrawerOpen: (openOrFn) =>
    set((state) => ({
      logsDrawerOpen:
        typeof openOrFn === "function"
          ? openOrFn(state.logsDrawerOpen)
          : openOrFn,
    })),
  setTemplateComposerOpen: (openOrFn) =>
    set((state) => ({
      templateComposerOpen:
        typeof openOrFn === "function"
          ? openOrFn(state.templateComposerOpen)
          : openOrFn,
    })),
  setTemplateName: (name) => set({ templateName: name }),
}));
