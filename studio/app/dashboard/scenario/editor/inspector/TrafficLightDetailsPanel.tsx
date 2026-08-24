"use client";

import { useRef } from "react";
import { RotateCcw, Signal, Trash2 } from "lucide-react";

import { ReferenceLightEditor } from "../signals/ReferenceLightEditor";
import { EditorDetailsPanel } from "./EditorDetailsPanel";

import type {
  ReferenceCyclePhase,
  ReferenceCycleTiming,
} from "@/app/lib/scenario/signals";

export type TrafficLightCycleSnapshot = {
  readonly timing: ReferenceCycleTiming;
  readonly phaseOrder: readonly ReferenceCyclePhase[];
};

export type TrafficLightAuthoring = {
  readonly junctionId: string;
  readonly headId: string;
  readonly label: string;
  readonly timing: ReferenceCycleTiming;
  readonly phaseOrder: readonly ReferenceCyclePhase[];
  readonly generated: boolean;
  readonly crossingStageCount: number;
  readonly hasPlan: boolean;
  readonly warning?: string | null;
  readonly onTimingChange: (next: Partial<ReferenceCycleTiming>) => void;
  readonly onPhaseOrderChange: (next: readonly ReferenceCyclePhase[]) => void;
  readonly onReset: (snapshot: TrafficLightCycleSnapshot) => void;
  readonly onRemoveControl?: () => void;
};

export function TrafficLightDetailsPanel({
  authoring,
  onClose,
}: {
  authoring: TrafficLightAuthoring;
  onClose: () => void;
}) {
  const openingSnapshot = useRef<TrafficLightCycleSnapshot>({
    timing: { ...authoring.timing },
    phaseOrder: [...authoring.phaseOrder],
  });

  return (
    <EditorDetailsPanel
      ariaLabel={`Traffic light ${authoring.headId} details`}
      onClose={onClose}
      onDelete={authoring.onRemoveControl}
      preview={(
        <div className="flex flex-col items-center gap-1 text-center">
          <Signal aria-hidden="true" className="size-9 text-[#E8E044]" />
          <span className="text-[9px] uppercase tracking-[0.16em] text-white/40">
            Junction {authoring.junctionId}
          </span>
          <strong className="max-w-52 truncate text-xs font-medium text-white">
            Traffic light {authoring.headId}
          </strong>
        </div>
      )}
      testId="scenario-traffic-light-details-panel"
    >
      <p className="text-[10px] leading-relaxed text-white/45">
        Set this light&rsquo;s cycle. Every other light in junction {authoring.junctionId}
        is aligned automatically from the map&rsquo;s controller stages.
      </p>
      {authoring.warning ? (
        <p className="rounded-lg border border-amber-300/35 bg-amber-300/10 px-2.5 py-2 text-[10px] leading-relaxed text-amber-100" role="alert">
          {authoring.warning} Saving a timing replaces it with a binding to the current map.
        </p>
      ) : null}
      <ReferenceLightEditor
        timing={authoring.timing}
        phaseOrder={authoring.phaseOrder}
        generated={authoring.generated}
        crossingStageCount={authoring.crossingStageCount}
        label={authoring.label}
        headerAction={authoring.onRemoveControl ? (
          <button
            aria-label={`Remove control from traffic light ${authoring.headId}`}
            className="editor-motion grid size-6 shrink-0 place-items-center rounded-md text-white/40 hover:bg-red-500/15 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
            data-testid="traffic-light-remove-control"
            onClick={authoring.onRemoveControl}
            title="Remove control"
            type="button"
          >
            <Trash2 aria-hidden="true" className="size-3.5" />
          </button>
        ) : null}
        onTimingChange={authoring.onTimingChange}
        onPhaseOrderChange={authoring.onPhaseOrderChange}
      />
      {authoring.hasPlan ? (
        <button
          className="editor-motion flex w-full items-center justify-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-xs text-white/60 hover:border-white/30 hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]"
          data-testid="traffic-light-details-reset"
          onClick={() => authoring.onReset(openingSnapshot.current)}
          type="button"
        >
          <RotateCcw aria-hidden="true" className="size-3.5" />
          Reset changes
        </button>
      ) : null}
    </EditorDetailsPanel>
  );
}
