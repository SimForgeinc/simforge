/**
 * `ScenarioTemplate`, schema v2 — the authored, portable, map-free document.
 *
 * ```
 * ScenarioTemplate v2
 *   meta, params, environment
 *   anchor: LogicalAnchor        ← predicate over road structure (L1+L2)
 *   roles: RoleBinding[]         ← how actors attach to matched structure
 *   props: PropPlacement[]       ← L3 temporary modifications / occluders
 *   choreography                 ← L4 timeline: 7 verbs, triggers, dynamics
 *   invariants                   ← what must survive retargeting
 *   variants                     ← author-defined degraded renditions
 * ```
 *
 * `SiteBinding` (anchor × map → ranked sites) and `ScenarioInstance`
 * (template × site × param draw) are **derived** and are not in this file —
 * they belong to the matcher and the sampler, are cached, and are always
 * re-derivable. Nothing here stores an absolute transform, a road id or a route
 * polyline, because every one of those is a fact about one map.
 *
 * ## Relationship to v1
 *
 * v1 (`schema/v1.ts`) stays exactly as it was: a map-bound scene of absolutely
 * posed entities, still parsed by `parseScenario`, still edited by
 * `ScenarioDocument`, still the format `apps/cloud` reads today. v2 is a
 * different *kind* of document that happens to be the next number in the same
 * version sequence, so one `scenarioVersion` field still tells a loader which
 * parser to use (`detectScenarioKind`). The v1 → v2 migration is explicit
 * (`migrateToTemplate`) rather than automatic, because turning a scene into a
 * template loses the thing v1 was best at — knowing exactly where everything is
 * — and that is a decision an author should make on purpose. See `migrate-v2.ts`.
 */

import { z } from 'zod';

import { MapRefSchema, ScenarioMetaSchema } from '../v1.js';
import { LogicalAnchorSchema } from './anchor.js';
import { RoleRefSchema, V2ExtensionsSchema } from './common.js';
import { EnvironmentSchema } from './environment.js';
import { ChoreographySchema } from './interactions.js';
import { InvariantSchema } from './invariants.js';
import { ParamsBlockSchema } from './params.js';
import { PropPlacementSchema } from './props.js';
import { RoleBindingSchema } from './roles.js';
import { TemplatePerceptionSchema } from './sensors.js';
import { TrafficControlSchema } from './traffic-controls.js';
import { MapSignalPlanSchema } from './map-signal-plans.js';
import { ReasoningTraceSegmentSchema } from './reasoning-trace.js';
import { VariantSchema } from './variants.js';

/** The schema version this module describes. */
export const SCENARIO_TEMPLATE_VERSION = 2;

/** Template bookkeeping: v1's meta plus the fields a scenario *library* needs. */
export const TemplateMetaSchema = ScenarioMetaSchema.extend({
  /**
   * Archetype id from the taxonomy (`docs/research/interactions-and-edge-cases.md`),
   * e.g. `C3.ltap-od` or `C5.cpnco-dartout`. The coverage ledger counts these.
   */
  archetype: z.string().max(120).optional(),
  /** Free tags for search and batch selection. */
  tags: z.array(z.string().min(1).max(64)).max(32).default([]),
  /** `human`, an agent id, or a workflow name — provenance for triage. */
  author: z.string().max(200).optional(),
  /**
   * Marks a template whose *purpose* is to be uneventful (phantom-brake bait,
   * kerb-standing pedestrians). The reject filters would otherwise drop it for
   * being trivially safe.
   */
  negativeControl: z.boolean().default(false),
});

/** The v2 document, without the cross-field checks. Exported for tooling/JSON Schema. */
export const ScenarioTemplateV2ObjectSchema = z.strictObject({
  scenarioVersion: z.literal(SCENARIO_TEMPLATE_VERSION),
  meta: TemplateMetaSchema,
  /**
   * Provenance only: the map the template was authored on. A template is
   * portable by construction, so nothing in matching may read this — it exists
   * so the editor can reopen the scene the author was looking at, and so a
   * migrated v1 document does not lose which map it belonged to.
   */
  sourceMap: MapRefSchema.optional(),
  params: ParamsBlockSchema.prefault({}),
  environment: EnvironmentSchema.prefault({}),
  anchor: LogicalAnchorSchema,
  roles: z.array(RoleBindingSchema).max(64).default([]),
  props: z.array(PropPlacementSchema).max(256).default([]),
  /** Portable executable traffic controls, independent of map-owned signals. */
  trafficControls: z.array(TrafficControlSchema).max(64).default([]),
  /** Map-bound phase edits for physical signal controllers selected in Studio. */
  mapSignalPlans: z.array(MapSignalPlanSchema).max(64).default([]),
  choreography: ChoreographySchema.prefault({}),
  /**
   * Declared map/percept divergence: where the HD map disagrees with the world.
   *
   * A typed field rather than a knob under `environment.extensions`, which is
   * documented as uninterpreted. Hiding a first-class fact in an uninterpreted
   * bag is exactly how this repo's existing capabilities became unreachable, so
   * the honest options are a typed field or no capability. The atmosphere is
   * *not* here: fog, darkness and sun angle already live in `environment`, and
   * the sensor model derives from those rather than duplicating them.
   */
  perception: TemplatePerceptionSchema.prefault({}),
  invariants: z.array(InvariantSchema).max(64).default([]),
  variants: z.array(VariantSchema).max(32).default([]),
  /**
   * The role whose episode metrics decide whether an instance is critical.
   * Everything else about it is ordinary — there is no privileged "ego" actor,
   * only a declared measurement subject (architecture doc §9.2).
   */
  metricSubject: RoleRefSchema.optional(),
  /** Time-bounded observation/action annotations authored for the metric subject. */
  reasoningTrace: z.array(ReasoningTraceSegmentSchema).max(128).default([]),
  extensions: V2ExtensionsSchema.optional(),
});

