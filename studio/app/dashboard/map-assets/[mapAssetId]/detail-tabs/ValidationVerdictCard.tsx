import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";

import type {
  ScenarioValidationJob,
  ScenarioValidationRepairKind,
} from "@simforge/studio-shared";

import { cn } from "@/app/lib/utils";
import type { ScenarioValidationState } from "@/app/lib/maps/frontend/use-scenario-validation";

/**
 * esmini validation verdict for the highlighted draft, rendered under its card
 * in the AI panel. Shows live progress while the auto-repair loop runs
 * (non-blocking), then the ground-truth verdict + metrics + a per-attempt
 * repair trace (decision D13). On a failed/exhausted run it stays advisory —
 * the user can still open/ship the draft (decision D6) — and always carries
 * the honesty caveat that a pass means "ready to send to CARLA", not "will
 * pass in CARLA".
 */

const REPAIR_KIND_LABEL: Record<ScenarioValidationRepairKind, string> = {
  initial: "Initial placement",
  scale_spawn_distance: "Adjusted spawn distance",
  scale_npc_speed: "Adjusted NPC speed",
  snap_spawn_to_drivable: "Snapped spawn to road",
  rerun_pedestrian_timing: "Recomputed pedestrian timing",
  nudge_pedestrian_path: "Nudged pedestrian path",
  retime_npc: "Retimed NPC to the subject",
  shift_npc_path: "Shifted NPC path onto the subject's arc",
  retime_subject: "Retimed subject to pedestrian",
  llm: "AI repair",
};

function repairKindLabel(kind: ScenarioValidationRepairKind | null): string {
  return kind ? REPAIR_KIND_LABEL[kind] : "Attempt";
}

function MetricsRow({ job }: { job: ScenarioValidationJob }) {
  const m = job.metrics;
  if (!m) return null;
  const bits: string[] = [];
  if (m.collisions.length > 0) {
    bits.push(`collision at ${m.collisions[0]!.t.toFixed(1)}s`);
  }
  if (m.min_ttc) bits.push(`min TTC ${m.min_ttc.seconds.toFixed(2)}s`);
  if (m.min_distance) bits.push(`min dist ${m.min_distance.meters.toFixed(1)}m`);
  if (bits.length === 0) return null;
  return <div className="text-[10px] text-muted-foreground">{bits.join(" • ")}</div>;
}

function RepairTrace({ history }: { history: ScenarioValidationJob[] }) {
  const finished = history.filter(
    (j) => j.status === "succeeded" || j.status === "failed",
  );
  if (finished.length <= 1) return null;
  return (
    <ol className="mt-1 space-y-px text-[10px] text-muted-foreground">
      {finished
        .slice()
        .sort((a, b) => a.attempt - b.attempt)
        .map((j) => (
          <li key={j.id}>
            <span className="tabular-nums">{j.attempt}.</span>{" "}
            {repairKindLabel(j.repair_kind)} →{" "}
            <span
              className={cn(
                j.verdict === "pass" ? "text-emerald-500" : "text-destructive",
              )}
            >
              {j.verdict ?? j.status}
            </span>
          </li>
        ))}
    </ol>
  );
}

const CARLA_CAVEAT =
  "esmini checks scenario-spec correctness, not CARLA reproduction.";

export function ValidationVerdictCard({
  validation,
}: {
  validation: ScenarioValidationState;
}) {
  const { latest, history, working, attemptsUsed, maxAttempts, verdict, error } =
    validation;

  // Nothing has happened yet for this scenario — stay quiet until the first
  // status read lands.
  if (!latest && !working && !error) return null;

  if (error) {
    return (
      <Shell tone="warn">
        <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
        <div>
          <div className="font-medium text-foreground">Couldn’t validate</div>
          <div className="text-[10px] text-muted-foreground">{error}</div>
        </div>
      </Shell>
    );
  }

  if (working) {
    const attemptLabel =
      attemptsUsed > 0 ? ` · attempt ${attemptsUsed}/${maxAttempts}` : "";
    return (
      <Shell tone="info">
        <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />
        <div className="text-foreground">Validating in esmini{attemptLabel}…</div>
      </Shell>
    );
  }

  if (verdict === "pass") {
    return (
      <Shell tone="pass">
        <CheckCircle2 className="size-3 shrink-0 text-emerald-500" aria-hidden="true" />
        <div className="min-w-0">
          <div className="font-medium text-foreground">
            Validated · ready to send to CARLA
          </div>
          {latest ? <MetricsRow job={latest} /> : null}
          {attemptsUsed > 1 ? (
            <div className="text-[10px] text-muted-foreground">
              repaired in {attemptsUsed} attempts
            </div>
          ) : null}
          <RepairTrace history={history} />
          <div className="mt-0.5 text-[9.5px] italic text-muted-foreground">
            {CARLA_CAVEAT}
          </div>
        </div>
      </Shell>
    );
  }

  // fail / inconclusive / budget exhausted — advisory, draft still openable.
  const exhausted = attemptsUsed >= maxAttempts && maxAttempts > 0;
  return (
    <Shell tone="fail">
      <XCircle className="size-3 shrink-0 text-destructive" aria-hidden="true" />
      <div className="min-w-0">
        <div className="font-medium text-foreground">
          {verdict === "inconclusive"
            ? "Validation inconclusive"
            : exhausted
              ? `Didn’t validate after ${attemptsUsed} attempts`
              : "Validation failed"}
        </div>
        {latest ? <MetricsRow job={latest} /> : null}
        <RepairTrace history={history} />
        <div className="mt-0.5 text-[10px] text-muted-foreground">
          You can still open the draft to inspect or fix it. {CARLA_CAVEAT}
        </div>
      </div>
    </Shell>
  );
}

function Shell({
  tone,
  children,
}: {
  tone: "info" | "pass" | "fail" | "warn";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "mt-1 flex items-start gap-1.5 rounded-sm border px-2 py-1 text-[11px]",
        tone === "pass" && "border-emerald-500/40 bg-emerald-500/5",
        tone === "fail" && "border-destructive/40 bg-destructive/5",
        (tone === "info" || tone === "warn") && "border-amber-500/40 bg-amber-500/5",
      )}
    >
      {children}
    </div>
  );
}
