import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  AUTOGEN_IMPORT_SCHEMA_VERSION,
  AutogenImportManifestSchema,
  IMPORT_LIMITS,
  sceneEligibilityErrors,
  type ArtifactRole,
  type AutogenImportManifest,
  type BundleArtifact,
  type BundleGates,
  type BundleScene,
} from "./manifest";
import {
  asRecord,
  classificationFrom,
  dimensionsFrom,
  discoverScenes,
  exists,
  gateFromSummary,
  cotGateState,
  readJson,
} from "./evidence";
import { materializeSpec } from "./materialize";
import { SCENARIO_CATALOG_VERSION, resolveCategory } from "../scenario-catalog";

/**
 * Orchestration for building a validated import bundle from an offline run.
 *
 * Fails CLOSED: a scene reaches `scenes[]` only when every mandatory artifact
 * exists, every gate passed, the materialized draft satisfies the editor
 * schema, and the category resolves. Everything else is counted in
 * `exclusions` and named in the report, but never gets an importable record.
 */

export type BuildOptions = {
  runRoot: string;
  batchId: string;
  /**
   * Explicit operator allowlist. Required whenever a bundle is written — see
   * the note in `buildBundle`.
   */
  selection: string[] | null;
  selectionSha256: string;
  outDir: string | null;
  datasetId: string | null;
  limit: number | null;
  /** Stable timestamps for materialized drafts; see MaterializeInput. */
  now: string;
};

export type Excluded = { sceneId: string; reasons: string[] };

