import type { SimScenarioInput } from '@simforge-oss/engine';

import { analyzeAsamCapabilities } from './common.js';
import { exportOpenScenarioXml14 } from './xml-1.4.js';
import { AsamExportError, type AsamExportOptions, type AsamExportResult } from './types.js';

export type EsminiExportMode = 'supported-actions' | 'deterministic-trajectory';
export type EsminiCompatibilityDisposition =
  | 'semantic-portable'
  | 'lowered'
  | 'trajectory-baked'
  | 'unsupported-blocking';

export interface EsminiCompatibilityEntry {
  readonly path: string;
  readonly disposition: EsminiCompatibilityDisposition;
  /** A blocking finding prevents the selected profile from claiming its stated fidelity. */
  readonly blocking: boolean;
  readonly reason: string;
}

export interface EsminiCompatibilityReport {
  readonly target: 'esmini';
  /** The runner pins the actual executable version in provenance at execution time. */
  readonly targetVersion: 'runner-pinned';
  readonly openScenarioVersion: '1.3.1';
  readonly profile: 'supported-actions' | 'deterministic-trajectory';
  readonly behaviorParityScope: 'semantic-actions' | 'motion-only';
  readonly coverageSources: readonly [string, string];
  readonly entries: readonly EsminiCompatibilityEntry[];
  readonly blocking: readonly EsminiCompatibilityEntry[];
}

const finding = (
  path: string,
  disposition: EsminiCompatibilityDisposition,
  reason: string,
  blocking = disposition === 'unsupported-blocking',
): EsminiCompatibilityEntry => ({ path, disposition, blocking, reason });

/**
 * esmini intentionally implements a useful subset of OpenSCENARIO. This
 * report describes the profile we emit instead of confusing XSD validity with
 * simulator coverage. Trajectory mode promises motion parity only.
 */
export function analyzeEsminiCompatibility(
  input: SimScenarioInput,
  mode: EsminiExportMode,
): EsminiCompatibilityReport {
  const replay = mode === 'deterministic-trajectory';
  const entries: EsminiCompatibilityEntry[] = [
    finding('schemaVersion', 'lowered', 'SimForge schema identity is retained in Properties; the XML document is authored directly as 1.3.1.'),
    finding('mapId', 'semantic-portable', 'Resolved to a hash-verified complete OpenDRIVE LogicFile in the runnable bundle.'),
    finding('clipSeconds', 'semantic-portable', 'Mapped to the storyboard StopTrigger.'),
    finding('warmupSeconds', 'lowered', 'Folded into absolute storyboard and trajectory time.'),
    finding('dt', replay ? 'trajectory-baked' : 'lowered', replay ? 'The fixed timestep is represented by timed trajectory vertices.' : 'Recorded as provenance; action execution uses the simulator step.'),
    finding('seed', replay ? 'trajectory-baked' : 'lowered', replay ? 'Stochastic outcomes are frozen into the canonical trace.' : 'Recorded as provenance; no simulator randomness is requested.'),
    finding('operationalConditions', replay ? 'trajectory-baked' : 'unsupported-blocking', replay ? 'Their motion effects are baked; weather and surface rendering are outside motion-only parity.' : 'The supported-actions profile does not emit environment conditions.'),
    finding('metricSubject', 'lowered', 'Metric subject identity is carried in provenance and evaluated outside esmini.'),
    finding('actors', replay ? 'trajectory-baked' : 'semantic-portable', replay ? 'Identity, dimensions and deterministic sampled motion are emitted.' : 'Entities, routes and supported controller actions remain editable semantic constructs.'),
    finding('interactions', replay ? 'trajectory-baked' : 'semantic-portable', replay ? 'Causal triggers are flattened into actor trajectories; motion-only parity is testable.' : 'Only interactions mapped by the supported-actions exporter are accepted.'),
    finding('signalPrograms', replay ? 'trajectory-baked' : 'unsupported-blocking', replay ? 'Actor response is baked; signal-head rendering/state parity is not claimed.' : 'esmini signal-controller coverage is not treated as a portable semantic contract.'),
    finding('roadControls', replay ? 'trajectory-baked' : 'unsupported-blocking', replay ? 'Actor response is baked; portable lane-control semantics are not claimed.' : 'Temporary and reversible lane controls are outside the supported-actions profile.'),
    finding('props', replay ? 'trajectory-baked' : 'unsupported-blocking', replay ? 'Actor response is baked; current XML does not reproduce procedural prop appearance.' : 'Procedural Studio props have no esmini catalog mapping.'),
    finding('occluders', 'semantic-portable', 'Stationary occluders are emitted as bounding-box MiscObjects.'),
    finding('occlusionPairs', replay ? 'trajectory-baked' : 'unsupported-blocking', replay ? 'Reveal outcomes remain in canonical trace evidence; OpenSCENARIO has no line-of-sight assertion.' : 'Line-of-sight evaluation is not an esmini execution construct.'),
  ];

  for (const interaction of input.interactions) {
    if (interaction.verb !== 'set') continue;
    const motionRule = interaction.target.key.startsWith('rules.') || interaction.target.key.startsWith('signal:');
    if (replay && motionRule) continue;
    if (replay) {
      entries.push(finding(
        `interactions.${interaction.id}.target.key`,
        'lowered',
        `${interaction.target.key} is emitted as a standard or user-defined appearance action when representable, but esmini rendering is outside motion-only parity.`,
        false,
      ));
    }
  }
  for (const actor of input.actors) {
    const loweredCategory = actor.kind === 'truck' || actor.kind === 'motorcycle' || actor.kind === 'scooter' || actor.kind === 'vehicle';
    if (!loweredCategory) continue;
    entries.push(finding(
      `actors.${actor.id}.kind`,
      'lowered',
      `${actor.kind} uses the closest OpenSCENARIO 1.3.1 vehicle category while its exact SimForge kind remains in Properties.`,
      false,
    ));
  }
  const material = (path: keyof SimScenarioInput): boolean => {
    const value = input[path];
    if (path === 'operationalConditions') {
      const conditions = input.operationalConditions;
      return conditions.weather !== 'clear' || conditions.timeOfDay !== 'day' ||
        conditions.visibility !== 'unrestricted' || conditions.effects.visibilityRangeM !== 10_000 ||
        conditions.effects.frictionScale !== 1 || conditions.effects.trafficSpeedFactor !== 1;
    }
    return !Array.isArray(value) || value.length > 0;
  };
  const filtered = entries.filter((entry) => {
    const top = entry.path.split('.')[0] as keyof SimScenarioInput;
    return !(top in input) || material(top);
  });
  return {
    target: 'esmini',
    targetVersion: 'runner-pinned',
    openScenarioVersion: '1.3.1',
    profile: mode,
    behaviorParityScope: replay ? 'motion-only' : 'semantic-actions',
    coverageSources: [
      'https://esmini.github.io/scenario-features.html',
      'https://esmini.github.io/command-reference.html',
    ],
    entries: filtered,
    blocking: filtered.filter((entry) => entry.blocking),
  };
}

