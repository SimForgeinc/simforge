import type {
  Interaction,
  LaneGraph,
  Pose,
  Route,
  SimActor,
  SimScenarioInput,
} from '@uniscenarios/sim-engine';

export const ASAM_FORMATS = ['xosc-1.4', 'xosc-1.3-esmini', 'osc-2.2'] as const;
export type AsamFormat = (typeof ASAM_FORMATS)[number];

export type AsamExportProfile =
  | 'xml-1.4-actions'
  | 'xml-1.4-trajectory-replay'
  | 'xml-1.3-esmini-actions'
  | 'xml-1.3-esmini-trajectory-replay'
  | 'dsl-2.2-actions';

export type AsamExportIntent = 'editable-semantic' | 'trajectory-replay';

export interface AsamCapabilityEntry {
  /** SimScenarioInput field covered by this decision. */
  readonly path: keyof SimScenarioInput;
  readonly disposition: 'preserved' | 'derived' | 'extension' | 'omitted';
  readonly fidelity: 'exact' | 'approximate' | 'metadata-only' | 'none';
  readonly reason: string;
}

export type AsamConstructKind =
  | 'actor'
  | 'interaction'
  | 'signal-program'
  | 'environment'
  | 'surface-patch'
  | 'occluder'
  | 'perception'
  | 'physics';

/**
 * Machine-readable disposition for one concrete authored construct.
 *
 * Field-level capability entries answer whether a profile generally supports a
 * part of SimScenarioInput. Construct entries answer the operationally useful
 * question: what happened to this exact actor/action/signal/environment value
 * in this exact export?
 */
export interface AsamConstructCapabilityEntry {
  readonly sourcePath: string;
  readonly sourceId?: string | undefined;
  readonly kind: AsamConstructKind;
  readonly disposition: 'preserved' | 'derived' | 'extension';
  readonly fidelity: 'exact' | 'approximate' | 'metadata-only';
  readonly representation:
    | 'standard-entity'
    | 'standard-trajectory'
    | 'standard-environment'
    | 'standard-signal-state'
    | 'profile-action'
    | 'profile-signal-controller'
    | 'simulated-outcome'
    | 'uniscenarios-property';
  readonly reason: string;
}

export interface AsamCapabilityReport {
  readonly profile: AsamExportProfile;
  readonly intent: AsamExportIntent;
  /** Import is intentionally not claimed by this exporter. */
  readonly roundTrip: 'not-supported';
  /** One entry for every top-level SimScenarioInput field. */
  readonly fields: readonly AsamCapabilityEntry[];
  /** One disposition for every material authored construct in this instance. */
  readonly constructs?: readonly AsamConstructCapabilityEntry[] | undefined;
  readonly summary: Readonly<Record<AsamCapabilityEntry['disposition'], number>>;
  readonly externalSimulatorValidation: 'not-verified';
}

export interface AsamExportIssue {
  readonly code: string;
  readonly path: string;
  readonly reason: string;
}

export interface AsamExportWarning extends AsamExportIssue {}

export class AsamExportError extends Error {
  override readonly name = 'AsamExportError';
  readonly issues: readonly AsamExportIssue[];

  constructor(issues: readonly AsamExportIssue[]) {
    super(`ASAM export rejected ${issues.length} unsupported or invalid feature${issues.length === 1 ? '' : 's'}`);
    this.issues = issues;
  }
}

export interface AsamExportOptions {
  /** Compiler-owned actor identities authorized for materialized-traffic replacement. */
  readonly trustedAmbientActorIds?: readonly string[] | undefined;
  /** The concrete map graph used to turn every engine route into world coordinates. */
  readonly graph: LaneGraph;
  /** Resolve OpenDRIVE XY to the absolute road-surface elevation for WorldPosition Z. */
  readonly worldElevation?: ((position: {
    readonly x: number;
    readonly y: number;
    readonly actorId?: string;
  }) => number) | undefined;
  /** Logical road file referenced by XML 1.4. Defaults to `<mapId>.xodr`. */
  readonly roadFile?: string | undefined;
  /** Deterministic header timestamp. Defaults to the Unix epoch. */
  readonly headerDate?: string | undefined;
  readonly author?: string | undefined;
  readonly description?: string | undefined;
  /** Stable instance-manifest fields carried into the interchange artifact. */
  readonly provenance?: Readonly<Record<string, string | number | boolean>> | undefined;
  /**
   * `trajectory-replay` embeds deterministic timed actor tracks and avoids
   * relying on unspecified simulator traffic-rule/controller behaviour.
   * The lower-level API keeps `actions` as its compatibility default; the CLI
   * selects trajectory replay for standards-faithful interchange.
   */
  readonly executionMode?: 'actions' | 'trajectory-replay' | undefined;
  /** Maximum distance between exported route waypoints. */
  readonly routeSampleM?: number | undefined;
  /**
   * UniScenarios near-miss acceptance intent. OSC 1.4 preserves the executable
   * trigger/trajectory natively; these criteria are carried as FileHeader
   * properties because OSC has no standard OBB-clearance success criterion.
   */
  readonly nearMissCriteria?: readonly {
    readonly pedestrianId: string;
    readonly targetId: string;
    readonly clearanceM: number;
    readonly toleranceM?: number;
    readonly pass?: 'front' | 'behind' | 'auto';
    readonly planHash?: string;
  }[] | undefined;
}

export interface AsamExportResult {
  readonly format: AsamFormat;
  readonly standard: 'ASAM OpenSCENARIO XML 1.4.0' | 'ASAM OpenSCENARIO XML 1.3.1 · esmini compatibility' | 'ASAM OpenSCENARIO DSL 2.2.0';
  readonly extension: '.xosc' | '.osc';
  readonly mediaType: 'application/xml' | 'text/plain';
  readonly content: string;
  readonly warnings: readonly AsamExportWarning[];
  readonly profile: AsamExportProfile;
  readonly intent: AsamExportIntent;
  readonly capabilityReport: AsamCapabilityReport;
}

export interface ResolvedActor {
  readonly actor: SimActor;
  readonly name: string;
  readonly routeName: string;
  readonly route: Route;
  readonly points: readonly Pose[];
}

export interface ResolvedInteraction {
  readonly interaction: Interaction;
  readonly name: string;
  readonly startTimeS?: number | undefined;
}

export interface ResolvedAsamScenario {
  readonly input: SimScenarioInput;
  readonly actors: readonly ResolvedActor[];
  readonly interactions: readonly ResolvedInteraction[];
  readonly actorNames: ReadonlyMap<string, string>;
  readonly interactionNames: ReadonlyMap<string, string>;
  readonly warnings: readonly AsamExportWarning[];
}
