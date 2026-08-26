/**
 * `simforge template validate <file>` — schema + tier-1.
 *
 * With `--map` the map-dependent half of tier 1 runs too, against a **real**
 * `MapContext` built from the best matched site (or `--site`). Without a site
 * there is no anchor frame, and therefore no honest way to answer "is there a
 * lane at (k, s)" — so those checks are skipped and `mapChecked` says so rather
 * than reporting a pass nobody earned.
 */

import {
  ScenarioTemplateV2Schema,
  parseAndValidateTemplate,
  toScenarioIssues,
  type ClauseResult,
} from '@simforge-oss/scenario';

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { adaptTemplate } from '../adapt.js';
import { CliError, EXIT } from '../errors.js';
import { assertKnownMap } from '@simforge-oss/compiler/node';
import { createMapContext } from '@simforge-oss/compiler/node';
import { emit, emitLines, pad } from '../output.js';
import { matchOnMap } from '@simforge-oss/compiler/node';
import { writeJsonFile } from '@simforge-oss/compiler/node';

export interface TemplateValidateOptions {
  readonly file: string;
  readonly mapId?: string | undefined;
  readonly siteId?: string | undefined;
  readonly pretty: boolean;
}

export async function templateValidate(options: TemplateValidateOptions): Promise<number> {
  const json = JSON.parse(await readFile(options.file, 'utf8')) as unknown;

  // Parse once here so map binding can use the parsed document, and reuse
  // `parseAndValidateTemplate`'s uniform issue shape when parsing fails.
  const parsed = ScenarioTemplateV2Schema.safeParse(json);
  if (!parsed.success) {
    const issues = toScenarioIssues(parsed.error.issues).map((i) => ({
      path: i.path,
      severity: 'error' as const,
      code: 'schema_invalid',
      message: i.message,
    }));
    emit(
      { file: options.file, ok: false, mapChecked: false, counts: { error: issues.length, warning: 0, info: 0 }, issues },
      options,
    );
    return EXIT.validationFindings;
  }
  const template = parsed.data;

  let mapChecked = false;
  let siteId: string | null = null;
  let context: ReturnType<typeof createMapContext> | undefined;
  // Not an `issue`: the validator's codes are a closed vocabulary shared with
  // the matcher, and "I could not run the map checks" is a property of *this
  // invocation*, not a defect in the document.
  let mapCheckSkipped: string | null = null;

  if (options.mapId) {
    const match = await matchOnMap(template, options.mapId);
    const site = options.siteId
      ? match.report.sites.find((s) => s.siteId === options.siteId)
      : match.report.sites[0];
    if (site) {
      context = createMapContext(match.bundle, site);
      siteId = site.siteId;
      mapChecked = true;
    } else {
      mapCheckSkipped = `the anchor matched no site on ${options.mapId}: ${match.report.failureSummary}`;
    }
  }

  const { report } = parseAndValidateTemplate(json, context);
  const adapted = adaptTemplate(template);
  // A clause the matcher cannot express is a document error, not a footnote.
  // Until this existed, `blind-crest-queue` shipped with its `crest` feature
  // deleted and every one of its five sites scored 0.89 from 142-272 m away
  // from the nearest actual crest, and the author was told nothing.
  const unmatchable: ClauseResult[] = adapted.notes
    .filter((n) => n.severity === 'error')
    .map((n) => ({
      path: n.path,
      severity: 'error' as const,
      code: 'clause_unmatchable' as const,
      message: n.reason,
    }));
  const issues: ClauseResult[] = [...report.issues, ...unmatchable];
  const counts = {
    error: issues.filter((i) => i.severity === 'error').length,
    warning: issues.filter((i) => i.severity === 'warning').length,
    info: issues.filter((i) => i.severity === 'info').length,
  };

  const payload = {
    file: options.file,
    ok: counts.error === 0,
    mapChecked,
    mapCheckSkipped,
    mapId: options.mapId ?? null,
    siteId,
    counts,
    issues,
    adapterNotes: adapted.notes,
  };

  if (!options.pretty) {
    emit(payload, options);
  } else {
    const lines = [
      `${options.file}: ${counts.error} error(s), ${counts.warning} warning(s)${
        mapChecked ? ` — map checks against ${options.mapId} site ${siteId}` : ' — document-only checks'
      }`,
      '',
    ];
    if (mapCheckSkipped) lines.push(`map checks skipped: ${mapCheckSkipped}`, '');
    for (const i of issues) {
      lines.push(`${pad(i.severity, 9)}${pad(i.code, 26)}${pad(i.path, 44)}${i.message}`);
    }
    for (const n of adapted.notes) {
      if (n.severity === 'error') continue; // already reported above as an issue
      lines.push(`${pad('adapter', 9)}${pad('note', 26)}${pad(n.path, 44)}${n.reason}`);
    }
    emitLines(lines);
  }
  return counts.error > 0 ? EXIT.validationFindings : EXIT.ok;
}

