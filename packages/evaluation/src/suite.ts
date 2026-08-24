import { createHash } from 'node:crypto';

/**
 * policy-eval-suite v1 — the frozen evaluation protocol (WS5 EvalHarness).
 *
 * The suite is a pure data structure derived deterministically from the
 * five-map catalog minus every route the RL training loop materialized.
 * Each base route carries three paired shifted variants (Fail2Drive,
 * arXiv 2604.08535) on the same template so memorization and
 * generalization separate:
 *
 *   - `appearance` — rain/dusk/headlight-limited operational conditions,
 *     same site, same seed: only the air and light change;
 *   - `layout`     — a different matched site of the same template on
 *     another map, fresh derived seed: only the concrete world changes;
 *   - `behavioral` — same site, same seed, actor timing/speed parameters
 *     pinned to harder in-range values: only the choreography changes.
 *
 * Everything is seeded; no wall clock enters any of these derivations.
 * This module is pure: it reads documents already parsed by the caller so
 * it stays unit-testable without map assets or the rl-env runtime.
 */

import { z } from 'zod';

/* ------------------------------------------------------------------ schema */

export const variantSchema = z.object({
  id: z.string(),
  title: z.string(),
  weather: z.string(),
  timeOfDay: z.string(),
  traffic: z.string(),
  visibility: z.string(),
});

export const suiteEntrySchema = z.object({
  entryId: z.string(),
  ability: z.string(),
  shift: z.enum(['base', 'appearance', 'layout', 'behavioral']),
  /** entryId of the base route this variant is paired with (self for base). */
  pairedWith: z.string(),
  templateSource: z.string(),
  mapId: z.string(),
  matcherSiteId: z.string(),
  seed: z.string(),
  catalogIdentity: z.string().nullable(),
  variant: variantSchema.nullable(),
  paramOverrides: z.record(z.string(), z.number()).nullable(),
});

export const policyEvalSuiteSchema = z.object({
  kind: z.literal('policy-eval-suite'),
  suiteVersion: z.literal(1),
  name: z.string(),
  decisionHz: z.number().int(),
  reward: z.record(z.string(), z.unknown()),
  appearanceShiftVariant: variantSchema,
  trainingExclusions: z.object({
    sources: z.array(z.string()),
    templates: z.array(z.string()),
    excludedSlotCount: z.number().int(),
    candidateSlotsConsidered: z.number().int(),
  }),
  abilities: z.record(z.string(), z.object({ title: z.string(), templateSource: z.string() })),
  entries: z.array(suiteEntrySchema).min(1),
  suiteHash: z.string(),
});

export type SuiteVariant = z.infer<typeof variantSchema>;
export type SuiteEntry = z.infer<typeof suiteEntrySchema>;
export type PolicyEvalSuite = z.infer<typeof policyEvalSuiteSchema>;

/** A catalog slot reduced to what suite construction needs. */
export interface CatalogSlotView {
  identity: string;
  mapId: string;
  seed: string;
  matcherSiteId: string;
  templateSource: string;
  variant: SuiteVariant;
}

/** One training episode-bank row (rl env-server episode spec form B). */
export interface TrainingEpisodeSpec {
  source: string;
  template: string;
  map: string;
  site: string;
  seeds: readonly string[];
}

/* ------------------------------------------------------- canonical hashing */

/** Stable JSON: object keys sorted recursively, arrays in order, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}


/**
 * The hash that pins the protocol: every report carries it, every training
 * claim must reference it. Covers everything that changes simulation
 * semantics — never provenance comments or exclusions metadata.
 */
export function computeSuiteHash(suite: Omit<PolicyEvalSuite, 'suiteHash'>): string {
  const digestInput = canonicalJson({
    kind: suite.kind,
    suiteVersion: suite.suiteVersion,
    name: suite.name,
    decisionHz: suite.decisionHz,
    reward: suite.reward,
    appearanceShiftVariant: suite.appearanceShiftVariant,
    entries: suite.entries,
  });
  return createHash('sha256').update(digestInput).digest('hex');
}

/** Deterministic per-entry seed for shifts that re-draw the world. */
export function deriveSeed(namespace: string, entryId: string): string {
  return createHash('sha256').update(`${namespace}|${entryId}`).digest('hex');
}

/* ------------------------------------------------------- training exclusions */

const basename = (p: string): string => p.replaceAll('\\', '/').split('/').pop() ?? p;

/**
 * A catalog slot is held out iff its (template file, map, site) triple was
 * never materialized by any rl training/eval bank AND its seed is outside
 * every bank's seed list for that same key.
 */
