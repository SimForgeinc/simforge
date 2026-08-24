import {
  DoubleSide,
  NoBlending,
  PerspectiveCamera,
  ShaderMaterial,
  type Scene,
  type WebGLRenderer,
} from "three";
import { encodePng16Gray } from './png.js';
import { renderOffscreenRgba, type RenderResourcePool } from './render-targets.js';

export const DEPTH_PNG_METRES_PER_UNIT = 0.001;
export const DEPTH_PNG_MAX_METRES = 65.534;

const depthMaterial = new ShaderMaterial({
  vertexShader: `
    varying highp float sensorViewDepth;
    void main() {
      vec3 transformed = position;
      #ifdef USE_INSTANCING
        vec4 instancePosition = instanceMatrix * vec4(transformed, 1.0);
        transformed = instancePosition.xyz;
      #endif
      vec4 viewPosition = modelViewMatrix * vec4(transformed, 1.0);
      sensorViewDepth = -viewPosition.z;
      gl_Position = projectionMatrix * viewPosition;
    }
  `,
  fragmentShader: `
    varying highp float sensorViewDepth;
    void main() {
      highp float millimetres = floor(clamp(sensorViewDepth * 1000.0, 0.0, 16777215.0) + 0.5);
      highp float red = floor(millimetres / 65536.0);
      highp float remainder = millimetres - red * 65536.0;
      highp float green = floor(remainder / 256.0);
      highp float blue = remainder - green * 256.0;
      gl_FragColor = vec4(red, green, blue, 255.0) / 255.0;
    }
  `,
  depthTest: true,
  depthWrite: true,
  side: DoubleSide,
  blending: NoBlending,
  toneMapped: false,
});

export type DepthCaptureInput = Readonly<{
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  width: number;
  height: number;
  nearM: number;
  farM: number;
  resourcePool?: RenderResourcePool;
  resourceKey?: string;
  onTiming?: (stage: 'scenePass' | 'readback', milliseconds: number) => void;
}>;

/** Render camera-space linear depth in metres; Infinity marks background. */
export function captureLinearDepthMeters(input: DepthCaptureInput): Float32Array {
  if (!(input.nearM > 0) || !(input.farM > input.nearM)) throw new Error("Depth clipping planes are invalid.");
  const previousAspect = input.camera.aspect;
  const previousNear = input.camera.near;
  const previousFar = input.camera.far;
  let rgba: Uint8Array;
  try {
    input.camera.aspect = input.width / input.height;
    input.camera.near = input.nearM;
    input.camera.far = input.farM;
    input.camera.updateProjectionMatrix();
    rgba = renderOffscreenRgba({
      ...input,
      overrideMaterial: depthMaterial,
      clearAlpha: 0,
    });
  } finally {
    input.camera.aspect = previousAspect;
    input.camera.near = previousNear;
    input.camera.far = previousFar;
    input.camera.updateProjectionMatrix();
  }
  return decodeDepthMillimetres(rgba, input.farM);
}

export function decodeDepthMillimetres(rgba: Uint8Array, farM = Number.POSITIVE_INFINITY): Float32Array {
  if (rgba.byteLength % 4 !== 0) throw new Error("Packed depth readback must contain RGBA pixels.");
  const depth = new Float32Array(rgba.byteLength / 4);
  for (let index = 0; index < depth.length; index += 1) {
    const offset = index * 4;
    if (rgba[offset + 3] === 0) {
      depth[index] = Number.POSITIVE_INFINITY;
      continue;
    }
    const metres = ((rgba[offset] ?? 0) * 65536 + (rgba[offset + 1] ?? 0) * 256 + (rgba[offset + 2] ?? 0)) / 1000;
    depth[index] = metres <= farM ? metres : Number.POSITIVE_INFINITY;
  }
  return depth;
}

/** PNG16 depth stores integer millimetres; 0xffff is the out-of-range/background sentinel. */
export function depthMetersToPng16(width: number, height: number, depth: Float32Array): Uint8Array {
  if (depth.length !== width * height) throw new Error("Depth dimensions do not match its sample count.");
  const samples = new Uint16Array(depth.length);
  for (let index = 0; index < depth.length; index += 1) {
    const metres = depth[index] ?? Number.POSITIVE_INFINITY;
    const millimetres = Math.round(metres / DEPTH_PNG_METRES_PER_UNIT);
    samples[index] = Number.isFinite(metres) && metres >= 0 && millimetres < 0xffff
      ? millimetres
      : 0xffff;
  }
  return encodePng16Gray(width, height, samples);
}
