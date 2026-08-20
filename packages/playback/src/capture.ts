/**
 * Deterministic, renderer- and encoder-agnostic fixed-step capture.
 *
 * A caller advances playback and produces an opaque frame in `renderFrame`;
 * the sink owns encoding/storage. This package only owns timing, ordering,
 * cancellation, progress, and a hard bound on frames awaiting the sink.
 */

import {
  fixedStepFrameCount,
  type ResolvedFrameSchedule,
} from '@uniscenarios/scenario-model';

export interface CaptureClip {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly fps: number;
}

export interface FixedStepCaptureFrame {
  readonly index: number;
  readonly totalFrames: number;
  /** Exact playback sample requested from the scenario trace. */
  readonly sourceTimeSeconds: number;
  /** Media timestamp relative to the beginning of the captured clip. */
  readonly timestampUs: number;
  readonly durationUs: number;
}

export interface CaptureProgress {
  readonly completedFrames: number;
  readonly totalFrames: number;
  readonly fraction: number;
}

export interface CaptureSummary {
  readonly schedule: Readonly<ResolvedFrameSchedule>;
  readonly framesWritten: number;
}

export interface CaptureFrameSink<Frame> {
  /**
   * Resolve only when the sink has accepted the frame and its storage may be
   * released. A WebCodecs adapter can wait for encode-queue capacity here.
   */
  write(
    frame: Frame,
    timing: FixedStepCaptureFrame,
    signal: AbortSignal,
  ): void | Promise<void>;
  /** Drain encoder/muxer state after all frames have been accepted. */
  flush?(signal: AbortSignal): void | Promise<void>;
  /** Finalize a successful artifact. */
  close?(summary: CaptureSummary): void | Promise<void>;
  /** Cancel partial output and release downstream resources. */
  abort?(reason: unknown): void | Promise<void>;
}

export interface FixedStepCaptureOptions<Frame> {
  readonly schedule: Readonly<ResolvedFrameSchedule>;
  readonly renderFrame: (
    timing: FixedStepCaptureFrame,
    signal: AbortSignal,
  ) => Frame | Promise<Frame>;
  readonly sink: CaptureFrameSink<Frame>;
  readonly signal?: AbortSignal;
  /** Serialized in v1: omitted or exactly one. */
  readonly maxInFlight?: number;
  /** Called after the sink has finished with a frame (for example VideoFrame.close). */
  readonly releaseFrame?: (frame: Frame) => void;
  readonly onProgress?: (progress: CaptureProgress) => void;
}

export class CaptureCancelledError extends Error {
  readonly reason: unknown;

  constructor(reason?: unknown) {
    super('fixed-step capture was cancelled');
    this.name = 'CaptureCancelledError';
    this.reason = reason;
  }
}

/** Build the serializable schedule stored in a resolved capture manifest. */
export function createFixedStepCaptureSchedule(clip: CaptureClip): Readonly<ResolvedFrameSchedule> {
  if (!Number.isFinite(clip.startSeconds) || clip.startSeconds < 0) {
    throw new RangeError('capture startSeconds must be finite and non-negative');
  }
  if (!Number.isFinite(clip.endSeconds) || clip.endSeconds <= clip.startSeconds) {
    throw new RangeError('capture endSeconds must be finite and greater than startSeconds');
  }
  if (!Number.isInteger(clip.fps) || clip.fps < 1 || clip.fps > 120) {
    throw new RangeError('capture fps must be an integer between 1 and 120');
  }
  const frameCount = fixedStepFrameCount(clip.startSeconds, clip.endSeconds, clip.fps);
  return Object.freeze({
    startSeconds: clip.startSeconds,
    endSeconds: clip.endSeconds,
    fps: clip.fps,
    frameCount,
    timestampUnit: 'microseconds' as const,
    firstTimestampUs: 0 as const,
    endTimestampUs: timestampBoundaryUs(frameCount, clip.fps),
  });
}

