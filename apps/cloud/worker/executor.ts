import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createRenderEngine as createBrowserRenderEngine } from "@uniscenarios/browser-renderer";
import type { RenderIntentV1 } from "@uniscenarios/scenario-model";
import {
  RenderArtifactManifestSchema,
  assertEngineSupportsIntent,
  createFixedSchedules,
  hashFile,
  loadBuiltinRenderEngine,
} from "@uniscenarios/render-runtime";

import type {
  RecordingArtifact,
  RenderExecutionRequest,
  RenderExecutionResult,
} from "./types.js";

export async function executeRender(request: RenderExecutionRequest): Promise<RenderExecutionResult> {
  const wireIntent = request.intent as unknown as RenderIntentV1 & { engine?: unknown; schedule?: unknown };
  const { engine: _engine, schedule: _schedule, ...portableIntent } = wireIntent;
  const intent = portableIntent as RenderIntentV1;
  const intentSha256 = createHash("sha256").update(canonicalJson(wireIntent)).digest("hex");
  if (request.intentSha256 && request.intentSha256 !== intentSha256) {
    throw new Error(`render intent digest mismatch: claim=${request.intentSha256} computed=${intentSha256}`);
  }
  const expectedInputs = new Map<string, { sha256: string; sizeBytes: number }>([
    ["scenario.xosc", intent.scenarioRevision.openScenario],
    ...intent.assets.map((asset) => [asset.assetId, asset] as const),
  ]);
  for (const [inputId, expected] of expectedInputs) {
    const input = request.inputs.get(inputId);
    if (!input) throw new Error(`render input ${inputId} is missing`);
    if (input.sha256 !== expected.sha256 || input.sizeBytes !== expected.sizeBytes) {
      throw new Error(`render input ${inputId} does not match its immutable intent declaration`);
    }
  }
  for (const inputId of request.inputs.keys()) {
    if (!expectedInputs.has(inputId)) throw new Error(`render input ${inputId} is not declared by the intent`);
  }

  await mkdir(request.workspace, { recursive: true, mode: 0o700 });
  const engine = request.engine === "browser"
    ? createBrowserRenderEngine(browserEngineOptions(request.engine))
    : await loadBuiltinRenderEngine(request.engine, browserEngineOptions(request.engine));
  try {
    const executionIntent = request.engine === "browser"
      ? browserExecutionIntent(intent)
      : intent;
    assertEngineSupportsIntent(
      engine.capabilities,
      request.engine === "browser"
        ? { ...intent, renderSpec: executionIntent.renderSpec }
        : intent,
    );
    const schedules = createFixedSchedules(intent);
    const stageTimingsMs: Record<string, number> = {};
    const engineStarted = performance.now();
    const runtimeManifest = RenderArtifactManifestSchema.parse(await engine.execute({
      jobId: request.jobId,
      attempt: request.attempt,
      intent: executionIntent,
      intentSha256,
      schedules,
      inputs: request.inputs,
      workspace: request.workspace,
      signal: request.signal,
      reportProgress: request.reportProgress ?? (async () => undefined),
    }));
    stageTimingsMs.engineExecute = performance.now() - engineStarted;
    if (runtimeManifest.intentSha256 !== intentSha256) {
      throw new Error("render engine returned a manifest for a different intent");
    }
    const verifyStarted = performance.now();
    for (const artifact of runtimeManifest.artifacts) {
      const path = safeArtifactPath(request.workspace, artifact.relativePath);
      const actual = await hashFile(path);
      if (actual.sha256 !== artifact.sha256 || actual.sizeBytes !== artifact.sizeBytes) {
        throw new Error(`render artifact integrity mismatch: ${artifact.relativePath}`);
      }
    }
    stageTimingsMs.artifactVerify = performance.now() - verifyStarted;
    if (runtimeManifest.artifacts.length === 0) throw new Error("render engine produced no artifacts");

    const frameCount = runtimeManifest.artifacts.reduce(
      (maximum, artifact) => Math.max(maximum, artifact.frameCount ?? 0),
      schedules[0]?.frameCount ?? 0,
    );
    const artifacts: RecordingArtifact[] = [];
    const omittedArtifacts: Array<{
      role: string;
      sensorId: string | null;
      modality: string | null;
      reason: string;
    }> = [];
    for (const artifact of runtimeManifest.artifacts) {
      if (
        artifact.identity.role === "diagnostics"
        && artifact.mediaType === "application/x-ndjson"
        && intent.renderSpec.artifacts.includes("frames")
      ) {
        artifacts.push({
          kind: "frames",
          path: safeArtifactPath(request.workspace, artifact.relativePath),
          mediaType: "application/x-ndjson",
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
        });
        continue;
      }
      if (artifact.identity.role !== "sensorArchive") continue;
      const { actorId, sensorId, modality } = artifact.identity;
      if (!actorId || !sensorId || !modality || artifact.mediaType !== "application/zip") {
        throw new Error(`browser sensor archive has invalid identity: ${artifact.relativePath}`);
      }
      if (!intent.renderSpec.artifacts.includes("sensorArchive")) {
        // Produced transiently (RGB archives feed the review MP4) but not part of
        // the declared artifact closure; recorded here so the omission is auditable.
        omittedArtifacts.push({ role: "sensorArchive", sensorId, modality, reason: "not_requested_by_render_spec" });
        continue;
      }
      artifacts.push({
        kind: "sensor_archive",
        sensor: { actorId, sensorId, modality },
        path: safeArtifactPath(request.workspace, artifact.relativePath),
        mediaType: "application/zip",
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
      });
    }
    let durationSeconds = Number(intent.renderSpec.clip.endSeconds) - Number(intent.renderSpec.clip.startSeconds);
    let video: RecordingArtifact | null = null;
    let videoEncoding: BrowserVideoEncoding | null = null;
    if (request.engine === "browser" && intent.renderSpec.artifacts.includes("video")) {
      const encodeStarted = performance.now();
      const encoded = await encodeBrowserMp4(request.workspace, runtimeManifest, intent, request.signal);
      stageTimingsMs.videoEncode = performance.now() - encodeStarted;
      video = encoded.artifact;
      videoEncoding = encoded.encoding;
      const probeStarted = performance.now();
      durationSeconds = await probeDuration(video.path, request.signal);
      stageTimingsMs.probeDuration = performance.now() - probeStarted;
      artifacts.push(video);
    }

    const manifestStarted = performance.now();
    const recordingManifestPath = join(request.workspace, "recording-manifest.json");
    await writeFile(recordingManifestPath, `${JSON.stringify({
      schema: "uniscenario.browser-threejs-recording-result/v1",
      intentSha256,
      engine: runtimeManifest.engine,
      frameCount,
      durationSeconds,
      runtimeManifest,
      omittedArtifacts,
      outputs: video
        ? [{
          role: "video",
          mediaType: video.mediaType,
          sha256: video.sha256,
          sizeBytes: video.sizeBytes,
          ...(videoEncoding ? { encoding: videoEncoding } : {}),
        }]
        : [],
    }, null, 2)}\n`, { mode: 0o600 });
    const manifestDigest = await hashFile(recordingManifestPath);
    artifacts.unshift({
      kind: "manifest",
      path: recordingManifestPath,
      mediaType: "application/json",
      ...manifestDigest,
    });
    stageTimingsMs.manifestWrite = performance.now() - manifestStarted;

    return { intentSha256, frameCount, durationSeconds, runtimeManifest, artifacts, stageTimingsMs };
  } finally {
    await engine.close?.();
  }
}

