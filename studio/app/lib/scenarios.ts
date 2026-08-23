import type { Scenario, ScenarioStatus } from "@simcloud/shared";
import { cache } from "react";
import { getCurrentSession } from "./auth/session";
import { getAppContext } from "./db/app-context";
import { getScenarioById as getScenarioByIdFromDb, listScenariosForWorkspace } from "./db/scenario-query-store";

export type ScenarioSummary = {
  id: string;
  displayName: string;
  createdAt: string;
  status: ScenarioStatus;
  mapAssetId: string;
};

async function getWorkspaceScenarios(): Promise<Scenario[]> {
  const session = await getCurrentSession();
  if (!session) return [];

  const context = getAppContext(session);
  return listScenariosForWorkspace(context.workspaceId);
}

export const getScenarios = cache(async function getScenarios(): Promise<Scenario[]> {
  return getWorkspaceScenarios();
});

export const getScenarioSummaries = cache(async (): Promise<ScenarioSummary[]> => {
  const scenarios = await getWorkspaceScenarios();
  return scenarios.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    createdAt: r.createdAt,
    status: r.status,
    mapAssetId: r.location.map_asset_id,
  }));
});

export async function getScenarioById(runId: string): Promise<Scenario | null> {
  const session = await getCurrentSession();
  if (!session) return null;

  const context = getAppContext(session);
  return getScenarioByIdFromDb(context.workspaceId, runId);
}
