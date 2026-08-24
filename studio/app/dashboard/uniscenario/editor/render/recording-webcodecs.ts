export type BrowserVideoQuality = "draft" | "standard" | "high";

export type BrowserVideoConfig = {
  width: number;
  height: number;
  fps: number;
  quality: BrowserVideoQuality;
};

export type BrowserVideoCapability =
  | { supported: true; codec: "vp9"; codecString: string }
  | { supported: false; reason: string };

type EncodedFrame = {
  timestampUs: number;
  durationUs: number | null;
  key: boolean;
  data: Uint8Array;
};

const NO_CAPTURE_FAILURE = Symbol("no capture failure");

const CODECS = [
  { codec: "vp9" as const, codecString: "vp09.00.10.08" },
];

const QUALITY_BITRATE: Record<BrowserVideoQuality, number> = {
  draft: 3_000_000,
  standard: 7_000_000,
  high: 14_000_000,
};

/**
 * Product capability probe. Recording never falls back to MediaRecorder or a
 * requestAnimationFrame clock: those paths cannot preserve the capture
 * manifest's exact frame schedule.
 */
export async function probeBrowserVideoEncoder(
  config: BrowserVideoConfig,
): Promise<BrowserVideoCapability> {
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") {
    return {
      supported: false,
      reason: "This browser does not provide the WebCodecs video encoder.",
    };
  }

  for (const candidate of CODECS) {
    try {
      const result = await VideoEncoder.isConfigSupported(
        videoEncoderConfig(config, candidate.codecString),
      );
      if (result.supported) return { supported: true, ...candidate };
    } catch {
      // A browser is allowed to reject a codec string instead of returning
      // supported=false. Continue to the next explicitly-defined WebM codec.
    }
  }

  return {
    supported: false,
    reason: "This browser cannot encode the VP9 WebM profile used by deterministic recording.",
  };
}

export async function encodeDeterministicWebm(input: {
  canvas: HTMLCanvasElement;
  schedule: Readonly<ResolvedFrameSchedule>;
  config: BrowserVideoConfig;
  renderFrame: (timing: FixedStepCaptureFrame) => void | Promise<void>;
  signal?: AbortSignal;
  onProgress?: (completedFrames: number, totalFrames: number) => void;
}): Promise<{ blob: Blob; codec: "vp9"; frameCount: number }> {
  const capability = await probeBrowserVideoEncoder(input.config);
  if (!capability.supported) throw new Error(capability.reason);

  const frames: EncodedFrame[] = [];
  let encoderFailure: Error | null = null;
  const encoder = new VideoEncoder({
    error: (reason) => {
      encoderFailure = reason instanceof Error ? reason : new Error(String(reason));
    },
    output: (chunk) => {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      frames.push({
        timestampUs: chunk.timestamp,
        durationUs: chunk.duration,
        key: chunk.type === "key",
        data: bytes,
      });
    },
  });

  let captureFailure: unknown | typeof NO_CAPTURE_FAILURE = NO_CAPTURE_FAILURE;
  try {
    encoder.configure(videoEncoderConfig(input.config, capability.codecString));
    await runFixedStepCapture<VideoFrame>({
      schedule: input.schedule,
      signal: input.signal,
      renderFrame: async (timing) => {
        await input.renderFrame(timing);
        return new VideoFrame(input.canvas, {
          timestamp: timing.timestampUs,
          duration: timing.durationUs,
        });
      },
      sink: {
        write: async (frame, timing) => {
          if (encoderFailure) throw encoderFailure;
          encoder.encode(frame, {
            keyFrame: timing.index % Math.max(1, input.config.fps * 2) === 0,
          });
          if (encoder.encodeQueueSize > 3) await encoder.flush();
          if (encoderFailure) throw encoderFailure;
        },
        flush: async () => {
          await encoder.flush();
          if (encoderFailure) throw encoderFailure;
        },
      },
      releaseFrame: (frame) => frame.close(),
      onProgress: ({ completedFrames, totalFrames }) => {
        input.onProgress?.(completedFrames, totalFrames);
      },
    });
  } catch (error) {
    captureFailure = error;
    throw error;
  } finally {
    if (encoder.state !== "closed") {
      try {
        encoder.close();
      } catch (closeError) {
        if (captureFailure === NO_CAPTURE_FAILURE) throw closeError;
      }
    }
  }

  assertEncodedFramesMatchSchedule(frames, input.schedule);
  const bytes = muxWebm({
    codecId: "V_VP9",
    width: input.config.width,
    height: input.config.height,
    fps: input.config.fps,
    durationUs: input.schedule.endTimestampUs,
    frames,
  });
  return {
    blob: new Blob([bytes.buffer as ArrayBuffer], { type: "video/webm" }),
    codec: capability.codec,
    frameCount: frames.length,
  };
}

function videoEncoderConfig(
  config: BrowserVideoConfig,
  codec: string,
): VideoEncoderConfig {
  const pixels = Math.max(1, config.width * config.height);
  const scale = Math.max(0.45, Math.min(2.4, pixels / (1280 * 720)));
  return {
    codec,
    width: config.width,
    height: config.height,
    framerate: config.fps,
    bitrate: Math.round(QUALITY_BITRATE[config.quality] * scale),
    latencyMode: "quality",
  };
}