/**
 * Fixed bookkeeping timestamps for emitted skeletons.
 *
 * `template new` is a *deterministic* generator: the same flags produce
 * byte-identical output, so two agents comparing skeletons diff their edits,
 * not their wall clocks. An author stamps real times on first save.
 */
const TEMPLATE_NEW_EPOCH = '1970-01-01T00:00:00.000Z';

export interface TemplateNewOptions {
  readonly out?: string | undefined;
  readonly mapId?: string | undefined;
  readonly siteId?: string | undefined;
  readonly pretty: boolean;
}

/**
 * `simforge template new` — a minimal, schema-valid v2 skeleton.
 *
 * The shape mirrors `examples/mechanisms/`: one `on_reference` ego, an empty
 * corridor anchor with matcher policy, and a 20 s clip with no interactions.
 * It validates as-is; the author's job is to make it *mean* something. With
 * `--map` (and optionally `--site`) the skeleton is pre-bound via
 * `anchor.pin`, which collapses matching to that exact place.
 */
export async function templateNew(options: TemplateNewOptions): Promise<number> {
  if (options.siteId !== undefined && options.mapId === undefined) {
    throw new CliError('missing_option', '--site requires --map', { path: '--site' });
  }
  if (options.mapId !== undefined) assertKnownMap(options.mapId);

  const template = {
    scenarioVersion: 2,
    meta: {
      name: 'New template',
      description:
        'Minimal v2 skeleton from `simforge template new`. Constrain the anchor corridor, add roles and choreography interactions, then run `simforge template validate`.',
      createdAt: TEMPLATE_NEW_EPOCH,
      modifiedAt: TEMPLATE_NEW_EPOCH,
      appVersion: 'simforge/template-new/v1',
      tags: ['skeleton'],
      author: 'cli/template-new',
      negativeControl: false,
    },
    ...(options.mapId === undefined
      ? {}
      : { sourceMap: { mapId: options.mapId, mapName: options.mapId } }),
    anchor: {
      id: 'new-template',
      corridor: {},
      features: [],
      policy: { allowMirror: true, maxSitesPerMap: 10 },
      ...(options.mapId === undefined
        ? {}
        : {
            pin: {
              mapId: options.mapId,
              ...(options.siteId === undefined ? {} : { siteId: options.siteId }),
            },
          }),
    },
    roles: [
      {
        id: 'ego',
        kind: 'on_reference',
        actor: { class: 'car' },
        pose: { laneOffset: 0, s: 15, tFrac: 0, headingOffsetRad: 0 },
        initialSpeedKph: 'clamp(0.8 * lane.speedLimitKph, 25, 50)',
      },
    ],
    choreography: { clipSeconds: 20, warmupSeconds: 5, interactions: [] },
    metricSubject: 'ego',
  };

  // Emit exactly what a downstream validator will parse — no drift between
  // what this writes and what `ScenarioTemplateV2Schema` accepts.
  const parsed = ScenarioTemplateV2Schema.parse(template);

  let out: string | null = null;
  if (options.out !== undefined) {
    await writeJsonFile(options.out, parsed);
    out = resolve(options.out);
  }
  emit({ ok: true, template: parsed, out }, options);
  return EXIT.ok;
}