export function isHeldOut(slot: CatalogSlotView, banks: readonly TrainingEpisodeSpec[]): boolean {
  for (const bank of banks) {
    if (basename(bank.template) !== basename(slot.templateSource)) continue;
    if (bank.map !== slot.mapId) continue;
    if (bank.site !== slot.matcherSiteId) continue;
    if (bank.seeds.includes(slot.seed)) return false;
  }
  return true;
}

export function countExcluded(
  slots: readonly CatalogSlotView[],
  banks: readonly TrainingEpisodeSpec[],
): number {
  return slots.filter((s) => !isHeldOut(s, banks)).length;
}

/* ------------------------------------------------------------ ability table */

export interface AbilitySpec {
  id: string;
  title: string;
  templateFile: string;
  /**
   * Behavioral-shift parameter pins (Fail2Drive-style): every value sits
   * inside the declaration's authored range, so validity is preserved and
   * only the choreography tightens — shorter gaps, faster actors, later
   * reveals. Authored once when the suite froze; never retuned after.
   */
  paramOverrides: Record<string, number>;
}

export const ABILITY_SPECS: readonly AbilitySpec[] = [
  {
    id: 'intersection-left-turn',
    title: 'Unprotected left across opposing through traffic',
    templateFile: 'ltap-opposing.template.json',
    paramOverrides: { arrivalTtc: 1.4 },
  },
  {
    id: 'intersection-encroachment',
    title: 'Opposing turn encroaches into the ego path',
    templateFile: 'opposing-turn-encroachment.template.json',
    paramOverrides: { arrivalDeltaS: 0.65, encroachmentFrac: 0.62 },
  },
  {
    id: 'intersection-violation',
    title: 'Cross traffic violates its stop control',
    templateFile: 'cross-traffic-stop-violation.template.json',
    paramOverrides: { rollSpeedKph: 16 },
  },
  {
    id: 'signal-timing-pressure',
    title: 'Late entry through a red signal',
    templateFile: 'red-light-late-entry.template.json',
    paramOverrides: { arrivalDeltaS: 2.13 },
  },
  {
    id: 'queue-navigation',
    title: 'Approach into a standing queue tail',
    templateFile: 'queue-tail.template.json',
    paramOverrides: { approachSpeedFrac: 0.95, previewDistanceM: 48 },
  },
  {
    id: 'cut-in-response',
    title: 'Abrupt cut-in followed by hard braking',
    templateFile: 'cut-in-brake.template.json',
    paramOverrides: { insertionLeadM: 16, lateralRateMps: 1.7 },
  },
  {
    id: 'lane-discipline',
    title: 'Slow lateral drift toward the ego lane (sideswipe)',
    templateFile: 'sideswipe.template.json',
    paramOverrides: { longitudinalOverlapM: -0.1, driftRateMps: 0.67 },
  },
  {
    id: 'obstacle-avoid',
    title: 'Stopped obstacle revealed late in-lane',
    templateFile: 'disabled-vehicle.template.json',
    paramOverrides: { previewDistanceM: 42 },
  },
  {
    id: 'pullout-yield',
    title: 'Vehicle pulls out from the kerb into the ego path',
    templateFile: 'vehicle-pulls-out.template.json',
    paramOverrides: { triggerDistanceM: 19, pulloutSpeedKph: 18 },
  },
  {
    id: 'overtake-return',
    title: 'Oncoming overtake returning into the ego lane',
    templateFile: 'oncoming-overtake.template.json',
    paramOverrides: { returnTtcS: 1.85, lateralRateMps: 1.3 },
  },
];

/**
 * The frozen appearance shift (Bench2Drive-Robust-style deployment weather).
 * Values are inside `applyCatalogVariant`'s vocabulary: rain → friction 0.72,
 * headlight-limited → 75 m visibility range, dusk lighting, heavy traffic.
 */
export const APPEARANCE_SHIFT_VARIANT: SuiteVariant = {
  id: 'eval-appearance-rain-dusk',
  title: 'Rain at dusk, heavy traffic, headlight-limited visibility',
  weather: 'rain',
  timeOfDay: 'dusk',
  traffic: 'heavy',
  visibility: 'headlight-limited with wet-road reflections',
};

export const SUITE_NAMESPACE = 'policy-eval-suite.v1';

/* ------------------------------------------------------------- construction */

export interface SuiteBuildInput {
  slots: readonly CatalogSlotView[];
  banks: readonly TrainingEpisodeSpec[];
  /**
   * Validation probe supplied by the CLI: returns true when the concrete
   * (template × map × site × seed × variant × overrides) cell materializes.
   * Pure tests pass `undefined` to skip validation.
   */
  validate?: ((entry: SuiteEntry) => boolean | Promise<boolean>) | undefined;
}

