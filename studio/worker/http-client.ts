import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { simforgeEnv } from "../lib/compat-env";

import type { RenderInputFile } from "@simforge-oss/render";

import type {
  CpuFence,
  CpuJobClaim,
  RecordingArtifact,
  RemoteInput,
} from "./types.js";

const JOB_FAMILY = "openscenario_render" as const;

type UploadReservation = {
  readonly artifactId: string;
  readonly key: string;
  readonly uploadUrl: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly reused: boolean;
};
type ReservedRecording = {
  readonly recordingId: string;
  readonly uploads: readonly UploadReservation[];
};


type JsonObject = Record<string, unknown>;

export class CpuJobsClient {
  readonly workerId: string;

  constructor(
    private readonly baseUrl: URL,
    private readonly token: string,
    workerId = `local-render-${process.pid}`,
    private readonly requestTimeoutMs = 30_000,
  ) {
    if (!token) throw new Error("SIMFORGE_RENDER_WORKER_TOKEN is required.");
    this.workerId = workerId;
  }

  async claim(signal: AbortSignal, leaseSeconds = 300): Promise<CpuJobClaim | null> {
    const response = await this.request(
      "/api/simforge/internal/cpu-jobs/claim",
      { workerId: this.workerId, leaseSeconds, families: [JOB_FAMILY] },
      signal,
      true,
    );
    return response === null ? null : parseClaim(response);
  }

  async heartbeat(
    claim: CpuJobClaim,
    progress: number,
    signal: AbortSignal,
    leaseSeconds = 300,
  ): Promise<{ cancelRequested: boolean; leaseExpiresAt: string }> {
    const body = object(await this.request(
      `/api/simforge/internal/cpu-jobs/${encodeURIComponent(claim.jobId)}/heartbeat`,
      { ...fence(claim), leaseSeconds, progress },
      signal,
    ));
    return {
      cancelRequested: body.cancelRequested === true,
      leaseExpiresAt: stringField(body, "leaseExpiresAt", "expiresAt", "expires_at"),
    };
  }

  async event(
    claim: CpuJobClaim,
    type: string,
    payload: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<void> {
    await this.request(
      `/api/simforge/internal/cpu-jobs/${encodeURIComponent(claim.jobId)}/events`,
      { ...fence(claim), type, payload },
      signal,
    );
  }

  async reserve(
    claim: CpuJobClaim,
    artifacts: readonly RecordingArtifact[],
    signal: AbortSignal,
  ): Promise<ReservedRecording> {
    const body = object(await this.request(
      "/api/simforge/recordings",
      {
        recording: claim.payload.recording,
        artifacts: artifacts.map((artifact) => ({
          role: artifact.kind,
          ...(artifact.sensor ? { sensor: artifact.sensor } : {}),
          mediaType: artifact.mediaType,
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
        })),
      },
      signal,
    ));
    const recording = object(body.recording);
    const rows = body.artifacts;
    if (!Array.isArray(rows) || rows.length !== artifacts.length) {
      throw new Error("recording creation returned an incomplete upload reservation set.");
    }
    return {
      recordingId: stringField(recording, "id", "recordingId"),
      uploads: rows.map((value, index) => parseReservation(object(value), artifacts[index]!)),
    };
  }

  async upload(
    reservation: UploadReservation,
    artifact: RecordingArtifact,
    signal: AbortSignal,
  ): Promise<void> {
    if (reservation.reused) return;
    if (!reservation.uploadUrl) throw new Error(`new ${reservation.key} reservation is missing an upload URL`);
    const response = await fetch(workerObjectUrl(reservation.uploadUrl), {
      method: "PUT",
      headers: reservation.headers,
      body: createReadStream(artifact.path),
      duplex: "half",
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]),
    } as unknown as RequestInit & { duplex: "half" });
    if (!response.ok) {
      throw new Error(`artifact PUT returned ${response.status}: ${(await response.text()).slice(0, 2_048)}`);
    }
  }

  async recordingProgress(
    recordingId: string,
    uploadedArtifacts: number,
    totalArtifacts: number,
    signal: AbortSignal,
  ): Promise<void> {
    const progress = 0.95 + (0.04 * uploadedArtifacts / Math.max(1, totalArtifacts));
    await this.request(
      `/api/simforge/recordings/${encodeURIComponent(recordingId)}`,
      {
        phase: "uploading",
        progress,
        detail: { uploadedArtifacts, totalArtifacts },
      },
      signal,
      false,
      "PUT",
    );
  }

  async complete(
    claim: CpuJobClaim,
    recordingId: string,
    artifacts: readonly RecordingArtifact[],
    reservations: readonly UploadReservation[],
    signal: AbortSignal,
  ): Promise<void> {
    const byKey = new Map(reservations.map((reservation) => [reservation.key, reservation]));
    const completedArtifacts = artifacts.map((artifact) => ({
      artifactId: requiredReservation(byKey, artifactKey(artifact)).artifactId,
      role: artifact.kind,
      ...(artifact.sensor ? { sensor: artifact.sensor } : {}),
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
    }));
    await this.request(
      `/api/simforge/recordings/${encodeURIComponent(recordingId)}`,
      { artifacts: completedArtifacts, summary: {} },
      signal,
      false,
      "PATCH",
    );
    await this.request(
      `/api/simforge/internal/cpu-jobs/${encodeURIComponent(claim.jobId)}/complete`,
      {
        ...fence(claim),
        artifacts: completedArtifacts.map(({ artifactId, role, sha256, sizeBytes }) => ({
          id: artifactId,
          kind: role,
          sha256,
          sizeBytes,
        })),
        browserRender: { recordingJobId: recordingId },
      },
      signal,
    );
  }

  async fail(
    claim: CpuJobClaim,
    code: string,
    detail: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<void> {
    await this.request(
      `/api/simforge/internal/cpu-jobs/${encodeURIComponent(claim.jobId)}/fail`,
      { ...fence(claim), code, detail },
      signal,
    );
  }

  private async request(
    path: string,
    payload: unknown,
    signal: AbortSignal,
    allowNoContent = false,
    method: "POST" | "PATCH" = "POST",
  ): Promise<JsonObject | null> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]),
    });
    if (allowNoContent && response.status === 204) return null;
    if (!response.ok) {
      throw new Error(`worker API ${path} returned ${response.status}: ${(await response.text()).slice(0, 2_048)}`);
    }
    return object(await response.json());
  }
}

