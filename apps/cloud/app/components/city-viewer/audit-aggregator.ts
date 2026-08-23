import type { CacheStats } from "./streaming/tile-cache";
import type { QualityTier } from "./quality";

// AuditAggregator — issue 07 dev-only metrics aggregator. Pure data sink that
// the viewer feeds with observable signals from the frame loop, the tile
// cache, the texture downscaler, and the LOD selector. The aggregator never
// imports Three.js — every input is a primitive value or a small POJO so the
// class is unit-testable without a renderer.

export interface AuditAggregatorOptions {
  /** Rolling window size for frame-time samples. Default 600 (10s @ 60fps). */
  frameWindowSize?: number;
  /** Cap on the event log; oldest entries are dropped FIFO. Default 1000. */
  maxEvents?: number;
}

export interface FrameSample {
  frameTimeMs: number;
  drawCalls: number;
  gpuTotalMB: number;
  vegetationInstances: number;
}

export interface TextureDownscale {
  beforeBytes: number;
  afterBytes: number;
}

interface BaseEvent {
  ts: number;
}

export type AuditEvent =
  | (BaseEvent & { type: "cache-eviction"; countDelta: number; bytesDelta: number })
  | (BaseEvent & {
      type: "texture-downscale";
      beforeBytes: number;
      afterBytes: number;
      bytesSaved: number;
    })
  | (BaseEvent & { type: "lod-floor-clamp"; tileId: string })
  | (BaseEvent & { type: "quality-tier"; tier: QualityTier; reason: string });

export interface AuditState {
  qualityTier: QualityTier | null;
  qualityReason: string | null;
  fps: {
    current: number;
    p50: number;
    p99: number;
    p50FrameMs: number;
    p99FrameMs: number;
  };
  drawCalls: number;
  gpuTotalMB: number;
  cache: {
    size: number;
    byteSize: number;
    pinnedCount: number;
    evictionCount: number;
    bytesEvictedTotal: number;
    bytesEvictedPerSecond: number;
  };
  textures: {
    downscaleCount: number;
    bytesSavedTotal: number;
  };
  /** Story 34: tier-policy floor clamps, distinct from selector choices. */
  lodFloorClampCount: number;
  lodSelectorChoiceCount: number;
  frameBudget: {
    over16ms: number;
    over33ms: number;
  };
  vegetationInstances: number;
  events: AuditEvent[];
}

const DEFAULT_FRAME_WINDOW = 600;
const DEFAULT_MAX_EVENTS = 1000;
const FRAME_BUDGET_60FPS_MS = 1000 / 60;
const FRAME_BUDGET_30FPS_MS = 1000 / 30;

function now(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx]!;
}

export class AuditAggregator {
  private readonly frameWindowSize: number;
  private readonly maxEvents: number;

  private frameTimes: number[] = [];
  private currentFrameTimeMs = 0;
  private over16ms = 0;
  private over33ms = 0;

  private drawCalls = 0;
  private gpuTotalMB = 0;
  private vegetationInstances = 0;

  private qualityTier: QualityTier | null = null;
  private qualityReason: string | null = null;

  private lastEvictionCount = 0;
  private lastBytesEvicted = 0;
  private lastCacheStats: CacheStats = {
    evictionCount: 0,
    bytesEvicted: 0,
    pinnedCount: 0,
    cachedCount: 0,
    currentBytes: 0,
  };
  private lastCacheStatsTs: number | null = null;
  private bytesEvictedPerSecond = 0;

  private textureDownscaleCount = 0;
  private textureBytesSavedTotal = 0;

  private lodFloorClampCount = 0;
  private lodSelectorChoiceCount = 0;

  private events: AuditEvent[] = [];

  constructor(options: AuditAggregatorOptions = {}) {
    this.frameWindowSize = options.frameWindowSize ?? DEFAULT_FRAME_WINDOW;
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  }

  recordFrame(sample: FrameSample): void {
    this.currentFrameTimeMs = sample.frameTimeMs;
    this.frameTimes.push(sample.frameTimeMs);
    if (this.frameTimes.length > this.frameWindowSize) {
      this.frameTimes.shift();
    }
    if (sample.frameTimeMs > FRAME_BUDGET_60FPS_MS) this.over16ms++;
    if (sample.frameTimeMs > FRAME_BUDGET_30FPS_MS) this.over33ms++;

    this.drawCalls = sample.drawCalls;
    this.gpuTotalMB = sample.gpuTotalMB;
    this.vegetationInstances = sample.vegetationInstances;
  }