export interface SuiteBuildResult {
  suite: PolicyEvalSuite;
  skipped: Array<{ ability: string; reason: string }>;
}

function slotToBaseEntry(ability: AbilitySpec, slot: CatalogSlotView, shift: SuiteEntry['shift']): SuiteEntry {
  const entryId = `${ability.id}|${shift}`;
  return {
    entryId,
    ability: ability.id,
    shift,
    pairedWith: `${ability.id}|base`,
    templateSource: slot.templateSource,
    mapId: slot.mapId,
    matcherSiteId: slot.matcherSiteId,
    seed: slot.seed,
    catalogIdentity: slot.identity,
    // Base keeps the catalog's own operational conditions; the other shifts
    // replace or keep them explicitly downstream.
    variant: shift === 'appearance' ? APPEARANCE_SHIFT_VARIANT : slot.variant,
    paramOverrides: shift === 'behavioral' ? { ...ability.paramOverrides } : null,
  };
}

/**
 * Build the frozen suite. For each ability: pick the first valid catalog
 * slot (catalog order) as base, then emit the three paired shifts; layout
 * uses the first valid partner slot on a different map (same-map fallback:
 * a different matched site), re-seeded from the suite namespace.
 */
export async function buildSuite(input: SuiteBuildInput): Promise<SuiteBuildResult> {
  const validate = input.validate;
  const skipped: SuiteBuildResult['skipped'] = [];
  const entries: SuiteEntry[] = [];
  const abilities: PolicyEvalSuite['abilities'] = {};

  for (const ability of ABILITY_SPECS) {
    const candidates = input.slots.filter(
      (s) => basename(s.templateSource) === ability.templateFile && isHeldOut(s, input.banks),
    );
    if (candidates.length === 0) {
      skipped.push({ ability: ability.id, reason: `no held-out catalog slots for ${ability.templateFile}` });
      continue;
    }
    abilities[ability.id] = { title: ability.title, templateSource: candidates[0]!.templateSource };

    // Base: first candidate that validates.
    let base: CatalogSlotView | null = null;
    let baseEntry: SuiteEntry | null = null;
    for (const candidate of candidates) {
      const probe = slotToBaseEntry(ability, candidate, 'base');
      if (!validate || (await validate(probe))) {
        base = candidate;
        baseEntry = probe;
        break;
      }
    }
    if (!base || !baseEntry) {
      skipped.push({ ability: ability.id, reason: 'no candidate slot materializes' });
      delete abilities[ability.id];
      continue;
    }

    // Layout: first valid partner on another map, else another site. The
    // paired-shift protocol needs all four cells; an ability without a
    // partner is skipped whole rather than half-paired.
    const others = candidates.filter((c) => c !== base);
    const crossMap = others.filter((c) => c.mapId !== base!.mapId);
    const orderedPartners = [...crossMap, ...others.filter((c) => c.mapId === base!.mapId)];
    let layoutEntry: SuiteEntry | null = null;
    for (const partner of orderedPartners) {
      const probe: SuiteEntry = {
        ...slotToBaseEntry(ability, partner, 'layout'),
        seed: deriveSeed(SUITE_NAMESPACE, `${ability.id}|layout|${partner.mapId}|${partner.matcherSiteId}`),
        variant: partner.variant,
      };
      if (!validate || (await validate(probe))) {
        layoutEntry = probe;
        break;
      }
    }
    if (!layoutEntry) {
      delete abilities[ability.id];
      skipped.push({ ability: ability.id, reason: 'no layout partner materializes' });
      continue;
    }
    entries.push(baseEntry);
    for (const shift of ['appearance', 'behavioral'] as const) {
      entries.push(slotToBaseEntry(ability, base, shift));
    }
    entries.push(layoutEntry);
  }

  const suite: Omit<PolicyEvalSuite, 'suiteHash'> = {
    kind: 'policy-eval-suite',
    suiteVersion: 1,
    name: 'policy-eval-suite.v1',
    decisionHz: 5,
    reward: { progressWeight: 0.1 },
    appearanceShiftVariant: APPEARANCE_SHIFT_VARIANT,
    trainingExclusions: {
      sources: [...new Set(input.banks.map((b) => b.source))].sort(),
      templates: [...new Set(input.banks.map((b) => basename(b.template)))].sort(),
      excludedSlotCount: countExcluded(input.slots, input.banks),
      candidateSlotsConsidered: input.slots.length,
    },
    abilities,
    entries,
  };
  return { suite: { ...suite, suiteHash: computeSuiteHash(suite) }, skipped };
}
