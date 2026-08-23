import {
  Color,
  LinearSRGBColorSpace,
  NearestFilter,
  NoToneMapping,
  RGBAFormat,
  UnsignedByteType,
  Vector4,
  WebGLRenderTarget,
  type Camera,
  type Material,
  type Scene,
  type WebGLRenderer,
} from "three";

export type OffscreenRenderInput = Readonly<{
  renderer: WebGLRenderer;
  scene: Scene;
  camera: Camera;
  width: number;
  height: number;
  overrideMaterial?: Material | null;
  beforeRender?: () => void;
  clearColor?: Color;
  clearAlpha?: number;
}>;

/**
 * Render one byte-exact RGBA pass and restore every renderer/scene mutation in
 * a finally block. Returned rows are top-to-bottom (WebGL readback is flipped).
 */
export function renderOffscreenRgba(input: OffscreenRenderInput): Uint8Array {
  if (!Number.isSafeInteger(input.width) || input.width <= 0 || !Number.isSafeInteger(input.height) || input.height <= 0) {
    throw new Error("Offscreen dimensions must be positive safe integers.");
  }
  const target = new WebGLRenderTarget(input.width, input.height, {
    format: RGBAFormat,
    type: UnsignedByteType,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
    samples: 0,
  });
  target.texture.colorSpace = LinearSRGBColorSpace;

  const renderer = input.renderer;
  const previousTarget = renderer.getRenderTarget();
  const previousViewport = renderer.getViewport(new Vector4());
  const previousScissor = renderer.getScissor(new Vector4());
  const previousScissorTest = renderer.getScissorTest();
  const previousClearColor = renderer.getClearColor(new Color());
  const previousClearAlpha = renderer.getClearAlpha();
  const previousToneMapping = renderer.toneMapping;
  const previousOutputColorSpace = renderer.outputColorSpace;
  const previousAutoClear = renderer.autoClear;
  const previousXrEnabled = renderer.xr.enabled;
  const previousShadowsEnabled = renderer.shadowMap.enabled;
  const previousOverrideMaterial = input.scene.overrideMaterial;
  const pixels = new Uint8Array(input.width * input.height * 4);

  try {
    renderer.xr.enabled = false;
    renderer.shadowMap.enabled = false;
    renderer.toneMapping = NoToneMapping;
    renderer.outputColorSpace = LinearSRGBColorSpace;
    renderer.autoClear = true;
    renderer.setRenderTarget(target);
    renderer.setViewport(0, 0, input.width, input.height);
    renderer.setScissor(0, 0, input.width, input.height);
    renderer.setScissorTest(false);
    renderer.setClearColor(input.clearColor ?? new Color(0), input.clearAlpha ?? 0);
    input.scene.overrideMaterial = input.overrideMaterial ?? null;
    input.beforeRender?.();
    renderer.clear(true, true, true);
    renderer.render(input.scene, input.camera);
    renderer.readRenderTargetPixels(target, 0, 0, input.width, input.height, pixels);
  } finally {
    input.scene.overrideMaterial = previousOverrideMaterial;
    renderer.setRenderTarget(previousTarget);
    renderer.setViewport(previousViewport);
    renderer.setScissor(previousScissor);
    renderer.setScissorTest(previousScissorTest);
    renderer.setClearColor(previousClearColor, previousClearAlpha);
    renderer.toneMapping = previousToneMapping;
    renderer.outputColorSpace = previousOutputColorSpace;
    renderer.autoClear = previousAutoClear;
    renderer.xr.enabled = previousXrEnabled;
    renderer.shadowMap.enabled = previousShadowsEnabled;
    target.dispose();
  }
  return flipRgbaRows(pixels, input.width, input.height);
}

export function flipRgbaRows(pixels: Uint8Array, width: number, height: number): Uint8Array {
  if (pixels.byteLength !== width * height * 4) throw new Error("RGBA readback dimensions do not match its byte length.");
  const output = new Uint8Array(pixels.byteLength);
  const stride = width * 4;
  for (let row = 0; row < height; row += 1) {
    output.set(pixels.subarray(row * stride, (row + 1) * stride), (height - row - 1) * stride);
  }
  return output;
}
