import { describe, expect, it } from "vitest";
import {
  AUTOGEN_IMPORT_SCHEMA_VERSION,
  AutogenImportManifestSchema,
  BundleArtifactSchema,
  MANDATORY_ARTIFACT_ROLES,
  sceneEligibilityErrors,
  type BundleGates,
} from "../manifest";
import { SCENARIO_CATALOG_VERSION } from "../../scenario-catalog";

const SHA = "a".repeat(64);

const PASSING_GATES: BundleGates = {
  phase2d: "pass",
  phase3d: "pass",
  cot: "pass",
  compose: "pass",
  sceneVerdict: "clean_miss",
};

const ALL_MANDATORY = MANDATORY_ARTIFACT_ROLES.map((role) => ({ role }));

describe("scene eligibility", () => {
  it("accepts a fully evidenced, fully gated scene", () => {
    expect(
      sceneEligibilityErrors({ gates: PASSING_GATES, artifacts: ALL_MANDATORY }),
    ).toEqual([]);
  });

  it("rejects a scene missing any mandatory artifact", () => {
    for (const omitted of MANDATORY_ARTIFACT_ROLES) {
      const artifacts = ALL_MANDATORY.filter((a) => a.role !== omitted);
      const errors = sceneEligibilityErrors({ gates: PASSING_GATES, artifacts });
      expect(errors, `omitting ${omitted} should fail`).toContain(
        `missing_artifact:${omitted}`,
      );
    }
  });

  it("rejects a scene whose composed review video is absent", () => {
    // The combined MP4 is the customer's primary evidence; without it the row
    // would render as a scenario with nothing to watch.
    const errors = sceneEligibilityErrors({
      gates: { ...PASSING_GATES, compose: "missing" },
      artifacts: ALL_MANDATORY,
    });
    expect(errors).toContain("gate_compose:missing");
  });

  it("rejects on any failed or missing gate, not just 3D", () => {
    const gates = ["phase2d", "phase3d", "cot", "compose"] as const;
    for (const gate of gates) {
      for (const state of ["fail", "missing"] as const) {
        const errors = sceneEligibilityErrors({
          gates: { ...PASSING_GATES, [gate]: state },
          artifacts: ALL_MANDATORY,
        });
        expect(errors, `${gate}=${state} should fail`).toContain(
          `gate_${gate}:${state}`,
        );
      }
    }
  });

  it("reports every reason at once rather than stopping at the first", () => {
    const errors = sceneEligibilityErrors({
      gates: { ...PASSING_GATES, cot: "fail", compose: "missing" },
      artifacts: ALL_MANDATORY.filter((a) => a.role !== "actor_track"),
    });
    expect(errors).toContain("missing_artifact:actor_track");
    expect(errors).toContain("gate_cot:fail");
    expect(errors).toContain("gate_compose:missing");
  });
});

describe("artifact paths", () => {
  const base = { role: "cot_trace" as const, contentType: "application/json", sizeBytes: 1, sha256: SHA };

  it("accepts a bundle-relative path", () => {
    expect(
      BundleArtifactSchema.safeParse({ ...base, path: "scenes/x/cot.json" }).success,
    ).toBe(true);
  });

  it("rejects absolute paths and traversal", () => {
    // An import bundle is unpacked by a server; a path escaping the bundle root
    // would let a crafted manifest write outside it.
    for (const path of ["/etc/passwd", "../../etc/passwd", "scenes/../../x"]) {
      expect(
        BundleArtifactSchema.safeParse({ ...base, path }).success,
        `${path} must be rejected`,
      ).toBe(false);
    }
  });

  it("requires a lowercase sha256", () => {
    expect(
      BundleArtifactSchema.safeParse({ ...base, path: "a.json", sha256: "abc" }).success,
    ).toBe(false);
    expect(
      BundleArtifactSchema.safeParse({
        ...base,
        path: "a.json",
        sha256: SHA.toUpperCase(),
      }).success,
    ).toBe(false);
  });
});

describe("manifest", () => {
  const manifest = {
    schemaVersion: AUTOGEN_IMPORT_SCHEMA_VERSION,
    sourceBatch: {
      id: "run-1",
      generatorSha: null,
      taxonomyVersion: SCENARIO_CATALOG_VERSION,
      selectionMode: "explicit_allowlist" as const,
      selectionSha256: SHA,
    },
    target: { datasetId: "ds_1" },
    scenes: [],
    exclusions: {
      notSelected: 0,
      gateRejected: 0,
      evidenceIncomplete: 0,
      categoryUnresolved: 0,
      byReason: {},
    },
  };

  it("accepts a well-formed empty manifest", () => {
    expect(AutogenImportManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("accepts only the explicit-allowlist selection mode", () => {
    // Phase 0 has no server-side threshold; anything else would imply one.
    const parsed = AutogenImportManifestSchema.safeParse({
      ...manifest,
      sourceBatch: { ...manifest.sourceBatch, selectionMode: "all_passing" },
    });
    expect(parsed.success).toBe(false);
  });

  it("pins the schema version", () => {
    const parsed = AutogenImportManifestSchema.safeParse({
      ...manifest,
      schemaVersion: "simforge.autogen-import.v2",
    });
    expect(parsed.success).toBe(false);
  });
});
