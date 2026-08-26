import type { AsamCapabilityReport, AsamExportIssue, AsamExportWarning } from './export/types.js';
import type { SimScenarioInput, SimTrace } from '@simforge-oss/engine';

export type OpenScenarioValidationStatus = 'passed' | 'failed' | 'pending' | 'not-run' | 'unavailable';

export interface OpenScenarioValidationStage {
  readonly id: 'internal-model' | 'xml-profile' | 'official-xsd' | 'dependencies' | 'external-execution' | 'behavior-parity';
  readonly label: string;
  readonly status: OpenScenarioValidationStatus;
  readonly detail: string;
}

export interface OpenScenarioSourceMapping {
  readonly sourcePath: string;
  readonly sourceId: string;
  readonly exportKind: 'entity' | 'event' | 'trajectory' | 'signal' | 'property';
  readonly exportName: string;
  readonly selector: string;
}

/** Immutable OpenSCENARIO artifact bound to one exact input and trace. */
export interface OpenScenarioSnapshot<TExternal = unknown> {
  readonly version: 1;
  readonly source: {
    readonly name: string;
    readonly templateHash: string;
    readonly mapping: readonly OpenScenarioSourceMapping[];
  };
  readonly concrete: {
    readonly input: SimScenarioInput;
    readonly inputHash: string;
    readonly instanceId: string;
    readonly traceHash: string;
    readonly traceHeader: SimTrace['header'];
    readonly trace: SimTrace;
  };
  readonly map: {
    readonly id: string;
    readonly roadFile: string;
    readonly xodrDigest: string;
    readonly laneGraphDigest: string;
  };
  readonly artifact: {
    readonly state: 'ready' | 'rejected';
    readonly standard: 'ASAM OpenSCENARIO XML 1.4.0';
    readonly profile: 'xml-1.4-trajectory-replay';
    readonly intent: 'trajectory-replay';
    readonly filename: string;
    readonly mediaType: 'application/xml';
    readonly content: string | null;
    readonly capabilityReport: AsamCapabilityReport | null;
    readonly warnings: readonly AsamExportWarning[];
    readonly issues: readonly AsamExportIssue[];
  };
  readonly validation: readonly OpenScenarioValidationStage[];
  /** Adapter-owned external execution evidence; never synthesized by the core. */
  readonly external?: TExternal;
}