export type BuildResult = {
  manifest: AutogenImportManifest;
  included: BundleScene[];
  excluded: Excluded[];
  discovered: number;
};

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".json": "application/json",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  return CONTENT_TYPES[path.slice(dot)] ?? "application/octet-stream";
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function buildBundle(options: BuildOptions): Promise<BuildResult> {
  const {
    runRoot,
    batchId,
    selection,
    selectionSha256,
    outDir,
    datasetId,
    limit,
    now,
  } = options;

  // Writing a bundle without an allowlist would package every eligible scene
  // while the manifest still declared `selectionMode: "explicit_allowlist"` and
  // hashed nothing — publishing scenes no reviewer chose, under provenance
  // claiming they were chosen. Surveying a run that way is fine; shipping one
  // is not.
  if (outDir && !selection) {
    throw new Error(
      "a --selection allowlist is required to write a bundle; " +
        "use --validate-only to survey a run without one",
    );
  }

  const scenes = await discoverScenes(runRoot);
  const considered = selection ?? [...scenes.keys()];
  if (considered.length > IMPORT_LIMITS.maxScenesPerRun) {
    throw new Error(
      `selection of ${considered.length} exceeds maxScenesPerRun ${IMPORT_LIMITS.maxScenesPerRun}`,
    );
  }

  const included: BundleScene[] = [];
  const excluded: Excluded[] = [];
  const byReason: Record<string, number> = {};
  const note = (reason: string) => {
    byReason[reason] = (byReason[reason] ?? 0) + 1;
  };
  const reject = (sceneId: string, reasons: string[]) => {
    excluded.push({ sceneId, reasons });
    for (const r of reasons) note(r.split(":")[0] ?? r);
  };

  for (const sceneId of considered) {
    if (limit !== null && included.length >= limit) break;

    const source = scenes.get(sceneId);
    if (!source) {
      reject(sceneId, ["not_found_in_run"]);
      continue;
    }

    const summary = await readJson(source.summaryPath);
    const twoDSummary = source.twoDSummaryPath
      ? await readJson(source.twoDSummaryPath)
      : null;
    const cotPath = join(source.runDir, "cot.json");
    const cot = (await exists(cotPath)) ? await readJson(cotPath) : null;
    const replay = source.replayPath ? await readJson(source.replayPath) : null;

    const threeD = gateFromSummary(summary);
    const twoD = gateFromSummary(twoDSummary);
    const gates: BundleGates = {
      phase2d: twoD.state,
      phase3d: threeD.state,
      cot: cotGateState(cot),
      compose: source.reviewVideoPath ? "pass" : "missing",
      sceneVerdict: threeD.verdict ?? "unknown",
    };

    const reasons: string[] = [];

    const classification = classificationFrom(replay, cot);
    if (!classification) reasons.push("classification_unavailable");
    const resolution = classification ? resolveCategory(classification) : null;
    if (resolution && !resolution.ok) reasons.push(resolution.reason);

    const candidates: Array<{ role: ArtifactRole; path: string }> = [];
    if (source.reviewVideoPath) {
      candidates.push({
        role: "evaluation_review_video",
        path: source.reviewVideoPath,
      });
    }
    for (const [role, rel] of [
      ["cot_trace", "cot.json"],
      ["scenario_events", "scenario_events.json"],
      ["actor_track", "actor_track.json"],
    ] as const) {
      const p = join(source.runDir, rel);
      if (await exists(p)) candidates.push({ role, path: p });
    }
    candidates.push({ role: "evaluation_summary", path: source.summaryPath });
    if (source.replayPath) {
      candidates.push({ role: "scenario_replay", path: source.replayPath });
    }

    reasons.push(
      ...sceneEligibilityErrors({
        gates,
        artifacts: candidates.map((c) => ({ role: c.role })),
      }),
    );

    if (reasons.length > 0 || !resolution?.ok || !classification) {
      reject(sceneId, reasons);
      continue;
    }

    const requestPath = join(source.runDir, "request.json");
    const compiled = (await exists(requestPath)) ? await readJson(requestPath) : null;
    if (!compiled) {
      reject(sceneId, ["missing_compiled_request"]);
      continue;
    }

    const mapName =
      (typeof compiled.mapName === "string" && compiled.mapName) ||
      (typeof compiled.map_name === "string" && compiled.map_name) ||
      source.map;
    const request = replay ? asRecord(replay.request) : null;
    const generation = replay ? asRecord(replay.generation) : null;

    // The real map asset id lives on the replay sidecar. The directory name is
    // only a nickname ("belmont"), and importing with it would bind the
    // scenario to a map that does not exist.
    const mapAssetId =
      typeof generation?.mapAssetId === "string" ? generation.mapAssetId : null;
    if (!mapAssetId) {
      reject(sceneId, ["missing_map_asset_id"]);
      continue;
    }

    const materialized = materializeSpec({
      request: compiled,
      sceneId,
      mapName,
      mapAssetId,
      datasetId,
      navPrompt: typeof request?.navPrompt === "string" ? request.navPrompt : null,
      createdAt: now,
      updatedAt: now,
    });
    if (!materialized.ok) {
      reject(sceneId, [materialized.error]);
      continue;
    }

    const sceneDir = outDir ? join(outDir, "scenes", sceneId) : null;
    if (sceneDir) await mkdir(sceneDir, { recursive: true });

    const specJson = `${JSON.stringify(materialized.spec, null, 2)}\n`;
    const specSha = createHash("sha256").update(specJson).digest("hex");
    const specRel = `scenes/${sceneId}/scenario-spec.json`;
    if (sceneDir) await writeFile(join(sceneDir, "scenario-spec.json"), specJson);

    const artifacts: BundleArtifact[] = [];
    for (const candidate of candidates) {
      const info = await stat(candidate.path);
      artifacts.push({
        role: candidate.role,
        path: `scenes/${sceneId}/${basename(candidate.path)}`,
        contentType: contentTypeFor(candidate.path),
        sizeBytes: info.size,
        sha256: await sha256File(candidate.path),
      });
      if (sceneDir) {
        await copyFile(candidate.path, join(sceneDir, basename(candidate.path)));
      }
    }

    if (artifacts.length > IMPORT_LIMITS.maxArtifactsPerScene) {
      reject(sceneId, ["too_many_artifacts"]);
      continue;
    }

    included.push({
      externalSceneId: sceneId,
      displayName: `${resolution.entry.label} — ${mapName} ${sceneId}`,
      category: {
        taxonomyVersion: SCENARIO_CATALOG_VERSION,
        id: resolution.entry.id,
        group: resolution.entry.group,
        label: resolution.entry.label,
        generatorFamily:
          classification.kind === "conflict" ? classification.family : "nominal",
        generatorStrategy:
          classification.kind === "nominal" ? classification.strategy : null,
        dimensions: dimensionsFrom(classification),
      },
      map: { mapAssetId, mapName, carlaMapName: mapName },
      scenario: {
        spec: { path: specRel, sha256: specSha },
        ...(source.replayPath
          ? {
              replay: {
                path: `scenes/${sceneId}/${basename(source.replayPath)}`,
                sha256: await sha256File(source.replayPath),
              },
            }
          : {}),
      },
      gates,
      reproducibility: {
        seed:
          typeof generation?.seed === "number"
            ? generation.seed
            : typeof request?.seed === "number"
              ? request.seed
              : null,
        generatorSha:
          typeof replay?.generatorSha === "string" ? replay.generatorSha : null,
        generatorVersion: null,
        taxonomyVersion: SCENARIO_CATALOG_VERSION,
        request: request ?? undefined,
      },
      artifacts,
    });
  }

  const manifest: AutogenImportManifest = {
    schemaVersion: AUTOGEN_IMPORT_SCHEMA_VERSION,
    sourceBatch: {
      id: batchId,
      generatorSha: included[0]?.reproducibility.generatorSha ?? null,
      taxonomyVersion: SCENARIO_CATALOG_VERSION,
      selectionMode: "explicit_allowlist",
      selectionSha256,
    },
    target: { datasetId },
    scenes: included,
    exclusions: {
      notSelected: Math.max(0, scenes.size - considered.length),
      gateRejected: excluded.filter((e) =>
        e.reasons.some((r) => r.startsWith("gate_")),
      ).length,
      evidenceIncomplete: excluded.filter((e) =>
        e.reasons.some((r) => r.startsWith("missing_")),
      ).length,
      categoryUnresolved: excluded.filter((e) =>
        e.reasons.some(
          (r) => r === "category_unmapped" || r === "category_reserved",
        ),
      ).length,
      byReason,
    },
  };

  // The bundle is valid only if it satisfies the shared contract, so a
  // malformed bundle never reaches the import API at all.
  const parsed = AutogenImportManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 10)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("\n  ");
    throw new Error(`manifest failed validation:\n  ${detail}`);
  }

  const manifestJson = `${JSON.stringify(parsed.data, null, 2)}\n`;
  if (Buffer.byteLength(manifestJson) > IMPORT_LIMITS.maxManifestBytes) {
    throw new Error("manifest exceeds maxManifestBytes");
  }
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "manifest.json"), manifestJson);
  }

  return {
    manifest: parsed.data,
    included,
    excluded,
    discovered: scenes.size,
  };
}
