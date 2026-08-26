/**
 * `simforge instantiate <template> --map --site [--seed | --draw K]`.
 *
 * The materializer's command surface. One cell in, one instance file out; the
 * instance carries its own replay key, so nothing downstream ever has to be
 * told which template, site, seed and package versions produced it.
 */

import path from 'node:path';

import { EXIT } from '../errors.js';
import { materialize, type MaterializeResult } from '../materialize.js';
import { emit, emitLines, fixed, pad } from '../output.js';
import { findSite } from '@simforge-oss/compiler/node';
import { readTemplate, writeJsonFile, type InstanceFile } from '@simforge-oss/compiler/node';

export interface InstantiateOptions {
  readonly file: string;
  readonly mapId: string;
  readonly siteId: string;
  readonly seed?: string | undefined;
  readonly draw?: number | undefined;
  readonly out?: string | undefined;
  readonly pretty: boolean;
}

export function instanceFile(result: MaterializeResult): InstanceFile {
  return {
    kind: 'scenario-instance',
    version: 1,
    manifest: result.manifest,
    input: result.input,
  };
}

export async function instantiate(options: InstantiateOptions): Promise<number> {
  const template = await readTemplate(options.file);
  const { bundle, site } = await findSite(template, options.mapId, options.siteId);
  const result = materialize(template, bundle, site, {
    ...(options.draw === undefined ? {} : { drawIndex: options.draw }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  });
  const file = instanceFile(result);

  if (options.out) {
    await writeJsonFile(options.out, file);
  }

  if (!options.pretty) {
    emit({ ...file, out: options.out ? path.resolve(options.out) : null }, options);
  } else {
    const m = result.manifest;
    const lines = [
      `${m.instanceId} — ${m.replayKey.templateId} on ${m.replayKey.mapId}`,
      `site ${m.site.siteId} score ${fixed(m.site.score, 3)} (${m.site.verdict}), ego turns ${m.site.egoTurn ?? '—'}`,
      `paramSeed ${m.replayKey.paramSeed.slice(0, 16)}… draw ${m.replayKey.drawIndex}`,
      `inputHash ${m.inputHash.slice(0, 16)}…  feasible: ${m.feasible}`,
      '',
      'params:',
      ...Object.entries(m.params.values).map(([k, v]) => `  ${pad(k, 24)}${fixed(v, 3)}`),
      ...Object.entries(m.params.categorical).map(([k, v]) => `  ${pad(k, 24)}${v}`),
      '',
      'actors:',
      ...m.actors.map(
        (a) =>
          `  ${pad(a.id, 18)}${pad(a.roleKind, 20)}${pad(a.laneRsl ?? '—', 16)}s=${fixed(a.spawnS, 1)} v=${fixed(
            a.initialSpeedMps * 3.6,
            1,
          )} kph  (${a.bindingStatus})`,
      ),
    ];
    if (m.arrival.length > 0) {
      lines.push('', 'arrival solves:');
      for (const s of m.arrival) {
        lines.push(
          `  ${pad(s.actorId, 18)}Δs ${fixed(s.spawnDeltaS, 2)} m → Δt ${fixed(s.achievedDeltaT, 3)} s (wanted ${fixed(
            s.targetDeltaT,
            3,
          )}), ttc ${fixed(s.achievedTtc, 3)} s${s.converged ? '' : '  [clamped]'}`,
        );
      }
    }
    if (m.issues.length > 0) {
      lines.push('', 'feasibility:');
      for (const i of m.issues) lines.push(`  ${pad(i.severity, 9)}${pad(i.code, 26)}${i.reason}`);
    }
    if (m.notes.length > 0) {
      lines.push('', 'notes:');
      for (const n of m.notes) lines.push(`  ${pad(n.path, 44)}${n.reason}`);
    }
    if (options.out) lines.push('', `written: ${path.resolve(options.out)}`);
    emitLines(lines);
  }

  return result.manifest.feasible ? EXIT.ok : EXIT.validationFindings;
}
