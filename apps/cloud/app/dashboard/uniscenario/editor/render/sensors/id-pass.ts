import {
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  NoBlending,
  PerspectiveCamera,
  ShaderMaterial,
  type BufferGeometry,
  type Object3D,
  type Scene,
  type WebGLRenderer,
} from "three";
import { encodePng8Rgba } from "./png";
import { renderOffscreenRgba } from "./render-targets";

export type IdPassMode = "instance" | "semantic";
export type IdLegend = Readonly<Record<string, number>>;

const idMaterial = new ShaderMaterial({
  uniforms: {
    sensorObjectId: { value: 0 },
    sensorUseInstanceId: { value: 0 },
  },
  vertexShader: `
    attribute float sensorInstanceId;
    uniform highp float sensorObjectId;
    uniform float sensorUseInstanceId;
    varying highp float sensorId;
    void main() {
      vec3 transformed = position;
      #ifdef USE_INSTANCING
        vec4 instancePosition = instanceMatrix * vec4(transformed, 1.0);
        transformed = instancePosition.xyz;
      #endif
      sensorId = sensorUseInstanceId > 0.5 ? sensorInstanceId : sensorObjectId;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
    }
  `,
  fragmentShader: `
    varying highp float sensorId;
    void main() {
      highp float identifier = floor(clamp(sensorId, 0.0, 16777215.0) + 0.5);
      highp float red = floor(identifier / 65536.0);
      highp float remainder = identifier - red * 65536.0;
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

type PreparedObject = {
  object: Mesh;
  originalGeometry: BufferGeometry | null;
  replacementGeometry: BufferGeometry | null;
  onBeforeRender: Object3D["onBeforeRender"];
};

export type IdCaptureResult = Readonly<{
  pixels: Uint8Array;
  png: Uint8Array;
  legend: IdLegend;
}>;

export function captureIdPass(input: Readonly<{
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  width: number;
  height: number;
  nearM: number;
  farM: number;
  mode: IdPassMode;
}>): IdCaptureResult {
  const legend = buildIdLegend(input.scene, input.mode);
  const prepared: PreparedObject[] = [];
  const previousAspect = input.camera.aspect;
  const previousNear = input.camera.near;
  const previousFar = input.camera.far;
  try {
    prepareSceneIds(input.scene, input.mode, legend, prepared);
    input.camera.aspect = input.width / input.height;
    input.camera.near = input.nearM;
    input.camera.far = input.farM;
    input.camera.updateProjectionMatrix();
    const pixels = renderOffscreenRgba({ ...input, overrideMaterial: idMaterial, clearAlpha: 0 });
    return { pixels, png: encodePng8Rgba(input.width, input.height, pixels), legend };
  } finally {
    for (const item of prepared) {
      item.object.onBeforeRender = item.onBeforeRender;
      if (item.originalGeometry && item.replacementGeometry) {
        item.object.geometry = item.originalGeometry;
        item.replacementGeometry.dispose();
      }
    }
    input.camera.aspect = previousAspect;
    input.camera.near = previousNear;
    input.camera.far = previousFar;
    input.camera.updateProjectionMatrix();
  }
}

export function decodeRgb24Ids(rgba: Uint8Array): Uint32Array {
  if (rgba.byteLength % 4 !== 0) throw new Error("ID readback must contain RGBA pixels.");
  const ids = new Uint32Array(rgba.byteLength / 4);
  for (let index = 0; index < ids.length; index += 1) {
    const offset = index * 4;
    ids[index] = rgba[offset + 3] === 0 ? 0 : (rgba[offset] ?? 0) * 65536 + (rgba[offset + 1] ?? 0) * 256 + (rgba[offset + 2] ?? 0);
  }
  return ids;
}

export function buildIdLegend(scene: Scene, mode: IdPassMode): IdLegend {
  const identities = new Set<string>();
  scene.traverse((object) => {
    for (const identity of objectIdentities(object, mode)) identities.add(identity);
  });
  return allocateIds([...identities].sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
}

function allocateIds(identities: readonly string[]): IdLegend {
  const assigned: Record<string, number> = {};
  const used = new Set<number>([0]);
  for (const identity of identities.filter((value) => value.startsWith("static:"))) {
    const id = Number(identity.slice("static:".length));
    if (!Number.isSafeInteger(id) || id <= 0 || id > 0xffffff || used.has(id)) {
      throw new Error(`Static semantic instance id is invalid or duplicated: ${identity}`);
    }
    assigned[identity] = id;
    used.add(id);
  }
  for (const identity of identities.filter((value) => !value.startsWith("static:"))) {
    let id = stableId(identity);
    while (used.has(id)) id = id === 0xffffff ? 1 : id + 1;
    used.add(id);
    assigned[identity] = id;
  }
  return Object.freeze(assigned);
}

function prepareSceneIds(scene: Scene, mode: IdPassMode, legend: IdLegend, prepared: PreparedObject[]): void {
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const identities = objectIdentities(object, mode);
    if (object instanceof InstancedMesh && identities.length > 0) {
      const originalGeometry = object.geometry;
      const geometry = originalGeometry.clone();
      const values = new Float32Array(object.count);
      for (let index = 0; index < object.count; index += 1) values[index] = legend[identities[index] ?? ""] ?? 0;
      geometry.setAttribute("sensorInstanceId", new InstancedBufferAttribute(values, 1, false));
      object.geometry = geometry;
      prepared.push({
        object,
        originalGeometry,
        replacementGeometry: geometry,
        onBeforeRender: object.onBeforeRender,
      });
      object.onBeforeRender = () => {
        idMaterial.uniforms.sensorUseInstanceId!.value = 1;
        idMaterial.uniforms.sensorObjectId!.value = 0;
      };
    } else {
      prepared.push({
        object,
        originalGeometry: null,
        replacementGeometry: null,
        onBeforeRender: object.onBeforeRender,
      });
      const id = legend[identities[0] ?? ""] ?? 0;
      object.onBeforeRender = () => {
        idMaterial.uniforms.sensorUseInstanceId!.value = 0;
        idMaterial.uniforms.sensorObjectId!.value = id;
      };
    }
  });
}

function objectIdentities(object: Object3D, mode: IdPassMode): string[] {
  const actorIds = Array.isArray(object.userData.actorIds)
    ? object.userData.actorIds.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  if (mode === "instance") {
    if (actorIds.length > 0) return actorIds.map((actorId) => `actor:${actorId}`);
    const staticId = object.userData.semanticInstanceId;
    return Number.isSafeInteger(staticId) && staticId > 0 && staticId <= 0xffffff ? [`static:${staticId}`] : [];
  }
  const staticClass = object.userData.semanticClass;
  if (typeof staticClass === "string" && staticClass.length > 0) return [staticClass];
  const identity = object.userData.renderIdentity;
  const actorClass = identity && typeof identity === "object" && "kind" in identity && typeof identity.kind === "string"
    ? identity.kind
    : "other";
  return actorIds.map(() => actorClass);
}

function stableId(identity: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 0xffffff) + 1;
}
