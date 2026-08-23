import type {
  Dataset,
  CreateDatasetInput,
  DatasetStats,
  DatasetStatsRepairState,
  DatasetStatus,
} from "@simcloud/shared";
import { createHash } from "node:crypto";
import { datasetId } from "./ids";
import { execute, queryOne, queryRows, type SqlParams } from "./data-api";

export const SYSTEM_GLOBAL_WORKSPACE_ID = "ws_system_global";
export const TEMPLATE_SCENARIOS_DATASET_ID = "ds_template_scenarios";
export const DEFAULT_SCENARIOS_DATASET_NAME = "Unorganized Scenarios";
export const DEFAULT_SCENARIOS_DATASET_DESCRIPTION =
  "Unorganized working dataset for scenarios created from Maps and editor flows";

export const DATASET_POLICY_SENSITIVITY_VALUES = [
  "public",
  "internal",
  "confidential",
  "restricted",
] as const;
export type DatasetPolicySensitivity =
  (typeof DATASET_POLICY_SENSITIVITY_VALUES)[number];

export const DATASET_POLICY_PII_TYPE_VALUES = [
  "face",
  "license_plate",
  "precise_location",
  "voice",
  "biometric",
  "personal_identifier",
  "other",
] as const;
export type DatasetPolicyPiiType =
  (typeof DATASET_POLICY_PII_TYPE_VALUES)[number];

export const DATASET_POLICY_USE_RESTRICTION_VALUES = [
  "no_export",
  "no_training",
  "no_snapshot",
  "no_public_release",
  "pii_review_required",
  "anonymization_required",
  "retention_limited",
  "quarantined",
] as const;
export type DatasetPolicyUseRestriction =
  (typeof DATASET_POLICY_USE_RESTRICTION_VALUES)[number];

export const DATASET_RETENTION_POLICY_VALUES = [
  "standard",
  "retention_limited",
  "compliance_locked",
] as const;
export type DatasetRetentionPolicy =
  (typeof DATASET_RETENTION_POLICY_VALUES)[number];

export type DatasetPolicyMetadata = {
  sensitivity: DatasetPolicySensitivity;
  piiTypes: DatasetPolicyPiiType[];
  useRestrictions: DatasetPolicyUseRestriction[];
  retentionPolicy: DatasetRetentionPolicy;
  retentionExpiresAt: string | null;
  trainingAllowed: boolean;
  exportAllowed: boolean;
  snapshotAllowed: boolean;
  notes: string | null;
  gates: {
    trainingReady: boolean;
    exportReady: boolean;
    snapshotReady: boolean;
    trainingBlockers: string[];
    exportBlockers: string[];
    snapshotBlockers: string[];
    requiresPiiReview: boolean;
    requiresAnonymization: boolean;
  };
};

export type DatasetPolicyUpdate = {
  sensitivity?: DatasetPolicySensitivity;
  piiTypes?: DatasetPolicyPiiType[];
  useRestrictions?: DatasetPolicyUseRestriction[];
  retentionPolicy?: DatasetRetentionPolicy;
  retentionExpiresAt?: string | null;
  trainingAllowed?: boolean;
  exportAllowed?: boolean;
  snapshotAllowed?: boolean;
  notes?: string | null;
};

type DatasetWithPolicy = Dataset & { policy: DatasetPolicyMetadata };

const DEFAULT_DATASET_POLICY: DatasetPolicyMetadata = {
  sensitivity: "internal",
  piiTypes: [],
  useRestrictions: [],
  retentionPolicy: "standard",
  retentionExpiresAt: null,
  trainingAllowed: true,
  exportAllowed: true,
  snapshotAllowed: true,
  notes: null,
  gates: {
    trainingReady: true,
    exportReady: true,
    snapshotReady: true,
    trainingBlockers: [],
    exportBlockers: [],
    snapshotBlockers: [],
    requiresPiiReview: false,
    requiresAnonymization: false,
  },
};

function defaultDatasetIdForWorkspace(workspaceId: string) {
  return `ds_${createHash("md5").update(`${workspaceId}:default-scenarios`).digest("hex").slice(0, 24)}`;
}

// ---------------------------------------------------------------------------
// createDataset
// ---------------------------------------------------------------------------

