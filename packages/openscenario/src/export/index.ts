import type { SimScenarioInput } from '@simforge-oss/engine';

import { exportOpenScenarioDsl22 } from './dsl-2.2.js';
import type { AsamExportOptions, AsamExportResult, AsamFormat } from './types.js';
import { exportOpenScenarioXml14 } from './xml-1.4.js';
import { exportOpenScenarioXml13Esmini } from './xml-1.3-esmini.js';

export { exportOpenScenarioDsl22 } from './dsl-2.2.js';
export {
  Dsl22SyntaxError,
  assertOpenScenarioDsl22ProfileSyntax,
  validateOpenScenarioDsl22ProfileSyntax,
  type Dsl22SyntaxDiagnostic,
} from './dsl-2.2-syntax.js';
export { exportOpenScenarioXml14 } from './xml-1.4.js';
export { analyzeAsamCapabilities } from './common.js';
export {
  analyzeEsminiCompatibility,
  exportOpenScenarioXml13Esmini,
  type EsminiCompatibilityEntry,
  type EsminiCompatibilityReport,
  type EsminiExportMode,
} from './xml-1.3-esmini.js';
export {
  ASAM_FORMATS,
  AsamExportError,
  type AsamCapabilityEntry,
  type AsamCapabilityReport,
  type AsamConstructCapabilityEntry,
  type AsamConstructKind,
  type AsamExportIntent,
  type AsamExportIssue,
  type AsamExportOptions,
  type AsamExportProfile,
  type AsamExportResult,
  type AsamExportWarning,
  type AsamFormat,
} from './types.js';

export function exportAsamScenario(
  format: AsamFormat,
  input: SimScenarioInput,
  options: AsamExportOptions,
): AsamExportResult {
  if (format === 'xosc-1.4') return exportOpenScenarioXml14(input, options);
  if (format === 'xosc-1.3-esmini') return exportOpenScenarioXml13Esmini(input, options);
  return exportOpenScenarioDsl22(input, options);
}
