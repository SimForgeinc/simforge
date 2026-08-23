import { fixedStepCaptureFrames, samplePlaybackActors, type PlaybackBundle, type PlaybackController, type SampledActor } from '@uniscenarios/playback';
import { lowerRenderSpecToBrowser, type BrowserRenderPass, type RenderSpecV3, type ResolvedFrameSchedule } from '@uniscenarios/scenario-model';
import type { CityViewer } from '@uniscenarios/city-renderer';
import { Matrix4, PerspectiveCamera, Quaternion, Vector3, type Object3D } from 'three';
import { HashedArtifactSink, StreamingZipWriter, sensorFramePath, throwIfAborted, type ArtifactReceipt, type ArtifactSinkFactory } from './artifacts.js';
import { BoundedCpuPipeline } from './pipeline.js';
import { captureLinearDepthMeters, depthMetersToPng16 } from './sensors/depth-pass.js';
import { buildSensorFrameRecord } from './sensors/frame-records.js';
import { captureIdPass } from './sensors/id-pass.js';
import { captureDepthCube, captureLidarFrame, cubeFacesForAperture, CubeCameraPool } from './sensors/lidar-pass.js';
import { encodePng8Rgba } from './sensors/png.js';
import { captureInstanceIdCube, captureRadarFrame, type TraceVelocity } from './sensors/radar-pass.js';
import { RenderResourcePool, renderOffscreenRgba } from './sensors/render-targets.js';
import { encodeRadarCsv, type RadarDetection } from './sensors/csv.js';
import { encodeLidarPly, type LidarPoint } from './sensors/ply.js';
import { StreamingSensorVideoEncoder } from './video.js';

export const BROWSER_RENDER_ENGINE_ID = 'browser' as const;
export type RenderStage = 'worldUpdate' | 'scenePass' | 'readback' | 'encoding' | 'artifactWrite' | 'visualization';
export type StageTiming = Readonly<{ count: number; totalMs: number; maxMs: number }>;
export type BrowserRenderProgress = Readonly<{
  schema: 'uniscenario.render-progress/v1';
  intentSha256: string;
  engine: typeof BROWSER_RENDER_ENGINE_ID;
  event: 'started' | 'frame' | 'artifact' | 'completed';
  completedFrames: number;
  totalFrames: number;
  outputFrameIndex?: number;
  artifact?: ArtifactReceipt;
  timings: Readonly<Record<RenderStage, StageTiming>>;
}>;

export type BrowserCaptureResult = Readonly<{
  engine: typeof BROWSER_RENDER_ENGINE_ID;
  intentSha256: string;
  artifacts: readonly ArtifactReceipt[];
  timings: Readonly<Record<RenderStage, StageTiming>>;
  frameCount: number;
}>;

