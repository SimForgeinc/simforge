"use client";

import { useId, type ReactNode } from "react";
import { ArrowUpDown, ChevronDown, ChevronUp } from "lucide-react";

import { Input } from "@/app/components/ui/input";
import {
  MAX_GREEN_S,
  MAX_RED_S,
  MAX_YELLOW_S,
  MIN_GREEN_S,
  MIN_RED_S,
  MIN_YELLOW_S,
  referenceCycleSeconds,
  type ReferenceCyclePhase,
  type ReferenceCycleTiming,
} from "@/app/lib/scenario/signals";

import { formatSeconds, indicationSwatch } from "./indication-style";

/**
 * The whole authoring surface for one traffic light: three sortable phase rows.
 *
 * Each row controls its duration and the row order is the playback order. The
 * cycle is their sum, and everything that crosses this light takes its turn
 * inside the red row. See `signals/reference-cycle.ts`.
 *
 * The PRIMARY card of the panel, and deliberately not behind a disclosure. v1
 * shipped this above an `Advanced` fold and everything else below it; v2 keeps
 * that ordering.
 */
export function ReferenceLightEditor({
  timing,
  generated,
  crossingStageCount,
  label,
  headerAction,
  phaseOrder,
  onPhaseOrderChange,
  onTimingChange,
}: {
  timing: ReferenceCycleTiming;
  /**
   * Whether these three numbers still explain the plan that is stored.
   *
   * `false` means the cycle has been hand-edited or transferred and the numbers
   * describe only part of it. Surfaced loudly: an author who believes the card
   * describes their junction will retime it and silently lose the hand edits.
   */
  generated: boolean;
  crossingStageCount: number;
  /** What to call the light the author clicked. */
  label: string;
  headerAction?: ReactNode;
  phaseOrder: readonly ReferenceCyclePhase[];
  onPhaseOrderChange: (next: readonly ReferenceCyclePhase[]) => void;
  onTimingChange: (next: Partial<ReferenceCycleTiming>) => void;
}) {
  const cycleS = referenceCycleSeconds(timing);
  const durationByPhase: Record<ReferenceCyclePhase, number> = {
    green: timing.greenS,
    yellow: timing.yellowS,
    red: timing.redS,
  };

  const movePhase = (at: number, direction: -1 | 1) => {
    const nextAt = at + direction;
    if (nextAt < 0 || nextAt >= phaseOrder.length) return;
    const next = [...phaseOrder];
    [next[at], next[nextAt]] = [next[nextAt]!, next[at]!];
    onPhaseOrderChange(next);
  };

  return (
    <section aria-label="Traffic light timing" className="min-w-0 space-y-2">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p className="min-w-0 truncate text-meta font-semibold text-foreground">{label}</p>
        {headerAction}
      </div>

      {/* The cycle at a glance follows the same user-selected order as the table. */}
      <div
        aria-hidden="true"
        className="flex h-2 w-full overflow-hidden border border-border bg-muted"
      >
        {phaseOrder.map((indication) => {
          const seconds = durationByPhase[indication];
          return seconds > 0 ? (
            <span
              key={indication}
              className={indicationSwatch(indication).fill}
              style={{ width: `${(seconds / Math.max(cycleS, 0.1)) * 100}%` }}
            />
          ) : null;
        })}
      </div>

      <div
        aria-label="Traffic light phase order and duration"
        className="overflow-hidden rounded-md border border-border"
        role="table"
      >
        <div
          className="grid grid-cols-[20px_minmax(0,1fr)_58px_42px] items-center border-b border-border bg-muted/60 px-1.5 py-1 text-micro uppercase tracking-wide text-muted-foreground"
          role="row"
        >
          <span aria-label="Order" role="columnheader" />
          <span role="columnheader">Phase</span>
          <span className="text-right" role="columnheader">Seconds</span>
          <span className="sr-only" role="columnheader">Reorder</span>
        </div>
        {phaseOrder.map((phase, at) => (
          <TimingRow
            key={phase}
            phase={phase}
            value={durationByPhase[phase]}
            first={at === 0}
            last={at === phaseOrder.length - 1}
            onMoveUp={() => movePhase(at, -1)}
            onMoveDown={() => movePhase(at, 1)}
            onCommit={(value) => onTimingChange(timingUpdateForPhase(phase, value))}
          />
        ))}
      </div>

      <p className="text-micro leading-relaxed text-muted-foreground">
        {formatSeconds(cycleS)}s cycle
        {crossingStageCount > 0
          ? ` · ${crossingStageCount} crossing ${
              crossingStageCount === 1 ? "stage takes" : "stages take"
            } turns while this light is red`
          : " · nothing crosses this light"}
      </p>

      {/*
        One of the four behaviours that must surface. `generated: false` is not a
        cosmetic caveat: retiming from here recompiles the whole junction, so the
        author's hand edits are about to be replaced and they have to know before
        they type.
      */}
      {!generated ? (
        <p
          className="border border-signal-yellow/50 bg-signal-yellow/10 px-2 py-1.5 text-micro leading-relaxed text-signal-yellow"
          data-testid="signal-reference-hand-edited"
          role="status"
        >
          Hand-edited; retiming overwrites. These three numbers describe only part
          of what this junction does. Changing any of them replaces the whole
          cycle.
        </p>
      ) : null}
    </section>
  );
}

