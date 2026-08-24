import { Vector2 } from "three";
import type { CityViewer } from "@simforge/viewer";
import type { PlaybackController } from "@simforge/playback";
import type { ResolvedFrameSchedule } from "@simforge/scenario";
import { setEditorSceneEnvironmentTime } from "../scene-environment";
import {
  encodeDeterministicWebm,
  type BrowserVideoConfig,
} from "./recording-webcodecs";

/**
 * Reuses the persistent CityViewer and playback controller. The renderer's
 * backing buffer is resized, never replaced; its CSS size and WebGL context
 * remain intact. Every mutation is restored even on cancellation or an encoder
 * failure.
 */
export async function captureViewerToWebm(input: {
  viewer: CityViewer;
  controller: PlaybackController;
  schedule: Readonly<ResolvedFrameSchedule>;
  config: BrowserVideoConfig;
  signal?: AbortSignal;
  onProgress?: (completedFrames: number, totalFrames: number) => void;
}): Promise<{ blob: Blob; codec: "vp9"; frameCount: number }> {
  const renderer = input.viewer.renderer;
  const previousSize = renderer.getSize(new Vector2());
  const previousPixelRatio = renderer.getPixelRatio();
  const previousView = input.viewer.captureView();
  const previousTime = input.controller.state.time;
  const wasPlaying = input.controller.state.playing;
  const wasRenderingSuspended = input.viewer.getStats().renderingSuspended;
  const previousAspect = input.viewer.camera.aspect;

  input.controller.pause();
  input.viewer.setCameraPoseConstraintsEnabled(false);
  // Stop CityViewer's requestAnimationFrame render loop from racing the
  // capture-owned fixed-step render. Manual renderer.render calls remain valid.
  input.viewer.setRenderingSuspended(true);
  renderer.setPixelRatio(1);
  renderer.setSize(input.config.width, input.config.height, false);

  try {
    return await encodeDeterministicWebm({
      canvas: renderer.domElement,
      config: input.config,
      schedule: input.schedule,
      signal: input.signal,
      onProgress: input.onProgress,
      renderFrame: (timing) => {
        setEditorSceneEnvironmentTime(input.viewer, timing.sourceTimeSeconds);
        input.controller.renderAt(timing.sourceTimeSeconds);
        input.viewer.camera.aspect = input.config.width / input.config.height;
        input.viewer.camera.updateProjectionMatrix();
        renderer.render(input.viewer.scene, input.viewer.camera);
      },
    });
  } finally {
    renderer.setPixelRatio(previousPixelRatio);
    renderer.setSize(previousSize.x, previousSize.y, false);
    setEditorSceneEnvironmentTime(input.viewer, null);
    input.controller.renderAt(previousTime);
    input.viewer.camera.aspect = previousAspect;
    input.viewer.camera.updateProjectionMatrix();
    input.viewer.applyView(previousView);
    input.viewer.setCameraPoseConstraintsEnabled(true);
    input.viewer.setRenderingSuspended(wasRenderingSuspended);
    if (wasPlaying) input.controller.play();
  }
}

export function browserRecordingPreflight(input: {
  viewer: CityViewer | null;
  controller: PlaybackController | null;
  mapVersionId: string | null;
  expectedMapVersionId?: string | null;
}) {
  const issues: string[] = [];
  if (!input.viewer || !input.controller) issues.push("The deterministic Three.js playback is not ready.");
  if (!input.mapVersionId) {
    issues.push("The persistent world is still loading this scenario's map.");
  } else if (input.expectedMapVersionId && input.mapVersionId !== input.expectedMapVersionId) {
    issues.push("The persistent world is still switching to this scenario's map.");
  }
  if (input.viewer) {
    const stats = input.viewer.getStats();
    if (!input.viewer.roadReady || !stats.roadVisible) {
      issues.push("Road and ground geometry has not settled yet.");
    }
    if (stats.loading > 0 || stats.queued > 0 || stats.uploading > 0) {
      issues.push(
        `Scene assets are still settling (${stats.loading} loading, ${stats.queued} queued, ${stats.uploading} uploading).`,
      );
    }
    if (stats.streamingError) issues.push(`Scene streaming failed: ${stats.streamingError}`);
    if (stats.renderingSuspended) issues.push("Three.js rendering is currently suspended.");
  }
  return issues;
}
