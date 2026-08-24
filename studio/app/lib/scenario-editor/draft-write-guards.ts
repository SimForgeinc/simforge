/**
 * Write-time guards for `PUT /api/scenarios/[id]/draft`.
 *
 * Draft NORMALIZATION is deliberately lenient: a stored draft that predates a
 * schema change must still open in the editor, so on the read path anything
 * unparseable is migrated or dropped. That leniency is exactly wrong at the
 * WRITE boundary — it is how the editor came to silently delete work:
 *
 *  - scenario-eval defect #23: a PUT whose payload contained one
 *    schema-invalid actor returned 200 and persisted the draft WITHOUT that
 *    actor (`asValidatedActorArray` filters `safeParse` failures);
 *  - scenario-eval defect #40: a PUT accepted `duration_seconds: 300`, then
 *    `POST /validate` 422'd the very same document against
 *    `ScenarioEditorSimulationConfigSchema` ("less than or equal to 60").
 *
 * These guards run against what the CLIENT sent (actors) and what is about to
 * be PERSISTED (timing), and the route returns 422 instead of quietly saving
 * something else. Only the incoming actors are checked — actors already
 * stored may legitimately predate the schema and are migrated on read, so
 * re-validating them here would lock authors out of old scenarios over
 * fields they never touched.
 *
 * The timing bounds are not re-stated here: violations come from parsing the
 * authored value through the same `ScenarioEditorSimulationConfigSchema` the
 * validate endpoint's export-compile parses the whole draft through, so PUT
 * and validate cannot drift apart again.
 */
import {
  ScenarioEditorActorDraftSchema,
  ScenarioEditorSimulationConfigSchema,
} from "@simcloud/shared";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export type InvalidActorDraftReport = {
  /** JSON path of the offending entry inside the submitted draft. */
  path: string;
  actorId: string | null;
  issues: { path: string; message: string }[];
};

/**
 * Every actor in the INCOMING draft that fails the actor schema of record.
 * Checks both draft shapes (`actors`, `setup.scene.actors`); an empty result
 * means normalization will not drop anything the client just sent.
 */
export function collectInvalidActorDrafts(
  incomingDraft: Record<string, unknown>,
): InvalidActorDraftReport[] {
  const sources: Array<[string, unknown]> = [];
  if (hasOwn(incomingDraft, "actors")) {
    sources.push(["actors", incomingDraft.actors]);
  }
  const scene = asRecord(asRecord(incomingDraft.setup).scene);
  if (hasOwn(scene, "actors")) {
    sources.push(["setup.scene.actors", scene.actors]);
  }

  const reports: InvalidActorDraftReport[] = [];
  for (const [basePath, value] of sources) {
    if (!Array.isArray(value)) continue;
    value.forEach((entry, index) => {
      const parsed = ScenarioEditorActorDraftSchema.safeParse(entry);
      if (parsed.success) return;
      const entryPath = `${basePath}[${index}]`;
      const record = asRecord(entry);
      reports.push({
        path: entryPath,
        actorId: typeof record.id === "string" ? record.id : null,
        issues: parsed.error.issues.slice(0, 5).map((issue) => ({
          path: issue.path.length > 0 ? `${entryPath}.${issue.path.join(".")}` : entryPath,
          message: issue.message,
        })),
      });
    });
  }
  return reports;
}

export type SimulationTimingViolation = {
  /** Where in the submitted/merged draft the value was read from. */
  field: string;
  key: "duration_seconds" | "fixed_delta_seconds";
  value: unknown;
  message: string;
};

const DURATION_ONLY = ScenarioEditorSimulationConfigSchema.pick({
  duration_seconds: true,
});
const FIXED_DELTA_ONLY = ScenarioEditorSimulationConfigSchema.pick({
  fixed_delta_seconds: true,
});

function firstAuthoredValue(
  candidates: Array<[string, Record<string, unknown>, string]>,
): { field: string; value: unknown } | null {
  for (const [path, record, key] of candidates) {
    // `== null` deliberately: absent and null both mean "use the default",
    // which is what normalization has always done with them.
    if (hasOwn(record, key) && record[key] != null) {
      return { field: path, value: record[key] };
    }
  }
  return null;
}

/**
 * Timing fields (scenario duration, fixed delta) that the export-compile's
 * schema would reject. Run this against the draft ABOUT TO BE PERSISTED — the
 * merged document is what `POST /validate` will later parse, so this is the
 * fail-fast twin of that check, sharing its schema and therefore its limits
 * (`SCENARIO_TIMING.maxScenarioDurationSeconds` = 60 s; longer renders use
 * `renderConfig.renderDurationOverrideSeconds`, a different knob).
 */
export function collectSimulationTimingViolations(
  draft: Record<string, unknown>,
): SimulationTimingViolation[] {
  const setupSimulation = asRecord(asRecord(draft.setup).simulation);
  const simulationConfig = asRecord(draft.simulationConfig);

  const violations: SimulationTimingViolation[] = [];

  const duration = firstAuthoredValue([
    ["setup.simulation.durationSeconds", setupSimulation, "durationSeconds"],
    ["simulationConfig.duration_seconds", simulationConfig, "duration_seconds"],
    ["duration_seconds", draft, "duration_seconds"],
    ["durationSeconds", draft, "durationSeconds"],
  ]);
  if (duration) {
    const parsed = DURATION_ONLY.safeParse({ duration_seconds: duration.value });
    if (!parsed.success) {
      violations.push({
        field: duration.field,
        key: "duration_seconds",
        value: duration.value,
        message: parsed.error.issues[0]?.message ?? "invalid duration",
      });
    }
  }

  const fixedDelta = firstAuthoredValue([
    ["setup.simulation.fixedDeltaSeconds", setupSimulation, "fixedDeltaSeconds"],
    ["simulationConfig.fixed_delta_seconds", simulationConfig, "fixed_delta_seconds"],
    ["fixed_delta_seconds", draft, "fixed_delta_seconds"],
    ["fixedDeltaSeconds", draft, "fixedDeltaSeconds"],
  ]);
  if (fixedDelta) {
    const parsed = FIXED_DELTA_ONLY.safeParse({
      fixed_delta_seconds: fixedDelta.value,
    });
    if (!parsed.success) {
      violations.push({
        field: fixedDelta.field,
        key: "fixed_delta_seconds",
        value: fixedDelta.value,
        message: parsed.error.issues[0]?.message ?? "invalid fixed delta",
      });
    }
  }

  return violations;
}