export async function captureBrowserArtifacts(input: {
  intentSha256: string;
  viewer: CityViewer;
  controller: PlaybackController;
  bundle: PlaybackBundle;
  renderSpec: RenderSpecV3;
  schedule: ResolvedFrameSchedule;
  createArtifactSink: ArtifactSinkFactory;
  signal?: AbortSignal;
  cpuConcurrency?: number;
  onProgress?: (line: string, event: BrowserRenderProgress) => void;
}): Promise<BrowserCaptureResult> {
  if (!/^[0-9a-f]{64}$/.test(input.intentSha256)) throw new Error('intentSha256 must be lowercase SHA-256 hex.');
  const plan = lowerRenderSpecToBrowser(input.renderSpec);
  if (plan.passes.length === 0) throw new Error('Browser render intent contains no sensor passes.');
  const timings = createTimings();
  const resources = new RenderResourcePool();
  const cubeCameras = new CubeCameraPool();
  const cameras = new Map<string, PerspectiveCamera>();
  const pipeline = new BoundedCpuPipeline(input.cpuConcurrency);
  const archives = new Map<string, StreamingZipWriter>();
  const videos = new Map<string, StreamingSensorVideoEncoder>();
  const worldMatrices = new Map<string, Matrix4>();
  const receipts: ArtifactReceipt[] = [];
  const openAbortables: { abort(reason: unknown): Promise<void> }[] = [];
  const framesSink = await hashedSink(input.createArtifactSink, { role: 'sensor-frames', actorId: null, sensorId: null, modality: 'frames' }, 'application/x-ndjson');
  openAbortables.push(framesSink);
  const encoder = new TextEncoder();

  try {
    for (const pass of plan.passes) {
      const identity = { role: 'sensor-archive', actorId: pass.actorId, sensorId: pass.sensorId, modality: pass.modality } as const;
      const sink = await hashedSink(input.createArtifactSink, identity, 'application/zip');
      const archive = new StreamingZipWriter(sink);
      archives.set(passKey(pass), archive); openAbortables.push(archive);
      if (input.renderSpec.video && (pass.modality === 'lidar' || pass.modality === 'radar')) {
        const videoSink = await hashedSink(input.createArtifactSink, { role: 'sensor-video', actorId: pass.actorId, sensorId: pass.sensorId, modality: pass.modality }, 'video/webm');
        const quality = input.renderSpec.video.quality === 'lossless' ? 'high' : input.renderSpec.video.quality;
        const video = await StreamingSensorVideoEncoder.create({ pass, schedule: input.schedule, config: { width: input.renderSpec.video.width, height: input.renderSpec.video.height, fps: input.renderSpec.video.fps, quality }, sink: videoSink, signal: input.signal });
        videos.set(passKey(pass), video); openAbortables.push(video);
      }
    }

    emitProgress(input, timings, { event: 'started', completedFrames: 0 });
    // Frame-major invariant: the authoritative playback world is sampled and updated
    // exactly once, then every active sensor observes that same immutable frame state.
    for (const frame of fixedStepCaptureFrames(input.schedule)) {
      throwIfAborted(input.signal);
      let started = performance.now();
      input.controller.renderAt(frame.sourceTimeSeconds);
      const actors = samplePlaybackActors(input.bundle, frame.sourceTimeSeconds);
      addTiming(timings, 'worldUpdate', performance.now() - started);
      const work: Promise<void>[] = [];
      for (const pass of plan.passes) {
        throwIfAborted(input.signal);
        const actor = actors.find((candidate) => candidate.id === pass.actorId && candidate.present);
        if (!actor) throw new Error(`Sensor actor ${pass.actorId} is absent at ${frame.sourceTimeSeconds}.`);
        const key = passKey(pass);
        const world = worldMatrices.get(key) ?? new Matrix4();
        worldMatrices.set(key, world);
        sensorWorldMatrix(world, pass, actor.x, actor.z, actor.headingRad);
        const record = buildSensorFrameRecord({ pass, outputFrameIndex: frame.index, scheduledTimeS: frame.sourceTimeSeconds, canonicalWorldMatrix: world });
        started = performance.now();
        await framesSink.write(encoder.encode(`${JSON.stringify(record)}\n`), input.signal);
        addTiming(timings, 'artifactWrite', performance.now() - started);
        const captured = capturePass({ pass, frameIndex: frame.index, fps: input.renderSpec.video?.fps ?? 24, viewer: input.viewer, world, actors, actor, resources, cubeCameras, cameras, timings });
        work.push(pipeline.run(() => serializeCapture(pass, captured), input.signal).then(async ({ value, timings: pipelineTiming }) => {
          addTiming(timings, 'encoding', pipelineTiming.executionMs);
          const archive = archives.get(passKey(pass));
          if (!archive) throw new Error(`Sensor archive was not initialized: ${pass.sensorId}`);
          const writeStarted = performance.now();
          await archive.add(sensorFramePath(pass.sensorId, frame.index, value.extension), value.bytes, input.signal);
          addTiming(timings, 'artifactWrite', performance.now() - writeStarted);
          const video = videos.get(passKey(pass));
          if (video && captured.structured) {
            const visualizationStarted = performance.now();
            await video.encode(frame, captured.structured, input.signal);
            addTiming(timings, 'visualization', performance.now() - visualizationStarted);
          }
        }));
      }
      await Promise.all(work);
      emitProgress(input, timings, { event: 'frame', completedFrames: frame.index + 1, outputFrameIndex: frame.index });
      await Promise.resolve();
    }

    receipts.push(await framesSink.close(input.signal));
    for (const pass of plan.passes) {
      const archive = archives.get(passKey(pass));
      if (archive) { const receipt = await archive.close(input.signal); receipts.push(receipt); emitProgress(input, timings, { event: 'artifact', completedFrames: input.schedule.frameCount, artifact: receipt }); }
      const video = videos.get(passKey(pass));
      if (video) { const receipt = await video.close(input.signal); receipts.push(receipt); emitProgress(input, timings, { event: 'artifact', completedFrames: input.schedule.frameCount, artifact: receipt }); }
    }
    const manifestSink = await hashedSink(input.createArtifactSink, { role: 'render-manifest', actorId: null, sensorId: null, modality: 'manifest' }, 'application/json');
    const manifest = { schema: 'uniscenario.browser-render-manifest/v1', engine: BROWSER_RENDER_ENGINE_ID, intentSha256: input.intentSha256, frameMajor: true, schedule: input.schedule, artifacts: receipts, timings };
    await manifestSink.write(encoder.encode(`${JSON.stringify(manifest)}\n`), input.signal);
    const manifestReceipt = await manifestSink.close(input.signal); receipts.push(manifestReceipt);
    emitProgress(input, timings, { event: 'completed', completedFrames: input.schedule.frameCount, artifact: manifestReceipt });
    return { engine: BROWSER_RENDER_ENGINE_ID, intentSha256: input.intentSha256, artifacts: receipts, timings, frameCount: input.schedule.frameCount };
  } catch (error) {
    pipeline.cancel(error);
    await Promise.allSettled(openAbortables.map((item) => item.abort(error)));
    throw error;
  } finally {
    resources.dispose();
  }
}

