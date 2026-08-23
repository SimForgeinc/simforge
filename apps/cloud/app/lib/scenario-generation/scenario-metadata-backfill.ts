import {
  ScenarioIntentionSchema,
  ScenarioMetadataSchema,
  type ScenarioEditorActorDraft,
  type ScenarioIntention,
  type ScenarioMetadata,
} from "@simcloud/shared";
import {
  buildScenarioMetadata,
  inferScenarioIntentionForBackfill,
} from "./scenario-intention";

export type ScenarioMetadataBackfillRow = {
  id: string;
  draft_json: unknown;
  variation_params?: unknown;
};

export type ScenarioMetadataBackfillResult = {
  id: string;
  status: "would_update" | "already_stamped" | "not_derivable";
  metadata: ScenarioMetadata | null;
  draft: Record<string, unknown> | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nestedRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return asRecord(value[key]);
}

function stringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function numberOrStringValue(...values: unknown[]): string | number | null {
  for (const value of values) {
    if (
      (typeof value === "number" && Number.isInteger(value)) ||
      (typeof value === "string" && value.trim())
    ) {
      return value;
    }
  }
  return null;
}

function existingScenarioMetadata(
  draft: Record<string, unknown>,
): ScenarioMetadata | null {
  const setupMetadata = nestedRecord(nestedRecord(draft, "setup"), "metadata");
  const authoredMetadata = nestedRecord(draft, "metadata");
  const parsed = ScenarioMetadataSchema.safeParse(
    setupMetadata.scenarioMetadata ?? authoredMetadata.scenarioMetadata,
  );
  return parsed.success ? parsed.data : null;
}

function scenarioIntention(
  draft: Record<string, unknown>,
  variation: Record<string, unknown>,
  environmentPreset: Record<string, unknown>,
): ScenarioIntention | null {
  const setupMetadata = nestedRecord(nestedRecord(draft, "setup"), "metadata");
  const authoredMetadata = nestedRecord(draft, "metadata");
  const parsed = ScenarioIntentionSchema.safeParse(
    setupMetadata.scenarioIntention ?? authoredMetadata.scenarioIntention,
  );
  if (parsed.success) return parsed.data;
  const generation = nestedRecord(variation, "generation");
  return inferScenarioIntentionForBackfill({
    family: stringValue(
      variation.scenarioFamily,
      variation.family,
      generation.family,
    ),
    strategy: stringValue(
      variation.strategy,
      variation.strategyId,
      generation.strategy,
    ),
    plannedOutcome:
      variation.plannedOutcome === "near_miss" ||
      variation.plannedOutcome === "collision"
        ? variation.plannedOutcome
        : generation.plannedOutcome === "near_miss" ||
            generation.plannedOutcome === "collision"
          ? generation.plannedOutcome
          : null,
    weather: environmentWeatherHint(environmentPreset),
  });
}

function actorsFromDraft(
  draft: Record<string, unknown>,
): ScenarioEditorActorDraft[] {
  const setupScene = nestedRecord(nestedRecord(draft, "setup"), "scene");
  const actors = setupScene.actors ?? draft.actors;
  return Array.isArray(actors) ? (actors as ScenarioEditorActorDraft[]) : [];
}

function environmentPresetFromDraft(
  draft: Record<string, unknown>,
): Record<string, unknown> {
  const setup = nestedRecord(draft, "setup");
  const setupRender = nestedRecord(setup, "renderConfig");
  const authoredRender = nestedRecord(draft, "renderConfig");
  return asRecord(
    setupRender.environmentPreset ?? authoredRender.environmentPreset,
  );
}

function environmentWeatherHint(
  environmentPreset: Record<string, unknown>,
): string | null {
  const values = [
    environmentPreset.weather,
    environmentPreset.roadSurface,
  ].filter(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  return values.length > 0 ? values.join(" ") : null;
}

export function stampScenarioMetadataOnDraft(
  draft: Record<string, unknown>,
  metadata: ScenarioMetadata,
): Record<string, unknown> {
  if (
    draft.setup &&
    typeof draft.setup === "object" &&
    !Array.isArray(draft.setup)
  ) {
    const setup = asRecord(draft.setup);
    return {
      ...draft,
      setup: {
        ...setup,
        metadata: {
          ...nestedRecord(setup, "metadata"),
          scenarioMetadata: metadata,
        },
      },
    };
  }
  return {
    ...draft,
    metadata: {
      ...nestedRecord(draft, "metadata"),
      scenarioMetadata: metadata,
    },
  };
}

/**
 * Pure row transformer used by the CLI and fixture tests. It never performs
 * I/O, which makes dry-run output identical to what `--apply` would write.
 */
export function deriveScenarioMetadataBackfill(
  row: ScenarioMetadataBackfillRow,
): ScenarioMetadataBackfillResult {
  const draft = asRecord(row.draft_json);
  const existing = existingScenarioMetadata(draft);
  if (existing) {
    return {
      id: row.id,
      status: "already_stamped",
      metadata: existing,
      draft,
    };
  }
  const variation = asRecord(row.variation_params);
  const environmentPreset = environmentPresetFromDraft(draft);
  const intention = scenarioIntention(draft, variation, environmentPreset);
  if (!intention) {
    return {
      id: row.id,
      status: "not_derivable",
      metadata: null,
      draft: null,
    };
  }
  const generation = nestedRecord(variation, "generation");
  const family = stringValue(
    variation.scenarioFamily,
    variation.family,
    generation.family,
  );
  const strategy = stringValue(
    variation.strategy,
    variation.strategyId,
    generation.strategy,
  );
  const generator =
    stringValue(
      variation.generator,
      generation.generator,
      generation.generatorId,
    ) ?? "simforge.metadata_backfill.v1";
  const seed =
    numberOrStringValue(
      variation.seed,
      variation.scenarioSeed,
      generation.seed,
    ) ?? 0;
  const weather = environmentWeatherHint(environmentPreset);
  const metadata = buildScenarioMetadata({
    generator,
    seed,
    classificationReference:
      (family ? `family:${family}` : null) ??
      (strategy ? `strategy:${strategy}` : null) ??
      `scenario:${row.id}`,
    scenarioIntention: intention,
    actors: actorsFromDraft(draft),
    traffic: intention.modifiers.traffic,
    weather,
    environmentPreset,
    sourceType: "backfill",
    sourceConfidence: ScenarioIntentionSchema.safeParse(
      nestedRecord(nestedRecord(draft, "setup"), "metadata").scenarioIntention ??
        nestedRecord(draft, "metadata").scenarioIntention,
    ).success
      ? 1
      : 0.8,
  });
  return {
    id: row.id,
    status: "would_update",
    metadata,
    draft: stampScenarioMetadataOnDraft(draft, metadata),
  };
}