  recordCacheStats(stats: CacheStats, ts: number = now()): void {
    const evictionDelta = stats.evictionCount - this.lastEvictionCount;
    const bytesDelta = stats.bytesEvicted - this.lastBytesEvicted;

    if (this.lastCacheStatsTs !== null && evictionDelta > 0) {
      const seconds = (ts - this.lastCacheStatsTs) / 1000;
      this.bytesEvictedPerSecond = seconds > 0 ? bytesDelta / seconds : 0;
      this.pushEvent({
        type: "cache-eviction",
        ts,
        countDelta: evictionDelta,
        bytesDelta,
      });
    } else if (evictionDelta === 0 && this.lastCacheStatsTs !== null) {
      const seconds = (ts - this.lastCacheStatsTs) / 1000;
      if (seconds > 1) this.bytesEvictedPerSecond = 0;
    }

    this.lastEvictionCount = stats.evictionCount;
    this.lastBytesEvicted = stats.bytesEvicted;
    this.lastCacheStats = { ...stats };
    this.lastCacheStatsTs = ts;
  }

  recordTextureDownscale(downscale: TextureDownscale, ts: number = now()): void {
    const bytesSaved = Math.max(0, downscale.beforeBytes - downscale.afterBytes);
    this.textureDownscaleCount++;
    this.textureBytesSavedTotal += bytesSaved;
    this.pushEvent({
      type: "texture-downscale",
      ts,
      beforeBytes: downscale.beforeBytes,
      afterBytes: downscale.afterBytes,
      bytesSaved,
    });
  }

  recordLodFloorClamp(tileId: string, ts: number = now()): void {
    this.lodFloorClampCount++;
    this.pushEvent({ type: "lod-floor-clamp", ts, tileId });
  }

  recordLodSelectorChoice(_tileId: string, _level: number): void {
    this.lodSelectorChoiceCount++;
  }

  recordQualityTier(tier: QualityTier, reason: string, ts: number = now()): void {
    this.qualityTier = tier;
    this.qualityReason = reason;
    this.pushEvent({ type: "quality-tier", ts, tier, reason });
  }

  getState(): AuditState {
    const p50FrameMs = percentile(this.frameTimes, 0.5);
    const p99FrameMs = percentile(this.frameTimes, 0.99);

    return {
      qualityTier: this.qualityTier,
      qualityReason: this.qualityReason,
      fps: {
        current: this.currentFrameTimeMs > 0 ? 1000 / this.currentFrameTimeMs : 0,
        p50: p50FrameMs > 0 ? 1000 / p50FrameMs : 0,
        p99: p99FrameMs > 0 ? 1000 / p99FrameMs : 0,
        p50FrameMs,
        p99FrameMs,
      },
      drawCalls: this.drawCalls,
      gpuTotalMB: this.gpuTotalMB,
      cache: {
        size: this.lastCacheStats.cachedCount,
        byteSize: this.lastCacheStats.currentBytes,
        pinnedCount: this.lastCacheStats.pinnedCount,
        evictionCount: this.lastCacheStats.evictionCount,
        bytesEvictedTotal: this.lastCacheStats.bytesEvicted,
        bytesEvictedPerSecond: this.bytesEvictedPerSecond,
      },
      textures: {
        downscaleCount: this.textureDownscaleCount,
        bytesSavedTotal: this.textureBytesSavedTotal,
      },
      lodFloorClampCount: this.lodFloorClampCount,
      lodSelectorChoiceCount: this.lodSelectorChoiceCount,
      frameBudget: {
        over16ms: this.over16ms,
        over33ms: this.over33ms,
      },
      vegetationInstances: this.vegetationInstances,
      events: [...this.events],
    };
  }

  serializeForExport(): string {
    return JSON.stringify(
      {
        ...this.getState(),
        exportedAt: now(),
      },
      null,
      2,
    );
  }

  private pushEvent(event: AuditEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }
}
