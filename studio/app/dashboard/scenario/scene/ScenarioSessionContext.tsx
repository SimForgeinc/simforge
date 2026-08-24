"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { ScenarioSession } from "./useScenarioSession";

const ScenarioSessionContext = createContext<ScenarioSession | null>(null);

export function ScenarioSessionProvider({
  session,
  children,
}: {
  session: ScenarioSession;
  children: ReactNode;
}) {
  return (
    <ScenarioSessionContext.Provider value={session}>
      {children}
    </ScenarioSessionContext.Provider>
  );
}

export function useOptionalScenarioSession(): ScenarioSession | null {
  return useContext(ScenarioSessionContext);
}
