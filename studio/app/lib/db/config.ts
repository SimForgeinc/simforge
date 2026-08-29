import { homedir } from "node:os";
import { join } from "node:path";

export const LOCAL_CLOUD_ROOT =
  process.env.SIMFORGE_CLOUD_ROOT?.trim() || join(homedir(), ".simforge", "cloud");
export const LOCAL_DATABASE_DIR = join(LOCAL_CLOUD_ROOT, "db");
export const LOCAL_ARTIFACTS_DIR = join(LOCAL_CLOUD_ROOT, "artifacts");
export const LOCAL_ARTIFACT_BUCKET = "local-artifacts";

export type DataApiConfig = {
  region: string;
  clusterArn: string;
  secretArn: string;
  database: string;
};

/** Retained for copied callers that inspect the legacy Data API config shape. */
export function getDataApiConfig(): DataApiConfig {
  return {
    region: "local",
    clusterArn: process.env.DATABASE_URL?.trim() ?? `file://${LOCAL_DATABASE_DIR}`,
    secretArn: "local",
    database: "simcloud",
  };
}

export function isDataApiConfigured(): boolean {
  return true;
}