export async function createDataset(
  workspaceId: string,
  userId: string,
  input: CreateDatasetInput,
): Promise<Dataset> {
  const id = datasetId();
  const now = new Date().toISOString();

  await execute(
    `
      INSERT INTO datasets (
        id,
        workspace_id,
        name,
        description,
        base_scenario_id,
        variation_config,
        status,
        total_variations,
        completed_variations,
        failed_variations,
        created_by_user_id,
        is_default,
        created_at,
        updated_at
      )
      VALUES (
        :id,
        :workspace_id,
        :name,
        :description,
        :base_scenario_id,
        :variation_config,
        'pending',
        :total_variations,
        0,
        0,
        :created_by_user_id,
        FALSE,
        NOW(),
        NOW()
      )
    `,
    {
      id,
      workspace_id: workspaceId,
      name: input.name,
      description: input.description ?? null,
      base_scenario_id: input.baseScenarioId ?? null,
      variation_config: input.variationConfig ?? null,
      total_variations: input.variationConfig?.count ?? 0,
      created_by_user_id: userId,
    },
  );

  return {
    id,
    workspaceId,
    name: input.name,
    description: input.description ?? null,
    baseScenarioId: input.baseScenarioId ?? null,
    variationConfig: input.variationConfig ?? null,
    status: "pending",
    totalVariations: input.variationConfig?.count ?? 0,
    completedVariations: 0,
    failedVariations: 0,
    createdByUserId: userId,
    scope: "workspace",
    mutability: "editable",
    copyPolicy: "allowed",
    systemSlug: null,
    isSystem: false,
    isDefault: false,
    stats: {
      scenarioCount: 0,
      renderSubmittedCount: 0,
      renderCompletedCount: 0,
      cosmosSubmittedCount: 0,
      cosmosCompletedCount: 0,
      modelSubmittedCount: 0,
      modelCompletedCount: 0,
      exportCompletedCount: 0,
      updatedAt: null,
      repairState: "healthy",
      version: 1,
    },
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// getDataset
// ---------------------------------------------------------------------------

type DatasetRow = {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  base_scenario_id: string | null;
  variation_config: string | null;
  status: string;
  total_variations: number;
  completed_variations: number;
  failed_variations: number;
  created_by_user_id: string | null;
  scope: string | null;
  mutability: string | null;
  copy_policy: string | null;
  system_slug: string | null;
  is_system: boolean | null;
  is_default: boolean | null;
  sensitivity: string | null;
  pii_types: string | null;
  use_restrictions: string | null;
  retention_policy: string | null;
  retention_expires_at: string | null;
  training_allowed: boolean | null;
  export_allowed: boolean | null;
  snapshot_allowed: boolean | null;
  policy_notes: string | null;
  stats_scenario_count: number | null;
  stats_render_submitted_count: number | null;
  stats_render_completed_count: number | null;
  stats_cosmos_submitted_count: number | null;
  stats_cosmos_completed_count: number | null;
  stats_model_submitted_count: number | null;
  stats_model_completed_count: number | null;
  stats_export_completed_count: number | null;
  stats_updated_at: string | null;
  stats_repair_state: string | null;
  stats_version: number | null;
  created_at: string;
  updated_at: string;
};

function isAllowedValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function parseJsonArray<T extends string>(
  raw: string | null | undefined,
  allowed: readonly T[],
): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((entry) => isAllowedValue(entry, allowed)))];
  } catch {
    return [];
  }
}

export function isDatasetPolicyRetentionLimited(
  policy: Pick<DatasetPolicyMetadata, "retentionPolicy" | "useRestrictions">,
): boolean {
  return (
    policy.retentionPolicy === "retention_limited" ||
    policy.useRestrictions.includes("retention_limited")
  );
}

export function isDatasetPolicyRetentionExpired(
  policy: Pick<DatasetPolicyMetadata, "retentionExpiresAt">,
  now = new Date(),
): boolean {
  return (
    policy.retentionExpiresAt !== null &&
    Date.parse(policy.retentionExpiresAt) <= now.getTime()
  );
}

