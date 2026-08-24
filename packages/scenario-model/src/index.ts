/**
 * `@uniscenarios/scenario-model` — the versioned scenario documents.
 *
 * Framework-free: no React, no three.js. Positions in v1 are plain `{x, y, z}`
 * in the y-up scene frame that `@uniscenarios/xodr-tools` produces, and
 * headings are radians CCW about +Y from +X (equal to the OpenDRIVE heading —
 * see `schema/v1.ts`).
 *
 * Two document kinds, deliberately different in kind and not just in version:
 *
 * - **v1, a scene** — actors at absolute coordinates on one named map.
 *   {@link ScenarioDocument} edits it, {@link parseScenario} reads it,
 *   {@link migrate} versions it. Unchanged by v2.
 * - **v2, a template** — a {@link LogicalAnchorSchema logical anchor} (a
 *   predicate over road structure, no coordinates, no road ids), roles bound to
 *   the matched structure, and a frame-relative timeline of seven verbs.
 *   {@link parseTemplate} reads it, {@link validateTemplate} checks it,
 *   {@link migrateToTemplate} converts a v1 scene into one.
 *
 * Layers:
 *
 * 1. **Schema** — {@link ScenarioV1Schema} / {@link ScenarioTemplateV2Schema}
 *    (zod v4, strict, with generated JSON Schemas under `schema/`).
 * 2. **Expressions** — {@link parseExpr}, {@link evaluateExpr}: typed numeric
 *    ASTs over lane/junction/param facts, so speeds are portable.
 * 3. **Document** — {@link ScenarioDocument}: typed operations, immer-patch
 *    undo/redo, dirty flag, `subscribe()`.
 * 4. **Validation** — {@link validateTemplate}: tier-1 static checks emitting
 *    {@link ClauseResult}s, with map-dependent checks behind {@link MapContext}.
 * 5. **Migration** — {@link migrate} (v1 chain) and {@link migrateToTemplate}.
 * 6. **Persistence** — {@link ScenarioFileStore} with in-memory and
 *    `localStorage` implementations.
 *
 * @example v1: edit a scene
 * ```ts
 * import { ScenarioDocument, MemoryScenarioFileStore } from '@uniscenarios/scenario-model';
 *
 * const doc = ScenarioDocument.create({
 *   name: 'Yale & Grant left turn',
 *   map: { mapId: 'yale-street', mapName: 'Yale Street' },
 * });
 * doc.addEntity({
 *   kind: 'vehicle',
 *   model: { catalogId: 'sedan.generic' },
 *   pose: { position: { x: 118.2, y: 0, z: -402.7 }, headingRad: Math.PI / 2 },
 * });
 *
 * const store = new MemoryScenarioFileStore();
 * await store.write('yale-left-turn', doc);
 * doc.markClean();
 * ```
 *
 * @example v2: validate a template
 * ```ts
 * import { parseTemplate, validateTemplate } from '@uniscenarios/scenario-model';
 *
 * const template = parseTemplate(JSON.parse(text));
 * const report = validateTemplate(template);        // document-only checks
 * if (!report.ok) console.error(report.issues);     // {path, severity, code, message}
 * ```
 *
 * @packageDocumentation
 */

export {
  DRIVER_PROFILE_IDS,
  DRIVER_PROFILES,
  DriverProfileSchema,
  driverProfileDefinition,
  type DriverProfile,
  type DriverProfileDefinition,
} from './driver-profiles.js';

export {
  SCENARIO_VERSION,
  ScenarioV1Schema,
  ScenarioV1ObjectSchema,
  ScenarioMetaSchema,
  MapRefSchema,
  EntitySchema,
  EntityIdSchema,
  EntityKindSchema,
  ModelRefSchema,
  PoseSchema,
  Vec3Schema,
  LaneRefSchema,
  DimensionsSchema,
  ExtensionsSchema,
  TimestampSchema,
  type ScenarioV1,
  type ScenarioV1Input,
  type ScenarioMeta,
  type MapRef,
  type Entity,
  type EntityKind,
  type ModelRef,
  type Pose,
  type Vec3,
  type LaneRef,
  type LaneRefInput,
  type Dimensions,
  type Extensions,
} from './schema/v1.js';

export {
  ScenarioDocument,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_APP_VERSION,
  type ScenarioDocumentOptions,
  type CreateScenarioInit,
  type ScenarioChange,
  type ScenarioChangeReason,
} from './document.js';

export {
  TemplateDocument,
  newTemplateId,
  type CreateTemplateInit,
  type TemplateChange,
  type TemplateChangeReason,
  type TemplateDocumentOptions,
} from './template-document.js';

