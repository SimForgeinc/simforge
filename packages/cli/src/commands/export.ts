/** `uniscenarios export <instance> --format xosc-1.4|xosc-1.3-esmini|osc-2.2 --out <file>`. */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { exportAsamScenario, AsamExportError, type AsamFormat } from '@simforge/openscenario/export';
import { CliError, EXIT } from '../errors.js';
import { loadMap } from '@simforge/compiler';
import { emit, emitLines } from '../output.js';
import { readInstance } from '@simforge/compiler';

export interface ExportOptions {
  readonly file: string;
  readonly format: AsamFormat;
  readonly out: string;
  readonly roadFile?: string | undefined;
  readonly author?: string | undefined;
  readonly description?: string | undefined;
  readonly routeSampleM?: number | undefined;
  readonly pretty: boolean;
}

export async function exportScenario(options: ExportOptions): Promise<number> {
  const instance = await readInstance(options.file);
  const bundle = await loadMap(instance.input.mapId);
  const replayKey = instance.manifest?.replayKey;
  const provenance = replayKey === undefined ? undefined : {
    ...replayKey,
    instanceId: instance.manifest.instanceId,
    inputHash: instance.manifest.inputHash,
  };
  let result;
  try {
    result = exportAsamScenario(options.format, instance.input, {
      graph: bundle.graph,
      ...(options.roadFile === undefined ? {} : { roadFile: options.roadFile }),
      ...(options.author === undefined ? {} : { author: options.author }),
      ...(options.description === undefined ? {} : { description: options.description }),
      ...(options.routeSampleM === undefined ? {} : { routeSampleM: options.routeSampleM }),
      ...(provenance === undefined ? {} : { provenance }),
      ...(options.format === 'xosc-1.4' || options.format === 'xosc-1.3-esmini'
        ? { executionMode: 'trajectory-replay' as const }
        : {}),
    });
  } catch (error) {
    if (error instanceof AsamExportError) {
      throw new CliError('asam_export_unsupported', error.message, {
        path: options.file,
        detail: { format: options.format, issues: error.issues },
        exitCode: EXIT.validationFindings,
      });
    }
    throw error;
  }
  const absolute = path.resolve(options.out);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, result.content, 'utf8');
  const payload = {
    ok: true,
    format: result.format,
    standard: result.standard,
    profile: result.profile,
    intent: result.intent,
    roundTrip: result.capabilityReport.roundTrip,
    externalSimulatorValidation: result.capabilityReport.externalSimulatorValidation,
    capabilityReport: result.capabilityReport,
    mediaType: result.mediaType,
    out: absolute,
    bytes: Buffer.byteLength(result.content),
    warnings: result.warnings,
  };
  if (!options.pretty) emit(payload, options);
  else {
    emitLines([
      `${result.standard} export`,
      `profile: ${result.profile}`,
      `intent: ${result.intent}`,
      `round-trip import: ${result.capabilityReport.roundTrip}`,
      `external simulator validation: ${result.capabilityReport.externalSimulatorValidation}`,
      `written: ${absolute}`,
      `bytes: ${payload.bytes}`,
      `warnings: ${result.warnings.length}`,
      ...result.warnings.map((warning) => `  ${warning.path}: ${warning.reason}`),
    ]);
  }
  return EXIT.ok;
}