function buildPolicyGates(input: {
  sensitivity: DatasetPolicySensitivity;
  piiTypes: DatasetPolicyPiiType[];
  useRestrictions: DatasetPolicyUseRestriction[];
  retentionPolicy: DatasetRetentionPolicy;
  retentionExpiresAt: string | null;
  trainingAllowed: boolean;
  exportAllowed: boolean;
  snapshotAllowed: boolean;
}) {
  const restrictions = new Set(input.useRestrictions);
  const requiresPiiReview =
    input.piiTypes.length > 0 || restrictions.has("pii_review_required");
  const requiresAnonymization = restrictions.has("anonymization_required");
  const retentionExpired = isDatasetPolicyRetentionExpired(input);
  const trainingBlockers: string[] = [];
  const exportBlockers: string[] = [];
  const snapshotBlockers: string[] = [];

  if (!input.trainingAllowed) trainingBlockers.push("training_not_allowed");
  if (restrictions.has("no_training")) trainingBlockers.push("restricted_no_training");
  if (restrictions.has("quarantined")) trainingBlockers.push("dataset_quarantined");
  if (input.sensitivity === "restricted") trainingBlockers.push("restricted_sensitivity");
  if (requiresPiiReview) trainingBlockers.push("pii_review_required");
  if (requiresAnonymization) trainingBlockers.push("anonymization_required");
  if (retentionExpired) trainingBlockers.push("retention_expired");

  if (!input.exportAllowed) exportBlockers.push("export_not_allowed");
  if (restrictions.has("no_export")) exportBlockers.push("restricted_no_export");
  if (restrictions.has("quarantined")) exportBlockers.push("dataset_quarantined");
  if (input.sensitivity === "restricted") exportBlockers.push("restricted_sensitivity");
  if (requiresPiiReview) exportBlockers.push("pii_review_required");
  if (retentionExpired) exportBlockers.push("retention_expired");

  if (!input.snapshotAllowed) snapshotBlockers.push("snapshot_not_allowed");
  if (restrictions.has("no_snapshot")) snapshotBlockers.push("restricted_no_snapshot");
  if (restrictions.has("quarantined")) snapshotBlockers.push("dataset_quarantined");
  if (retentionExpired) snapshotBlockers.push("retention_expired");

  return {
    trainingReady: trainingBlockers.length === 0,
    exportReady: exportBlockers.length === 0,
    snapshotReady: snapshotBlockers.length === 0,
    trainingBlockers,
    exportBlockers,
    snapshotBlockers,
    requiresPiiReview,
    requiresAnonymization,
  };
}

function rowToDatasetPolicy(row: Partial<DatasetRow>): DatasetPolicyMetadata {
  const sensitivity = isAllowedValue(
    row.sensitivity,
    DATASET_POLICY_SENSITIVITY_VALUES,
  )
    ? row.sensitivity
    : DEFAULT_DATASET_POLICY.sensitivity;
  const piiTypes = parseJsonArray(
    row.pii_types,
    DATASET_POLICY_PII_TYPE_VALUES,
  );
  const useRestrictions = parseJsonArray(
    row.use_restrictions,
    DATASET_POLICY_USE_RESTRICTION_VALUES,
  );
  const retentionPolicy = isAllowedValue(
    row.retention_policy,
    DATASET_RETENTION_POLICY_VALUES,
  )
    ? row.retention_policy
    : DEFAULT_DATASET_POLICY.retentionPolicy;
  const trainingAllowed = row.training_allowed ?? true;
  const exportAllowed = row.export_allowed ?? true;
  const snapshotAllowed = row.snapshot_allowed ?? true;

  return {
    sensitivity,
    piiTypes,
    useRestrictions,
    retentionPolicy,
    retentionExpiresAt: row.retention_expires_at ?? null,
    trainingAllowed,
    exportAllowed,
    snapshotAllowed,
    notes: row.policy_notes ?? null,
    gates: buildPolicyGates({
      sensitivity,
      piiTypes,
      useRestrictions,
      retentionPolicy,
      retentionExpiresAt: row.retention_expires_at ?? null,
      trainingAllowed,
      exportAllowed,
      snapshotAllowed,
    }),
  };
}

export function getDefaultDatasetPolicy(): DatasetPolicyMetadata {
  return {
    ...DEFAULT_DATASET_POLICY,
    piiTypes: [],
    useRestrictions: [],
    gates: {
      ...DEFAULT_DATASET_POLICY.gates,
      trainingBlockers: [],
      exportBlockers: [],
      snapshotBlockers: [],
    },
  };
}

