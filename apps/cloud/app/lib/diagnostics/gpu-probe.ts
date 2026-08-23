/**
 * Shared synchronous WebGL/WebGL2 capability probe used by map and viewer
 * diagnostics. Captures vendor + (when exposed) unmasked GPU strings so we
 * can tell apart "GPU process disabled" / SwiftShader / blocklisted-driver
 * cases on user devices.
 */

export type WebGLProbe = {
  webgl: boolean;
  webgl2: boolean;
  renderer?: string;
  vendor?: string;
  unmaskedRenderer?: string;
  unmaskedVendor?: string;
  maxTextureSize?: number;
  /** statusMessage from a `webglcontextcreationerror` event, if one fired. */
  contextCreationError?: string;
};

export function probeWebGL(): WebGLProbe {
  if (typeof document === "undefined") {
    return { webgl: false, webgl2: false };
  }

  const canvas = document.createElement("canvas");

  let contextCreationError: string | undefined;
  const onCreationError = (event: Event) => {
    const detail = (event as Event & { statusMessage?: string }).statusMessage;
    if (detail) contextCreationError = detail;
  };
  canvas.addEventListener("webglcontextcreationerror", onCreationError, false);

  let gl: WebGL2RenderingContext | WebGLRenderingContext | null = null;
  let webgl2 = false;

  try {
    gl = canvas.getContext("webgl2");
    webgl2 = gl != null;
  } catch (err) {
    contextCreationError = contextCreationError ?? String(err);
  }

  if (!gl) {
    try {
      gl =
        (canvas.getContext("webgl") as WebGLRenderingContext | null) ??
        (canvas.getContext("experimental-webgl") as WebGLRenderingContext | null);
    } catch (err) {
      contextCreationError = contextCreationError ?? String(err);
    }
  }

  canvas.removeEventListener("webglcontextcreationerror", onCreationError, false);

  if (!gl) {
    return { webgl: false, webgl2: false, contextCreationError };
  }

  const probe: WebGLProbe = {
    webgl: true,
    webgl2,
    renderer: safeGetParam(gl, gl.RENDERER),
    vendor: safeGetParam(gl, gl.VENDOR),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    contextCreationError,
  };

  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
  if (debugInfo) {
    probe.unmaskedRenderer = safeGetParam(gl, debugInfo.UNMASKED_RENDERER_WEBGL);
    probe.unmaskedVendor = safeGetParam(gl, debugInfo.UNMASKED_VENDOR_WEBGL);
  }

  const lose = gl.getExtension("WEBGL_lose_context");
  lose?.loseContext();

  return probe;
}

function safeGetParam(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  pname: number,
): string | undefined {
  try {
    const value = gl.getParameter(pname);
    return typeof value === "string" ? value : value == null ? undefined : String(value);
  } catch {
    return undefined;
  }
}
