"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { UniScenarioSession } from "./useUniScenarioSession";

const UniScenarioSessionContext = createContext<UniScenarioSession | null>(null);

export function UniScenarioSessionProvider({
  session,
  children,
}: {
  session: UniScenarioSession;
  children: ReactNode;
}) {
  return (
    <UniScenarioSessionContext.Provider value={session}>
      {children}
    </UniScenarioSessionContext.Provider>
  );
}

export function useOptionalUniScenarioSession(): UniScenarioSession | null {
  return useContext(UniScenarioSessionContext);
}
