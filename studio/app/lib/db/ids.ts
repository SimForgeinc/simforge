import { createHash, randomUUID } from "node:crypto";

function digest(input: string) {
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

export function userIdForSub(sub: string) {
  return sub;
}

export function workspaceIdForSub(sub: string) {
  return `ws_${digest(`personal:${sub}`)}`;
}

export function workspaceSlugForSub(sub: string) {
  return `personal-${digest(sub).slice(0, 12)}`;
}

export const SIMFORGE_CANONICAL_WORKSPACE_ID = "ws_simforge_ai";
export const SIMFORGE_CANONICAL_ORGANIZATION_ID = "org_ws_simforge_ai";
export const SIMFORGE_CANONICAL_WORKSPACE_SLUG = "simforge-ai";
export const SIMFORGE_CANONICAL_ORGANIZATION_SLUG = "simforge";

export function organizationIdForWorkspace(workspaceId: string) {
  return `org_${workspaceId}`;
}

export function workspaceIdForOrganizationId(organizationId: string | null | undefined) {
  const trimmed = organizationId?.trim();
  if (!trimmed?.startsWith("org_ws_")) return null;
  return trimmed.slice("org_".length);
}

export function personalOrganizationIdForSub(sub: string) {
  return organizationIdForWorkspace(workspaceIdForSub(sub));
}

export function organizationMemberId(organizationId: string, userId: string) {
  return `mem_${digest(`${organizationId}:${userId}`)}`;
}

export function invitationTokenId(invitationId: string) {
  return invitationId;
}

export function scenarioRowId(workspaceId: string, scenarioId: string) {
  return `scn_${digest(`${workspaceId}:${scenarioId}`)}`;
}

export function draftRowId(workspaceId: string, scenarioId: string) {
  return `drf_${digest(`${workspaceId}:${scenarioId}`)}`;
}

export function templateRowId(workspaceId: string, templateKey: string) {
  return `tpl_${digest(`${workspaceId}:${templateKey}`)}`;
}

export function artifactRowId(workspaceId: string, scenarioId: string, s3Key: string) {
  return `art_${digest(`${workspaceId}:${scenarioId}:${s3Key}`)}`;
}

export function mapAssetRowId(mapAssetId: string) {
  return `map_${digest(mapAssetId)}`;
}

export function mapAssetArtifactRowId(mapAssetId: string, s3Key: string) {
  return `maa_${digest(`${mapAssetId}:${s3Key}`)}`;
}

export function candidateLocationRowId(mapAssetId: string, source: string, index: number) {
  return `cloc_${digest(`${mapAssetId}:${source}:${index}`)}`;
}

/**
 * Stable row ID derived from a content-stable cluster key (e.g. the sorted
 * Overture feature IDs that went into a cluster). Two runs that produce the
 * same cluster — even in a different order — yield the same row ID, so
 * per-source upserts don't churn IDs and downstream search-index signatures
 * stay stable. Mirrors the helper of the same name in
 * infra/lambdas/map-third-party-enrichment/src/ids.ts.
 */
export function candidateLocationRowIdFromKey(
  mapAssetId: string,
  source: string,
  key: string,
) {
  return `cloc_${digest(`${mapAssetId}:${source}:k:${key}`)}`;
}

export function executionJobRowId(workspaceId: string, providerJobId: string) {
  return `job_${digest(`${workspaceId}:${providerJobId}`)}`;
}

export function executionJobEventRowId(executionJobId: string, ordinal: number) {
  return `jev_${digest(`${executionJobId}:${ordinal}`)}`;
}

export function simulationSensorRowId(workspaceId: string, simulationId: string, sensorId: string) {
  return `ssr_${digest(`${workspaceId}:${simulationId}:${sensorId}`)}`;
}

export function simulationSequenceRowId(
  workspaceId: string,
  simulationId: string,
  sensorId: string,
  sequenceId: string,
  outputModality: string,
  isRaw: boolean,
) {
  return `sseq_${digest(`${workspaceId}:${simulationId}:${sensorId}:${sequenceId}:${outputModality}:${isRaw ? "raw" : "derived"}`)}`;
}

export function simulationFrameSampleRowId(
  workspaceId: string,
  simulationSequenceId: string,
  frameIndex: number,
) {
  return `sfs_${digest(`${workspaceId}:${simulationSequenceId}:${frameIndex}`)}`;
}

export function marketplacePurchaseRowId(
  workspaceId: string,
  itemType: string,
  itemKey: string,
) {
  return `mkt_${digest(`${workspaceId}:${itemType}:${itemKey}`)}`;
}

// --- Non-deterministic IDs for user-created entities ---

function randomId(): string {
  return randomUUID().replace(/-/g, "");
}

export function teamWorkspaceId(): string {
  return `ws_${randomId().slice(0, 24)}`;
}

export function projectId(): string {
  return `proj_${randomId().slice(0, 24)}`;
}

export function invitationId(): string {
  return `inv_${randomId().slice(0, 24)}`;
}

export function inviteToken(): string {
  return randomUUID().replace(/-/g, "");
}

export function datasetId(): string {
  return `ds_${randomId().slice(0, 24)}`;
}

export function datasetExportId(): string {
  return `dexp_${randomId().slice(0, 24)}`;
}

export function derivedExportJobId(): string {
  return `dexj_${randomId().slice(0, 24)}`;
}

export function sdgBatchId(): string {
  return `sdgb_${randomId().slice(0, 24)}`;
}

export function sdgVariantOutputId(): string {
  return `sdgv_${randomId().slice(0, 24)}`;
}

export function marketplaceTemplateId(): string {
  return `mktpl_${randomId().slice(0, 24)}`;
}

export function datasetScenarioId(): string {
  return `dsc_${randomId().slice(0, 24)}`;
}

export function datasetScenarioImportSessionId(): string {
  return `dsis_${randomId().slice(0, 24)}`;
}

export function datasetScenarioImportFileId(): string {
  return `dsif_${randomId().slice(0, 24)}`;
}

export function editorDocumentId(): string {
  return `edoc_${randomId().slice(0, 24)}`;
}

export function canonicalArtifactId(workspaceId: string, s3Bucket: string, s3KeyOrPrefix: string) {
  return `artc_${digest(`${workspaceId}:${s3Bucket}:${s3KeyOrPrefix}`)}`;
}

export function datasetSnapshotId(_datasetId?: string) {
  return `dss_${randomId().slice(0, 24)}`;
}

export function datasetSnapshotItemId(datasetSnapshotId: string, artifactId: string, role: string) {
  return `dsi_${digest(`${datasetSnapshotId}:${artifactId}:${role}`)}`;
}

export function datasetPublicationId(datasetSnapshotId: string, kind: string) {
  return `dpub_${digest(`${datasetSnapshotId}:${kind}:${randomId()}`)}`;
}

export function carlaJobId() {
  return `cj_${randomId().slice(0, 24)}`;
}

export function carlaJobEventId(carlaJobId: string, sequenceNumber: number) {
  return `cje_${digest(`${carlaJobId}:${sequenceNumber}`)}`;
}

export function datasetExportJobId() {
  return `dej_${randomId().slice(0, 24)}`;
}

export function datasetExportTaskId() {
  return `det_${randomId().slice(0, 24)}`;
}

export function datasetExportTaskAttemptId(taskId: string, attemptNumber: number) {
  return `deta_${digest(`${taskId}:${attemptNumber}`)}`;
}

export function datasetExportPublicationId() {
  return `depub_${randomId().slice(0, 24)}`;
}

export function enrichmentJobId(): string {
  return `ejob_${randomId().slice(0, 24)}`;
}

export function scenarioValidationJobId(): string {
  return `svjob_${randomId().slice(0, 24)}`;
}

export function scenarioParityReportId(): string {
  return `spr_${randomId().slice(0, 24)}`;
}

export function deploymentId(): string {
  return `dep_${randomId().slice(0, 24)}`;
}

export function deploymentCameraId(): string {
  return `dcam_${randomId().slice(0, 24)}`;
}

export function incidentId(): string {
  return `inc_${randomId().slice(0, 24)}`;
}

export function trafficMetricId(): string {
  return `tm_${randomId().slice(0, 24)}`;
}

export function workspaceAuditLogId(): string {
  return `waud_${randomId().slice(0, 24)}`;
}

export function artifactDeletionJobId(): string {
  return `adel_${randomId().slice(0, 24)}`;
}

export function artifactLifecycleEventId(): string {
  return `alev_${randomId().slice(0, 24)}`;
}

export function modelVersionId(): string {
  return `mv_${randomId().slice(0, 24)}`;
}

export function modelEndpointId(): string {
  return `mep_${randomId().slice(0, 24)}`;
}

export function modelRunId(): string {
  return `mrun_${randomId().slice(0, 24)}`;
}

export function modelRunAttemptId(runId: string, attemptNumber: number): string {
  return `mra_${digest(`${runId}:${attemptNumber}`)}`;
}

export function modelRunEventId(runId: string, ordinal: number): string {
  return `mrev_${digest(`${runId}:${ordinal}`)}`;
}

export function hifiPreviewRequestId(): string {
  return `hprev_${randomId().slice(0, 24)}`;
}