function timingUpdateForPhase(
  phase: ReferenceCyclePhase,
  value: number,
): Partial<ReferenceCycleTiming> {
  if (phase === "green") return { greenS: value };
  if (phase === "yellow") return { yellowS: value };
  return { redS: value };
}

/**
 * One labelled number, committed on blur or Enter.
 *
 * Not per keystroke: typing "25" passes through "2", which would recompile the
 * junction — and push a junk entry onto the document's undo stack — on the way.
 */
function TimingRow({
  phase,
  value,
  first,
  last,
  onMoveUp,
  onMoveDown,
  onCommit,
}: {
  phase: ReferenceCyclePhase;
  value: number;
  first: boolean;
  last: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onCommit: (value: number) => void;
}) {
  const id = useId();
  const label = phase[0]!.toUpperCase() + phase.slice(1);
  const bounds = phase === "green"
    ? { min: MIN_GREEN_S, max: MAX_GREEN_S }
    : phase === "yellow"
      ? { min: MIN_YELLOW_S, max: MAX_YELLOW_S }
      : { min: MIN_RED_S, max: MAX_RED_S };
  return (
    <div
      className="grid grid-cols-[20px_minmax(0,1fr)_58px_42px] items-center border-b border-border px-1.5 py-1 last:border-b-0"
      data-testid={`traffic-light-phase-row-${phase}`}
      role="row"
    >
      <span className="grid place-items-center" role="cell">
        <ArrowUpDown aria-hidden="true" className="size-3 text-muted-foreground/60" />
      </span>
      <div className="flex min-w-0 items-center gap-1.5" role="cell">
        <span
          aria-hidden="true"
          className={`size-2.5 shrink-0 rounded-full ${indicationSwatch(phase).fill}`}
        />
        <label className="truncate text-meta text-foreground" htmlFor={id}>
          {label}
        </label>
      </div>
      <div className="relative" role="cell">
        <Input
          id={id}
          key={`${id}-${value}`}
          type="number"
          inputMode="decimal"
          min={bounds.min}
          max={bounds.max}
          step={1}
          defaultValue={value}
          className="h-6 w-full pr-3 pl-1 text-right text-meta tabular-nums"
          onBlur={(event) => {
            const next = Number(event.currentTarget.value);
            if (Number.isFinite(next) && next !== value) onCommit(next);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 text-[8px] text-muted-foreground"
        >
          s
        </span>
      </div>
      <div className="flex justify-end" role="cell">
        <button
          aria-label={`Move ${label} up`}
          className="grid size-5 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-20"
          disabled={first}
          onClick={onMoveUp}
          type="button"
        >
          <ChevronUp aria-hidden="true" className="size-3" />
        </button>
        <button
          aria-label={`Move ${label} down`}
          className="grid size-5 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-20"
          disabled={last}
          onClick={onMoveDown}
          type="button"
        >
          <ChevronDown aria-hidden="true" className="size-3" />
        </button>
      </div>
    </div>
  );
}
