export const SCENARIO_TIMING = {
  defaultDurationSeconds: 20,
  minScenarioDurationSeconds: 1,
  maxScenarioDurationSeconds: 60,
  minRenderDurationSeconds: 1,
  maxRenderDurationSeconds: 3600,
} as const;

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampWholeSeconds(value: unknown, min: number, max: number): number {
  const number = finiteNumber(value);
  const fallback = SCENARIO_TIMING.defaultDurationSeconds;
  const whole = Math.trunc(number ?? fallback);
  return Math.min(max, Math.max(min, whole));
}

export function normalizeScenarioDurationSeconds(value: unknown): number {
  return clampWholeSeconds(
    value,
    SCENARIO_TIMING.minScenarioDurationSeconds,
    SCENARIO_TIMING.maxScenarioDurationSeconds,
  );
}

export function normalizeRenderDurationOverrideSeconds(value: unknown): number | null {
  if (value == null || value === "") return null;
  return clampWholeSeconds(
    value,
    SCENARIO_TIMING.minRenderDurationSeconds,
    SCENARIO_TIMING.maxRenderDurationSeconds,
  );
}

export function resolveRenderDurationSeconds(input: {
  scenarioDurationSeconds: unknown;
  renderDurationOverrideSeconds?: unknown;
}): number {
  const override = normalizeRenderDurationOverrideSeconds(
    input.renderDurationOverrideSeconds,
  );
  return override ?? normalizeScenarioDurationSeconds(input.scenarioDurationSeconds);
}
