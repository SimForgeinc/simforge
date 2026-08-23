import { describe, expect, it } from "vitest";
import {
  WorkspaceStorageDeletionPreviewRequestSchema,
  WorkspaceStoragePolicySchema,
} from "./workspace-storage";

describe("workspace storage contracts", () => {
  it("requires a concrete deletion selection", () => {
    expect(WorkspaceStorageDeletionPreviewRequestSchema.safeParse({
      action: "delete_artifacts",
      selection: {},
    }).success).toBe(false);
    expect(WorkspaceStorageDeletionPreviewRequestSchema.safeParse({
      action: "keep_latest_render",
      selection: { scenarioIds: ["scenario-1"] },
    }).success).toBe(true);
  });

  it("keeps the trash recovery window within the supported range", () => {
    const base = {
      workspaceId: "ws-1",
      automaticKeepLatestRender: false,
      includeDerivedOutputs: false,
      updatedAt: null,
    };
    expect(WorkspaceStoragePolicySchema.safeParse({ ...base, trashRecoveryDays: 30 }).success).toBe(true);
    expect(WorkspaceStoragePolicySchema.safeParse({ ...base, trashRecoveryDays: 0 }).success).toBe(false);
    expect(WorkspaceStoragePolicySchema.safeParse({ ...base, trashRecoveryDays: 91 }).success).toBe(false);
  });
});
