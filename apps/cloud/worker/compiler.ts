import { createRequire } from "node:module";
import { hostname } from "node:os";
import { setTimeout as wait } from "node:timers/promises";

import { COMPILER_VERSION, compileClaim, type CompileResult, type CompilerArtifact, type CompilerArtifactKind, type CompilerClaim } from "./compiler-core.js";

const LEASE_SECONDS = 900;
const HEARTBEAT_MS = 30_000;
const POLL_MS = 1_000;
const DIGEST = /^[a-f0-9]{64}$/;

type JsonObject = Record<string, unknown>;
type Reservation = { id: string; kind: CompilerArtifactKind; uploadRequired: boolean; uploadUrl: string | null };

class CompilerClient {
  constructor(private readonly baseUrl: URL, private readonly token: string, readonly workerId: string) {}

  private async post(path: string, payload: unknown, signal: AbortSignal, allowNoContent = false): Promise<JsonObject | null> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    });
    if (allowNoContent && response.status === 204) return null;
    if (!response.ok) throw new Error(`compiler API ${path} returned ${response.status}: ${(await response.text()).slice(0, 2_048)}`);
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("compiler API returned non-object JSON");
    return value as JsonObject;
  }

  async claim(signal: AbortSignal): Promise<CompilerClaim | null> {
    const value = await this.post("/api/uniscenario/internal/exports/claim", { workerId: this.workerId, leaseSeconds: LEASE_SECONDS }, signal, true);
    if (!value) return null;
    return parseClaim(value);
  }

  async heartbeat(claim: CompilerClaim, signal: AbortSignal): Promise<void> {
    await this.post(`/api/uniscenario/internal/exports/${encodeURIComponent(claim.exportId)}/heartbeat`, fence(claim, { leaseSeconds: LEASE_SECONDS }), signal);
  }

  async reserve(claim: CompilerClaim, artifacts: readonly CompilerArtifact[], signal: AbortSignal): Promise<Reservation[]> {
    const value = await this.post(`/api/uniscenario/internal/exports/${encodeURIComponent(claim.exportId)}/reserve`, fence(claim, {
      artifacts: artifacts.map((item) => ({ kind: item.kind, mediaType: item.mediaType, sha256: item.sha256, sizeBytes: item.bytes.byteLength })),
    }), signal);
    const rows = value?.artifacts;
    if (!Array.isArray(rows) || rows.length !== artifacts.length) throw new Error("compiler_reservation_invalid");
    return rows.map((row) => {
      const item = object(row); const kind = string(item.kind) as CompilerArtifactKind;
      if (!artifacts.some((artifact) => artifact.kind === kind)) throw new Error("compiler_reservation_kind_invalid");
      return { id: string(item.id), kind, uploadRequired: item.uploadRequired === true, uploadUrl: item.uploadUrl === null ? null : string(item.uploadUrl) };
    });
  }

  async upload(artifact: CompilerArtifact, reservation: Reservation, signal: AbortSignal): Promise<void> {
    if (!reservation.uploadRequired) return;
    if (!reservation.uploadUrl) throw new Error("compiler_upload_url_missing");
    const response = await fetch(reservation.uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": artifact.mediaType,
        "x-amz-checksum-sha256": Buffer.from(artifact.sha256, "hex").toString("base64"),
        "x-amz-sdk-checksum-algorithm": "SHA256",
      },
      body: artifact.bytes as BodyInit,
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    });
    if (!response.ok) throw new Error(`compiler_upload_failed:${response.status}`);
  }

  async complete(claim: CompilerClaim, result: CompileResult, reservations: readonly Reservation[], signal: AbortSignal): Promise<void> {
    const byKind = new Map(reservations.map((item) => [item.kind, item]));
    await this.post(`/api/uniscenario/internal/exports/${encodeURIComponent(claim.exportId)}/complete`, fence(claim, {
      artifacts: result.artifacts.map((item) => ({ id: byKind.get(item.kind)?.id, kind: item.kind, sha256: item.sha256, sizeBytes: item.bytes.byteLength })),
      manifestSha256: result.manifestSha256,
      xsdSha256: result.xsdSha256,
      sourceInputDigest: result.sourceInputDigest,
    }), signal);
  }

  async fail(claim: CompilerClaim, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^[a-z0-9_:-]+$/i.test(message) ? message.slice(0, 100) : "compiler_failed";
    await this.post(`/api/uniscenario/internal/exports/${encodeURIComponent(claim.exportId)}/fail`, fence(claim, {
      code,
      detail: { category: error instanceof Error ? error.name : "UnknownError", message: message.slice(0, 2_000) },
    }), AbortSignal.timeout(30_000));
  }
}

export async function runCompilerLoop(baseUrl: string | URL, token: string, signal: AbortSignal): Promise<void> {
  const workerId = process.env.UNISCENARIO_COMPILER_WORKER_ID?.trim() || `local-compiler-${hostname().replace(/[^A-Za-z0-9._:-]/g, "-")}-${process.pid}`;
  const client = new CompilerClient(new URL(baseUrl), token, workerId);
  const xsdPath = createRequire(import.meta.url).resolve("@uniscenarios/openscenario/schema/OpenSCENARIO.xsd");
  process.stdout.write(`${JSON.stringify({ component: "uniscenarios-local-compiler", event: "worker.started", workerId, compilerVersion: COMPILER_VERSION })}\n`);
  while (!signal.aborted) {
    const claim = await client.claim(signal);
    if (!claim) { await delay(POLL_MS, signal); continue; }
    await runClaim(client, claim, xsdPath, signal);
  }
}

