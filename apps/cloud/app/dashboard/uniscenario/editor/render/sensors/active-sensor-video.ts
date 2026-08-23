import type {
  BrowserRenderPass,
  ResolvedFrameSchedule,
} from "@uniscenarios/scenario-model";
import type { FixedStepCaptureFrame } from "@uniscenarios/playback";
import {
  encodeDeterministicWebm,
  type BrowserVideoConfig,
} from "../recording-webcodecs";
import type { RadarDetection } from "./csv";
import type { LidarPoint } from "./ply";

const decoder = new TextDecoder();
const ACTIVE_SENSOR_VIDEO_BACKGROUND = "#03070b";
const GRID = "rgba(116, 214, 225, 0.16)";
const TEXT = "rgba(226, 246, 248, 0.92)";
const MUTED_TEXT = "rgba(187, 218, 222, 0.64)";

export type ActiveSensorPass = Extract<BrowserRenderPass, { modality: "lidar" | "radar" }>;

export function decodeLidarPly(bytes: Uint8Array): LidarPoint[] {
  const text = decoder.decode(bytes);
  const marker = "end_header\n";
  const bodyStart = text.indexOf(marker);
  if (bodyStart < 0) throw new Error("LiDAR PLY is missing end_header.");
  const rows = text.slice(bodyStart + marker.length).trim();
  if (!rows) return [];
  return rows.split("\n").map((row) => {
    const values = row.trim().split(/\s+/).map(Number);
    if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
      throw new Error("LiDAR PLY contains an invalid point row.");
    }
    return { x: values[0]!, y: values[1]!, z: values[2]!, intensity: values[3]! };
  });
}

export function decodeRadarCsv(bytes: Uint8Array): RadarDetection[] {
  const rows = decoder.decode(bytes).trim().split("\n");
  if (rows[0] !== "altitude,azimuth,depth,velocity") {
    throw new Error("Radar CSV has an invalid header.");
  }
  return rows.slice(1).filter(Boolean).map((row) => {
    const values = row.split(",").map(Number);
    if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
      throw new Error("Radar CSV contains an invalid detection row.");
    }
    return {
      altitude: values[0]!,
      azimuth: values[1]!,
      depth: values[2]!,
      velocity: values[3]!,
    };
  });
}

export function projectLidarPoint(
  point: Pick<LidarPoint, "x" | "y" | "z">,
  width: number,
  height: number,
  displayRangeM: number,
): { x: number; y: number } {
  const centreX = width / 2;
  const floorY = height * 0.82;
  const scale = Math.min(width / (displayRangeM * 2.35), height / (displayRangeM * 0.82));
  const forward = Math.max(0, point.x);
  const perspective = 1 / (1 + forward / Math.max(1, displayRangeM * 1.4));
  return {
    x: centreX - point.z * scale * perspective,
    y: floorY - forward * scale * 0.58 - point.y * scale,
  };
}

export function projectRadarDetection(
  detection: Pick<RadarDetection, "azimuth" | "depth">,
  width: number,
  height: number,
  rangeM: number,
): { x: number; y: number } {
  const scale = Math.min(width * 0.43, height * 0.78) / rangeM;
  return {
    x: width / 2 + Math.sin(detection.azimuth) * detection.depth * scale,
    y: height * 0.9 - Math.cos(detection.azimuth) * detection.depth * scale,
  };
}

