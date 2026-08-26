/**
 * `simforge import <file.xosc>` — OpenSCENARIO XML 1.4 → v2 scenario template.
 *
 * The heavy lifting lives in `@simforge-oss/openscenario/import` (`analyze` →
 * `resolveOpenScenarioMap` → `translate`); this command is the agent-facing
 * wrapper: it binds the file's embedded map identity against the dev-assets
 * maps on disk, runs tier-1 validation over the translated draft, and reports
 * everything — stats, mapped/unmapped features, validation findings, and what
 * the translation was lossy about — as one JSON summary.
 *
 * Exit codes follow the CLI contract: **0** a clean import, **2** the import
 * ran and reported findings (unsupported/approximated features, an unresolved
 * map identity, or validation errors). Findings are data, not failures — the
 * translated template is still written when one exists.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import {
  analyzeOpenScenarioImport,
  OpenScenarioImportError,
  resolveOpenScenarioMap,
  translateOpenScenarioImport,
  type OpenScenarioImportDiagnostic,
  type OpenScenarioImportMapCandidate,
} from '@simforge-oss/openscenario/import';
import { parseAndValidateTemplate, type ClauseResult } from '@simforge-oss/scenario';

import { assertKnownMap, availableMaps, mapDir } from '@simforge-oss/compiler/node';
import { CliError, EXIT } from '../errors.js';
import { emit, emitLines, pad } from '../output.js';
import { writeJsonFile } from '@simforge-oss/compiler/node';

export interface ImportOptions {
  readonly file: string;
  readonly out?: string | undefined;
  readonly mapId?: string | undefined;
  readonly pretty: boolean;
}

/**
 * The dev-assets maps as import candidates. The slug is both identities: dev
 * maps have no separate immutable version id, and the on-disk `map.xodr`
 * digest gives the strong `xodrSha256` match path for files that carry it.
 */
function mapCandidates(): OpenScenarioImportMapCandidate[] {
  return availableMaps().map((mapId) => ({
    mapVersionId: mapId,
    sourceMapId: mapId,
    label: mapId,
    aliases: [mapId],
    xodrSha256: xodrDigest(mapId),
  }));
}

function xodrDigest(mapId: string): string | undefined {
  const xodr = `${mapDir(mapId)}/map.xodr`;
  if (!existsSync(xodr)) return undefined;
  return createHash('sha256').update(readFileSync(xodr)).digest('hex');
}

/** What the translation could not carry across, one line per loss. */
function lossyNotes(diagnostics: readonly OpenScenarioImportDiagnostic[]): string[] {
  const notes = diagnostics
    .filter((d) => d.disposition !== 'supported')
    .map((d) => `${d.path}: ${d.message}`);
  // True even when every diagnostic above says "supported": the translator
  // pins actors at their Init world positions by design.
  notes.push(
    'roles are scene_absolute (map-pinned world poses); re-author them as portable role kinds before retargeting to another map',
  );
  return notes;
}