/** Known 1.4-only trajectory additions are removed structurally, never relabelled. */
function lowerXml14OutputTo13(xml: string): string {
  return xml
    .replace('revMajor="1" revMinor="4"', 'revMajor="1" revMinor="3"')
    .replaceAll('vehicleCategory="other"', 'vehicleCategory="car"')
    .replaceAll('vehicleCategory="heavyTruck"', 'vehicleCategory="truck"')
    .replaceAll('vehicleCategory="motorcycle"', 'vehicleCategory="motorbike"')
    .replaceAll('vehicleCategory="standupScooter"', 'vehicleCategory="motorbike"')
    .replaceAll(/\n\s*<Motion speed_longitudinal="[^"]+"\/>/g, '')
    .replaceAll(/\n\s*<Interpolation\/>/g, '');
}

export interface EsminiXml13Export extends AsamExportResult {
  readonly compatibilityReport: EsminiCompatibilityReport;
}

export function exportOpenScenarioXml13Esmini(
  input: SimScenarioInput,
  options: AsamExportOptions & { readonly esminiMode?: EsminiExportMode },
): EsminiXml13Export {
  const mode = options.esminiMode ?? (options.executionMode === 'actions' ? 'supported-actions' : 'deterministic-trajectory');
  const compatibilityReport = analyzeEsminiCompatibility(input, mode);
  if (compatibilityReport.blocking.length > 0) {
    throw new AsamExportError(compatibilityReport.blocking.map((entry) => ({
      code: 'esmini_unsupported',
      path: entry.path,
      reason: entry.reason,
    })));
  }
  const executionMode = mode === 'supported-actions' ? 'actions' : 'trajectory-replay';
  const base = exportOpenScenarioXml14(input, { ...options, executionMode });
  const profile = mode === 'supported-actions'
    ? 'xml-1.3-esmini-actions' as const
    : 'xml-1.3-esmini-trajectory-replay' as const;
  const capability = analyzeAsamCapabilities(input, profile);
  return {
    ...base,
    format: 'xosc-1.3-esmini',
    standard: 'ASAM OpenSCENARIO XML 1.3.1 · esmini compatibility',
    content: lowerXml14OutputTo13(base.content)
      .replaceAll('uniscenarios.export.profile" value="xml-1.4-actions', 'uniscenarios.export.profile" value="xml-1.3-esmini-actions')
      .replaceAll('uniscenarios.export.profile" value="xml-1.4-trajectory-replay', 'uniscenarios.export.profile" value="xml-1.3-esmini-trajectory-replay'),
    profile,
    capabilityReport: capability.report,
    warnings: [...base.warnings, ...capability.warnings],
    compatibilityReport,
  };
}
