import { create } from "zustand";
import type { EditorAssistantToolTrace } from "@/app/lib/editor-tools/types";

export type AssistantToolTrace = EditorAssistantToolTrace;

export type AssistantChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolTrace?: AssistantToolTrace[];
};

export type AssistantStreamingState = {
  active: boolean;
  text: string;
  thinking: string;
  tools: AssistantToolTrace[];
};

export type AssistantChatThread = {
  messages: AssistantChatMessage[];
  input: string;
  busy: boolean;
  streaming: AssistantStreamingState;
  hydrated: boolean;
};

export const EMPTY_STREAMING_STATE: AssistantStreamingState = {
  active: false,
  text: "",
  thinking: "",
  tools: [],
};

export const EMPTY_ASSISTANT_THREAD: AssistantChatThread = {
  messages: [],
  input: "",
  busy: false,
  streaming: EMPTY_STREAMING_STATE,
  hydrated: false,
};

type AssistantChatStore = {
  threads: Record<string, AssistantChatThread>;
  ensureThread: (threadId: string) => void;
  hydrateThread: (threadId: string, messages: AssistantChatMessage[]) => void;
  setMessages: (
    threadId: string,
    value:
      | AssistantChatMessage[]
      | ((messages: AssistantChatMessage[]) => AssistantChatMessage[]),
  ) => void;
  setInput: (threadId: string, input: string) => void;
  setBusy: (threadId: string, busy: boolean) => void;
  setStreaming: (
    threadId: string,
    value:
      | AssistantStreamingState
      | ((streaming: AssistantStreamingState) => AssistantStreamingState),
  ) => void;
  resetThread: (threadId: string) => void;
};

function newThread(): AssistantChatThread {
  return {
    messages: [],
    input: "",
    busy: false,
    streaming: { ...EMPTY_STREAMING_STATE },
    hydrated: false,
  };
}

function threadOrNew(thread: AssistantChatThread | undefined) {
  return thread ?? newThread();
}

export const useAssistantChatStore = create<AssistantChatStore>()((set) => ({
  threads: {},
  ensureThread: (threadId) =>
    set((state) => {
      if (state.threads[threadId]) return state;
      return {
        threads: {
          ...state.threads,
          [threadId]: newThread(),
        },
      };
    }),
  hydrateThread: (threadId, messages) =>
    set((state) => {
      const current = threadOrNew(state.threads[threadId]);
      if (current.hydrated) return state;
      return {
        threads: {
          ...state.threads,
          [threadId]: {
            ...current,
            messages,
            hydrated: true,
          },
        },
      };
    }),
  setMessages: (threadId, value) =>
    set((state) => {
      const current = threadOrNew(state.threads[threadId]);
      return {
        threads: {
          ...state.threads,
          [threadId]: {
            ...current,
            messages:
              typeof value === "function" ? value(current.messages) : value,
          },
        },
      };
    }),
  setInput: (threadId, input) =>
    set((state) => {
      const current = threadOrNew(state.threads[threadId]);
      return {
        threads: {
          ...state.threads,
          [threadId]: { ...current, input },
        },
      };
    }),
  setBusy: (threadId, busy) =>
    set((state) => {
      const current = threadOrNew(state.threads[threadId]);
      return {
        threads: {
          ...state.threads,
          [threadId]: { ...current, busy },
        },
      };
    }),
  setStreaming: (threadId, value) =>
    set((state) => {
      const current = threadOrNew(state.threads[threadId]);
      return {
        threads: {
          ...state.threads,
          [threadId]: {
            ...current,
            streaming:
              typeof value === "function" ? value(current.streaming) : value,
          },
        },
      };
    }),
  resetThread: (threadId) =>
    set((state) => {
      const current = threadOrNew(state.threads[threadId]);
      return {
        threads: {
          ...state.threads,
          [threadId]: {
            ...current,
            messages: [],
            input: "",
            busy: false,
            streaming: { ...EMPTY_STREAMING_STATE },
            hydrated: true,
          },
        },
      };
    }),
}));
