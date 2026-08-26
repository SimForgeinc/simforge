/**
 * `@simforge-oss/cli` — layer 4 of `docs/agent-authoring-architecture.md`.
 *
 * The `simforge` binary is the product; this module is its library face, so the
 * editor, the workflows in layer 5 and the tests can call the same code paths
 * without shelling out.
 *
 * ```ts
 * import { loadMap, matchOnMap, materialize } from '@simforge-oss/cli';
 *
 * const bundle = await loadMap('yale-street');
 * const { report } = await matchOnMap(template, 'yale-street');
 * const { input, manifest } = materialize(template, bundle, report.sites[0]!, { drawIndex: 0 });
 * ```
 *
 * @packageDocumentation
 */

export { run } from './main.js';

export {
  CliError,
  EXIT,
  exitCodeOf,
  toStructuredError,
  type StructuredError,
} from './errors.js';

export {
  ARTIFACTS,
  DEV_ASSETS,
  KNOWN_MAPS,
  REPO_ROOT,
  artifactPresence,
  assertKnownMap,
  availableMaps,
  loadMap,
  mapDir,
  resolveMapSelection,
  type MapArtifactPresence,
  type MapBundle,
} from '@simforge-oss/compiler/node';

export {
  buildSiteSignalPlan,
  defaultPhasesForHead,
  parseMapSignalCatalog,
  SYNTHETIC_SIGNAL_OFFSET_S,
  type MapSignalCatalog,
  type MapSignalController,
  type MapSignalHead,
  type MapSignalJunction,
  type SiteSignalPlan,
} from './map-signals.js';
export { loadMapSignalCatalog } from '@simforge-oss/compiler/node';

export {
  CLAUSE_UNMATCHABLE,
  OPEN_END_M,
  adaptTemplate,
  numberish,
  templateCrossingAngle,
  templateStaticScope,
  unmatchableNotes,
  type AdaptNote,
  type AdaptSeverity,
  type AdaptedAnchor,
} from './adapt.js';

export {
  cellSeed,
  discreteValues,
  paramsVersion,
  resolveParams,
  templateId,
  type ParamDraw,
} from './params.js';

export {
  applyCatalogVariant,
  mapSetKey,
  materialize,
  type AppliedCatalogVariant,
  type CatalogVariantApplication,
  type InstanceManifest,
  type MaterializeOptions,
  type MaterializeResult,
  type ReplayKey,
} from './materialize.js';

export { createMapContext } from '@simforge-oss/compiler/node';

export {
  assertMatchableAnchor,
  findSite,
  matchOnMap,
  matchOnMaps,
  siteSummary,
  type SiteMatch,
} from '@simforge-oss/compiler/node';

export {
  checkInvariants,
  type InvariantContext,
  type InvariantResidualReport,
} from './invariants.js';

export {
  cellPaths,
  runCell,
  type CellCoords,
  type CellOptions,
  type CellResult,
} from './batch-cell.js';

export {
  detectKind,
  readInstance,
  readTemplate,
  readTraceFile,
  writeJsonFile,
  writeTraceFile,
  type InstanceFile,
} from '@simforge-oss/compiler/node';

export { PROP_DIMS, propDims, type PropDims } from './prop-dims.js';

export {
  CATALOG_GENERATOR_VERSION,
  CATALOG_KIND,
  CATALOG_RESEARCH_SOURCES,
  CATALOG_SLOTS_PER_MAP,
  CATALOG_TEMPLATE_SOURCES,
  CATALOG_VERSION,
  DEFAULT_CATALOG_NAMESPACE,
  INCIDENT_DOMAINS,
  INCIDENT_TAXONOMY,
  OPERATIONAL_VARIANTS,
  createScenarioCatalog,
  refreshScenarioCatalog,
  validateScenarioCatalog,
  type CatalogAcceptanceCheck,
  type CatalogEvidencePaths,
  type CatalogIssue,
  type CatalogMapProvenance,
  type CatalogProgressCounts,
  type CatalogSiteBinding,
  type CatalogSlotStatus,
  type CatalogTemplateProvenance,
  type CatalogValidationReport,
  type ScenarioCatalogManifest,
  type ScenarioCatalogSlot,
} from './catalog.js';

export { evaluate, combinedEvaluationVerdict, criticalityBand, filtersFor, type EvaluateFilterMode, type EvaluateOptions } from './commands/evaluate.js';
export { metricsSummary } from './commands/simulate.js';
export { debugScenario, type DebugOptions, type DebugPathSample } from './commands/debug.js';
export { SCHEMAS, type SchemaEntry } from './commands/schemas.js';
export { renderHash, renderRun, type RenderRunOptions } from './commands/render.js';
export { importOpenScenario, type ImportOptions } from './commands/import.js';
export { templateNew, type TemplateNewOptions } from './commands/template.js';
export {
  loadBuiltinRenderEngine,
  loadRenderEngine,
  type BuiltinRenderEngineId,
  type RenderEngineAdapter,
  type RenderExecutionContext,
} from '@simforge-oss/render';
