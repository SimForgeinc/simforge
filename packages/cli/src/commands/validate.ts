/**
 * `simforge validate <instance|template> [--tier 2 --map --site]`.
 *
 * Tier 1 is the static pass (`simforge template validate` in one word). **Tier 2 is
 * one engine pass**: the invariant residuals the template declared, the engine
 * issues, the never-fired triggers and the axis conflicts that only a run can
 * settle. It is the acceptance test for a *transfer* — "did the thing the
 * author said must stay true actually stay true on this site".
 */

import { runSimulation } from '@simforge-oss/engine';

import { CliError, EXIT } from '../errors.js';
import { checkInvariants, type InvariantResidualReport } from '../invariants.js';
import { loadMap } from '@simforge-oss/compiler/node';
import { materialize } from '../materialize.js';
import { emit, emitLines, fixed, pad } from '../output.js';
import { findSite } from '@simforge-oss/compiler/node';
import { detectKind, readInstance, readTemplate } from '@simforge-oss/compiler/node';
import { metricsSummary } from './simulate.js';
import { templateValidate } from './template.js';

export interface ValidateOptions {
  readonly file: string;
  readonly tier: 1 | 2;
  readonly mapId?: string | undefined;
  readonly siteId?: string | undefined;
  readonly draw?: number | undefined;
  readonly seed?: string | undefined;
  readonly pretty: boolean;
}

export async function validate(options: ValidateOptions): Promise<number> {
  const kind = await detectKind(options.file);

  if (options.tier === 1) {
    if (kind === 'template') {
      return templateValidate({
        file: options.file,
        mapId: options.mapId,
        siteId: options.siteId,
        pretty: options.pretty,
      });
    }
    // A tier-1 pass on an instance is the engine contract plus the guards.
    const instance = await readInstance(options.file);
    const bundle = await loadMap(instance.input.mapId);
    const { checkFeasibility } = await import('@simforge-oss/engine');
    const issues = checkFeasibility(instance.input, bundle.graph);
    const errors = issues.filter((i) => i.severity === 'error').length;
    emit(
      { file: options.file, tier: 1, kind: 'instance', ok: errors === 0, issues },
      options,
    );
    return errors > 0 ? EXIT.validationFindings : EXIT.ok;
  }

  // --- tier 2 --------------------------------------------------------------
  let input;
  let template;
  let arrival;
  let speedLimitKph: number | null = null;

  if (kind === 'template') {
    if (!options.mapId) {
      throw new CliError('missing_option', 'tier-2 validation of a template needs --map', {
        path: '--map',
      });
    }
    template = await readTemplate(options.file);
    const match = options.siteId
      ? await findSite(template, options.mapId, options.siteId)
      : await (async () => {
          const { matchOnMap } = await import('@simforge-oss/compiler/node');
          const m = await matchOnMap(template!, options.mapId as string);
          const site = m.report.sites[0];
          if (!site) {
            throw new CliError('no_site', `no site matched on ${options.mapId}`, {
              path: '--map',
              detail: { failureSummary: m.report.failureSummary },
              exitCode: EXIT.validationFindings,
            });
          }
          return { bundle: m.bundle, site };
        })();
    const result = materialize(template, match.bundle, match.site, {
      ...(options.draw === undefined ? {} : { drawIndex: options.draw }),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
    });
    input = result.input;
    arrival = result.manifest.arrival;
    speedLimitKph = match.bundle.index.lanes[match.site.frame.entryLaneRsl]?.speedLimitKph ?? null;
  } else {
    const instance = await readInstance(options.file);
    input = instance.input;
    arrival = instance.manifest?.arrival ?? [];
    if (options.mapId) {
      const bundle = await loadMap(options.mapId);
      speedLimitKph =
        bundle.index.lanes[instance.input.actors[0]?.initial.laneRef?.rsl ?? '']?.speedLimitKph ?? null;
    }
  }

  const bundle = await loadMap(input.mapId);
  const run = runSimulation(input, { graph: bundle.graph, guards: 'collect' });

  let residuals: InvariantResidualReport[] = [];
  if (template) {
    residuals = checkInvariants({
      template,
      trace: run.trace,
      scope: {
        params: {},
        clip: { seconds: run.trace.header.clipSeconds },
        ...(speedLimitKph === null ? {} : { lane: { speedLimitKph } }),
      },
      arrival: arrival ?? [],
      speedLimitKph,
    });
  }

  const violated = residuals.filter(
    (r) => r.status === 'violated' && r.essentiality === 'required',
  );
  const errors = run.issues.filter((i) => i.severity === 'error');
  const ok = violated.length === 0 && errors.length === 0;

  const payload = {
    file: options.file,
    tier: 2,
    kind,
    ok,
    mapId: input.mapId,
    metrics: metricsSummary(run.trace),
    invariants: residuals,
    issues: run.issues,
    triggerNeverFired: run.trace.metrics.triggerNeverFired,
    preemptions: run.trace.events.filter((e) => e.kind === 'preemption'),
  };

  if (!options.pretty) {
    emit(payload, options);
  } else {
    const lines = [
      `${options.file}: tier-2 ${ok ? 'OK' : 'FINDINGS'} on ${input.mapId}`,
      '',
      'invariants:',
      ...residuals.map(
        (r) =>
          `  ${pad(r.id, 18)}${pad(r.kind, 16)}${pad(r.status, 11)}${pad(
            r.achieved === null ? '—' : fixed(r.achieved, 3),
            10,
          )}residual ${fixed(r.residual, 3)}  ${r.reason}`,
      ),
    ];
    if (run.issues.length > 0) {
      lines.push('', 'engine issues:');
      for (const i of run.issues) lines.push(`  ${pad(i.severity, 9)}${pad(i.code, 26)}${i.reason}`);
    }
    if (run.trace.metrics.triggerNeverFired.length > 0) {
      lines.push('', `never fired: ${run.trace.metrics.triggerNeverFired.join(', ')}`);
    }
    emitLines(lines);
  }

  return ok ? EXIT.ok : EXIT.validationFindings;
}
