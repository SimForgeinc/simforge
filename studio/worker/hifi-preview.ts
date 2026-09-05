/**
 * The `hifi_preview` job family: leases queued `simforge.hifi_preview_requests`
 * and renders exactly ONE frame per request through `native-render-service`
 * (renderer/service — Bevy) on the receipt-validated native master closure of
 * the request's immutable map version:
 *
 *   lease -> resolve .corpus/<source_map_asset_id> and verify every receipt
 *   member -> spawn native-render-service with master.gltf -> hello /
 *   load_scene_state (single scene-state.v1 tick doc) / render with export_dir
 *   -> wait for the async PNG export -> store the PNG with provenance.
 *
 * Transport is the service's framed wire: one u32-LE length-prefixed msgpack
 * document per message, requests `{i, op, ...}`, responses echo `i`
 * (renderer/service/src/proto.rs). The request's contract camera report is
 * echoed verbatim into provenance so the camera pose round-trips exactly.
 *
 * Runs in two homes with the same executor:
 *   - `kickHifiPreviewExecutor()` — in-process drain inside the studio server
 *     (local PGlite is single-owner, so dev renders happen in-process);
 *   - `runHifiPreviewLoop()` — standalone polling worker
 *     (scripts/hifi-preview-worker.ts) for Postgres deployments.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { homedir, hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { decode, encode } from "@msgpack/msgpack";

import { LOCAL_ARTIFACT_BUCKET } from "../app/lib/db/config";
import { writeLocalObject } from "../app/lib/s3/s3-object";
import {
  HIFI_PREVIEW_PROVENANCE_SCHEMA,
  RENDERER_CONTRACT_VERSION,
  type CreateHifiPreviewInput,
  type HifiPreviewProvenance,
} from "../app/lib/hifi-preview/contracts";
import {
  completeHifiPreview,
  failHifiPreview,
  getMapNativeSource,
  leaseNextHifiPreview,
  type LeasedHifiPreview,
} from "../app/lib/hifi-preview/store";
import {
  HifiPreviewFailure,
  resolveNativeReadyMap,
  type NativeReadyMap,
} from "./native-ready-map";
import { computePayloadWorldBounds, framePayload } from "./payload-framing";
import { renderWithCoverageFallback, type RenderCamera } from "./preview-coverage";

const CONNECT_TIMEOUT_MS = 240_000; // covers prewarm + first shader compile
const RPC_TIMEOUT_MS = 120_000;
const PNG_EXPORT_TIMEOUT_MS = 60_000;
const SENSOR_ID = "hifi";

function cameraCoverage(response: Record<string, unknown>): number {
  const records = response.coverage;
  if (!Array.isArray(records)) return Number.NaN;
  const record = records.find((candidate) =>
    candidate !== null
    && typeof candidate === "object"
    && "sensorId" in candidate
    && candidate.sensorId === SENSOR_ID);
  return record && typeof record === "object" && "fraction" in record
    ? Number(record.fraction)
    : Number.NaN;
}


function log(event: string, fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ component: "simforge-hifi-preview-worker", event, ...fields })}\n`);
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve: settle, reject } = Promise.withResolvers<void>();
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    settle();
  }, milliseconds);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}

/* ------------------------------------------------------------------ wire */

/**
 * Minimal client for the native render service's framed msgpack protocol.
 * The service is synchronous and single-client; requests are awaited one at
 * a time, so the reader only ever matches the most recent sequence id.
 */
