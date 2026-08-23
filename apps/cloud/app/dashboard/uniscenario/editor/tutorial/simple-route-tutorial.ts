export const SIMPLE_ROUTE_TUTORIAL_STORAGE_KEY =
  "simcloud.uniscenario.simple-route-tutorial.v1";

export function shouldShowSimpleRouteTutorial(
  storage: Pick<Storage, "getItem"> | null,
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(SIMPLE_ROUTE_TUTORIAL_STORAGE_KEY) == null;
  } catch {
    return false;
  }
}

export function markSimpleRouteTutorialSeen(
  storage: Pick<Storage, "setItem"> | null,
): void {
  try {
    storage?.setItem(SIMPLE_ROUTE_TUTORIAL_STORAGE_KEY, new Date().toISOString());
  } catch {
    // Route editing should remain available when storage is unavailable.
  }
}

export function simpleRouteTutorialStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