type StructuredCapture = readonly LidarPoint[] | readonly RadarDetection[];
type CapturedPass = { pixels?: Uint8Array; depth?: Float32Array; structured?: StructuredCapture };

function capturePass(input: { pass: BrowserRenderPass; frameIndex: number; fps: number; viewer: CityViewer; world: Matrix4; actors: readonly SampledActor[]; actor: SampledActor; resources: RenderResourcePool; cubeCameras: CubeCameraPool; cameras: Map<string, PerspectiveCamera>; timings: MutableTimings }): CapturedPass {
  const { pass } = input;
  const onTiming = (stage: 'scenePass' | 'readback', milliseconds: number) => addTiming(input.timings, stage, milliseconds);
  if (pass.modality !== 'lidar' && pass.modality !== 'radar') {
    const camera = input.cameras.get(passKey(pass)) ?? new PerspectiveCamera(); input.cameras.set(passKey(pass), camera); applySensorCamera(camera, input.world, pass);
    const common = { renderer: input.viewer.renderer, scene: input.viewer.scene, camera, width: pass.width, height: pass.height, nearM: pass.nearM, farM: pass.farM, resourcePool: input.resources, resourceKey: passKey(pass), onTiming };
    const restoreHost = hideSensorHost(input.viewer.scene, pass.actorId);
    try {
      if (pass.modality === 'rgb') return { pixels: renderOffscreenRgba(common) };
      if (pass.modality === 'depth') return { depth: captureLinearDepthMeters(common) };
      const result = captureIdPass({ ...common, mode: pass.modality, encodePng: false });
      return { pixels: result.pixels };
    } finally {
      restoreHost();
    }
  }
  const cubeResolution = 256;
  const sweep = pass.modality === 'lidar' ? 360 * Math.min(1, pass.rotationFrequencyHz / input.fps) : pass.horizontalFovDeg;
  const centre = pass.modality === 'lidar' ? (input.frameIndex * 360 * pass.rotationFrequencyHz / input.fps) + sweep / 2 : 0;
  const lower = pass.modality === 'lidar' ? pass.lowerFovDeg : -pass.verticalFovDeg / 2;
  const upper = pass.modality === 'lidar' ? pass.upperFovDeg : pass.verticalFovDeg / 2;
  const facesToRender = cubeFacesForAperture(sweep, lower, upper, centre);
  const faces = captureDepthCube({ renderer: input.viewer.renderer, scene: input.viewer.scene, sensorWorldMatrix: input.world, resolution: cubeResolution, nearM: 0.05, farM: pass.rangeM, faces: facesToRender, cameraPool: input.cubeCameras, renderResourcePool: input.resources, resourceKey: `${passKey(pass)}:depth`, onTiming });
  if (pass.modality === 'lidar') return { structured: captureLidarFrame({ faces, channels: pass.channels, rangeM: pass.rangeM, pointsPerSecond: pass.pointsPerSecond, rotationFrequencyHz: pass.rotationFrequencyHz, upperFovDeg: pass.upperFovDeg, lowerFovDeg: pass.lowerFovDeg, fps: input.fps, outputFrameIndex: input.frameIndex }) };
  const ids = captureInstanceIdCube({ renderer: input.viewer.renderer, scene: input.viewer.scene, sensorWorldMatrix: input.world, resolution: cubeResolution, nearM: 0.05, farM: pass.rangeM, faces: facesToRender, cameraPool: input.cubeCameras, renderResourcePool: input.resources, resourceKey: `${passKey(pass)}:ids`, onTiming });
  const velocities: Record<number, TraceVelocity> = {};
  for (const sampled of input.actors) { const id = ids.legend[`actor:${sampled.id}`]; if (id !== undefined) velocities[id] = traceVelocity(sampled.speedMps, sampled.headingRad); }
  return { structured: captureRadarFrame({ faces, idFaces: ids.faces, actorVelocityByInstanceId: velocities, sensorVelocity: traceVelocity(input.actor.speedMps, input.actor.headingRad), horizontalFovDeg: pass.horizontalFovDeg, verticalFovDeg: pass.verticalFovDeg, rangeM: pass.rangeM, pointsPerSecond: pass.pointsPerSecond, fps: input.fps }) };
}

