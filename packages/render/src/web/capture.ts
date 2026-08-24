import { fixedStepCaptureFrames, samplePlaybackActors, type PlaybackBundle, type PlaybackController, type SampledActor } from '@simforge/playback';
import { lowerRenderSpecToBrowser, type BrowserCameraRenderPass, type BrowserRenderPass, type RenderSpecV3, type ResolvedFrameSchedule } from '@simforge/scenario';
import type { CityViewer } from '@simforge/viewer';
import { Matrix4, PerspectiveCamera, Quaternion, Vector3, type Object3D } from 'three';
import { HashedArtifactSink, StreamingZipWriter, sensorFramePath, throwIfAborted, type ArtifactReceipt, type ArtifactSinkFactory } from './artifacts.js';
import { BoundedCpuPipeline } from './pipeline.js';
import { captureLinearDepthMeters } from './sensors/depth-pass.js';
import { buildSensorFrameRecord } from './sensors/frame-records.js';
import { captureIdPass } from './sensors/id-pass.js';
import { captureDepthCube, captureLidarFrame, cubeFacesForAperture, CubeCameraPool } from './sensors/lidar-pass.js';
import { captureInstanceIdCube, captureRadarFrame, type TraceVelocity } from './sensors/radar-pass.js';
import { RenderResourcePool, renderOffscreenRgba } from './sensors/render-targets.js';
import { encodeRadarCsv, type RadarDetection } from './sensors/csv.js';
import { encodeLidarPly, type LidarPoint } from './sensors/ply.js';
import { StreamingSensorVideoEncoder, type BrowserVideoConfig, type SensorVideoEncoding } from './video.js';

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

export type OmittedArtifact = Readonly<{
  role: 'sensor-archive' | 'sensor-video';
  actorId: string;
  sensorId: string;
  modality: string;
  reason: string;
}>;

/** Encoding evidence for one sensor's video stream, keyed by sensor identity. */
export type SensorStreamEncoding = Readonly<{
  actorId: string;
  sensorId: string;
  modality: string;
}> & SensorVideoEncoding;

export type BrowserCaptureResult = Readonly<{
  engine: typeof BROWSER_RENDER_ENGINE_ID;
  intentSha256: string;
  artifacts: readonly ArtifactReceipt[];
  timings: Readonly<Record<RenderStage, StageTiming>>;
  frameCount: number;
  videoEncodings: readonly SensorStreamEncoding[];
  omittedArtifacts: readonly OmittedArtifact[];
}>;

export type BrowserCaptureInput = Readonly<{
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
}>;

