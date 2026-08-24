import type { AppContext } from "@/app/lib/db/app-context";
import { parseJsonObject } from "@/app/lib/db/json-helpers";
import { queryRows } from "@/app/lib/db/data-api";
import { getS3ObjectUtf8Bounded } from "@/app/lib/s3/s3-get-object";
import type { ScenarioExportInspectionDto } from "./contracts";

type ClosureRow = {
  export_id: string;
  revision_id: string;
  compiler_version: string;
  execution_package_id: string;
  manifest_sha256: string;
  xsd_sha256: string;
  capability_profile: string;
  xosc_artifact_id: string;
  xosc_sha256: string;
  manifest_bucket: string;
  manifest_key: string;
};

type ArtifactRow = {
  storage_bucket: string;
  storage_key: string;
};

const JSON_LIMIT = { maximumStoredBytes: 2 * 1024 * 1024, maximumRawBytes: 4 * 1024 * 1024 };

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function capabilityWarnings(value: unknown): ScenarioExportInspectionDto["capability"]["warnings"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const warning = jsonObject(candidate);
    if (
      typeof warning.code !== "string" ||
      typeof warning.path !== "string" ||
      typeof warning.reason !== "string"
    ) return [];
    return [{ code: warning.code, path: warning.path, reason: warning.reason }];
  });
}

/**
 * Reads the compiler's immutable manifest first, then resolves the capability artifact by the digest
 * recorded in that manifest. This keeps the inspection tied to the exact execution package rather
 * than picking the newest report for a revision.
 */
export async function inspectCompletedExport(
  context: AppContext,
  exportId: string,
): Promise<ScenarioExportInspectionDto | null> {
  const closure = (await queryRows<ClosureRow>(
    `SELECT e.id AS export_id, e.revision_id, e.compiler_version,
       ep.id AS execution_package_id, ep.manifest_sha256, ep.xsd_sha256,
       ep.capability_profile, ep.xosc_artifact_id, xa.sha256 AS xosc_sha256,
       ma.storage_bucket AS manifest_bucket, ma.storage_key AS manifest_key
     FROM uniscenario.exports e
     JOIN uniscenario.execution_packages ep
       ON ep.id = e.execution_package_id AND ep.workspace_id = e.workspace_id
     JOIN uniscenario.artifacts xa
       ON xa.id = ep.xosc_artifact_id AND xa.workspace_id = e.workspace_id
     JOIN uniscenario.artifacts ma
       ON ma.id = ep.package_artifact_id AND ma.workspace_id = e.workspace_id
     WHERE e.workspace_id = :workspace_id AND e.id = :export_id
       AND e.export_state = 'succeeded'
       AND xa.artifact_state = 'available' AND ma.artifact_state = 'available'
     LIMIT 1`,
    { workspace_id: context.workspaceId, export_id: exportId },
  ))[0];
  if (!closure) return null;

  const manifest = parseJsonObject(JSON.parse(await getS3ObjectUtf8Bounded(
    closure.manifest_bucket,
    closure.manifest_key,
    JSON_LIMIT,
  )));
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const capabilityDigest = files.find((candidate) => {
    const item = jsonObject(candidate);
    return item.kind === "capability-report" && typeof item.sha256 === "string";
  });
  const capabilitySha256 = jsonObject(capabilityDigest).sha256;
  if (typeof capabilitySha256 !== "string") throw new Error("compiler_capability_report_missing");

  // Capability reports are content-addressed: byte-identical reports across
  // revisions keep a single artifact row under whichever revision produced
  // them first, so the lookup must bind to the manifest's sha256 within the
  // workspace rather than to this export's revision.
  const artifact = (await queryRows<ArtifactRow>(
    `SELECT storage_bucket, storage_key FROM uniscenario.artifacts
     WHERE workspace_id = :workspace_id
       AND artifact_kind = 'compiler-capability-report' AND sha256 = :sha256
       AND artifact_state = 'available' LIMIT 1`,
    {
      workspace_id: context.workspaceId,
      sha256: capabilitySha256,
    },
  ))[0];
  if (!artifact) throw new Error("compiler_capability_report_unavailable");

  const report = parseJsonObject(JSON.parse(await getS3ObjectUtf8Bounded(
    artifact.storage_bucket,
    artifact.storage_key,
    JSON_LIMIT,
  )));
  const validation = jsonObject(report.validation);
  const openScenario = jsonObject(report.openScenario);
  const summarySource = jsonObject(openScenario.summary);
  const summary = Object.fromEntries(
    Object.entries(summarySource).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
  );
  const diagnostics = Array.isArray(validation.diagnostics)
    ? validation.diagnostics.filter((item): item is string => typeof item === "string")
    : [];
  const warnings = capabilityWarnings(report.warnings);
  if (validation.valid !== true || validation.xsdSha256 !== closure.xsd_sha256) {
    throw new Error("compiler_xsd_validation_mismatch");
  }

  return {
    exportId: closure.export_id,
    revisionId: closure.revision_id,
    executionPackageId: closure.execution_package_id,
    executionPackageSha256: closure.manifest_sha256,
    compilerVersion: closure.compiler_version,
    capabilityProfile: closure.capability_profile,
    xoscArtifactId: closure.xosc_artifact_id,
    xoscSha256: closure.xosc_sha256,
    xsdValidation: {
      valid: true,
      standard: typeof validation.standard === "string" ? validation.standard : "ASAM OpenSCENARIO XML 1.4.0",
      xsdSha256: closure.xsd_sha256,
      diagnostics,
    },
    capability: {
      contract: typeof report.contract === "string" ? report.contract : "",
      profile: typeof openScenario.profile === "string" ? openScenario.profile : closure.capability_profile,
      intent: typeof openScenario.intent === "string" ? openScenario.intent : "",
      roundTrip: typeof openScenario.roundTrip === "string" ? openScenario.roundTrip : "",
      externalSimulatorValidation: typeof openScenario.externalSimulatorValidation === "string"
        ? openScenario.externalSimulatorValidation
        : "",
      summary,
      warningCount: warnings.length,
      warnings,
    },
  };
}