export async function downloadInputs(
  inputs: readonly RemoteInput[],
  directory: string,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, RenderInputFile>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = resolve(directory);
  const seen = new Set<string>();
  const paths = new Set<string>();
  const materialized = new Map<string, RenderInputFile>();
  for (const [index, input] of inputs.entries()) {
    if (seen.has(input.inputId)) throw new Error(`duplicate render input ${input.inputId}`);
    seen.add(input.inputId);
    const safeName = basename(input.inputId).replace(/[^A-Za-z0-9._-]/g, "_") || "input";
    const path = input.relativePath
      ? resolve(root, input.relativePath)
      : join(root, `${String(index).padStart(3, "0")}-${safeName}`);
    if (path === root || !path.startsWith(`${root}/`) || paths.has(path)) {
      throw new Error(`invalid or duplicate render input relativePath for ${input.inputId}`);
    }
    paths.add(path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const response = await fetch(workerObjectUrl(input.download.url), {
      headers: input.download.headers,
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`input ${input.inputId} download returned ${response.status}`);
    }
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const verify = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.byteLength;
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as NodeReadableStream),
      verify,
      createWriteStream(path, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    const sha256 = hash.digest("hex");
    if (sha256 !== input.sha256 || sizeBytes !== input.sizeBytes) {
      throw new Error(
        `input ${input.inputId} integrity mismatch: expected ${input.sha256}/${input.sizeBytes}, got ${sha256}/${sizeBytes}`,
      );
    }
    materialized.set(input.inputId, { inputId: input.inputId, path, sha256, sizeBytes, ...(input.relativePath === undefined ? {} : { relativePath: input.relativePath }) });
  }
  return materialized;
}

function parseClaim(value: JsonObject): CpuJobClaim {
  if (value.contract !== "uniscenario.cpu-job-claim/v1" || value.jobFamily !== JOB_FAMILY) {
    throw new Error("CPU claim is not an openscenario_render v1 claim.");
  }
  const payload = object(value.payload);
  if (payload.mode !== "browser_render") throw new Error("CPU render claim mode is not browser_render.");
  const engine = payload.engine ?? "browser";
  if (engine !== "browser" && engine !== "native") throw new Error("CPU render claim has an unsupported engine.");
  const rawInputs = payload.inputs;
  if (!Array.isArray(rawInputs) || rawInputs.length === 0) {
    throw new Error("browser_render claim is missing checksum-bound input downloads.");
  }
  const intent = object(payload.intent);
  const intentSha256 = stringField(payload, "intentSha256");
  if (!/^[a-f0-9]{64}$/.test(intentSha256)) throw new Error("CPU render claim has an invalid intentSha256.");
  return {
    contract: "uniscenario.cpu-job-claim/v1",
    jobFamily: JOB_FAMILY,
    jobId: stringField(value, "jobId"),
    attemptId: stringField(value, "attemptId"),
    fenceToken: stringField(value, "fenceToken"),
    leaseExpiresAt: stringField(value, "leaseExpiresAt"),
    payload: {
      mode: "browser_render",
      engine,
      intent,
      intentSha256,
      inputs: rawInputs.map(parseRemoteInput),
      recording: object(payload.recording),
    },
  };
}

function parseRemoteInput(value: unknown): RemoteInput {
  const row = object(value);
  const download = row.download === undefined
    ? { url: stringField(row, "downloadUrl"), headers: objectOrEmpty(row.headers) }
    : object(row.download);
  const sha256 = stringField(row, "sha256");
  const sizeBytes = numberField(row, "sizeBytes");
  if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error("CPU render input has invalid immutable metadata.");
  }
  return {
    inputId: stringField(row, "inputId"),
    ...(typeof row.relativePath === "string" ? { relativePath: row.relativePath } : {}),
    sha256,
    sizeBytes,
    download: {
      url: stringField(download, "url"),
      headers: stringRecord(download.headers),
    },
  };
}