async function runClaim(client: CompilerClient, claim: CompilerClaim, xsdPath: string, workerSignal: AbortSignal): Promise<void> {
  const job = new AbortController(); const signal = AbortSignal.any([workerSignal, job.signal]);
  const heartbeat = runHeartbeat(client, claim, job, workerSignal);
  try {
    const result = await compileClaim(claim, xsdPath, signal);
    const reservations = await client.reserve(claim, result.artifacts, signal);
    for (const artifact of result.artifacts) {
      const reservation = reservations.find((item) => item.kind === artifact.kind);
      if (!reservation) throw new Error(`compiler_reservation_missing:${artifact.kind}`);
      await client.upload(artifact, reservation, signal);
    }
    job.abort(new Error("compile complete")); await heartbeat;
    await client.complete(claim, result, reservations, workerSignal);
    process.stdout.write(`${JSON.stringify({ component: "uniscenarios-local-compiler", event: "job.completed", exportId: claim.exportId, sourceInputDigest: result.sourceInputDigest })}\n`);
  } catch (error) {
    job.abort(error); await heartbeat.catch(() => undefined);
    if (workerSignal.aborted) throw workerSignal.reason;
    await client.fail(claim, error).catch((failure) => process.stderr.write(`${JSON.stringify({ component: "uniscenarios-local-compiler", event: "failure_callback.failed", exportId: claim.exportId, error: failure instanceof Error ? failure.message : String(failure) })}\n`));
    process.stderr.write(`${JSON.stringify({ component: "uniscenarios-local-compiler", event: "job.failed", exportId: claim.exportId, error: error instanceof Error ? error.message : String(error) })}\n`);
  }
}

async function runHeartbeat(client: CompilerClient, claim: CompilerClaim, job: AbortController, workerSignal: AbortSignal): Promise<void> {
  while (!job.signal.aborted && !workerSignal.aborted) {
    await delay(HEARTBEAT_MS, AbortSignal.any([job.signal, workerSignal])).catch(() => undefined);
    if (job.signal.aborted || workerSignal.aborted) return;
    try { await client.heartbeat(claim, workerSignal); } catch (error) { job.abort(error); return; }
  }
}

function parseClaim(value: JsonObject): CompilerClaim {
  if (value.contract !== "uniscenario.compiler-claim/v1") throw new Error("compiler_claim_contract_invalid");
  const revision = object(value.revision); const map = object(value.map); const ambient = object(value.ambient); const materializedTraffic = object(ambient.materializedTraffic);
  const artifacts = map.artifacts; if (!Array.isArray(artifacts) || artifacts.length !== 6) throw new Error("compiler_claim_map_closure_invalid");
  const claim = {
    contract: "uniscenario.compiler-claim/v1" as const,
    exportId: string(value.exportId), attemptId: string(value.attemptId), fenceToken: string(value.fenceToken), leaseExpiresAt: string(value.leaseExpiresAt), compilerVersion: string(value.compilerVersion),
    revision: { id: string(revision.id), contentSha256: digest(revision.contentSha256), canonicalContent: revision.canonicalContent, mapVersionId: string(revision.mapVersionId) },
    map: {
      id: string(map.id), sourceMapId: string(map.sourceMapId), runtimeMapName: string(map.runtimeMapName), coordinateSystemId: string(map.coordinateSystemId), coordinateSystemSha256: digest(map.coordinateSystemSha256), assetCatalogVersionId: string(map.assetCatalogVersionId), assetCatalogManifestSha256: digest(map.assetCatalogManifestSha256), sumoNetworkSha256: map.sumoNetworkSha256 === null ? null : digest(map.sumoNetworkSha256),
      artifacts: artifacts.map((row) => { const item = object(row); return { id: string(item.id), kind: string(item.kind) as CompilerClaim["map"]["artifacts"][number]["kind"], mediaType: string(item.mediaType), sha256: digest(item.sha256), sizeBytes: number(item.sizeBytes), downloadUrl: string(item.downloadUrl) }; }),
    },
    ambient: { ...ambient, mode: string(ambient.mode), configSha256: digest(ambient.configSha256), resultSha256: digest(ambient.resultSha256), ambientConfig: object(ambient.ambientConfig), materializedTraffic: { artifactId: string(materializedTraffic.artifactId), sha256: digest(materializedTraffic.sha256), sizeBytes: number(materializedTraffic.sizeBytes), sourceInputDigest: digest(materializedTraffic.sourceInputDigest), mapAssetId: string(materializedTraffic.mapAssetId), mapVersionId: string(materializedTraffic.mapVersionId) } },
  };
  if (claim.fenceToken.length < 32 || !["disabled", "native", "sumo"].includes(claim.ambient.mode)) throw new Error("compiler_claim_fence_or_ambient_invalid");
  return claim as CompilerClaim;
}
function fence(claim: CompilerClaim, extra: JsonObject): JsonObject { return { attemptId: claim.attemptId, fenceToken: claim.fenceToken, ...extra }; }
function object(value: unknown): JsonObject { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("compiler API value is not an object"); return value as JsonObject; }
function string(value: unknown): string { if (typeof value !== "string" || value.length === 0) throw new Error("compiler API string field invalid"); return value; }
function digest(value: unknown): string { const result = string(value); if (!DIGEST.test(result)) throw new Error("compiler API digest invalid"); return result; }
function number(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("compiler API number field invalid"); return value; }
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return wait(milliseconds, undefined, { signal });
}
