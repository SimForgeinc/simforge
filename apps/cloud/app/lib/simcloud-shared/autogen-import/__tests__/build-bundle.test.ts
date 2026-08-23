import { describe, expect, it } from "vitest";
import { buildBundle } from "../build-bundle";
import { AutogenImportManifestSchema, type BundleScene } from "../manifest";
import { SCENARIO_CATALOG_VERSION } from "../../scenario-catalog";

const SHA = "b".repeat(64);

describe("selection guard", () => {
  const base = {
    runRoot: "/nonexistent-run",
    batchId: "batch-1",
    selectionSha256: SHA,
    datasetId: null,
    limit: null,
    now: "2026-08-03T00:00:00.000Z",
  };

  it("refuses to write a bundle without an explicit allowlist", async () => {
    // Otherwise every eligible scene ships while the manifest still declares
    // selectionMode "explicit_allowlist" and hashes nothing — publishing
    // scenes no reviewer chose, under provenance claiming they were chosen.
    await expect(
      buildBundle({ ...base, selection: null, outDir: "/tmp/should-not-be-written" }),
    ).rejects.toThrow(/selection allowlist is required/i);
  });

  it("allows surveying a run with no allowlist when writing nothing", async () => {
    const result = await buildBundle({ ...base, selection: null, outDir: null });
    expect(result.included).toEqual([]);
    expect(result.discovered).toBe(0);
  });

  it("allows an allowlist with an output directory", async () => {
    // An empty run yields an empty manifest rather than an error.
    const result = await buildBundle({ ...base, selection: [], outDir: null });
    expect(result.manifest.sourceBatch.selectionMode).toBe("explicit_allowlist");
  });
});

describe("manifest eligibility refinement", () => {
  const eligibleScene: BundleScene = {
    externalSceneId: "left-1025-1",
    displayName: "Left turn across oncoming car",
    category: {
      taxonomyVersion: SCENARIO_CATALOG_VERSION,
      id: "conflict.turn_left.car",
      group: "Junction",
      label: "Left turn across oncoming car",
      generatorFamily: "unprotected_left_turn",
      generatorStrategy: null,
      dimensions: { npcVehicleType: "car" },
    },
    map: { mapAssetId: "di-rosa_1", mapName: "Di_Rosa" },
    scenario: { spec: { path: "scenes/x/scenario-spec.json", sha256: SHA } },
    gates: {
      phase2d: "pass",
      phase3d: "pass",
      cot: "pass",
      compose: "pass",
      sceneVerdict: "clean_miss",
    },
    reproducibility: {
      seed: 1,
      generatorSha: null,
      generatorVersion: null,
      taxonomyVersion: SCENARIO_CATALOG_VERSION,
    },
    artifacts: (
      [
        "evaluation_review_video",
        "cot_trace",
        "evaluation_summary",
        "scenario_events",
        "actor_track",
      ] as const
    ).map((role) => ({
      role,
      path: `scenes/x/${role}`,
      contentType: "application/json",
      sizeBytes: 1,
      sha256: SHA,
    })),
  };

  const manifestWith = (scenes: unknown[]) => ({
    schemaVersion: "simforge.autogen-import.v1",
    sourceBatch: {
      id: "b",
      generatorSha: null,
      taxonomyVersion: SCENARIO_CATALOG_VERSION,
      selectionMode: "explicit_allowlist",
      selectionSha256: SHA,
    },
    target: { datasetId: null },
    scenes,
    exclusions: {
      notSelected: 0,
      gateRejected: 0,
      evidenceIncomplete: 0,
      categoryUnresolved: 0,
      byReason: {},
    },
  });

  it("accepts a fully evidenced, fully gated scene", () => {
    expect(
      AutogenImportManifestSchema.safeParse(manifestWith([eligibleScene])).success,
    ).toBe(true);
  });

  it("rejects a hand-assembled manifest carrying a failed gate", () => {
    // The contract — not just the CLI that happens to write bundles today —
    // has to enforce this, or every downstream consumer must remember the
    // filter that the contract exists to make unnecessary.
    const parsed = AutogenImportManifestSchema.safeParse(
      manifestWith([{ ...eligibleScene, gates: { ...eligibleScene.gates, cot: "fail" } }]),
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain("gate_cot:fail");
    }
  });

  it("rejects a scene missing mandatory evidence", () => {
    const parsed = AutogenImportManifestSchema.safeParse(
      manifestWith([
        {
          ...eligibleScene,
          artifacts: eligibleScene.artifacts.filter((a) => a.role !== "actor_track"),
        },
      ]),
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain("missing_artifact:actor_track");
    }
  });
});
