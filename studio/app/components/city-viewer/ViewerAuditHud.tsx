'use client';

import { useEffect, useState } from 'react';
import type { AuditAggregator, AuditState } from './audit-aggregator';
import { ViewerAccordionSection } from './ViewerAccordion';

// Dev-only audit overlay rendered as an accordion section. Imported by
// `CityViewer.tsx` only on dev/staging builds; the dynamic-import wrapper
// there tree-shakes this file out of production bundles entirely. The
// accordion section shell owns collapse + positioning, so this component
// just renders the audit grid and the JSON-export header adornment.

interface Props {
  aggregator: AuditAggregator;
}

const POLL_INTERVAL_MS = 500;

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function fmtFps(fps: number): string {
  if (!Number.isFinite(fps) || fps <= 0) return '—';
  return fps.toFixed(0);
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  return `${ms.toFixed(1)}ms`;
}

function downloadAudit(aggregator: AuditAggregator): void {
  const blob = new Blob([aggregator.serializeForExport()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  a.download = `viewer-audit-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function ViewerAuditHud({ aggregator }: Props) {
  const [state, setState] = useState<AuditState>(() => aggregator.getState());

  useEffect(() => {
    const id = window.setInterval(() => {
      setState(aggregator.getState());
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [aggregator]);

  const { fps, cache, textures, frameBudget } = state;

  return (
    <ViewerAccordionSection
      id="viewer-audit"
      title="Viewer audit"
      kind="dev"
      headerAdornment={
        <button
          type="button"
          onClick={() => downloadAudit(aggregator)}
          className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          title="Download audit JSON"
        >
          JSON
        </button>
      }
    >
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
        <span>Tier</span>
        <span>{state.qualityTier ?? '—'}</span>
        {state.qualityReason && (
          <span className="col-span-2 text-[10px] opacity-70 italic">
            {state.qualityReason}
          </span>
        )}
        <span>FPS</span>
        <span>
          {fmtFps(fps.current)} (p50 {fmtFps(fps.p50)} / p99 {fmtFps(fps.p99)})
        </span>
        <span>Frame</span>
        <span>
          p50 {fmtMs(fps.p50FrameMs)} / p99 {fmtMs(fps.p99FrameMs)}
        </span>
        <span>Budget miss</span>
        <span>
          &gt;16ms {frameBudget.over16ms} · &gt;33ms {frameBudget.over33ms}
        </span>
        <span>Draws</span>
        <span>{state.drawCalls}</span>
        <span>GPU est.</span>
        <span>{state.gpuTotalMB} MB</span>

        <span className="col-span-2 mt-1 border-t border-border/40 pt-1 text-[10px] uppercase tracking-wider opacity-70">
          Cache
        </span>
        <span>Tiles</span>
        <span>{cache.size} ({fmtBytes(cache.byteSize)})</span>
        <span>Pinned</span>
        <span>{cache.pinnedCount}</span>
        <span>Evictions</span>
        <span>
          {cache.evictionCount} ({fmtBytes(cache.bytesEvictedTotal)})
        </span>
        <span>Eviction rate</span>
        <span>{fmtBytes(cache.bytesEvictedPerSecond)}/s</span>

        <span className="col-span-2 mt-1 border-t border-border/40 pt-1 text-[10px] uppercase tracking-wider opacity-70">
          Guardrails
        </span>
        <span>Texture downscales</span>
        <span>
          {textures.downscaleCount} (saved {fmtBytes(textures.bytesSavedTotal)})
        </span>
        <span>LOD floor clamps</span>
        <span>{state.lodFloorClampCount}</span>
        <span>LOD selector picks</span>
        <span>{state.lodSelectorChoiceCount}</span>
        <span>Veg instances</span>
        <span>{state.vegetationInstances.toLocaleString()}</span>
      </div>
    </ViewerAccordionSection>
  );
}

export default ViewerAuditHud;