function attachPolicy(dataset: Dataset, policy: DatasetPolicyMetadata): Dataset {
  return Object.assign(dataset, { policy }) as DatasetWithPolicy;
}

function rowToDataset(row: DatasetRow): Dataset {
  const dataset: Dataset = {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    baseScenarioId: row.base_scenario_id,
    variationConfig: row.variation_config ? JSON.parse(row.variation_config) : null,
    status: row.status as DatasetStatus,
    totalVariations: row.total_variations,
    completedVariations: row.completed_variations,
    failedVariations: row.failed_variations,
    createdByUserId: row.created_by_user_id,
    scope: row.scope === "global" ? "global" : "workspace",
    mutability: row.mutability === "read_only" ? "read_only" : "editable",
    copyPolicy: row.copy_policy === "blocked" ? "blocked" : "allowed",
    systemSlug: row.system_slug,
    isSystem: Boolean(row.is_system),
    isDefault: Boolean(row.is_default),
    stats: {
      scenarioCount: row.stats_scenario_count ?? 0,
      renderSubmittedCount: row.stats_render_submitted_count ?? 0,
      renderCompletedCount: row.stats_render_completed_count ?? 0,
      cosmosSubmittedCount: row.stats_cosmos_submitted_count ?? 0,
      cosmosCompletedCount: row.stats_cosmos_completed_count ?? 0,
      modelSubmittedCount: row.stats_model_submitted_count ?? 0,
      modelCompletedCount: row.stats_model_completed_count ?? 0,
      exportCompletedCount: row.stats_export_completed_count ?? 0,
      updatedAt: row.stats_updated_at ?? null,
      repairState: isAllowedValue(
        row.stats_repair_state,
        ["healthy", "dirty", "repairing"] as const,
      )
        ? row.stats_repair_state
        : ("dirty" satisfies DatasetStatsRepairState),
      version: row.stats_version ?? 1,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return attachPolicy(dataset, rowToDatasetPolicy(row));
}

const DATASET_SELECT = `
  SELECT
    id,
    workspace_id,
    name,
    description,
    base_scenario_id,
    variation_config::text AS variation_config,
    status,
    total_variations,
    completed_variations,
    failed_variations,
    created_by_user_id,
    COALESCE(scope, 'workspace') AS scope,
    COALESCE(mutability, 'editable') AS mutability,
    COALESCE(copy_policy, 'allowed') AS copy_policy,
    system_slug,
    COALESCE(is_system, FALSE) AS is_system,
    COALESCE(is_default, FALSE) AS is_default,
    COALESCE(sensitivity, 'internal') AS sensitivity,
    COALESCE(pii_types, '[]'::jsonb)::text AS pii_types,
    COALESCE(use_restrictions, '[]'::jsonb)::text AS use_restrictions,
    COALESCE(retention_policy, 'standard') AS retention_policy,
    retention_expires_at::text AS retention_expires_at,
    COALESCE(training_allowed, TRUE) AS training_allowed,
    COALESCE(export_allowed, TRUE) AS export_allowed,
    COALESCE(snapshot_allowed, TRUE) AS snapshot_allowed,
    policy_notes,
    COALESCE(stats_scenario_count, 0) AS stats_scenario_count,
    COALESCE(stats_render_submitted_count, 0) AS stats_render_submitted_count,
    COALESCE(stats_render_completed_count, 0) AS stats_render_completed_count,
    COALESCE(stats_cosmos_submitted_count, 0) AS stats_cosmos_submitted_count,
    COALESCE(stats_cosmos_completed_count, 0) AS stats_cosmos_completed_count,
    COALESCE(stats_model_submitted_count, 0) AS stats_model_submitted_count,
    COALESCE(stats_model_completed_count, 0) AS stats_model_completed_count,
    COALESCE(stats_export_completed_count, 0) AS stats_export_completed_count,
    stats_updated_at::text AS stats_updated_at,
    COALESCE(stats_repair_state, 'healthy') AS stats_repair_state,
    COALESCE(stats_version, 1) AS stats_version,
    created_at::text AS created_at,
    updated_at::text AS updated_at
  FROM datasets
`;

// Dataset collection views only need summary metadata. In particular,
// variation_config.extra_params may contain large generated payloads; selecting
// every config for every dataset can exceed the Aurora Data API's immutable
// 1 MB response limit before the application gets a chance to serialize it.
// Keep detail reads lossless through DATASET_SELECT, while list reads omit that
// blob and bound user-authored prose. Page the query as a second guard against
// workspace growth crossing the same Data API limit later.

export async function getDataset(
  workspaceId: string,
  id: string,
): Promise<Dataset | null> {
  const row = await queryOne<DatasetRow>(
    `
      ${DATASET_SELECT}
      WHERE workspace_id = :workspace_id
        AND id = :id
      LIMIT 1
    `,
    { workspace_id: workspaceId, id },
  );

  return row ? rowToDataset(row) : null;
}

// ---------------------------------------------------------------------------
// getDatasetById
// ---------------------------------------------------------------------------

export async function getDatasetById(id: string): Promise<Dataset | null> {
  const row = await queryOne<DatasetRow>(
    `
      ${DATASET_SELECT}
      WHERE id = :id
      LIMIT 1
    `,
    { id },
  );

  return row ? rowToDataset(row) : null;
}

// ---------------------------------------------------------------------------
// Dataset summaries for the index
// ---------------------------------------------------------------------------

/**
 * The columns a dataset SUMMARY is built from, and nothing else.
 *
 * The index used to run `DATASET_LIST_SELECT` and hand whole `Dataset` objects
 * to `toDatasetSummary`, which then dropped twelve of them -- policy metadata
 * (`pii_types`, `use_restrictions`, `policy_notes`, the retention and
 * allowed-use flags), `base_scenario_id`, `created_by_user_id`,
 * `variation_config` -- after the Data API had already serialized every one for
 * every row. 39 columns fetched to render 7.
 *
 * `workspace_id`, `system_slug` and `is_system` are here despite not reaching
 * the summary: `effectiveDatasetMutability` needs them to decide whether the
 * caller may edit the dataset.
 */
const DATASET_SUMMARY_SELECT = `
  SELECT
    id,
    workspace_id,
    LEFT(name, 512) AS name,
    LEFT(description, 2048) AS description,
    COALESCE(scope, 'workspace') AS scope,
    COALESCE(mutability, 'editable') AS mutability,
    system_slug,
    COALESCE(is_system, FALSE) AS is_system,
    COALESCE(stats_scenario_count, 0) AS stats_scenario_count,
    COALESCE(stats_render_submitted_count, 0) AS stats_render_submitted_count,
    COALESCE(stats_render_completed_count, 0) AS stats_render_completed_count,
    COALESCE(stats_cosmos_submitted_count, 0) AS stats_cosmos_submitted_count,
    COALESCE(stats_cosmos_completed_count, 0) AS stats_cosmos_completed_count,
    COALESCE(stats_model_submitted_count, 0) AS stats_model_submitted_count,
    COALESCE(stats_model_completed_count, 0) AS stats_model_completed_count,
    COALESCE(stats_export_completed_count, 0) AS stats_export_completed_count,
    stats_updated_at::text AS stats_updated_at,
    COALESCE(stats_repair_state, 'healthy') AS stats_repair_state,
    COALESCE(stats_version, 1) AS stats_version,
    updated_at::text AS updated_at
  FROM datasets
`;

type DatasetSummaryRow = Pick<
  DatasetRow,
  | "id"
  | "workspace_id"
  | "name"
  | "description"
  | "scope"
  | "mutability"
  | "system_slug"
  | "is_system"
  | "stats_scenario_count"
  | "stats_render_submitted_count"
  | "stats_render_completed_count"
  | "stats_cosmos_submitted_count"
  | "stats_cosmos_completed_count"
  | "stats_model_submitted_count"
  | "stats_model_completed_count"
  | "stats_export_completed_count"
  | "stats_updated_at"
  | "stats_repair_state"
  | "stats_version"
  | "updated_at"
>;

/** What the dataset index and `/api/datasets` render, before access is applied. */
export type DatasetSummarySource = {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  scope: "workspace" | "global";
  mutability: "editable" | "read_only";
  systemSlug: string | null;
  isSystem: boolean;
  stats: DatasetStats;
  updatedAt: string;
};

function rowToDatasetSummarySource(row: DatasetSummaryRow): DatasetSummarySource {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    scope: row.scope === "global" ? "global" : "workspace",
    mutability: row.mutability === "read_only" ? "read_only" : "editable",
    systemSlug: row.system_slug,
    isSystem: Boolean(row.is_system),
    stats: {
      scenarioCount: row.stats_scenario_count ?? 0,
      renderSubmittedCount: row.stats_render_submitted_count ?? 0,
      renderCompletedCount: row.stats_render_completed_count ?? 0,
      cosmosSubmittedCount: row.stats_cosmos_submitted_count ?? 0,
      cosmosCompletedCount: row.stats_cosmos_completed_count ?? 0,
      modelSubmittedCount: row.stats_model_submitted_count ?? 0,
      modelCompletedCount: row.stats_model_completed_count ?? 0,
      exportCompletedCount: row.stats_export_completed_count ?? 0,
      updatedAt: row.stats_updated_at ?? null,
      repairState: isAllowedValue(
        row.stats_repair_state,
        ["healthy", "dirty", "repairing"] as const,
      )
        ? row.stats_repair_state
        : ("dirty" satisfies DatasetStatsRepairState),
      version: row.stats_version ?? 1,
    },
    updatedAt: row.updated_at,
  };
}

/**
 * Every dataset the workspace can see, in one round trip.
 *
 * This used to page at 100 rows in a sequential `while` loop -- each page
 * waiting on the last, so the cost grew linearly in ROUND TRIPS rather than in
 * rows, and the Aurora Data API charges a lot per round trip. The loop bought
 * nothing: there was no cursor to resume from and every page was concatenated
 * before returning, so it was one query wearing several queries' latency.
 *
 * `LIST_HARD_CAP` is a runaway guard, not a page size. A workspace at the cap
 * has a product problem the index cannot render anyway; ordering puts templates
 * and defaults first so the truncation, if it ever happens, drops the least
 * useful rows.
 */
const LIST_HARD_CAP = 5000;

export async function listDatasetSummarySourcesForWorkspace(
  workspaceId: string,
): Promise<DatasetSummarySource[]> {
  const rows = await queryRows<DatasetSummaryRow>(
    `
      ${DATASET_SUMMARY_SELECT}
      WHERE workspace_id = :workspace_id
         OR scope = 'global'
         OR is_system = TRUE
      ORDER BY
        CASE
          WHEN system_slug = 'template-scenarios' THEN 0
          WHEN COALESCE(is_default, FALSE) THEN 1
          ELSE 2
        END,
        created_at DESC,
        id DESC
      LIMIT :limit
    `,
    { workspace_id: workspaceId, limit: LIST_HARD_CAP },
  );
  return rows.map(rowToDatasetSummarySource);
}

export async function getDefaultDatasetForWorkspace(
  workspaceId: string,
): Promise<Dataset | null> {
  const row = await queryOne<DatasetRow>(
    `
      ${DATASET_SELECT}
      WHERE workspace_id = :workspace_id
        AND COALESCE(is_default, FALSE) = TRUE
      LIMIT 1
    `,
    { workspace_id: workspaceId },
  );

  return row ? rowToDataset(row) : null;
}

export async function ensureDefaultDatasetForWorkspace(
  workspaceId: string,
  userId: string | null,
): Promise<Dataset> {
  const existing = await getDefaultDatasetForWorkspace(workspaceId);
  if (existing) return existing;

  const id = defaultDatasetIdForWorkspace(workspaceId);

  try {
    await execute(
      `
        INSERT INTO datasets (
          id,
          workspace_id,
          name,
          description,
          status,
          total_variations,
          completed_variations,
          failed_variations,
          created_by_user_id,
          scope,
          mutability,
          copy_policy,
          is_system,
          is_default,
          created_at,
          updated_at
        )
        SELECT
          :id,
          :workspace_id,
          :name,
          :description,
          'pending',
          0,
          0,
          0,
          :created_by_user_id,
          'workspace',
          'editable',
          'allowed',
          FALSE,
          TRUE,
          NOW(),
          NOW()
        WHERE NOT EXISTS (
          SELECT 1
          FROM datasets
          WHERE workspace_id = :workspace_id
            AND COALESCE(is_default, FALSE) = TRUE
        )
      `,
      {
        id,
        workspace_id: workspaceId,
        name: DEFAULT_SCENARIOS_DATASET_NAME,
        description: DEFAULT_SCENARIOS_DATASET_DESCRIPTION,
        created_by_user_id: userId,
      },
    );
  } catch (error) {
    const concurrent = await getDefaultDatasetForWorkspace(workspaceId);
    if (concurrent) return concurrent;
    throw error;
  }

  const created = await getDefaultDatasetForWorkspace(workspaceId);
  if (!created) {
    throw new Error(`Default dataset missing after ensure for workspace ${workspaceId}`);
  }
  return created;
}

// ---------------------------------------------------------------------------
// updateDatasetStatus
// ---------------------------------------------------------------------------

export async function updateDatasetStatus(
  workspaceId: string,
  id: string,
  status: DatasetStatus,
): Promise<void> {
  await execute(
    `
      UPDATE datasets
      SET status = :status, updated_at = NOW()
      WHERE workspace_id = :workspace_id
        AND id = :id
    `,
    { workspace_id: workspaceId, id, status },
  );
}

// ---------------------------------------------------------------------------
// updateDatasetVariationCounts
// ---------------------------------------------------------------------------

export async function updateDatasetVariationCounts(
  workspaceId: string,
  id: string,
  counts: { completedVariations?: number; failedVariations?: number },
): Promise<void> {
  if (counts.completedVariations !== undefined) {
    await execute(
      `
        UPDATE datasets
        SET completed_variations = :completed_variations, updated_at = NOW()
        WHERE workspace_id = :workspace_id
          AND id = :id
      `,
      { workspace_id: workspaceId, id, completed_variations: counts.completedVariations },
    );
  }
  if (counts.failedVariations !== undefined) {
    await execute(
      `
        UPDATE datasets
        SET failed_variations = :failed_variations, updated_at = NOW()
        WHERE workspace_id = :workspace_id
          AND id = :id
      `,
      { workspace_id: workspaceId, id, failed_variations: counts.failedVariations },
    );
  }
}

// ---------------------------------------------------------------------------
// updateDataset
// ---------------------------------------------------------------------------

export async function updateDataset(
  workspaceId: string,
  id: string,
  updates: { name?: string; description?: string | null; status?: DatasetStatus },
): Promise<void> {
  const parts: string[] = [];
  const params: SqlParams = { workspace_id: workspaceId, id };

  if (updates.name !== undefined) {
    parts.push("name = :name");
    params.name = updates.name;
  }
  if ("description" in updates) {
    parts.push("description = :description");
    params.description = updates.description ?? null;
  }
  if (updates.status !== undefined) {
    parts.push("status = :status");
    params.status = updates.status;
  }
  if (parts.length === 0) return;

  await execute(
    `UPDATE datasets SET ${parts.join(", ")}, updated_at = NOW()
     WHERE workspace_id = :workspace_id AND id = :id`,
    params,
  );
}

// ---------------------------------------------------------------------------
// dataset policy
// ---------------------------------------------------------------------------

export async function getDatasetPolicy(
  workspaceId: string,
  id: string,
): Promise<DatasetPolicyMetadata | null> {
  const row = await queryOne<DatasetRow>(
    `
      ${DATASET_SELECT}
      WHERE workspace_id = :workspace_id
        AND id = :id
      LIMIT 1
    `,
    { workspace_id: workspaceId, id },
  );

  return row ? rowToDatasetPolicy(row) : null;
}

export async function getDatasetPolicyForSnapshot(
  workspaceId: string,
  snapshotId: string,
): Promise<DatasetPolicyMetadata | null> {
  const row = await queryOne<{
    policy_snapshot_json: string | Record<string, unknown> | null;
    sensitivity: string | null;
    pii_types: string | null;
    use_restrictions: string | null;
    retention_policy: string | null;
    retention_expires_at: string | null;
    training_allowed: boolean | null;
    export_allowed: boolean | null;
    snapshot_allowed: boolean | null;
    policy_notes: string | null;
  }>(
    `
      SELECT
        NULLIF(ds.policy_snapshot_json, '{}'::jsonb)::text AS policy_snapshot_json,
        d.sensitivity,
        d.pii_types::text AS pii_types,
        d.use_restrictions::text AS use_restrictions,
        d.retention_policy,
        d.retention_expires_at::text AS retention_expires_at,
        d.training_allowed,
        d.export_allowed,
        d.snapshot_allowed,
        d.policy_notes
      FROM dataset_snapshots ds
      JOIN datasets d
        ON d.id = ds.dataset_id
       AND d.workspace_id = ds.workspace_id
      WHERE ds.workspace_id = :workspace_id
        AND ds.id = :snapshot_id
      LIMIT 1
    `,
    { workspace_id: workspaceId, snapshot_id: snapshotId },
  );

  if (!row) return null;
  if (row.policy_snapshot_json) {
    const policy =
      typeof row.policy_snapshot_json === "string"
        ? JSON.parse(row.policy_snapshot_json) as Record<string, unknown>
        : row.policy_snapshot_json;
    return rowToDatasetPolicy({
      sensitivity: typeof policy.sensitivity === "string" ? policy.sensitivity : null,
      pii_types: JSON.stringify(policy.piiTypes ?? []),
      use_restrictions: JSON.stringify(policy.useRestrictions ?? []),
      retention_policy: typeof policy.retentionPolicy === "string" ? policy.retentionPolicy : null,
      retention_expires_at: typeof policy.retentionExpiresAt === "string" ? policy.retentionExpiresAt : null,
      training_allowed: typeof policy.trainingAllowed === "boolean" ? policy.trainingAllowed : null,
      export_allowed: typeof policy.exportAllowed === "boolean" ? policy.exportAllowed : null,
      snapshot_allowed: typeof policy.snapshotAllowed === "boolean" ? policy.snapshotAllowed : null,
      policy_notes: typeof policy.notes === "string" ? policy.notes : null,
    });
  }
  return rowToDatasetPolicy(row);
}

export async function updateDatasetPolicy(
  workspaceId: string,
  id: string,
  updates: DatasetPolicyUpdate,
): Promise<void> {
  const parts: string[] = [];
  const params: SqlParams = { workspace_id: workspaceId, id };

  if (updates.sensitivity !== undefined) {
    parts.push("sensitivity = :sensitivity");
    params.sensitivity = updates.sensitivity;
  }
  if (updates.piiTypes !== undefined) {
    parts.push("pii_types = :pii_types::jsonb");
    params.pii_types = JSON.stringify([...new Set(updates.piiTypes)]);
  }
  if (updates.useRestrictions !== undefined) {
    parts.push("use_restrictions = :use_restrictions::jsonb");
    params.use_restrictions = JSON.stringify([...new Set(updates.useRestrictions)]);
  }
  if (updates.retentionPolicy !== undefined) {
    parts.push("retention_policy = :retention_policy");
    params.retention_policy = updates.retentionPolicy;
  }
  if ("retentionExpiresAt" in updates) {
    parts.push("retention_expires_at = :retention_expires_at");
    params.retention_expires_at = updates.retentionExpiresAt ?? null;
  }
  if (updates.trainingAllowed !== undefined) {
    parts.push("training_allowed = :training_allowed");
    params.training_allowed = updates.trainingAllowed;
  }
  if (updates.exportAllowed !== undefined) {
    parts.push("export_allowed = :export_allowed");
    params.export_allowed = updates.exportAllowed;
  }
  if (updates.snapshotAllowed !== undefined) {
    parts.push("snapshot_allowed = :snapshot_allowed");
    params.snapshot_allowed = updates.snapshotAllowed;
  }
  if ("notes" in updates) {
    parts.push("policy_notes = :policy_notes");
    params.policy_notes = updates.notes ?? null;
  }
  if (parts.length === 0) return;

  await execute(
    `UPDATE datasets SET ${parts.join(", ")}, updated_at = NOW()
     WHERE workspace_id = :workspace_id AND id = :id`,
    params,
  );
}

// ---------------------------------------------------------------------------
// deleteDataset
// ---------------------------------------------------------------------------

export async function deleteDataset(
  workspaceId: string,
  id: string,
): Promise<void> {
  await execute(
    `
      DELETE FROM datasets
      WHERE workspace_id = :workspace_id
        AND id = :id
    `,
    { workspace_id: workspaceId, id },
  );
}
