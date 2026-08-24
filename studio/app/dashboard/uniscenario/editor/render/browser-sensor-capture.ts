import {
  fixedStepCaptureFrames,
  samplePlaybackActors,
  type PlaybackBundle,
  type PlaybackController,
} from "@simforge/playback";
import {
  lowerRenderSpecToBrowser,
  type BrowserRenderPass,
  type RenderSpecV3,
  type ResolvedFrameSchedule,
} from "@simforge/scenario";
import type { CityViewer } from "@simforge/viewer";
import { Matrix4, PerspectiveCamera, Quaternion, Vector3 } from "three";
import { captureLinearDepthMeters, depthMetersToPng16 } from "./sensors/depth-pass";
import { buildSensorFrameRecord, type BrowserSensorFrameRecord } from "./sensors/frame-records";
import { captureIdPass, decodeRgb24Ids } from "./sensors/id-pass";
import { captureDepthCube, captureLidarFrame, type CubeFaceName } from "./sensors/lidar-pass";
import { encodePng8Rgba } from "./sensors/png";
import { captureRadarFrame, type InstanceIdCube, type TraceVelocity } from "./sensors/radar-pass";
import { renderOffscreenRgba } from "./sensors/render-targets";
import { encodeRadarCsv } from "./sensors/csv";
import { encodeLidarPly } from "./sensors/ply";
import { sensorFramePath, writeDeterministicZip, type DeterministicZipEntry } from "./sensors/zip";
import { encodeActiveSensorVideo } from "./sensors/active-sensor-video";

export type CapturedSensorArchive = Readonly<{
  sensor: { actorId: string; sensorId: string; modality: BrowserRenderPass["modality"] };
  blob: Blob;
}>;
export type CapturedSensorVideo = Readonly<{
  sensor: { actorId: string; sensorId: string; modality: "lidar" | "radar" };
  blob: Blob;
}>;


export type BrowserSensorCaptureArtifacts = Readonly<{
  archives: readonly CapturedSensorArchive[];
  videos: readonly CapturedSensorVideo[];
  frames: Blob;
  frameRecords: readonly BrowserSensorFrameRecord[];
}>;

const CUBE_FACE_ORDER: readonly CubeFaceName[] = ["px", "nx", "py", "ny", "pz", "nz"];
const CUBE_FACE_AXES: Readonly<Record<CubeFaceName, readonly [Vector3, Vector3]>> = {
  px: [new Vector3(1, 0, 0), new Vector3(0, 0, 1)],
  nx: [new Vector3(-1, 0, 0), new Vector3(0, 0, 1)],
  py: [new Vector3(0, 1, 0), new Vector3(0, 0, 1)],
  ny: [new Vector3(0, -1, 0), new Vector3(0, 0, 1)],
  pz: [new Vector3(0, 0, 1), new Vector3(1, 0, 0)],
  nz: [new Vector3(0, 0, -1), new Vector3(-1, 0, 0)],
};

