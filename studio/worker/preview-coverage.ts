import { HifiPreviewFailure } from "./native-ready-map";
import type { FramedPayload, WorldBounds } from "./payload-framing";

/**
 * Frames below 0.5% instance-ID coverage are operationally blank: at common
 * preview sizes this still requires thousands of geometry pixels, while
 * rejecting isolated raster noise and tiny edge slivers.
 */
export const MIN_PREVIEW_COVERAGE = 0.005;

export type RenderCamera = FramedPayload;
export type CoverageRender<T> = T & { coverage: number };

export function isUsableCamera(camera: RenderCamera): boolean {
  return [...camera.eye, ...camera.target].every(Number.isFinite)
    && Math.hypot(
      camera.eye[0] - camera.target[0],
      camera.eye[1] - camera.target[1],
      camera.eye[2] - camera.target[2],
    ) > 1e-6;
}

/** Render the caller camera, retry an exactly empty pass once with framing. */
export async function renderWithCoverageFallback<T>(input: {
  requestedCamera: RenderCamera;
  framedCamera: RenderCamera;
  worldBounds: WorldBounds;
  render: (camera: RenderCamera, attempt: "requested" | "framed") => Promise<CoverageRender<T>>;
}): Promise<CoverageRender<T> & { camera: RenderCamera; fallbackFraming: boolean }> {
  const requestedUsable = isUsableCamera(input.requestedCamera);
  let camera = requestedUsable ? input.requestedCamera : input.framedCamera;
  let fallbackFraming = !requestedUsable;
  let result = await input.render(camera, fallbackFraming ? "framed" : "requested");
  if (requestedUsable && result.coverage === 0) {
    camera = input.framedCamera;
    fallbackFraming = true;
    result = await input.render(camera, "framed");
  }
  if (!Number.isFinite(result.coverage) || result.coverage < MIN_PREVIEW_COVERAGE) {
    throw new HifiPreviewFailure(
      "camera_sees_nothing",
      `rendered camera coverage ${(result.coverage * 100).toFixed(3)}% is below the 0.5% minimum`,
      { cameraPose: camera, worldBounds: input.worldBounds, coverage: result.coverage, threshold: MIN_PREVIEW_COVERAGE },
    );
  }
  return { ...result, camera, fallbackFraming };
}