export type BrowserVideoEncoding = {
  readonly codec: "h264";
  readonly preset: string;
  readonly crf: number;
  readonly frameFormat: "png" | "jpg";
  readonly fps: number;
};

async function encodeBrowserMp4(
  workspace: string,
  manifest: RenderExecutionResult["runtimeManifest"],
  intent: RenderIntentV1,
  signal: AbortSignal,
): Promise<{ artifact: RecordingArtifact; encoding: BrowserVideoEncoding }> {
  const rgbArchives = manifest.artifacts
    .filter((artifact) => artifact.identity.role === "sensorArchive" && artifact.identity.modality === "rgb")
    .sort((left, right) => {
      const leftChase = left.identity.sensorId === "chase-cam-trailing" ? 0 : 1;
      const rightChase = right.identity.sensorId === "chase-cam-trailing" ? 0 : 1;
      return leftChase - rightChase || left.relativePath.localeCompare(right.relativePath);
    });
  const source = rgbArchives[0];
  if (!source) throw new Error("browser renderer produced no RGB frame archive for MP4 encoding");

  const framesDirectory = join(workspace, ".recording-frames");
  await rm(framesDirectory, { recursive: true, force: true });
  await mkdir(framesDirectory, { recursive: true, mode: 0o700 });
  await runProcess(
    "unzip",
    ["-q", safeArtifactPath(workspace, source.relativePath), "-d", framesDirectory],
    signal,
  );
  const sensorDirectory = join(framesDirectory, requiredSafeSegment(source.identity.sensorId));
  const frames = (await readdir(sensorDirectory))
    .filter((name) => /^\d{8}\.(png|jpg)$/.test(name))
    .sort();
  if (frames.length === 0) throw new Error("RGB frame archive contains no PNG or JPEG frames");
  const frameFormat = frames[0]!.endsWith(".jpg") ? "jpg" as const : "png" as const;
  if (!frames.every((name) => name.endsWith(`.${frameFormat}`))) {
    throw new Error("RGB frame archive mixes PNG and JPEG frames");
  }

  const outputPath = join(workspace, "recording.mp4");
  await rm(outputPath, { force: true });
  const fps = intent.renderSpec.video?.fps ?? rgbFrameRate(intent);
  if (!fps || !Number.isFinite(fps)) throw new Error("browser render has no finite RGB frame rate");
  const preset = qualityPreset(intent.renderSpec.video?.quality);
  const crf = Number(qualityCrf(intent.renderSpec.video?.quality));
  await runProcess(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel", "error",
      "-framerate", String(fps),
      "-i", join(sensorDirectory, `%08d.${frameFormat}`),
      "-c:v", "libx264",
      "-preset", preset,
      "-crf", String(crf),
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outputPath,
    ],
    signal,
  );
  const digest = await hashFile(outputPath);
  if (digest.sizeBytes === 0) throw new Error("ffmpeg produced an empty MP4");
  return {
    artifact: { kind: "video", path: outputPath, mediaType: "video/mp4", ...digest },
    encoding: { codec: "h264", preset, crf, frameFormat, fps },
  };
}