function serializeCapture(pass: BrowserRenderPass, capture: CapturedPass): { bytes: Uint8Array; extension: 'png' | 'ply' | 'csv' } {
  if (pass.modality === 'rgb') return { bytes: encodePng8Rgba(pass.width, pass.height, capture.pixels!), extension: 'png' };
  if (pass.modality === 'depth') return { bytes: depthMetersToPng16(pass.width, pass.height, capture.depth!), extension: 'png' };
  if (pass.modality === 'semantic' || pass.modality === 'instance') return { bytes: encodePng8Rgba(pass.width, pass.height, capture.pixels!), extension: 'png' };
  if (pass.modality === 'lidar') return { bytes: encodeLidarPly(capture.structured as readonly LidarPoint[]), extension: 'ply' };
  return { bytes: encodeRadarCsv(capture.structured as readonly RadarDetection[]), extension: 'csv' };
}

async function hashedSink(factory: ArtifactSinkFactory, identity: Parameters<ArtifactSinkFactory>[0], mediaType: string): Promise<HashedArtifactSink> { return new HashedArtifactSink(identity, mediaType, await factory(identity, mediaType)); }
function passKey(pass: BrowserRenderPass): string { return `${pass.actorId}\u0000${pass.sensorId}\u0000${pass.modality}`; }