function artifactKey(artifact: RecordingArtifact): string {
  return artifact.sensor
    ? `${artifact.kind}\0${artifact.sensor.actorId}\0${artifact.sensor.sensorId}\0${artifact.sensor.modality}`
    : artifact.kind;
}

function parseReservation(row: JsonObject, expected: RecordingArtifact): UploadReservation {
  const kind = row.role ?? row.kind ?? expected.kind;
  if (kind !== expected.kind) throw new Error(`reserved ${String(kind)} while expecting ${expected.kind}`);
  const reused = row.uploadRequired === false || row.reused === true;
  const upload = reused
    ? null
    : row.upload === undefined
      ? row
      : object(row.upload);
  return {
    artifactId: stringField(row, "artifactId", "id"),
    key: artifactKey(expected),
    uploadUrl: upload ? stringField(upload, "url", "uploadUrl") : null,
    headers: upload ? stringRecord(upload.headers ?? upload.requiredHeaders) : {},
    reused,
  };
}

function requiredReservation(
  reservations: ReadonlyMap<string, UploadReservation>,
  key: string,
): UploadReservation {
  const reservation = reservations.get(key);
  if (!reservation) throw new Error(`missing ${key} upload reservation`);
  return reservation;
}

function fence(claim: CpuFence): CpuFence {
  return {
    jobFamily: JOB_FAMILY,
    attemptId: claim.attemptId,
    fenceToken: claim.fenceToken,
  };
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("worker API returned a non-object JSON value");
  return value as JsonObject;
}

function objectOrEmpty(value: unknown): JsonObject {
  return value === undefined ? {} : object(value);
}

function stringField(value: JsonObject, ...names: string[]): string {
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  throw new Error(`worker API response is missing ${names.join("/")}`);
}

function numberField(value: JsonObject, name: string): number {
  const candidate = value[name];
  if (typeof candidate !== "number") throw new Error(`worker API response is missing ${name}`);
  return candidate;
}

function stringRecord(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  const row = object(value);
  for (const item of Object.values(row)) {
    if (typeof item !== "string") throw new Error("worker API returned a non-string transfer header");
  }
  return row as Record<string, string>;
}

/**
 * Browser-facing presigned URLs retain the HTTPS tailnet origin. A colocated
 * worker may explicitly route only the local object-store endpoint over
 * loopback; all non-local-object URLs remain byte-for-byte unchanged.
 */
function workerObjectUrl(value: string): string {
  const override = simforgeEnv("WORKER_OBJECT_BASE_URL")?.trim();
  if (!override) return value;
  const source = new URL(value);
  if (!source.pathname.startsWith("/api/local-objects/")) return value;
  const local = new URL(override);
  local.pathname = source.pathname;
  local.search = source.search;
  local.hash = source.hash;
  return local.toString();
}