/** Resolve one deterministic source sample and media timestamp by frame index. */
export function fixedStepCaptureFrame(
  schedule: Readonly<ResolvedFrameSchedule>,
  index: number,
): FixedStepCaptureFrame {
  if (!Number.isInteger(index) || index < 0 || index >= schedule.frameCount) {
    throw new RangeError(`capture frame index ${index} is outside [0, ${schedule.frameCount})`);
  }
  const timestampUs = timestampBoundaryUs(index, schedule.fps);
  const nextTimestampUs = timestampBoundaryUs(index + 1, schedule.fps);
  return Object.freeze({
    index,
    totalFrames: schedule.frameCount,
    sourceTimeSeconds: schedule.startSeconds + index / schedule.fps,
    timestampUs,
    durationUs: nextTimestampUs - timestampUs,
  });
}

/** Iterate timing records lazily; large captures never allocate a frame table. */
export function* fixedStepCaptureFrames(
  schedule: Readonly<ResolvedFrameSchedule>,
): Generator<FixedStepCaptureFrame, void, undefined> {
  for (let index = 0; index < schedule.frameCount; index++) {
    yield fixedStepCaptureFrame(schedule, index);
  }
}

/**
 * Render and deliver a fixed-step clip with serialized sink writes. This is a
 * deliberate first-release contract: cleanup never calls `abort` while an
 * encoder write is still outstanding, and at most one opaque frame is held.
 */
export async function runFixedStepCapture<Frame>(
  options: FixedStepCaptureOptions<Frame>,
): Promise<CaptureSummary> {
  validateSchedule(options.schedule);
  const maxInFlight = options.maxInFlight ?? 1;
  if (maxInFlight !== 1) {
    throw new RangeError('fixed-step capture currently requires serialized sink writes (maxInFlight = 1)');
  }

  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener('abort', forwardAbort, { once: true });
  const signal = controller.signal;
  let completedFrames = 0;
  let writtenFrames = 0;

  const progress = (): void => options.onProgress?.({
    completedFrames,
    totalFrames: options.schedule.frameCount,
    fraction: completedFrames / options.schedule.frameCount,
  });

  progress();
  try {
    for (const timing of fixedStepCaptureFrames(options.schedule)) {
      throwIfCancelled(signal);
      const frame = await options.renderFrame(timing, signal);
      // The source may finish concurrently with cancellation. Release the
      // newly-created frame before surfacing the cancellation.
      if (signal.aborted) options.releaseFrame?.(frame);
      throwIfCancelled(signal);
      try {
        await options.sink.write(frame, timing, signal);
        writtenFrames += 1;
        completedFrames += 1;
        progress();
      } finally {
        options.releaseFrame?.(frame);
      }
    }
    throwIfCancelled(signal);
    await options.sink.flush?.(signal);
    throwIfCancelled(signal);
    const summary = Object.freeze({
      schedule: options.schedule,
      framesWritten: writtenFrames,
    });
    await options.sink.close?.(summary);
    return summary;
  } catch (caught) {
    const error = signal.aborted && !(caught instanceof CaptureCancelledError)
      ? new CaptureCancelledError(signal.reason)
      : caught;
    if (!signal.aborted) controller.abort(error);
    try {
      await options.sink.abort?.(error);
    } catch {
      // Preserve the original capture failure; adapter abort is best-effort.
    }
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}

function timestampBoundaryUs(index: number, fps: number): number {
  return Math.round(index * 1_000_000 / fps);
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new CaptureCancelledError(signal.reason);
}

function validateSchedule(schedule: Readonly<ResolvedFrameSchedule>): void {
  const canonical = createFixedStepCaptureSchedule(schedule);
  if (canonical.frameCount !== schedule.frameCount
    || canonical.timestampUnit !== schedule.timestampUnit
    || canonical.firstTimestampUs !== schedule.firstTimestampUs
    || canonical.endTimestampUs !== schedule.endTimestampUs) {
    throw new RangeError('capture schedule is not a canonical fixed-step schedule');
  }
}