export async function importOpenScenario(options: ImportOptions): Promise<number> {
  let bytes: Buffer;
  try {
    bytes = await readFile(options.file);
  } catch {
    throw new CliError('file_not_found', `cannot read ${options.file}`, { path: options.file });
  }
  if (options.mapId !== undefined) assertKnownMap(options.mapId);

  let analysis;
  try {
    analysis = analyzeOpenScenarioImport(bytes, basename(options.file));
  } catch (error) {
    if (error instanceof OpenScenarioImportError) {
      throw new CliError(error.code, error.message, { path: options.file });
    }
    throw error;
  }

  const resolution = resolveOpenScenarioMap(analysis, mapCandidates(), options.mapId ?? null);

  const selected =
    resolution.selectedMapVersionId === null
      ? null
      : resolution.candidates.find((c) => c.mapVersionId === resolution.selectedMapVersionId) ?? null;
  const document =
    selected === null
      ? null
      : translateOpenScenarioImport(
          analysis,
          {
            artifactId: basename(options.file),
            sha256: analysis.source.sha256,
            byteLength: analysis.source.byteLength,
            mediaType: analysis.source.mediaType,
          },
          selected,
        );

  // Tier-1 without a MapContext: the draft is pinned to a map it has never been
  // matched against, so map-dependent checks are skipped exactly the way
  // `template validate` skips them without `--map`.
  const { report } =
    document === null ? { report: null } : parseAndValidateTemplate(document);
  const featureFindings = analysis.diagnostics.filter((d) => d.disposition !== 'supported');
  const validationErrors: ClauseResult[] =
    report === null ? [] : report.issues.filter((i) => i.severity === 'error');
  const findings = [
    ...featureFindings.map((d) => ({ kind: 'feature' as const, code: d.code, path: d.path, message: d.message })),
    ...(resolution.diagnostic === null
      ? []
      : [{ kind: 'map' as const, code: resolution.diagnostic.code, path: resolution.diagnostic.path, message: resolution.diagnostic.message }]),
    ...validationErrors.map((i) => ({ kind: 'validation' as const, code: i.code, path: i.path, message: i.message })),
  ];

  let out: string | null = null;
  if (document !== null && options.out !== undefined) {
    await writeJsonFile(options.out, document);
    out = resolve(options.out);
  }

  const actorsByKind: Record<string, number> = {};
  for (const actor of analysis.actors) actorsByKind[actor.kind] = (actorsByKind[actor.kind] ?? 0) + 1;

  const payload = {
    ok: findings.length === 0,
    file: resolve(options.file),
    standard: analysis.standard,
    title: analysis.title,
    logicFile: analysis.logicFile,
    source: analysis.source,
    stats: {
      actors: analysis.actors.length,
      actorsByKind,
      rolesTranslated: document?.roles.length ?? 0,
      clipSeconds: document?.choreography.clipSeconds ?? null,
      interactions: document?.choreography.interactions.length ?? null,
    },
    map: {
      status: resolution.status,
      source: resolution.source,
      requestedIdentity: resolution.requestedIdentity,
      selectedMapVersionId: resolution.selectedMapVersionId,
      candidates: resolution.candidates.map((c) => c.mapVersionId),
      diagnostic: resolution.diagnostic,
    },
    capabilities: analysis.capabilities,
    diagnostics: analysis.diagnostics,
    lossy: lossyNotes(analysis.diagnostics),
    validation:
      report === null
        ? null
        : {
            ok: report.ok,
            counts: {
              error: report.issues.filter((i) => i.severity === 'error').length,
              warning: report.issues.filter((i) => i.severity === 'warning').length,
              info: report.issues.filter((i) => i.severity === 'info').length,
            },
            issues: report.issues,
          },
    findings,
    out,
  };

  if (!options.pretty) {
    emit(payload, options);
    return findings.length > 0 ? EXIT.validationFindings : EXIT.ok;
  }

  const lines = [
    `${pad('file', 12)}${payload.file}`,
    `${pad('standard', 12)}${payload.standard}`,
    `${pad('title', 12)}${payload.title}`,
    `${pad('actors', 12)}${payload.stats.actors} (${Object.entries(actorsByKind).map(([k, n]) => `${k}:${n}`).join(', ') || 'none'})`,
    `${pad('map', 12)}${resolution.status}${resolution.selectedMapVersionId ? ` → ${resolution.selectedMapVersionId}` : ''}`,
    `${pad('out', 12)}${out ?? '—'}`,
    '',
    'capabilities:',
    `  supported: ${analysis.capabilities.supported}  approximated: ${analysis.capabilities.approximated}  unsupported: ${analysis.capabilities.unsupported}`,
  ];
  if (payload.lossy.length > 0) {
    lines.push('', 'lossy:');
    for (const note of payload.lossy) lines.push(`  - ${note}`);
  }
  if (payload.validation !== null) {
    lines.push(
      '',
      `validation: ${payload.validation.ok ? 'ok' : 'errors'} (e:${payload.validation.counts.error} w:${payload.validation.counts.warning} i:${payload.validation.counts.info})`,
    );
    for (const issue of payload.validation.issues) lines.push(`  [${issue.severity}] ${issue.path}: ${issue.message}`);
  }
  emitLines(lines);
  return findings.length > 0 ? EXIT.validationFindings : EXIT.ok;
}