export async function encodeActiveSensorVideo(input: {
  pass: ActiveSensorPass;
  frameBytes: readonly Uint8Array[];
  schedule: Readonly<ResolvedFrameSchedule>;
  config: BrowserVideoConfig;
  signal?: AbortSignal;
  onProgress?: (completedFrames: number, totalFrames: number) => void;
}): Promise<Blob> {
  if (input.frameBytes.length !== input.schedule.frameCount) {
    throw new Error("Active-sensor visualization frame count does not match the capture schedule.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = input.config.width;
  canvas.height = input.config.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("A 2D canvas is required for active-sensor visualization.");

  const encoded = await encodeDeterministicWebm({
    canvas,
    schedule: input.schedule,
    config: input.config,
    signal: input.signal,
    onProgress: input.onProgress,
    renderFrame: (timing) => {
      const bytes = input.frameBytes[timing.index];
      if (!bytes) throw new Error(`Active-sensor frame ${timing.index} is missing.`);
      if (input.pass.modality === "lidar") {
        drawLidarFrame(context, input.pass, decodeLidarPly(bytes), timing);
      } else {
        drawRadarFrame(context, input.pass, decodeRadarCsv(bytes), timing);
      }
    },
  });
  return encoded.blob;
}

export function drawLidarFrame(
  context: CanvasRenderingContext2D,
  pass: Extract<ActiveSensorPass, { modality: "lidar" }>,
  points: readonly LidarPoint[],
  timing: Pick<FixedStepCaptureFrame, "index" | "sourceTimeSeconds">,
): void {
  const { width, height } = context.canvas;
  const displayRangeM = Math.min(pass.rangeM, 80);
  drawBackground(context, width, height);
  drawLidarGrid(context, width, height, displayRangeM);

  for (const point of points) {
    const distance = Math.hypot(point.x, point.y, point.z);
    if (point.x < 0 || distance > displayRangeM) continue;
    const projected = projectLidarPoint(point, width, height, displayRangeM);
    const hue = 190 - 145 * Math.min(1, distance / displayRangeM);
    const size = Math.max(1, Math.min(3, 1 + point.intensity * 1.8));
    context.fillStyle = `hsla(${hue}, 92%, 62%, ${0.45 + point.intensity * 0.5})`;
    context.fillRect(projected.x - size / 2, projected.y - size / 2, size, size);
  }

  drawHeader(context, "LiDAR · 3D POINT CLOUD", pass.sensorId, timing, [
    `${points.length.toLocaleString()} points`,
    `${displayRangeM.toFixed(0)} m view`,
    "color = range",
  ]);
}

export function drawRadarFrame(
  context: CanvasRenderingContext2D,
  pass: Extract<ActiveSensorPass, { modality: "radar" }>,
  detections: readonly RadarDetection[],
  timing: Pick<FixedStepCaptureFrame, "index" | "sourceTimeSeconds">,
): void {
  const { width, height } = context.canvas;
  drawBackground(context, width, height);
  drawRadarGrid(context, width, height, pass.rangeM, pass.horizontalFovDeg);

  for (const detection of detections) {
    const projected = projectRadarDetection(detection, width, height, pass.rangeM);
    const speed = Math.min(1, Math.abs(detection.velocity) / 20);
    context.fillStyle = detection.velocity < 0
      ? `rgba(63, 196, 255, ${0.55 + speed * 0.4})`
      : `rgba(255, 101, 72, ${0.55 + speed * 0.4})`;
    context.beginPath();
    context.arc(projected.x, projected.y, 3 + speed * 3, 0, Math.PI * 2);
    context.fill();
  }

  drawHeader(context, "RADAR · RANGE / AZIMUTH", pass.sensorId, timing, [
    `${detections.length.toLocaleString()} detections`,
    `${pass.rangeM.toFixed(0)} m range`,
    "blue = approaching · red = receding",
  ]);
}

function drawBackground(context: CanvasRenderingContext2D, width: number, height: number): void {
  context.fillStyle = ACTIVE_SENSOR_VIDEO_BACKGROUND;
  context.fillRect(0, 0, width, height);
  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "rgba(9, 34, 43, 0.42)");
  gradient.addColorStop(1, "rgba(2, 5, 8, 0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
}

function drawLidarGrid(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  rangeM: number,
): void {
  context.strokeStyle = GRID;
  context.lineWidth = 1;
  for (let distance = 10; distance <= rangeM; distance += 10) {
    const left = projectLidarPoint({ x: distance, y: 0, z: distance * 0.75 }, width, height, rangeM);
    const right = projectLidarPoint({ x: distance, y: 0, z: -distance * 0.75 }, width, height, rangeM);
    context.beginPath();
    context.moveTo(left.x, left.y);
    context.lineTo(right.x, right.y);
    context.stroke();
  }
  for (const lateral of [-0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75]) {
    const start = projectLidarPoint({ x: 0, y: 0, z: rangeM * lateral }, width, height, rangeM);
    const end = projectLidarPoint({ x: rangeM, y: 0, z: rangeM * lateral }, width, height, rangeM);
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
  }
}

function drawRadarGrid(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  rangeM: number,
  horizontalFovDeg: number,
): void {
  const originX = width / 2;
  const originY = height * 0.9;
  const scale = Math.min(width * 0.43, height * 0.78) / rangeM;
  const halfFov = horizontalFovDeg * DEG_TO_RAD / 2;
  context.strokeStyle = GRID;
  context.lineWidth = 1;
  for (let fraction = 0.2; fraction <= 1; fraction += 0.2) {
    context.beginPath();
    context.arc(originX, originY, rangeM * scale * fraction, -Math.PI / 2 - halfFov, -Math.PI / 2 + halfFov);
    context.stroke();
  }
  for (const fraction of [-1, -0.5, 0, 0.5, 1]) {
    const angle = fraction * halfFov;
    context.beginPath();
    context.moveTo(originX, originY);
    context.lineTo(
      originX + Math.sin(angle) * rangeM * scale,
      originY - Math.cos(angle) * rangeM * scale,
    );
    context.stroke();
  }
}

function drawHeader(
  context: CanvasRenderingContext2D,
  title: string,
  sensorId: string,
  timing: Pick<FixedStepCaptureFrame, "index" | "sourceTimeSeconds">,
  metrics: readonly string[],
): void {
  const { width } = context.canvas;
  const margin = Math.max(20, width * 0.025);
  context.fillStyle = TEXT;
  context.font = `700 ${Math.max(16, width * 0.018)}px ui-monospace, monospace`;
  context.fillText(title, margin, margin + 20);
  context.fillStyle = MUTED_TEXT;
  context.font = `500 ${Math.max(11, width * 0.011)}px ui-monospace, monospace`;
  context.fillText(sensorId, margin, margin + 44);
  context.textAlign = "right";
  context.fillText(
    `t=${timing.sourceTimeSeconds.toFixed(3)}s · frame ${timing.index.toString().padStart(5, "0")}`,
    width - margin,
    margin + 20,
  );
  context.fillText(metrics.join(" · "), width - margin, margin + 44);
  context.textAlign = "left";
}

const DEG_TO_RAD = Math.PI / 180;
