"use client";

import { useSyncExternalStore } from "react";

export const EXPERIMENTAL_FEATURES_STORAGE_KEY =
  "simforge.experimental-features.v1";
export const EXPERIMENTAL_FEATURES_CHANGE_EVENT =
  "simforge:experimental-features-change";
export const DEFAULT_EXPERIMENTAL_FEATURES_ENABLED =
  process.env.NEXT_PUBLIC_ENV === "dev";

export function readExperimentalFeaturesEnabled(
  storage?: Pick<Storage, "getItem"> | null,
  defaultEnabled = DEFAULT_EXPERIMENTAL_FEATURES_ENABLED,
): boolean {
  try {
    const browserStorage =
      storage === undefined
        ? typeof window === "undefined"
          ? null
          : window.localStorage
        : storage;
    const stored = browserStorage?.getItem(EXPERIMENTAL_FEATURES_STORAGE_KEY);
    if (stored === "true") return true;
    if (stored === "false") return false;
    return defaultEnabled;
  } catch {
    return defaultEnabled;
  }
}

export function setExperimentalFeaturesEnabled(
  enabled: boolean,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const browserStorage =
      storage === undefined
        ? typeof window === "undefined"
          ? null
          : window.localStorage
        : storage;
    browserStorage?.setItem(
      EXPERIMENTAL_FEATURES_STORAGE_KEY,
      enabled ? "true" : "false",
    );
  } catch {
    // The current page still receives the change event when storage is blocked.
  }
  if (storage === undefined && typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<boolean>(EXPERIMENTAL_FEATURES_CHANGE_EVENT, {
        detail: enabled,
      }),
    );
  }
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === EXPERIMENTAL_FEATURES_STORAGE_KEY) listener();
  };
  window.addEventListener(EXPERIMENTAL_FEATURES_CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EXPERIMENTAL_FEATURES_CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useExperimentalFeaturesEnabled(): boolean {
  return useSyncExternalStore(
    subscribe,
    readExperimentalFeaturesEnabled,
    () => DEFAULT_EXPERIMENTAL_FEATURES_ENABLED,
  );
}