/** Capture every v3 source into the CARLA-compatible per-sensor archive layout. */
export async function captureBrowserSensorArtifacts(input: {
  viewer: CityViewer;
  controller: PlaybackController;
  bundle: PlaybackBundle;
  renderSpec: RenderSpecV3;
  schedule: ResolvedFrameSchedule;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
}): Promise<BrowserSensorCaptureArtifacts> {
  const plan = lowerRenderSpecToBrowser(input.renderSpec);
  const archives: CapturedSensorArchive[] = [];
  const videos: CapturedSensorVideo[] = [];
  const frameRecords: BrowserSensorFrameRecord[] = [];
  const activeVideoPasses = input.renderSpec.video
    ? plan.passes.filter((pass) => pass.modality === "lidar" || pass.modality === "radar").length
    : 0;
  const total = (plan.passes.length + activeVideoPasses) * input.schedule.frameCount;
  let completed = 0;

  for (const pass of plan.passes) {
    const entries: DeterministicZipEntry[] = [];
    for (const frame of fixedStepCaptureFrames(input.schedule)) {
      if (input.signal?.aborted) throw new DOMException("Capture cancelled", "AbortError");
      input.controller.renderAt(frame.sourceTimeSeconds);
      const actors = samplePlaybackActors(input.bundle, frame.sourceTimeSeconds);
      const actor = actors.find((candidate) => candidate.id === pass.actorId && candidate.present);
      if (!actor) throw new Error(`Sensor actor ${pass.actorId} is absent at ${frame.sourceTimeSeconds}.`);
      const groundY = input.viewer.getGroundIndex()?.sample(actor.x, actor.z)
        ?? input.viewer.sampleGroundHeight(actor.x, actor.z)
        ?? 0;
      const matrices = sensorMatrices(pass, actor.x, groundY, actor.z, actor.headingRad);
      const camera = input.viewer.camera;
      applySensorCamera(camera, matrices.world, pass);
      let bytes: Uint8Array;
      let extension: "png" | "ply" | "csv";
      if (pass.modality === "rgb") {
        bytes = encodePng8Rgba(pass.width, pass.height, renderOffscreenRgba({
          renderer: input.viewer.renderer,
          scene: input.viewer.scene,
          camera,
          width: pass.width,
          height: pass.height,
        }));
        extension = "png";
      } else if (pass.modality === "depth") {
        bytes = depthMetersToPng16(pass.width, pass.height, captureLinearDepthMeters({
          renderer: input.viewer.renderer,
          scene: input.viewer.scene,
          camera,
          width: pass.width,
          height: pass.height,
          nearM: pass.nearM,
          farM: pass.farM,
        }));
        extension = "png";
      } else if (pass.modality === "instance" || pass.modality === "semantic") {
        bytes = captureIdPass({
          renderer: input.viewer.renderer,
          scene: input.viewer.scene,
          camera,
          width: pass.width,
          height: pass.height,
          nearM: pass.nearM,
          farM: pass.farM,
          mode: pass.modality,
        }).png;
        extension = "png";
      } else {
        if (pass.modality !== "lidar" && pass.modality !== "radar") {
          throw new Error(`Unsupported browser sensor modality: ${pass.modality}`);
        }
        const cubeResolution = 256;
        const faces = captureDepthCube({
          renderer: input.viewer.renderer,
          scene: input.viewer.scene,
          sensorWorldMatrix: matrices.world,
          resolution: cubeResolution,
          nearM: 0.05,
          farM: pass.rangeM,
        });
        if (pass.modality === "lidar") {
          bytes = encodeLidarPly(captureLidarFrame({
            faces,
            channels: pass.channels,
            rangeM: pass.rangeM,
            pointsPerSecond: pass.pointsPerSecond,
            rotationFrequencyHz: pass.rotationFrequencyHz,
            upperFovDeg: pass.upperFovDeg,
            lowerFovDeg: pass.lowerFovDeg,
            fps: input.renderSpec.video?.fps ?? 24,
            outputFrameIndex: frame.index,
          }));
          extension = "ply";
        } else {
          const idCapture = captureInstanceIdCube(input.viewer, matrices.world, cubeResolution, 0.05, pass.rangeM);
          const actorVelocityByInstanceId: Record<number, TraceVelocity> = {};
          for (const sampled of actors) {
            const id = idCapture.legend[`actor:${sampled.id}`];
            if (id == null) continue;
            actorVelocityByInstanceId[id] = traceVelocity(sampled.speedMps, sampled.headingRad);
          }
          bytes = encodeRadarCsv(captureRadarFrame({
            faces,
            idFaces: idCapture.faces,
            actorVelocityByInstanceId,
            sensorVelocity: traceVelocity(actor.speedMps, actor.headingRad),
            horizontalFovDeg: pass.horizontalFovDeg,
            verticalFovDeg: pass.verticalFovDeg,
            rangeM: pass.rangeM,
            pointsPerSecond: pass.pointsPerSecond,
            fps: input.renderSpec.video?.fps ?? 24,
          }));
          extension = "csv";
        }
      }
      const relativePath = sensorFramePath(pass.sensorId, frame.index, extension);
      entries.push({ path: relativePath, bytes });
      frameRecords.push(buildSensorFrameRecord({
        pass,
        outputFrameIndex: frame.index,
        scheduledTimeS: frame.sourceTimeSeconds,
        canonicalWorldMatrix: matrices.world,
      }));
      completed += 1;
      input.onProgress?.(completed, total);
      await Promise.resolve();
    }
    if (
      input.renderSpec.video
      && (pass.modality === "lidar" || pass.modality === "radar")
    ) {
      const progressBase = completed;
      const blob = await encodeActiveSensorVideo({
        pass,
        frameBytes: entries.map((entry) => entry.bytes),
        schedule: input.schedule,
        config: {
          width: input.renderSpec.video.width,
          height: input.renderSpec.video.height,
          fps: input.renderSpec.video.fps,
          quality: input.renderSpec.video.quality === "lossless"
            ? "high"
            : input.renderSpec.video.quality,
        },
        signal: input.signal,
        onProgress: (encodedFrames) => {
          input.onProgress?.(progressBase + encodedFrames, total);
        },
      });
      completed = progressBase + input.schedule.frameCount;
      videos.push({
        sensor: {
          actorId: pass.actorId,
          sensorId: pass.sensorId,
          modality: pass.modality,
        },
        blob,
      });
    }
    const zipped = writeDeterministicZip(entries);
    const blobBytes = new Uint8Array(zipped.byteLength);
    blobBytes.set(zipped);
    archives.push({
      sensor: { actorId: pass.actorId, sensorId: pass.sensorId, modality: pass.modality },
      blob: new Blob([blobBytes], { type: "application/zip" }),
    });
  }
  const frames = new Blob([JSON.stringify(frameRecords)], { type: "application/json" });
  return { archives, videos, frames, frameRecords };
}