export async function captureBrowserArtifacts(input: BrowserCaptureInput): Promise<BrowserCaptureResult> {
  if (!/^[0-9a-f]{64}$/.test(input.intentSha256)) throw new Error('intentSha256 must be lowercase SHA-256 hex.');
  const plan = lowerRenderSpecToBrowser(input.renderSpec);
  if (plan.passes.length === 0) throw new Error('Browser render intent contains no sensor passes.');
  const wantsSensorArchives = input.renderSpec.artifacts.includes('sensorArchive');
  const omittedArtifacts: OmittedArtifact[] = [];
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

  const videoSource = input.renderSpec.video
    ? plan.passes.find(isRgbPass)
    : undefined;

  try {
    for (const pass of plan.passes) {
      const isCamera = pass.modality !== 'lidar' && pass.modality !== 'radar';
      // Lidar/radar keep their per-frame measurement archives (PLY point
      // clouds, radar CSV). Camera passes never archive individual frames:
      // each camera's sole pixel output is its own encoded video stream.
      if (!isCamera && wantsSensorArchives) {
        const identity = { role: 'sensor-archive', actorId: pass.actorId, sensorId: pass.sensorId, modality: pass.modality } as const;
        const sink = await hashedSink(input.createArtifactSink, identity, 'application/zip');
        const archive = new StreamingZipWriter(sink);
        archives.set(passKey(pass), archive); openAbortables.push(archive);
      } else if (!isCamera) {
        omittedArtifacts.push({ role: 'sensor-archive', actorId: pass.actorId, sensorId: pass.sensorId, modality: pass.modality, reason: 'not_requested_by_render_spec' });
      }
      const quality = input.renderSpec.video?.quality === 'lossless' ? 'high' as const : input.renderSpec.video?.quality ?? 'standard' as const;
      const videoConfig: BrowserVideoConfig | null = isCamera
        // A camera's video is the camera output: native sensor resolution at the capture rate.
        ? { width: pass.width, height: pass.height, fps: input.schedule.fps, quality }
        : input.renderSpec.video
          ? { width: input.renderSpec.video.width, height: input.renderSpec.video.height, fps: input.renderSpec.video.fps, quality }
          : null;
      if (videoConfig) {
        const videoSink = await hashedSink(input.createArtifactSink, { role: 'sensor-video', actorId: pass.actorId, sensorId: pass.sensorId, modality: pass.modality }, 'video/webm');
        const video = await StreamingSensorVideoEncoder.create({ pass, schedule: input.schedule, config: videoConfig, sink: videoSink, signal: input.signal });
        videos.set(passKey(pass), video); openAbortables.push(video);
      } else {
        omittedArtifacts.push({ role: 'sensor-video', actorId: pass.actorId, sensorId: pass.sensorId, modality: pass.modality, reason: 'not_requested_by_render_spec' });
      }
    }

    await prepareSceneForCapture(input, plan.passes, videoSource);

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
        const groundY = sampleGroundHeight(input.viewer, actor.x, actor.z);
        sensorWorldMatrix(world, pass, actor.x, groundY, actor.z, actor.headingRad);
        if (pass === videoSource) applySensorCamera(input.viewer.camera, world, pass);
        const record = buildSensorFrameRecord({ pass, outputFrameIndex: frame.index, scheduledTimeS: frame.sourceTimeSeconds, canonicalWorldMatrix: world });
        started = performance.now();
        await framesSink.write(encoder.encode(`${JSON.stringify(record)}\n`), input.signal);
        addTiming(timings, 'artifactWrite', performance.now() - started);
        const archive = archives.get(key);
        const video = videos.get(key);
        // Neither an archive nor a video consumes this pass's readback;
        // the pose record above is its only output for this frame.
        if (!archive && !video) continue;
        const captured = capturePass({ pass, frameIndex: frame.index, fps: input.renderSpec.video?.fps ?? input.schedule.fps, viewer: input.viewer, world, actors, actor, resources, cubeCameras, cameras, timings });
        work.push((async () => {
          if (archive) {
            const { value, timings: pipelineTiming } = await pipeline.run(() => serializeCapture(pass, captured), input.signal);
            addTiming(timings, 'encoding', pipelineTiming.executionMs);
            const writeStarted = performance.now();
            await archive.add(sensorFramePath(pass.sensorId, frame.index, value.extension), value.bytes, input.signal);
            addTiming(timings, 'artifactWrite', performance.now() - writeStarted);
          }

          if (video) {
            const visualizationStarted = performance.now();
            await video.encode(frame, captured, input.signal);
            addTiming(timings, 'visualization', performance.now() - visualizationStarted);
          }
        })());
      }
      await Promise.all(work);
      emitProgress(input, timings, { event: 'frame', completedFrames: frame.index + 1, outputFrameIndex: frame.index });
      await Promise.resolve();
    }

    receipts.push(await framesSink.close(input.signal));
    const videoEncodings: SensorStreamEncoding[] = [];
    for (const pass of plan.passes) {
      const archive = archives.get(passKey(pass));
      if (archive) { const receipt = await archive.close(input.signal); receipts.push(receipt); emitProgress(input, timings, { event: 'artifact', completedFrames: input.schedule.frameCount, artifact: receipt }); }
      const video = videos.get(passKey(pass));
      if (video) {
        const receipt = await video.close(input.signal); receipts.push(receipt);
        videoEncodings.push({ actorId: pass.actorId, sensorId: pass.sensorId, modality: pass.modality, ...video.encoding() });
        emitProgress(input, timings, { event: 'artifact', completedFrames: input.schedule.frameCount, artifact: receipt });
      }
    }
    const manifestSink = await hashedSink(input.createArtifactSink, { role: 'render-manifest', actorId: null, sensorId: null, modality: 'manifest' }, 'application/json');
    const manifest = { schema: 'uniscenario.browser-render-manifest/v1', engine: BROWSER_RENDER_ENGINE_ID, intentSha256: input.intentSha256, frameMajor: true, schedule: input.schedule, videoEncodings, artifacts: receipts, omittedArtifacts, timings };
    await manifestSink.write(encoder.encode(`${JSON.stringify(manifest)}\n`), input.signal);
    const manifestReceipt = await manifestSink.close(input.signal); receipts.push(manifestReceipt);
    emitProgress(input, timings, { event: 'completed', completedFrames: input.schedule.frameCount, artifact: manifestReceipt });
    return { engine: BROWSER_RENDER_ENGINE_ID, intentSha256: input.intentSha256, artifacts: receipts, timings, frameCount: input.schedule.frameCount, videoEncodings, omittedArtifacts };
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

