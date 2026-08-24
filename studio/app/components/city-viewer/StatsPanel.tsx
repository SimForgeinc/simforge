'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { ViewerStats, MemoryMetrics, StreamingMetrics } from './city-viewer-core';

// Dev-only stats overlay. Imported by `CityViewer.tsx` only on dev/staging
// builds; the dynamic-import wrapper there tree-shakes this file out of
// production bundles entirely.
//
// After ABH-66 the panel is mounted as the body of a `ViewerAccordionSection`
// — Shift+H visibility, collapse, and section chrome live in the accordion,
// not here. The body keeps `onDump` so the section's MEM affordance can be
// rendered next to the stats grid without a second dynamic import.

interface Props {
  stats: ViewerStats;
  onDump: () => void;
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function gpuColor(mb: number): string {
  if (mb > 1500) return 'text-destructive font-medium';
  if (mb > 800) return 'text-yellow-500';
  return '';
}

function growthColor(rate: number): string {
  if (rate <= 0) return 'text-green-500';
  if (rate > 15) return 'text-destructive font-medium';
  if (rate > 5) return 'text-yellow-500';
  return 'text-yellow-500';
}

function GpuBreakdown({ m }: { m: MemoryMetrics }) {
  return (
    <div className="col-span-2 mt-0.5 pt-0.5 border-t border-border/50 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pl-2 text-[10px] opacity-80">
      <span>Geometry</span><span>{m.geometryMB} MB ({m.geometryCount})</span>
      <span>Textures</span><span>{m.textureMB} MB ({m.textureCount})</span>
      <span>RT/Shadow</span><span>{m.renderTargetMB} MB</span>
      <span>Meshes</span>
      <span>{m.meshCount}{m.instancedMeshCount > 0 ? ` (${m.instancedMeshCount} inst, ${formatNum(m.totalInstances)})` : ''}</span>
    </div>
  );
}

function streamingStateColor(state: StreamingMetrics['state']): string {
  switch (state) {
    case 'circuit-breaker':
      return 'text-destructive font-medium';
    case 'lod-downgrading':
      return 'text-orange-500 font-medium';
    case 'veg-thinning':
      return 'text-yellow-500';
    default:
      return 'text-green-500';
  }
}

// Threshold markers at 75/85/90/95 % match the degradation controller's
// activation/recovery boundaries (issue #06).
function BudgetBar({ utilPercent }: { utilPercent: number }) {
  const thresholds: Array<{ at: number; cls: string; title: string }> = [
    { at: 75, cls: 'bg-green-500/70', title: 'recovery (75%)' },
    { at: 85, cls: 'bg-yellow-500/70', title: 'veg-thinning (85%)' },
    { at: 90, cls: 'bg-orange-500/70', title: 'lod-downgrade (90%)' },
    { at: 95, cls: 'bg-destructive/80', title: 'circuit-breaker (95%)' },
  ];
  const fillPct = Math.max(0, Math.min(100, utilPercent));
  const fillColor =
    utilPercent >= 95
      ? 'bg-destructive'
      : utilPercent >= 90
      ? 'bg-orange-500'
      : utilPercent >= 85
      ? 'bg-yellow-500'
      : 'bg-green-500/70';
  return (
    <div className="relative h-1.5 w-full rounded-sm bg-muted/60 overflow-hidden">
      <div
        className={`absolute inset-y-0 left-0 ${fillColor}`}
        style={{ width: `${fillPct}%` }}
      />
      {thresholds.map((t) => (
        <div
          key={t.at}
          className={`absolute inset-y-0 w-px ${t.cls}`}
          style={{ left: `${t.at}%` }}
          title={t.title}
        />
      ))}
    </div>
  );
}

function StreamingPanel({ s }: { s: StreamingMetrics }) {
  const utilPercent = Math.round(s.util * 1000) / 10;
  return (
    <div className="col-span-2 mt-0.5 pt-0.5 border-t border-border/50 flex flex-col gap-1 text-[10px] opacity-90">
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <span>Budget</span>
        <span>
          {s.usedMB} / {s.budgetMB} MB ({utilPercent.toFixed(1)}%)
        </span>
      </div>
      <BudgetBar utilPercent={utilPercent} />
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <span>State</span>
        <span className={streamingStateColor(s.state)}>{s.state}</span>
        <span>Activate</span>
        <span>{s.activationRateMBps} MB/s</span>
        <span>Queue</span>
        <span>{s.queueDepth}</span>
        <span>Evicted</span>
        <span>
          {s.evicted}
          {s.downgraded > 0 ? ` (+${s.downgraded} ↓LOD)` : ''}
        </span>
        <span>Drift</span>
        <span>{s.driftMB >= 0 ? '+' : ''}{s.driftMB} MB</span>
        <span>P50/P5</span>
        <span>{s.fpsP50} / {s.fpsP5} fps</span>
      </div>
    </div>
  );
}

export function StatsPanel({ stats, onDump }: Props) {
  const [expanded, setExpanded] = useState(false);
  const m = stats.memory;

  return (
    <div className="font-mono text-[11px] leading-relaxed text-muted-foreground">
      <div className="mb-1 flex justify-end">
        <button
          type="button"
          onClick={onDump}
          className="rounded px-1 py-0 text-[9px] leading-none border border-border/60 hover:bg-muted hover:text-foreground transition-colors"
          title="Dump detailed memory info to browser console (or press M)"
        >
          MEM
        </button>
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <span>FPS</span>
        <span className={stats.fps < 20 ? 'text-destructive font-medium' : stats.fps < 30 ? 'text-yellow-500' : 'text-green-500'}>
          {stats.fps}
        </span>
        <span>Tris</span>
        <span>{formatNum(stats.triangles)}</span>
        <span>Draws</span>
        <span>{stats.drawCalls}</span>
        <span>Tiles</span>
        <span className="flex items-center gap-1">
          {stats.tilesLoaded}/{stats.tilesTotal}
          {stats.tilesLoaded < stats.tilesTotal && (
            <Loader2 className="size-2.5 animate-spin" />
          )}
        </span>
        <span>Cache</span>
        <span>{stats.tileCacheMB.toFixed(0)} MB</span>
        {stats.jsHeapMB > 0 && (
          <>
            <span>Heap</span>
            <span className={stats.jsHeapMB > 800 ? 'text-destructive font-medium' : stats.jsHeapMB > 500 ? 'text-yellow-500' : ''}>
              {stats.jsHeapMB} MB
            </span>
          </>
        )}
        <span
          className="cursor-pointer underline decoration-dotted"
          onClick={() => setExpanded(!expanded)}
        >
          GPU (est.)
        </span>
        <span className={`flex items-center gap-1 ${gpuColor(m.gpuTotalMB)}`}>
          {m.gpuTotalMB} MB
          {m.leakSuspected && <AlertTriangle className="size-2.5 text-destructive" />}
        </span>
        {m.gpuGrowthMBPerMin !== 0 && (
          <>
            <span>Trend</span>
            <span className={growthColor(m.gpuGrowthMBPerMin)}>
              {m.gpuGrowthMBPerMin > 0 ? '+' : ''}{m.gpuGrowthMBPerMin} MB/min
            </span>
          </>
        )}
        {expanded && <GpuBreakdown m={m} />}
        {stats.streaming && <StreamingPanel s={stats.streaming} />}
      </div>
    </div>
  );
}

export default StatsPanel;