const scratchActorRotation = new Quaternion(); const scratchYaw = new Quaternion(); const scratchPitch = new Quaternion(); const scratchRoll = new Quaternion(); const scratchRelative = new Matrix4(); const scratchActorWorld = new Matrix4(); const scratchPosition = new Vector3(); const scratchScale = new Vector3(1, 1, 1); const scratchRotation = new Quaternion(); const scratchTarget = new Vector3(); const scratchUp = new Vector3();
function sensorWorldMatrix(target: Matrix4, pass: BrowserRenderPass, x: number, z: number, heading: number): void {
  scratchActorRotation.setFromAxisAngle(scratchUp.set(0, 1, 0), heading); scratchYaw.setFromAxisAngle(scratchUp.set(0, 1, 0), pass.transform.rotation.yawRad); scratchPitch.setFromAxisAngle(scratchUp.set(0, 0, 1), pass.transform.rotation.pitchRad); scratchRoll.setFromAxisAngle(scratchUp.set(1, 0, 0), pass.transform.rotation.rollRad); scratchRotation.copy(scratchYaw).multiply(scratchPitch).multiply(scratchRoll);
  scratchRelative.compose(scratchPosition.set(pass.transform.position.x, pass.transform.position.y, pass.transform.position.z), scratchRotation, scratchScale); scratchActorWorld.compose(scratchPosition.set(x, 0, z), scratchActorRotation, scratchScale); target.multiplyMatrices(scratchActorWorld, scratchRelative);
}
function applySensorCamera(camera: PerspectiveCamera, world: Matrix4, pass: Exclude<BrowserRenderPass, { modality: 'lidar' | 'radar' }>): void {
  world.decompose(scratchPosition, scratchRotation, scratchScale); camera.position.copy(scratchPosition); camera.up.copy(scratchUp.set(0, 1, 0)).applyQuaternion(scratchRotation); camera.lookAt(scratchTarget.set(1, 0, 0).applyQuaternion(scratchRotation).add(scratchPosition)); camera.aspect = pass.width / pass.height; camera.fov = 2 * Math.atan(Math.tan(pass.horizontalFovDeg * Math.PI / 360) / camera.aspect) * 180 / Math.PI; camera.near = pass.nearM; camera.far = pass.farM; camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
}
function hideSensorHost(scene: Object3D, actorId: string): () => void {
  const hidden: Object3D[] = [];
  scene.traverse((object) => {
    if (object.visible && object.userData.actorId === actorId) {
      object.visible = false;
      hidden.push(object);
    }
  });
  return () => {
    for (const object of hidden) object.visible = true;
  };
}
function traceVelocity(speed: number, heading: number): TraceVelocity { return { x: speed * Math.cos(heading), y: 0, z: -speed * Math.sin(heading) }; }

type MutableTimings = Record<RenderStage, { count: number; totalMs: number; maxMs: number }>;
function createTimings(): MutableTimings { return { worldUpdate: { count: 0, totalMs: 0, maxMs: 0 }, scenePass: { count: 0, totalMs: 0, maxMs: 0 }, readback: { count: 0, totalMs: 0, maxMs: 0 }, encoding: { count: 0, totalMs: 0, maxMs: 0 }, artifactWrite: { count: 0, totalMs: 0, maxMs: 0 }, visualization: { count: 0, totalMs: 0, maxMs: 0 } }; }
function addTiming(timings: MutableTimings, stage: RenderStage, ms: number): void { const value = timings[stage]; value.count += 1; value.totalMs += ms; value.maxMs = Math.max(value.maxMs, ms); }
function emitProgress(input: { intentSha256: string; schedule: ResolvedFrameSchedule; onProgress?: (line: string, event: BrowserRenderProgress) => void }, timings: MutableTimings, value: Pick<BrowserRenderProgress, 'event' | 'completedFrames' | 'outputFrameIndex' | 'artifact'>): void {
  const event: BrowserRenderProgress = { schema: 'uniscenario.render-progress/v1', intentSha256: input.intentSha256, engine: BROWSER_RENDER_ENGINE_ID, event: value.event, completedFrames: value.completedFrames, totalFrames: input.schedule.frameCount, ...(value.outputFrameIndex === undefined ? {} : { outputFrameIndex: value.outputFrameIndex }), ...(value.artifact === undefined ? {} : { artifact: value.artifact }), timings };
  input.onProgress?.(`${JSON.stringify(event)}\n`, event);
}