function sensorMatrices(pass: BrowserRenderPass, actorX: number, actorY: number, actorZ: number, headingRad: number) {
  const actorRotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), headingRad);
  const yaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), pass.transform.rotation.yawRad);
  const pitch = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), pass.transform.rotation.pitchRad);
  const roll = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), pass.transform.rotation.rollRad);
  const sensorRotation = yaw.multiply(pitch).multiply(roll);
  const relative = new Matrix4().compose(
    new Vector3(pass.transform.position.x, pass.transform.position.y, pass.transform.position.z),
    sensorRotation,
    new Vector3(1, 1, 1),
  );
  const actorWorld = new Matrix4().compose(
    new Vector3(actorX, actorY, actorZ),
    actorRotation,
    new Vector3(1, 1, 1),
  );
  return { world: actorWorld.multiply(relative) };
}

function applySensorCamera(camera: PerspectiveCamera, world: Matrix4, pass: BrowserRenderPass): void {
  const position = new Vector3();
  const rotation = new Quaternion();
  world.decompose(position, rotation, new Vector3());
  camera.position.copy(position);
  camera.up.copy(new Vector3(0, 1, 0).applyQuaternion(rotation));
  camera.lookAt(position.clone().add(new Vector3(1, 0, 0).applyQuaternion(rotation)));
  if (pass.modality !== "lidar" && pass.modality !== "radar") {
    camera.aspect = pass.width / pass.height;
    camera.fov = 2 * Math.atan(Math.tan(pass.horizontalFovDeg * Math.PI / 360) / camera.aspect) * 180 / Math.PI;
    camera.near = pass.nearM;
    camera.far = pass.farM;
  }
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

function captureInstanceIdCube(
  viewer: CityViewer,
  world: Matrix4,
  resolution: number,
  nearM: number,
  farM: number,
): { faces: InstanceIdCube; legend: Readonly<Record<string, number>> } {
  const position = new Vector3();
  const rotation = new Quaternion();
  world.decompose(position, rotation, new Vector3());
  const faces = {} as Record<CubeFaceName, InstanceIdCube[CubeFaceName]>;
  let legend: Readonly<Record<string, number>> = {};
  for (const name of CUBE_FACE_ORDER) {
    const [axis, up] = CUBE_FACE_AXES[name];
    const camera = new PerspectiveCamera(90, 1, nearM, farM);
    camera.position.copy(position);
    camera.up.copy(up).applyQuaternion(rotation);
    camera.lookAt(position.clone().add(axis.clone().applyQuaternion(rotation)));
    camera.updateMatrixWorld(true);
    const result = captureIdPass({
      renderer: viewer.renderer,
      scene: viewer.scene,
      camera,
      width: resolution,
      height: resolution,
      nearM,
      farM,
      mode: "instance",
    });
    legend = result.legend;
    faces[name] = { width: resolution, height: resolution, ids: decodeRgb24Ids(result.pixels) };
  }
  return { faces, legend };
}

function traceVelocity(speedMps: number, headingRad: number): TraceVelocity {
  return { x: speedMps * Math.cos(headingRad), y: 0, z: -speedMps * Math.sin(headingRad) };
}