export {
  AUTHORED_ACTOR_LIMIT_CODE,
  MAX_AUTHORED_ACTORS,
  authoredActorCount,
  authoredActorLimitMessage,
} from './actor-limits.js';

export {
  applyTemplateOp,
  describeTemplateOp,
  type TemplateMetaPatch,
  type TemplateOp,
} from './template-operations.js';

export {
  prepareSimulationInput,
  TemplatePreparationError,
  type MaterializationProduct,
  type SemanticLoss,
  type TemplateMaterializer,
} from './materialization.js';

export {
  applyOp,
  buildEntity,
  describeOp,
  normalizeHeading,
  type ScenarioOp,
  type AddEntityOp,
  type UpdateEntityOp,
  type RemoveEntityOp,
  type MoveEntityOp,
  type SetMetaOp,
  type SetMapOp,
  type SetExtensionOp,
  type NewEntity,
  type EntityPatch,
  type MetaPatch,
} from './operations.js';

export {
  migrate,
  runMigrations,
  deserializeScenario,
  CURRENT_SCENARIO_VERSION,
  SCENARIO_MIGRATIONS,
  type ScenarioMigration,
  type MigrateResult,
  type RunMigrationsOptions,
} from './migrate.js';

export {
  serializeScenario,
  parseScenario,
  parseTemplate,
  serializeTemplate,
  canonicalize,
  roundFloat,
  deepFreeze,
  FLOAT_DECIMALS,
} from './serialize.js';

export {
  migrateLegacyInitialRoutes,
  type InitialRouteMigrationResult,
} from './initial-route-migration.js';

// --- schema v2: the portable ScenarioTemplate -------------------------------

export * from './schema/v2/index.js';

export * from './expr/index.js';
export * from './semantic-ledger.js';
export * from './render-spec.js';
export * from './render-intent.js';
export { Sha256 } from './sha256.js';

export {
  CURRENT_TEMPLATE_VERSION,
  TEMPLATE_MIGRATIONS,
  detectScenarioKind,
  migrateToTemplate,
  v1ToTemplateV2,
  type MigrationNote,
  type TemplateMigrationResult,
} from './migrate-v2.js';

export {
  ISSUE_CODES,
  axisTimeline,
  collectExpressions,
  createFakeMapContext,
  earliestOf,
  endBound,
  isPortableTemplate,
  joinPath,
  latestOf,
  mapIssues,
  parseAndValidateTemplate,
  resolveTriggerTime,
  staticScope,
  structuralIssues,
  toReport,
  unusedRoles,
  validateTemplate,
  type AxisSlot,
  type AxisTimeline,
  type ClauseResult,
  type FakeLane,
  type FakeMapOptions,
  type FeatureFacts,
  type GateFacts,
  type IssueCode,
  type LaneChangePermissions,
  type LaneFacts,
  type LaneRsl,
  type LaneType,
  type MapContext,
  type Severity,
  type SignalFacts,
  type TimeBound,
  type TimingContext,
  type ValidationReport,
} from './validate/index.js';

export {
  ANCHOR_JSON_SCHEMA_PATH,
  INTERACTIONS_JSON_SCHEMA_PATH,
  TEMPLATE_JSON_SCHEMA_PATH,
  V2_SCHEMA_BASE,
  buildAllV2JsonSchemas,
  buildAnchorJsonSchema,
  buildInteractionsJsonSchema,
  buildTemplateJsonSchema,
} from './json-schema-v2.js';

export { newId, sequentialIds, ULID_PATTERN } from './ids.js';

export {
  WebTemplateFileStore,
  type TemplateFileStore,
  type TemplateLike,
} from './stores/template-web.js';

export { buildJsonSchema, JSON_SCHEMA_ID, JSON_SCHEMA_PATH } from './json-schema.js';

export {
  ScenarioValidationError,
  AuthoredActorLimitError,
  ScenarioMigrationError,
  ScenarioOperationError,
  ScenarioNotFoundError,
  toScenarioIssues,
  type ScenarioIssue,
} from './errors.js';

export {
  assertValidScenarioName,
  toScenarioV1,
  type ScenarioFileStore,
  type ScenarioFileEntry,
  type ScenarioLike,
} from './stores/types.js';

export { MemoryScenarioFileStore } from './stores/memory.js';

export {
  WebScenarioFileStore,
  MemoryStorage,
  DEFAULT_STORAGE_PREFIX,
  type StorageLike,
  type WebScenarioFileStoreOptions,
} from './stores/web.js';