type SerializedFrame = { bytes: Uint8Array; extension: 'ply' | 'csv' };

/** Only lidar/radar measurement data serializes to per-frame files; camera pixels exist solely as encoded video. */
function serializeCapture(pass: BrowserRenderPass, capture: CapturedPass): SerializedFrame {
  if (pass.modality === 'lidar') return { bytes: encodeLidarPly(capture.structured as readonly LidarPoint[]), extension: 'ply' };
  if (pass.modality === 'radar') return { bytes: encodeRadarCsv(capture.structured as readonly RadarDetection[]), extension: 'csv' };
  throw new Error(`Camera pass ${pass.sensorId} has no per-frame serialization; cameras output video only.`);
}

async function hashedSink(factory: ArtifactSinkFactory, identity: Parameters<ArtifactSinkFactory>[0], mediaType: string): Promise<HashedArtifactSink> { return new HashedArtifactSink(identity, mediaType, await factory(identity, mediaType)); }
function passKey(pass: BrowserRenderPass): string { return `${pass.actorId}\u0000${pass.sensorId}\u0000${pass.modality}`; }
function isRgbPass(pass: BrowserRenderPass): pass is BrowserCameraRenderPass & { readonly modality: 'rgb' } {
  return pass.modality === 'rgb';
}

const scratchActorRotation = new Quaternion(); const scratchYaw = new Quaternion(); const scratchPitch = new Quaternion(); const scratchRoll = new Quaternion(); const scratchRelative = new Matrix4(); const scratchActorWorld = new Matrix4(); const scratchPosition = new Vector3(); const scratchScale = new Vector3(1, 1, 1); const scratchDecomposedScale = new Vector3(); const scratchRotation = new Quaternion(); const scratchTarget = new Vector3(); const scratchUp = new Vector3();
function sensorWorldMatrix(target: Matrix4, pass: BrowserRenderPass, x: number, y: number, z: number, heading: number): void {
  const values = [
    x, y, z, heading,
    pass.transform.position.x, pass.transform.position.y, pass.transform.position.z,
    pass.transform.rotation.yawRad, pass.transform.rotation.pitchRad, pass.transform.rotation.rollRad,
  ];
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error(`Sensor ${pass.actorId}/${pass.sensorId} has a non-finite actor pose or mount transform.`);
  }
  // Sensor mounts are rigid. applySensorCamera() decomposes into a separate scratch vector,
  // so restore the invariant before composing the next sensor instead of reusing mutable scale.
  scratchScale.set(1, 1, 1);
  scratchActorRotation.setFromAxisAngle(scratchUp.set(0, 1, 0), heading);
  scratchYaw.setFromAxisAngle(scratchUp.set(0, 1, 0), pass.transform.rotation.yawRad);
  scratchPitch.setFromAxisAngle(scratchUp.set(0, 0, 1), pass.transform.rotation.pitchRad);
  scratchRoll.setFromAxisAngle(scratchUp.set(1, 0, 0), pass.transform.rotation.rollRad);
  scratchRotation.copy(scratchYaw).multiply(scratchPitch).multiply(scratchRoll);
  scratchRelative.compose(scratchPosition.set(pass.transform.position.x, pass.transform.position.y, pass.transform.position.z), scratchRotation, scratchScale);
  scratchActorWorld.compose(scratchPosition.set(x, y, z), scratchActorRotation, scratchScale);
  target.multiplyMatrices(scratchActorWorld, scratchRelative);
}
function applySensorCamera(camera: PerspectiveCamera, world: Matrix4, pass: BrowserCameraRenderPass): void {
  world.decompose(scratchPosition, scratchRotation, scratchDecomposedScale); camera.position.copy(scratchPosition); camera.up.copy(scratchUp.set(0, 1, 0)).applyQuaternion(scratchRotation); camera.lookAt(scratchTarget.set(1, 0, 0).applyQuaternion(scratchRotation).add(scratchPosition)); camera.aspect = pass.width / pass.height; camera.fov = 2 * Math.atan(Math.tan(pass.horizontalFovDeg * Math.PI / 360) / camera.aspect) * 180 / Math.PI; camera.near = pass.nearM; camera.far = pass.farM; camera.updateProjectionMatrix(); camera.matrixWorld.copy(world); camera.matrixWorldInverse.copy(world).invert();
}