function muxWebm(input: {
  codecId: "V_VP9" | "V_VP8";
  width: number;
  height: number;
  fps: number;
  durationUs: number;
  frames: readonly EncodedFrame[];
}): Uint8Array {
  // A 1µs timecode scale lets every exact WebCodecs timestamp survive the
  // container. Each frame gets its own cluster, so SimpleBlock's signed 16-bit
  // relative timecode never imposes a duration limit.
  const timecodeScaleNs = 1_000;
  const ebmlHeader = element(0x1a45dfa3, concat(
    element(0x4286, uint(1)),
    element(0x42f7, uint(1)),
    element(0x42f2, uint(4)),
    element(0x42f3, uint(8)),
    element(0x4282, text("webm")),
    element(0x4287, uint(4)),
    element(0x4285, uint(2)),
  ));
  const info = element(0x1549a966, concat(
    element(0x2ad7b1, uint(timecodeScaleNs)),
    element(0x4489, float64(input.durationUs)),
    element(0x4d80, text("SimForge deterministic browser recorder")),
    element(0x5741, text("SimForge deterministic browser recorder")),
  ));
  const video = element(0xe0, concat(
    element(0xb0, uint(input.width)),
    element(0xba, uint(input.height)),
  ));
  const track = element(0xae, concat(
    element(0xd7, uint(1)),
    element(0x73c5, uint(1)),
    element(0x83, uint(1)),
    element(0x86, text(input.codecId)),
    element(0x23e383, uint(Math.round(1_000_000_000 / input.fps))),
    video,
  ));
  const tracks = element(0x1654ae6b, track);
  const clusters = input.frames.map((frame) => {
    const simpleBlock = concat(
      new Uint8Array([0x81, 0, 0, frame.key ? 0x80 : 0]),
      frame.data,
    );
    return element(0x1f43b675, concat(
      element(0xe7, uint(frame.timestampUs)),
      element(0xa3, simpleBlock),
    ));
  });
  return concat(ebmlHeader, element(0x18538067, concat(info, tracks, ...clusters)));
}

function assertEncodedFramesMatchSchedule(
  frames: readonly EncodedFrame[],
  schedule: Readonly<ResolvedFrameSchedule>,
): void {
  if (frames.length !== schedule.frameCount) {
    throw new Error(
      `WebCodecs emitted ${frames.length} frames for a ${schedule.frameCount}-frame capture schedule.`,
    );
  }

  let previousTimestampUs = -1;
  for (const timing of fixedStepCaptureFrames(schedule)) {
    const frame = frames[timing.index];
    if (!frame) {
      throw new Error(`WebCodecs omitted encoded frame ${timing.index}.`);
    }
    if (frame.timestampUs <= previousTimestampUs) {
      throw new Error(
        `WebCodecs frame ${timing.index} timestamp ${frame.timestampUs} is not strictly ordered.`,
      );
    }
    if (frame.timestampUs !== timing.timestampUs) {
      throw new Error(
        `WebCodecs frame ${timing.index} timestamp ${frame.timestampUs} does not match the capture schedule timestamp ${timing.timestampUs}.`,
      );
    }
    if (frame.durationUs !== timing.durationUs) {
      throw new Error(
        `WebCodecs frame ${timing.index} duration ${String(frame.durationUs)} does not match the capture schedule duration ${timing.durationUs}.`,
      );
    }
    if (frame.data.byteLength === 0) {
      throw new Error(`WebCodecs emitted an empty payload for frame ${timing.index}.`);
    }
    previousTimestampUs = frame.timestampUs;
  }

  if (!frames[0]?.key) {
    throw new Error("WebCodecs did not emit a key frame at the start of the capture.");
  }
}

function element(id: number, payload: Uint8Array): Uint8Array {
  return concat(idBytes(id), vint(payload.byteLength), payload);
}

function idBytes(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return new Uint8Array(bytes);
}

function vint(value: number): Uint8Array {
  for (let length = 1; length <= 8; length += 1) {
    const max = 2 ** (7 * length) - 2;
    if (value > max) continue;
    const bytes = new Uint8Array(length);
    let remaining = value;
    for (let index = length - 1; index >= 0; index -= 1) {
      bytes[index] = remaining & 0xff;
      remaining = Math.floor(remaining / 256);
    }
    bytes[0] = (bytes[0] ?? 0) | (1 << (8 - length));
    return bytes;
  }
  throw new Error("WebM element is too large for an EBML variable integer.");
}

function uint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid EBML integer.");
  if (value === 0) return new Uint8Array([0]);
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return new Uint8Array(bytes);
}

function float64(value: number): Uint8Array {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value);
  return new Uint8Array(buffer);
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
import type { ResolvedFrameSchedule } from "@simforge/scenario";
import {
  fixedStepCaptureFrames,
  runFixedStepCapture,
  type FixedStepCaptureFrame,
} from "@simforge/playback";
