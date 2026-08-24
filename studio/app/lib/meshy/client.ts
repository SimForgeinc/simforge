import type { GalleryActorClass } from "@/app/lib/asset-gallery/contracts";
import { galleryGenerationPolycountFor } from "@/app/lib/asset-gallery/generation-contracts";

const MESHY_API_ROOT = "https://api.meshy.ai/openapi/v1";
const MESHY_API_TIMEOUT_MS = 15_000;
const MESHY_ARTIFACT_TIMEOUT_MS = 60_000;
const ERROR_BODY_LIMIT = 1_000;

export type MeshyTaskStatus = "PENDING" | "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "CANCELED";

export interface MeshyTask {
  id: string;
  status: MeshyTaskStatus;
  progress: number;
  glbUrl: string | null;
  thumbnailUrl: string | null;
  error: string | null;
  consumedCredits: number | null;
}

export interface MeshySubmitInput {
  images: { data: Uint8Array; mediaType: "image/jpeg" | "image/png" }[];
  actorClass: GalleryActorClass;
  texturePrompt?: string;
}

export class MeshyUnavailableError extends Error {
  override name = "MeshyUnavailableError";
}

export class MeshyInsufficientCreditsError extends Error {
  override name = "MeshyInsufficientCreditsError";
}

export class MeshyArtifactTooLargeError extends Error {
  override name = "MeshyArtifactTooLargeError";
}

function cleanEnv(key: string): string {
  const value = process.env[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function meshyApiKey(): string {
  const apiKey = cleanEnv("MESHY_API_KEY");
  if (!apiKey) throw new MeshyUnavailableError("MESHY_API_KEY is not configured.");
  return apiKey;
}

export function meshyConfigured(): boolean {
  return Boolean(cleanEnv("MESHY_API_KEY"));
}

function safeErrorText(value: string): string {
  const apiKey = cleanEnv("MESHY_API_KEY");
  return apiKey ? value.split(apiKey).join("[redacted]") : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerError(status: number, responseText: string): Error {
  const detail = safeErrorText(responseText.slice(0, ERROR_BODY_LIMIT));
  const message = `Meshy API error (${status}): ${detail}`;
  if (status === 402) return new MeshyInsufficientCreditsError(message);
  if (status >= 500) return new MeshyUnavailableError(message);
  return new Error(message);
}

async function requestMeshyJson(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${MESHY_API_ROOT}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${meshyApiKey()}`,
        ...init?.headers,
      },
      signal: AbortSignal.timeout(MESHY_API_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof MeshyUnavailableError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new MeshyUnavailableError(`Meshy API request failed: ${safeErrorText(detail)}`);
  }

  let responseText: string;
  try {
    responseText = await response.text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new MeshyUnavailableError(`Meshy API response failed: ${safeErrorText(detail)}`);
  }
  if (!response.ok) throw providerError(response.status, responseText);

  let body: unknown;
  try {
    body = responseText ? JSON.parse(responseText) : {};
  } catch {
    const detail = safeErrorText(responseText.slice(0, ERROR_BODY_LIMIT));
    throw new MeshyUnavailableError(
      `Meshy API returned invalid JSON (${response.status}): ${detail}`,
    );
  }
  if (!isRecord(body)) {
    throw new MeshyUnavailableError(`Meshy API returned an invalid response (${response.status}).`);
  }
  return body;
}

function meshTaskStatus(value: unknown): MeshyTaskStatus {
  switch (value) {
    case "PENDING":
    case "IN_PROGRESS":
    case "SUCCEEDED":
    case "FAILED":
    case "CANCELED":
      return value;
    default:
      throw new MeshyUnavailableError("Meshy API returned an invalid task status.");
  }
}

export async function submitMeshyImageTo3d(
  input: MeshySubmitInput,
): Promise<{ taskId: string; request: Record<string, unknown> }> {
  const imageUrls = input.images.map(
    (image) => `data:${image.mediaType};base64,${Buffer.from(image.data).toString("base64")}`,
  );
  const texturePrompt = input.texturePrompt?.trim();
  const body: Record<string, unknown> = {
    image_urls: imageUrls,
    ai_model: "latest",
    should_texture: true,
    texture_resolution: "2k",
    enable_pbr: false,
    should_remesh: true,
    topology: "triangle",
    target_polycount: galleryGenerationPolycountFor(input.actorClass),
    remove_lighting: true,
    image_enhancement: true,
    auto_size: true,
    origin_at: "bottom",
    target_formats: ["glb"],
    multi_view_thumbnails: true,
    moderation: true,
  };
  if (texturePrompt) body.texture_prompt = texturePrompt;

  const response = await requestMeshyJson("/multi-image-to-3d", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const taskId = typeof response.result === "string" ? response.result.trim() : "";
  if (!taskId) throw new MeshyUnavailableError("Meshy API did not return a task id.");

  return {
    taskId,
    request: { ...body, image_urls: imageUrls.length },
  };
}

export async function fetchMeshyTask(taskId: string): Promise<MeshyTask> {
  const response = await requestMeshyJson(`/multi-image-to-3d/${encodeURIComponent(taskId)}`);
  const modelUrls = isRecord(response.model_urls) ? response.model_urls : {};
  const taskError = isRecord(response.task_error) ? response.task_error : {};

  return {
    id: typeof response.id === "string" && response.id.trim() ? response.id : taskId,
    status: meshTaskStatus(response.status),
    progress: typeof response.progress === "number" && Number.isFinite(response.progress)
      ? response.progress
      : 0,
    glbUrl: typeof modelUrls.glb === "string" && modelUrls.glb ? modelUrls.glb : null,
    thumbnailUrl: typeof response.thumbnail_url === "string" && response.thumbnail_url
      ? response.thumbnail_url
      : null,
    error: typeof taskError.message === "string" && taskError.message ? taskError.message : null,
    consumedCredits: typeof response.consumed_credits === "number"
      && Number.isFinite(response.consumed_credits)
      ? response.consumed_credits
      : null,
  };
}

export async function fetchMeshyBalance(): Promise<number> {
  const response = await requestMeshyJson("/balance");
  if (typeof response.balance !== "number" || !Number.isFinite(response.balance)) {
    throw new MeshyUnavailableError("Meshy API returned an invalid balance.");
  }
  return response.balance;
}

export async function downloadMeshyArtifact(url: string, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer.");
  }

  const controller = new AbortController();
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(MESHY_ARTIFACT_TIMEOUT_MS),
      ]),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new MeshyUnavailableError(
      `Meshy artifact download failed: ${safeErrorText(detail)}`,
    );
  }

  if (!response.ok) {
    let responseText: string;
    try {
      responseText = await response.text();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new MeshyUnavailableError(
        `Meshy artifact error response failed: ${safeErrorText(detail)}`,
      );
    }
    const detail = safeErrorText(responseText.slice(0, ERROR_BODY_LIMIT));
    throw new MeshyUnavailableError(
      `Meshy artifact download error (${response.status}): ${detail}`,
    );
  }
  if (!response.body) {
    throw new MeshyUnavailableError("Meshy artifact response did not contain a body.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > maxBytes) {
        // Enforcing the cap while reading prevents a signed provider URL from exhausting server memory before a post-download size check can run.
        controller.abort();
        await reader.cancel().catch(() => undefined);
        throw new MeshyArtifactTooLargeError(
          `Meshy artifact exceeds the ${maxBytes}-byte download limit.`,
        );
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof MeshyArtifactTooLargeError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new MeshyUnavailableError(
      `Meshy artifact download failed: ${safeErrorText(detail)}`,
    );
  }

  const artifact = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    artifact.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return artifact;
}