class NativeRenderServiceClient {
  private buffer: Buffer = Buffer.alloc(0);
  private sequence = 0;
  private waiter: {
    id: number;
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  } | null = null;

  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (error: Error) => this.waiter?.reject(error));
    socket.on("close", () => this.waiter?.reject(new Error("render service socket closed")));
  }

  static async connect(socketPath: string, child: ChildProcess, stderrTail: () => string): Promise<NativeRenderServiceClient> {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    let lastError = "socket never appeared";
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new HifiPreviewFailure(
          "renderer_exited",
          `native-render-service exited with code ${child.exitCode} before serving`,
          { stderr: stderrTail() },
        );
      }
      if (existsSync(socketPath)) {
        try {
          const { promise, resolve: connected, reject } = Promise.withResolvers<Socket>();
          const candidate = createConnection(socketPath);
          candidate.once("connect", () => connected(candidate));
          candidate.once("error", reject);
          const socket = await promise;
          return new NativeRenderServiceClient(socket);
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      await delay(250);
    }
    throw new HifiPreviewFailure("renderer_connect_timeout", `could not connect to ${socketPath}: ${lastError}`, {
      stderr: stderrTail(),
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + length) return;
      const payload = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      const message = decode(payload) as Record<string, unknown>;
      if (this.waiter && Number(message.i) === this.waiter.id) {
        const waiter = this.waiter;
        this.waiter = null;
        waiter.resolve(message);
      }
    }
  }

  async request(
    op: string,
    fields: Record<string, unknown> = {},
    timeoutMs = RPC_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const id = ++this.sequence;
    const payload = encode({ i: id, op, ...fields });
    const frame = Buffer.alloc(4 + payload.byteLength);
    frame.writeUInt32LE(payload.byteLength, 0);
    frame.set(payload, 4);
    const { promise, resolve: settle, reject } = Promise.withResolvers<Record<string, unknown>>();
    const timer = setTimeout(
      () => reject(new HifiPreviewFailure("renderer_rpc_timeout", `${op} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    this.waiter = {
      id,
      resolve: (value) => {
        clearTimeout(timer);
        settle(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    };
    this.socket.write(frame);
    const response = await promise;
    if (response.ok === false) {
      throw new HifiPreviewFailure("renderer_error", String(response.error ?? `op ${op} failed`));
    }
    return response;
  }

  destroy(): void {
    this.socket.destroy();
  }
}

/* -------------------------------------------------------------- binary */

/** Resolve the long-lived render service binary (WSB5). */
export function resolveServiceBinary(): string | null {
  const override = process.env.SIMFORGE_NATIVE_RENDER_SERVICE?.trim();
  // Keep resolution runtime-only: this module is also imported by a Next
  // route, whose bundler treats `new URL("../..", import.meta.url)` as a
  // module request. Package scripts run from `studio/`; direct invocations
  // commonly run from the repository root.
  const candidates = [
    ...(override ? [override] : []),
    resolve(process.cwd(), "../renderer/target/release/native-render-service"),
    resolve(process.cwd(), "../renderer/target/debug/native-render-service"),
    resolve(process.cwd(), "renderer/target/release/native-render-service"),
    resolve(process.cwd(), "renderer/target/debug/native-render-service"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/* ------------------------------------------------------- map payloads */

function mapsCacheRoot(): string {
  const configured = process.env.SIMFORGE_MAPS_CACHE_ROOT?.trim();
  if (configured) return resolve(configured);
  const dataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return resolve(dataHome, "simforge", "maps");
}

/** Resolve the exact registry release pinned by the requested map version. */
async function resolveMapPayloads(
  workspaceId: string,
  mapVersionId: string,
  requestedMapId: string,
): Promise<NativeReadyMap> {
  const source = await getMapNativeSource(workspaceId, mapVersionId);
  if (!source) {
    throw new HifiPreviewFailure(
      "map_payload_unavailable",
      `map version ${mapVersionId} has no registry-backed native source`,
    );
  }
  if (requestedMapId !== source.sourceMapAssetId) {
    throw new HifiPreviewFailure(
      "map_payload_identity_mismatch",
      `requested map ${requestedMapId} does not match immutable map version ${mapVersionId}`,
      {
        requestedMapId,
        sourceMapAssetId: source.sourceMapAssetId,
        registryReleaseDigest: source.registryReleaseDigest,
      },
    );
  }
  return resolveNativeReadyMap({
    mapId: source.sourceMapAssetId,
    releaseDigest: source.registryReleaseDigest,
    corpusRoot: join(mapsCacheRoot(), ".corpus"),
  });
}

/* ------------------------------------------------------------ executor */

export async function executeHifiPreview(
  lease: LeasedHifiPreview,
  signal: AbortSignal,
): Promise<{ artifactBucket: string; artifactKey: string; provenance: HifiPreviewProvenance }> {
  const t0 = Date.now();
  const request: CreateHifiPreviewInput = lease.request;
  const binary = resolveServiceBinary();
  if (!binary) {
    throw new HifiPreviewFailure(
      "renderer_unavailable",
      "native-render-service binary not found (build renderer/service or set SIMFORGE_NATIVE_RENDER_SERVICE)",
    );
  }

  const nativeMap = await resolveMapPayloads(lease.workspaceId, request.mapVersionId, request.scene.mapId);
  const worldBounds = await computePayloadWorldBounds([nativeMap.masterPath]);
  const framedCamera = framePayload(
    worldBounds,
    request.width / request.height,
    request.camera.intrinsics.fovYDeg,
  );

  const workspace = await mkdtemp(join(tmpdir(), "simforge-hifi-"));
  const socketPath = join(workspace, "render.sock");
  const shmPath = `/dev/shm/simforge-hifi-${process.pid}-${lease.requestId.slice(-8)}`;
  const exportRoot = join(workspace, "export");
  const sceneSpecPath = join(workspace, "scene.json");
  await writeFile(sceneSpecPath, JSON.stringify({
    glbs: [nativeMap.masterPath],
    profile: request.profile,
    nearM: Math.min(Math.max(request.camera.intrinsics.near, 0.05), 10),
    farM: Math.min(Math.max(request.camera.intrinsics.far, 200), 4000),
    warmupFrames: 10,
  }));

  const child = spawn(binary, [
    "--socket", socketPath,
    "--shm", shmPath,
    "--shm-size-mb", "128",
    "--scene", sceneSpecPath,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_192);
  });

  let client: NativeRenderServiceClient | null = null;
  try {
    client = await NativeRenderServiceClient.connect(socketPath, child, () => stderr);
    const prewarmMs = Date.now() - t0;
    const hello = await client.request("hello");

    if (request.scene.actors.length > 0) {
      await client.request("load_scene_state", {
        states: [{
          version: request.scene.version,
          mapId: request.scene.mapId,
          tick: request.scene.tick,
          tickHz: request.scene.tickHz,
          ...(request.scene.timeOfDay !== undefined ? { timeOfDay: request.scene.timeOfDay } : {}),
          groundY: request.scene.groundY,
          actors: request.scene.actors.map((actor) => ({
            id: actor.id,
            kind: actor.kind,
            catalogId: actor.catalogId,
            actorClass: actor.actorClass,
            transform: { position: actor.transform.position, rotation: actor.transform.rotation },
            velocity: actor.velocity,
          })),
        }],
      });
    }

    const requestedCamera: RenderCamera = {
      eye: request.camera.pose.position,
      target: request.camera.pose.target,
    };
    const rendered = await renderWithCoverageFallback({
      requestedCamera,
      framedCamera,
      worldBounds,
      render: async (camera, attempt) => {
        const attemptExportDir = join(exportRoot, attempt);
        const fields = {
          tick_id: request.tick,
          cameras: [{
            sensorId: SENSOR_ID,
            width: request.width,
            height: request.height,
            fovDeg: request.camera.intrinsics.fovYDeg,
            eye: camera.eye,
            target: camera.target,
          }],
          ...(request.scene.actors.length > 0 ? { tick_index: 0 } : {}),
        };
        // A camera pose transition needs one service request to settle all
        // readback buffers before the exported retry. This is still one
        // fallback pose; no intermediate image is accepted or stored.
        const settle = attempt === "framed"
          ? await client!.request("render", fields)
          : null;
        const response = await client!.request("render", {
          ...fields,
          export_dir: attemptExportDir,
        });
        return {
          response,
          exportDir: attemptExportDir,
          coverage: cameraCoverage(response),
          renderMs: Number(response.server_ms ?? 0) + Number(settle?.server_ms ?? 0),
        };
      },
    });
    const renderMs = rendered.renderMs;

    // PNG export is demoted off the render critical path (WSB5); wait for it.
    const pngPath = join(rendered.exportDir, `tick-${String(request.tick).padStart(6, "0")}.${SENSOR_ID}.rgb.png`);
    const pngDeadline = Date.now() + PNG_EXPORT_TIMEOUT_MS;
    let pngBytes: Buffer | null = null;
    while (Date.now() < pngDeadline) {
      if (signal.aborted) throw new HifiPreviewFailure("aborted", "worker shutdown during export");
      try {
        const info = await stat(pngPath);
        if (info.size > 0) {
          // Two reads a tick apart guard against catching a partial write.
          const first = await readFile(pngPath);
          await delay(50);
          const second = await readFile(pngPath);
          if (first.length === second.length) {
            pngBytes = second;
            break;
          }
        }
      } catch {
        // not exported yet
      }
      await delay(100);
    }
    if (!pngBytes) {
      throw new HifiPreviewFailure("render_export_timeout", `PNG export never appeared at ${pngPath}`, {
        stderr,
      });
    }

    await client.request("close", {}, 10_000).catch(() => undefined);

    const frameSha256 = createHash("sha256").update(pngBytes).digest("hex");
    const artifactKey = `hifi-preview/${lease.requestId}/frame.png`;
    await writeLocalObject(LOCAL_ARTIFACT_BUCKET, artifactKey, pngBytes, "image/png");

    const provenance: HifiPreviewProvenance = {
      schema: HIFI_PREVIEW_PROVENANCE_SCHEMA,
      renderer: "bevy-native",
      rendererProtocol: Number(hello.protocol ?? 0),
      contractVersion: RENDERER_CONTRACT_VERSION,
      profile: request.profile,
      tick: request.tick,
      mapVersionId: request.mapVersionId,
      mapId: request.scene.mapId,
      mapDigest: nativeMap.mapDigest,
      payloadDigests: nativeMap.payloads.map((payload) => payload.sha256),
      // The request report remains intact; renderedCamera records framing.
      camera: request.camera,
      renderedCamera: { position: rendered.camera.eye, target: rendered.camera.target },
      coverage: rendered.coverage,
      fallbackFraming: rendered.fallbackFraming,
      worldBounds,
      frame: {
        width: request.width,
        height: request.height,
        pass: "rgb",
        sha256: frameSha256,
        sizeBytes: pngBytes.byteLength,
      },
      map: {
        tileCount: 1,
        payloads: nativeMap.payloads.map((payload) => ({
          path: payload.relativePath,
          sha256: payload.sha256,
          sizeBytes: payload.sizeBytes,
        })),
      },
      timings: { prewarmMs, renderMs, totalMs: Date.now() - t0 },
      renderedAt: new Date().toISOString(),
    };
    return { artifactBucket: LOCAL_ARTIFACT_BUCKET, artifactKey, provenance };
  } finally {
    client?.destroy();
    child.kill("SIGTERM");
    const hardKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    hardKill.unref();
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    await rm(shmPath, { force: true }).catch(() => undefined);
  }
}

/* ---------------------------------------------------------- schedulers */

async function runOne(lease: LeasedHifiPreview, signal: AbortSignal): Promise<void> {
  log("request.started", { requestId: lease.requestId, mapVersionId: lease.request.mapVersionId, profile: lease.request.profile });
  try {
    const result = await executeHifiPreview(lease, signal);
    await completeHifiPreview(lease, result);
    log("request.succeeded", {
      requestId: lease.requestId,
      artifactKey: result.artifactKey,
      totalMs: result.provenance.timings.totalMs,
    });
  } catch (error) {
    const failure = error instanceof HifiPreviewFailure
      ? error
      : new HifiPreviewFailure("execution_error", error instanceof Error ? error.message : String(error));
    await failHifiPreview(lease, {
      errorCode: failure.code,
      errorDetail: { message: failure.message, ...failure.detail },
    }).catch((storeError) => log("request.fail_write_error", { requestId: lease.requestId, error: String(storeError) }));
    log("request.failed", { requestId: lease.requestId, code: failure.code, message: failure.message });
  }
}

async function drainQueue(workerId: string, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const lease = await leaseNextHifiPreview({ workerId });
    if (!lease) return;
    await runOne(lease, signal);
  }
}

type ExecutorHandle = { pending: boolean; running: boolean };
const executorKey = Symbol.for("simforge.hifi-preview.executor");

/**
 * In-process executor for the studio server: local PGlite is single-owner,
 * so the API route that enqueues a request also kicks this drain. Reentrant
 * kicks while a drain is running only mark it pending — one drain at a time.
 */
export function kickHifiPreviewExecutor(): void {
  const globals = globalThis as typeof globalThis & { [executorKey]?: ExecutorHandle };
  const handle = globals[executorKey];
  if (handle?.running) {
    handle.pending = true;
    return;
  }
  const next: ExecutorHandle = { pending: false, running: true };
  globals[executorKey] = next;
  const workerId = `studio-inline:${hostname()}:${process.pid}`;
  void (async () => {
    try {
      do {
        next.pending = false;
        await drainQueue(workerId, new AbortController().signal);
      } while (next.pending);
    } catch (error) {
      log("executor.error", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      next.running = false;
    }
  })();
}

export type HifiPreviewWorkerOptions = {
  signal: AbortSignal;
  workerId?: string;
  idleDelayMs?: number;
};

/** Standalone polling loop (scripts/hifi-preview-worker.ts). */
export async function runHifiPreviewLoop(options: HifiPreviewWorkerOptions): Promise<void> {
  const workerId = options.workerId ?? `hifi-preview:${hostname()}:${process.pid}`;
  const idleDelayMs = options.idleDelayMs ?? 1_500;
  log("worker.started", { workerId, binary: resolveServiceBinary() });
  while (!options.signal.aborted) {
    const lease = await leaseNextHifiPreview({ workerId });
    if (!lease) {
      try {
        await delay(idleDelayMs, options.signal);
      } catch {
        break;
      }
      continue;
    }
    await runOne(lease, options.signal);
  }
  log("worker.stopped", { workerId });
}