async function prepareSceneForCapture(
  input: BrowserCaptureInput,
  passes: readonly BrowserRenderPass[],
  videoSource: (BrowserCameraRenderPass & { readonly modality: 'rgb' }) | undefined,
): Promise<void> {
  const pass = videoSource ?? passes.find(isRgbPass);
  const firstFrame = fixedStepCaptureFrames(input.schedule).next().value;
  if (!pass || !firstFrame) throw new Error('Browser capture requires one scheduled RGB sensor frame.');
  input.controller.renderAt(firstFrame.sourceTimeSeconds);
  const actor = samplePlaybackActors(input.bundle, firstFrame.sourceTimeSeconds)
    .find((candidate) => candidate.id === pass.actorId && candidate.present);
  if (!actor) throw new Error(`Sensor actor ${pass.actorId} is absent at ${firstFrame.sourceTimeSeconds}.`);
  const world = new Matrix4();
  sensorWorldMatrix(
    world,
    pass,
    actor.x,
    sampleGroundHeight(input.viewer, actor.x, actor.z),
    actor.z,
    actor.headingRad,
  );
  let detailReadySince: number | null = null;
  applySensorCamera(input.viewer.camera, world, pass);

  const deadline = performance.now() + 30_000;
  do {
    throwIfAborted(input.signal);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const stats = input.viewer.getStats();
    if (stats.residentAssets >= 8) {
      detailReadySince ??= performance.now();
      if (performance.now() - detailReadySince >= 1_000) return;
    } else {
      detailReadySince = null;
    }
  } while (performance.now() < deadline);
  const stats = input.viewer.getStats();
  throw new Error(
    `Browser capture map detail did not become ready: ${stats.residentAssets} resident, `
    + `${stats.loading} loading, ${stats.uploading} uploading.`,
  );
}

function sampleGroundHeight(viewer: CityViewer, x: number, z: number): number {
  return viewer.getGroundIndex()?.sample(x, z) ?? viewer.sampleGroundHeight(x, z) ?? 0;
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
