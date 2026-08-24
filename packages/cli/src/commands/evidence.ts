import { EXIT } from '../errors.js';
import { verifyEvidenceHashes } from '../evidence.js';
import { emit, emitLines, pad } from '../output.js';
import { readInstance, readTraceFile } from '@simforge/compiler';

export interface EvidenceVerifyOptions {
  readonly instance: string;
  readonly trace: string;
  readonly pretty: boolean;
}

export async function evidenceVerify(options: EvidenceVerifyOptions): Promise<number> {
  const [instance, trace] = await Promise.all([
    readInstance(options.instance),
    readTraceFile(options.trace),
  ]);
  const report = verifyEvidenceHashes(instance, trace);
  const payload = {
    instance: options.instance,
    trace: options.trace,
    ...report,
  };

  if (!options.pretty) {
    emit(payload, options);
  } else {
    const lines = [
      `${options.instance} ↔ ${options.trace}: ${report.ok ? 'OK' : 'MISMATCH'}`,
      `inputHash manifest=${report.manifestInputHash ?? '—'} trace=${report.traceInputHash ?? '—'} recomputed=${report.recomputedInputHash}`,
      `mapId input=${report.inputMapId} manifest=${report.manifestMapId ?? '—'} trace=${report.traceMapId ?? '—'}`,
      `matcherIndexDigest ${report.matcherIndexDigest ?? '—'}`,
      `engineGraphDigest manifest=${report.manifestEngineGraphDigest ?? '—'} trace=${report.traceEngineGraphDigest ?? '—'}`,
      `input actors ${report.inputActorIds.length}: ${report.inputActorIds.join(', ') || '—'}`,
      `trace actors ${report.traceActorIds.length}: ${report.traceActorIds.join(', ') || '—'}`,
    ];
    if (report.issues.length > 0) {
      lines.push('', 'issues:');
      for (const issue of report.issues) {
        lines.push(`  ${pad(issue.code, 30)}${issue.reason}`);
      }
    }
    emitLines(lines);
  }

  return report.ok ? EXIT.ok : EXIT.validationFindings;
}