/**
 * Review renders tolerate JPEG-level compromises; `veryfast` cuts x264 wall
 * time several-fold at visually equivalent quality for these bitrates. The
 * high/lossless tiers keep the slower preset for archival-grade output.
 */
function qualityPreset(quality: "draft" | "standard" | "high" | "lossless" | undefined): string {
  return quality === "high" || quality === "lossless" ? "medium" : "veryfast";
}

async function probeDuration(path: string, signal: AbortSignal): Promise<number> {
  const output = await runProcess(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path],
    signal,
  );
  const duration = Number(output.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("ffprobe returned an invalid MP4 duration");
  return duration;
}
function browserExecutionIntent(intent: RenderIntentV1): RenderIntentV1 {
  const fps = intent.renderSpec.video?.fps ?? rgbFrameRate(intent);
  if (!fps) throw new Error("browser render requires a fixed RGB frame rate");
  return {
    ...intent,
    renderSpec: {
      ...intent.renderSpec,
      // Trace and annotations are control-plane products of the frozen
      // playback evidence. The browser engine captures only image artifacts.
      artifacts: intent.renderSpec.artifacts.filter((kind) =>
        kind !== "trace" && kind !== "annotations"
      ),
      capabilityIntent: {
        ...intent.renderSpec.capabilityIntent,
        required: intent.renderSpec.capabilityIntent.required.filter((capability) =>
          capability !== "artifact.trace" && capability !== "artifact.annotations"
        ),
      },
    },
  } as RenderIntentV1;
}

function rgbFrameRate(intent: RenderIntentV1): number | undefined {
  const source = intent.renderSpec.sources.find((candidate) =>
    candidate.modality === "rgb" && "fps" in candidate.attributes
  );
  return source && "fps" in source.attributes ? source.attributes.fps : undefined;
}


function browserEngineOptions(engine: RenderExecutionRequest["engine"]): Readonly<Record<string, unknown>> {
  if (engine !== "browser") return {};
  return {
    chromiumExecutablePath: process.env.CHROMIUM_EXECUTABLE_PATH ?? "/usr/bin/google-chrome",
    headless: true,
  };
}

function safeArtifactPath(workspace: string, relativePath: string): string {
  const root = resolve(workspace);
  const path = resolve(root, relativePath);
  if (path !== root && !path.startsWith(`${root}/`)) throw new Error(`artifact escapes workspace: ${relativePath}`);
  return path;
}

function requiredSafeSegment(value: string | null): string {
  if (!value || !/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`unsafe sensor path component: ${String(value)}`);
  return value;
}

function qualityCrf(quality: "draft" | "standard" | "high" | "lossless" | undefined): string {
  if (quality === "lossless") return "0";
  if (quality === "high") return "18";
  if (quality === "standard") return "23";
  return "28";
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON cannot contain non-finite numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new TypeError(`canonical JSON cannot contain ${typeof value}`);
}

function runProcess(command: string, args: readonly string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-64 * 1_024); });
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-64 * 1_024); });
    const abort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      signal.removeEventListener("abort", abort);
      rejectPromise(error);
    });
    child.once("exit", (code, exitSignal) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) rejectPromise(signal.reason);
      else if (code === 0) resolvePromise(stdout);
      else rejectPromise(new Error(`${command} exited code=${String(code)} signal=${String(exitSignal)}: ${stderr}`));
    });
  });
}