/**
 * The v2 template schema. Parse `.template.json` / v2 `.scenario.json` with this.
 *
 * The `.check` here covers only the things that are cheap, universal and truly
 * structural: unique ids within each list and `modifiedAt >= createdAt`.
 * Everything else — reference resolution, one-axis-one-owner, `set` keys,
 * dynamics — lives in `validate/` and returns `ClauseResult`s, because those
 * checks have to be reportable as a *list of repairable issues* to an agent,
 * not as a parse failure. See `validate/structural.ts`.
 */
export const ScenarioTemplateV2Schema = ScenarioTemplateV2ObjectSchema.check((ctx) => {
  const doc = ctx.value;
  const dupes = (
    items: ReadonlyArray<{ id: string }>,
    path: string,
  ): void => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      if (seen.has(item.id)) {
        ctx.issues.push({
          code: 'custom',
          message: `duplicate ${path} id "${item.id}"`,
          path: [path, index, 'id'],
          input: item.id,
        });
      }
      seen.add(item.id);
    });
  };
  dupes(doc.roles, 'roles');
  dupes(doc.props, 'props');
  dupes(doc.trafficControls, 'trafficControls');
  dupes(doc.mapSignalPlans, 'mapSignalPlans');
  const junctionOwners = new Set<string>();
  doc.mapSignalPlans.forEach((plan, index) => {
    const key = `${plan.binding.mapId}\u0000${plan.binding.junctionId}`;
    if (junctionOwners.has(key)) {
      ctx.issues.push({
        code: 'custom', path: ['mapSignalPlans', index, 'binding', 'junctionId'], input: plan.binding.junctionId,
        message: `only one map signal plan may own junction "${plan.binding.junctionId}" on map "${plan.binding.mapId}"`,
      });
    }
    junctionOwners.add(key);
    plan.clips.forEach((clip, clipIndex) => {
      if (clip.endS > doc.choreography.clipSeconds) {
        ctx.issues.push({
          code: 'custom', path: ['mapSignalPlans', index, 'clips', clipIndex, 'endS'], input: clip.endS,
          message: `map signal clip ends after choreography.clipSeconds (${doc.choreography.clipSeconds})`,
        });
      }
    });
  });
  dupes(doc.invariants, 'invariants');
  dupes(doc.variants, 'variants');
  dupes(doc.reasoningTrace, 'reasoningTrace');
  doc.reasoningTrace.forEach((segment, index) => {
    if (segment.endS > doc.choreography.clipSeconds) {
      ctx.issues.push({
        code: 'custom', path: ['reasoningTrace', index, 'endS'], input: segment.endS,
        message: `reasoning trace ends after choreography.clipSeconds (${doc.choreography.clipSeconds})`,
      });
    }
  });
  dupes(doc.params.declarations, 'params');
  dupes(doc.anchor.features, 'features');
  const seenInteractions = new Set<string>();
  doc.choreography.interactions.forEach((interaction, index) => {
    if (seenInteractions.has(interaction.id)) {
      ctx.issues.push({
        code: 'custom',
        message: `duplicate interaction id "${interaction.id}"`,
        path: ['choreography', 'interactions', index, 'id'],
        input: interaction.id,
      });
    }
    seenInteractions.add(interaction.id);
  });
  if (Date.parse(doc.meta.modifiedAt) < Date.parse(doc.meta.createdAt)) {
    ctx.issues.push({
      code: 'custom',
      message: 'meta.modifiedAt precedes meta.createdAt',
      path: ['meta', 'modifiedAt'],
      input: doc.meta.modifiedAt,
    });
  }
});

/** A validated v2 template (all defaults materialised, expressions parsed). */
export type ScenarioTemplateV2 = z.infer<typeof ScenarioTemplateV2Schema>;
/** A v2 template as authored: defaults optional, expressions may be strings. */
export type ScenarioTemplateV2Input = z.input<typeof ScenarioTemplateV2Schema>;
/** Template metadata. */
export type TemplateMeta = z.infer<typeof TemplateMetaSchema>;
