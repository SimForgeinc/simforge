/**
 * `simforge` — the agent CLI (layer 4 of `docs/agent-authoring-architecture.md`).
 *
 * Contract, in three lines:
 *
 * - **stdout is JSON** unless `--pretty`; stderr carries the structured error.
 * - **exit 0** ok · **1** the command could not run · **2** it ran and found
 *   something wrong with the input (schema issues, no site, infeasible cell,
 *   a rejected trace). Callers key repair loops off that distinction.
 * - **every error is `{code, path?, reason, detail?}`**, JSON, on stderr.
 */

import {
  boolFlag,
  listFlag,
  optionalInt,
  optionalNumber,
  optionalString,
  pairsFlag,
  parseArgs,
  requireString,
  type ParsedArgs,
} from './args.js';
import type { AmbientTrafficProfile } from '@simforge/engine';

import { CliError, EXIT, exitCodeOf, toStructuredError } from './errors.js';
import { emit, emitError } from './output.js';
import { availableMaps, resolveMapSelection, KNOWN_MAPS } from '@simforge/compiler/node';
import { batch } from './commands/batch.js';
import { catalogCreate, catalogVerify } from './commands/catalog.js';
import { catalogBatch } from './commands/catalog-batch.js';
import { evaluate, type EvaluateFilterMode } from './commands/evaluate.js';
import { evidenceVerify } from './commands/evidence.js';
import { exportScenario } from './commands/export.js';
import { instantiate } from './commands/instantiate.js';
import { locationsFind, locationsGet, locationsResolve } from './commands/locations.js';
import { mapsList } from './commands/maps.js';
import { schemas } from './commands/schemas.js';
import { simulate } from './commands/simulate.js';
import { debugScenario } from './commands/debug.js';
import { sitesMatch } from './commands/sites.js';
import { templateNew, templateValidate } from './commands/template.js';
import { importOpenScenario } from './commands/import.js';
import { validate } from './commands/validate.js';
import { renderHash, renderRun } from './commands/render.js';
import { corpusBuildCommand, corpusPrewarm } from './commands/corpus.js';

const COMMANDS = [
  { name: 'maps list', summary: 'the five dev maps, their artifacts and catalog revisions' },
  { name: 'locations find', summary: 'structured location query: --map --type --facts --near …' },
  { name: 'locations get', summary: 'one location by handle or id, optionally --describe' },
  { name: 'locations resolve', summary: 'free text → ranked handles' },
  { name: 'template new', summary: 'emit a minimal schema-valid v2 template skeleton (--out, --map/--site pre-bind)' },
  { name: 'template validate', summary: 'schema + tier-1, with map checks when --map is given' },
  { name: 'sites match', summary: 'anchor → ranked concrete sites on one map or --all-maps' },
  { name: 'instantiate', summary: 'template × site × draw → a concrete SimScenarioInput' },
  { name: 'simulate', summary: 'one engine pass over an instance, with an optional trace' },
  { name: 'debug', summary: 'compile a template/instance, run native or SUMO, and emit complete paths + diagnostics' },
  { name: 'validate', summary: 'tier-1, or tier-2 (one engine pass + invariant residuals)' },
  { name: 'evaluate', summary: 'reject filters over a trace' },
  { name: 'evidence verify', summary: 'prove one instance/trace pair shares the same input hash' },
  { name: 'export', summary: 'concrete instance → native XML 1.4, explicit XML 1.3 esmini compatibility, or DSL 2.2' },
  { name: 'catalog create', summary: 'reserve exactly 100 deterministic scenario identities per supported map' },
  { name: 'catalog verify', summary: 'reject catalog identity, cardinality, provenance, or evidence gaps' },
  { name: 'import', summary: 'OpenSCENARIO XML 1.4 → v2 template draft, with a lossy-feature report' },
  { name: 'catalog batch', summary: 'resumable catalog materialization + simulation with an attempt ledger' },
  { name: 'batch', summary: 'sites × draws matrix: instantiate → simulate → evaluate' },
  { name: 'render run', summary: 'execute one immutable render intent with the browser, CARLA, or native engine' },
  { name: 'render hash', summary: 'compute the canonical SHA-256 identity of a render intent' },
  { name: 'corpus build', summary: 'decode dev-assets GLB tiles into the checksummed sensor corpus (--map, or --maps a,b)' },
  { name: 'corpus prewarm', summary: 'tile subset a camera route touches (--map --route poses.json [--radius m])' },
  { name: 'schemas', summary: 'the published JSON Schemas — the LLM emission contract' },
] as const;

const GLOBAL_BOOLEANS = ['pretty', 'help'];

function usage(pretty: boolean): number {
  const payload = {
    bin: 'simforge',
    exitCodes: { 0: 'ok', 1: 'command error', 2: 'validation findings' },
    commands: COMMANDS,
    maps: availableMaps(),
  };
  if (!pretty) {
    emit(payload, { pretty: false });
  } else {
    process.stdout.write(
      [
        'simforge — SimForge agent CLI (`scen` remains an alias)',
        '',
        ...COMMANDS.map((c) => `  simforge ${c.name.padEnd(20)}${c.summary}`),
        '',
        '  --pretty   human-readable rendering of the same result',
        `  maps: ${availableMaps().join(', ')}`,
        '',
      ].join('\n'),
    );
  }
  return EXIT.ok;
}

function filterMode(args: ParsedArgs): EvaluateFilterMode {
  const raw = optionalString(args, 'filter') ?? 'critical';
  if (raw !== 'critical' && raw !== 'negative-control' && raw !== 'all') {
    throw new CliError('bad_value', '--filter must be critical | negative-control | all', {
      path: '--filter',
    });
  }
  return raw;
}

const AMBIENT_PRESETS = ['off', 'light', 'moderate', 'city', 'heavy'] as const;

/**
 * Default ambient warm-up, seconds.
 *
 * Generated traffic spawns at cruise speed, so without a settle the road is
 * populated but has visibly *just started*: nothing has closed on a leader and
 * nothing is queued at a stop line. `choreography.warmupSeconds` cannot supply
 * this because the engine integrates the whole scene from `-warmupSeconds` and
 * would advance the ego and the authored challenger with it. `--ambient-settle`
 * runs an ambient-ONLY prologue instead. 20 s is roughly two signal phases,
 * which is what a standing queue needs; `--ambient-settle 0` restores the
 * un-settled behaviour exactly.
 */
const DEFAULT_AMBIENT_SETTLE_S = 20;

/** `--ambient-settle <seconds>`; only meaningful with `--ambient`. */
function ambientSettleArg(args: ParsedArgs): number | undefined {
  const preset = optionalString(args, 'ambient');
  const settle = optionalNumber(args, 'ambient-settle');
  if (preset === undefined || preset === 'off') {
    if (settle !== undefined) {
      throw new CliError('missing_argument', `--ambient-settle requires --ambient <${AMBIENT_PRESETS.join('|')}>`, {
        path: '--ambient-settle',
      });
    }
    return undefined;
  }
  if (settle === undefined) return DEFAULT_AMBIENT_SETTLE_S;
  if (!(settle >= 0) || !Number.isFinite(settle) || settle > 300) {
    throw new CliError('bad_value', '--ambient-settle must be between 0 and 300 seconds', {
      path: '--ambient-settle',
    });
  }
  return settle;
}

/**
 * `--ambient <preset>` and its overrides.
 *
 * Returns `undefined` when `--ambient` is absent, which is what keeps the empty
 * road the default: a run that does not ask for background traffic produces
 * byte-identical artifacts to the ones it produced before this flag existed.
 * `--ambient off` is accepted and means the same thing explicitly.
 */
function ambientProfileArg(args: ParsedArgs): AmbientTrafficProfile | undefined {
  const preset = optionalString(args, 'ambient');
  const density = optionalNumber(args, 'ambient-density');
  const maxActors = optionalInt(args, 'ambient-max-actors');
  const radiusM = optionalNumber(args, 'ambient-radius-m');
  const seed = optionalString(args, 'ambient-seed');
  if (preset === undefined) {
    // An override without the flag that turns the feature on is a silent no-op,
    // and a silent no-op in a generation pipeline is a corpus of empty roads.
    for (const [flag, value] of [
      ['--ambient-density', density],
      ['--ambient-max-actors', maxActors],
      ['--ambient-radius-m', radiusM],
      ['--ambient-seed', seed],
    ] as const) {
      if (value !== undefined) {
        throw new CliError('missing_argument', `${flag} requires --ambient <${AMBIENT_PRESETS.join('|')}>`, {
          path: flag,
        });
      }
    }
    return undefined;
  }
  if (!(AMBIENT_PRESETS as readonly string[]).includes(preset)) {
    throw new CliError('bad_value', `--ambient must be ${AMBIENT_PRESETS.join(' | ')}`, { path: '--ambient' });
  }
  return {
    version: 1,
    preset: preset as AmbientTrafficProfile['preset'],
    ...(density === undefined ? {} : { densityVehiclesPerKm: density }),
    ...(maxActors === undefined ? {} : { maxActors }),
    ...(radiusM === undefined ? {} : { radiusM }),
    ...(seed === undefined ? {} : { seed }),
  };
}

function positional(args: ParsedArgs, index: number, name: string): string {
  const value = args.positionals[index];
  if (value === undefined) {
    throw new CliError('missing_argument', `<${name}> is required`, { path: name });
  }
  return value;
}

async function dispatch(argv: readonly string[]): Promise<number> {
  const head = argv[0];
  if (head === undefined || head === '--help' || head === 'help') {
    return usage(argv.includes('--pretty'));
  }

  const sub = argv[1];

  switch (head) {
    case 'maps': {
      const args = parseArgs(argv.slice(2), { booleans: GLOBAL_BOOLEANS });
      if (sub !== 'list') {
        throw new CliError('unknown_command', `simforge maps ${sub ?? ''}`.trim(), {
          detail: { known: ['list'] },
        });
      }
      return mapsList({ pretty: boolFlag(args, 'pretty') });
    }

    case 'locations': {
      if (sub === 'find') {
        const args = parseArgs(argv.slice(2), {
          booleans: GLOBAL_BOOLEANS,
          values: [
            'map',
            'type',
            'subtype',
            'tags',
            'affordances',
            'facts',
            'near',
            'within-m',
            'limit',
            'diversity-m',
          ],
        });
        return locationsFind({
          mapId: requireString(args, 'map'),
          type: listFlag(args, 'type'),
          subtype: listFlag(args, 'subtype'),
          tags: listFlag(args, 'tags'),
          affordances: listFlag(args, 'affordances'),
          facts: pairsFlag(args, 'facts'),
          near: optionalString(args, 'near'),
          withinM: optionalNumber(args, 'within-m'),
          limit: optionalInt(args, 'limit'),
          diversityM: optionalNumber(args, 'diversity-m'),
          pretty: boolFlag(args, 'pretty'),
        });
      }
      if (sub === 'get') {
        const args = parseArgs(argv.slice(2), {
          booleans: [...GLOBAL_BOOLEANS, 'describe'],
          values: ['map'],
        });
        return locationsGet({
          mapId: requireString(args, 'map'),
          ref: positional(args, 0, 'handleOrId'),
          describe: boolFlag(args, 'describe'),
          pretty: boolFlag(args, 'pretty'),
        });
      }
      if (sub === 'resolve') {
        const args = parseArgs(argv.slice(2), {
          booleans: GLOBAL_BOOLEANS,
          values: ['map', 'limit'],
        });
        return locationsResolve({
          mapId: requireString(args, 'map'),
          text: args.positionals.join(' '),
          limit: optionalInt(args, 'limit'),
          pretty: boolFlag(args, 'pretty'),
        });
      }
      throw new CliError('unknown_command', `simforge locations ${sub ?? ''}`.trim(), {
        detail: { known: ['find', 'get', 'resolve'] },
      });
    }

    case 'template': {
      if (sub === 'new') {
        const args = parseArgs(argv.slice(2), {
          booleans: GLOBAL_BOOLEANS,
          values: ['out', 'map', 'site'],
        });
        return templateNew({
          out: optionalString(args, 'out'),
          mapId: optionalString(args, 'map'),
          siteId: optionalString(args, 'site'),
          pretty: boolFlag(args, 'pretty'),
        });
      }
      if (sub !== 'validate') {
        throw new CliError('unknown_command', `simforge template ${sub ?? ''}`.trim(), {
          detail: { known: ['new', 'validate'] },
        });
      }
      const args = parseArgs(argv.slice(2), {
        booleans: GLOBAL_BOOLEANS,
        values: ['map', 'site'],
      });
      return templateValidate({
        file: positional(args, 0, 'file'),
        mapId: optionalString(args, 'map'),
        siteId: optionalString(args, 'site'),
        pretty: boolFlag(args, 'pretty'),
      });
    }

    case 'import': {
      const args = parseArgs(argv.slice(1), {
        booleans: GLOBAL_BOOLEANS,
        values: ['out', 'map'],
      });
      return importOpenScenario({
        file: positional(args, 0, 'file.xosc'),
        out: optionalString(args, 'out'),
        mapId: optionalString(args, 'map'),
        pretty: boolFlag(args, 'pretty'),
      });
    }

    case 'sites': {
      if (sub !== 'match') {
        throw new CliError('unknown_command', `simforge sites ${sub ?? ''}`.trim(), {
          detail: { known: ['match'] },
        });
      }
      const args = parseArgs(argv.slice(2), {
        booleans: [...GLOBAL_BOOLEANS, 'all-maps', 'rejected'],
        values: ['map', 'maps', 'min-score', 'max-sites'],
      });
      return sitesMatch({
        file: positional(args, 0, 'template.json'),
        mapIds: resolveMapSelection({
          map: optionalString(args, 'map'),
          maps: listFlag(args, 'maps'),
          allMaps: boolFlag(args, 'all-maps'),
        }),
        minScore: optionalNumber(args, 'min-score'),
        maxSites: optionalInt(args, 'max-sites'),
        includeRejected: boolFlag(args, 'rejected'),
        pretty: boolFlag(args, 'pretty'),
      });
    }

    case 'instantiate': {
      const args = parseArgs(argv.slice(1), {
        booleans: GLOBAL_BOOLEANS,
        values: ['map', 'site', 'seed', 'draw', 'out'],
      });
      return instantiate({
        file: positional(args, 0, 'template.json'),
        mapId: requireString(args, 'map'),
        siteId: requireString(args, 'site'),
        seed: optionalString(args, 'seed'),
        draw: optionalInt(args, 'draw'),
        out: optionalString(args, 'out'),
        pretty: boolFlag(args, 'pretty'),
      });
    }

    case 'simulate': {
      const args = parseArgs(argv.slice(1), {
        booleans: GLOBAL_BOOLEANS,
        values: ['trace'],
      });
      return simulate({
        file: positional(args, 0, 'instance.json'),
        trace: optionalString(args, 'trace'),
        pretty: boolFlag(args, 'pretty'),
      });
    }

    case 'debug': {
      const args = parseArgs(argv.slice(1), {
        booleans: [...GLOBAL_BOOLEANS, 'fail-on-collision', 'fail-on-road-departure', 'fail-on-fallback', 'fail-on-never-fired'],
        values: ['map', 'site', 'draw', 'seed', 'provider', 'duration', 'sample', 'ambient-count', 'out', 'compare', 'position-tolerance-m', 'speed-tolerance-mps'],
      });
      const provider = optionalString(args, 'provider') ?? 'native';
      if (provider !== 'native' && provider !== 'sumo') {
        throw new CliError('bad_value', '--provider must be native | sumo', { path: '--provider' });
      }
      return debugScenario({
        file: positional(args, 0, 'scenario.json'),
        mapId: optionalString(args, 'map'),
        siteId: optionalString(args, 'site'),
        draw: optionalInt(args, 'draw'),
        seed: optionalString(args, 'seed'),
        provider,
        durationSeconds: optionalNumber(args, 'duration'),
        sampleSeconds: optionalNumber(args, 'sample'),
        ambientCount: optionalInt(args, 'ambient-count'),
        out: optionalString(args, 'out'),
        compare: optionalString(args, 'compare'),
        positionToleranceM: optionalNumber(args, 'position-tolerance-m'),
        speedToleranceMps: optionalNumber(args, 'speed-tolerance-mps'),
        failOnCollision: boolFlag(args, 'fail-on-collision'),
        failOnRoadDeparture: boolFlag(args, 'fail-on-road-departure'),
        failOnFallback: boolFlag(args, 'fail-on-fallback'),
        failOnNeverFired: boolFlag(args, 'fail-on-never-fired'),
        pretty: boolFlag(args, 'pretty'),
      });
    }

    case 'validate': {
      const args = parseArgs(argv.slice(1), {
        booleans: GLOBAL_BOOLEANS,
        values: ['tier', 'map', 'site', 'draw', 'seed'],
      });
      const tier = optionalInt(args, 'tier') ?? 1;
      if (tier !== 1 && tier !== 2) {
        throw new CliError('bad_value', '--tier must be 1 or 2', { path: '--tier' });
      }
      return validate({
        file: positional(args, 0, 'instance|template'),
        tier,
        mapId: optionalString(args, 'map'),
        siteId: optionalString(args, 'site'),
        draw: optionalInt(args, 'draw'),
        seed: optionalString(args, 'seed'),
        pretty: boolFlag(args, 'pretty'),
      });
    }

    case 'evaluate': {
      const args = parseArgs(argv.slice(1), {
        booleans: [...GLOBAL_BOOLEANS, 'reject-collisions'],
        values: ['filter', 'trivial-ttc', 'rubric', 'blind-review-out'],
      });
      return evaluate({
        file: positional(args, 0, 'trace'),
        filter: filterMode(args),
        trivialTtcS: optionalNumber(args, 'trivial-ttc'),
        rejectCollisions: boolFlag(args, 'reject-collisions'),
        rubric: optionalString(args, 'rubric'),
        blindReviewOut: optionalString(args, 'blind-review-out'),
        pretty: boolFlag(args, 'pretty'),
      });
    }

    case 'export': {
      const args = parseArgs(argv.slice(1), {
        booleans: GLOBAL_BOOLEANS,
        values: ['format', 'out', 'road-file', 'author', 'description', 'route-sample-m'],
      });
      const format = requireString(args, 'format');
      if (format !== 'xosc-1.4' && format !== 'xosc-1.3-esmini' && format !== 'osc-2.2') {
        throw new CliError('bad_value', '--format must be xosc-1.4 | xosc-1.3-esmini | osc-2.2', {
          path: '--format',
          detail: { known: ['xosc-1.4', 'xosc-1.3-esmini', 'osc-2.2'] },
        });
      }
      return exportScenario({
        file: positional(args, 0, 'instance.json'),
        format,
        out: requireString(args, 'out'),
        roadFile: optionalString(args, 'road-file'),
        author: optionalString(args, 'author'),
        description: optionalString(args, 'description'),
        routeSampleM: optionalNumber(args, 'route-sample-m'),
        pretty: boolFlag(args, 'pretty'),
      });
    }

    case 'evidence': {
      if (sub !== 'verify') {
        throw new CliError('unknown_command', `simforge evidence ${sub ?? ''}`.trim(), {
          detail: { known: ['verify'] },
        });
      }
      const args = parseArgs(argv.slice(2), { booleans: GLOBAL_BOOLEANS });
      return evidenceVerify({
        instance: positional(args, 0, 'instance.json'),
        trace: positional(args, 1, 'trace.json.gz'),
        pretty: boolFlag(args, 'pretty'),
      });
    }

    case 'catalog': {
      if (sub === 'create') {
        const args = parseArgs(argv.slice(2), {
          booleans: GLOBAL_BOOLEANS,
          values: ['out', 'namespace', 'evidence-root'],
        });
        return catalogCreate({
          out: requireString(args, 'out'),
          namespace: optionalString(args, 'namespace'),
          evidenceRoot: optionalString(args, 'evidence-root'),
          pretty: boolFlag(args, 'pretty'),
        });
      }
      if (sub === 'verify') {
        const args = parseArgs(argv.slice(2), {
          booleans: [...GLOBAL_BOOLEANS, 'require-evidence'],
          values: ['evidence-root'],
        });
        return catalogVerify({
          file: positional(args, 0, 'catalog.json'),
          evidenceRoot: optionalString(args, 'evidence-root'),
          requireEvidence: boolFlag(args, 'require-evidence'),
          pretty: boolFlag(args, 'pretty'),
        });
      }
      if (sub === 'batch') {
        const args = parseArgs(argv.slice(2), {
          booleans: [...GLOBAL_BOOLEANS, 'force', 'allow-collisions'],
          values: ['ledger', 'slots', 'map', 'maps', 'mechanisms', 'attempts', 'concurrency', 'filter', 'trivial-ttc'],
        });
        const map = optionalString(args, 'map');
        return catalogBatch({
          file: positional(args, 0, 'catalog.json'),
          ledger: optionalString(args, 'ledger'),
          slotIds: listFlag(args, 'slots'),
          mapIds: map ? [map] : listFlag(args, 'maps'),
          mechanismIds: listFlag(args, 'mechanisms'),
          maxAttempts: optionalInt(args, 'attempts') ?? 3,
          concurrency: optionalInt(args, 'concurrency'),
          force: boolFlag(args, 'force'),
          filter: filterMode(args),
          trivialTtcS: optionalNumber(args, 'trivial-ttc'),
          collisionPolicy: boolFlag(args, 'allow-collisions') ? 'allow' : 'reject',
          pretty: boolFlag(args, 'pretty'),
        });
      }
      throw new CliError('unknown_command', `simforge catalog ${sub ?? ''}`.trim(), {
        detail: { known: ['create', 'verify', 'batch'] },
      });
    }

    case 'batch': {
      const args = parseArgs(argv.slice(1), {
        booleans: [...GLOBAL_BOOLEANS, 'all-maps', 'force', 'no-trace'],
        values: [
          'map',
          'maps',
          'draws',
          'out',
          'min-score',
          'max-sites',
          'concurrency',
          'filter',
          'trivial-ttc',
          'ambient',
          'ambient-density',
          'ambient-max-actors',
          'ambient-radius-m',
          'ambient-seed',
          'ambient-settle',
        ],
      });
      return batch({
        file: positional(args, 0, 'template.json'),
        mapIds: resolveMapSelection({
          map: optionalString(args, 'map'),
          maps: listFlag(args, 'maps'),
          allMaps: boolFlag(args, 'all-maps'),
        }),
        draws: optionalInt(args, 'draws') ?? 1,
        outDir: requireString(args, 'out'),
        minScore: optionalNumber(args, 'min-score'),
        maxSites: optionalInt(args, 'max-sites'),
        concurrency: optionalInt(args, 'concurrency'),
        writeTrace: !boolFlag(args, 'no-trace'),
        filter: filterMode(args),
        trivialTtcS: optionalNumber(args, 'trivial-ttc'),
        force: boolFlag(args, 'force'),
        ...(ambientProfileArg(args) === undefined ? {} : { ambient: ambientProfileArg(args) }),
        ...(ambientSettleArg(args) === undefined ? {} : { ambientSettleSeconds: ambientSettleArg(args) }),
        pretty: boolFlag(args, 'pretty'),
      });
    }

    case 'render': {
      if (sub === 'hash') {
        const args = parseArgs(argv.slice(2), { booleans: GLOBAL_BOOLEANS });
        return renderHash(positional(args, 0, 'render-intent.json'), boolFlag(args, 'pretty'));
      }
      if (sub === 'run') {
        const args = parseArgs(argv.slice(2), {
          booleans: GLOBAL_BOOLEANS,
          values: ['engine', 'out', 'inputs', 'engine-options'],
        });
        const engine = requireString(args, 'engine');
        if (engine !== 'browser' && engine !== 'carla' && engine !== 'native') {
          throw new CliError('bad_value', '--engine must be browser | carla | native', { path: '--engine' });
        }
        return renderRun({
          intentPath: positional(args, 0, 'render-intent.json'),
          engine,
          outDir: requireString(args, 'out'),
          inputsPath: requireString(args, 'inputs'),
          engineOptionsPath: optionalString(args, 'engine-options'),
          pretty: boolFlag(args, 'pretty'),
        });
      }
      throw new CliError('unknown_command', `simforge render ${sub ?? ''}`.trim(), {
        detail: { known: ['run', 'hash'] },
      });
    }

    case 'corpus': {
      if (sub === 'build') {
        const args = parseArgs(argv.slice(2), {
          booleans: [...GLOBAL_BOOLEANS, 'force', 'quiet'],
          values: ['map', 'maps', 'out-root', 'source-root'],
        });
        const mapFlag = optionalString(args, 'map');
        const mapsFlag = listFlag(args, 'maps');
        if ((mapFlag === undefined) === (mapsFlag === undefined)) {
          throw new CliError('missing_option', 'corpus build needs exactly one of --map <id> or --maps a,b,c', {
            path: '--map',
          });
        }
        const maps = mapFlag !== undefined ? [mapFlag] : (mapsFlag ?? []);
        for (const mapId of maps) {
          if (!(KNOWN_MAPS as readonly string[]).includes(mapId)) {
            throw new CliError('bad_value', `unknown map "${mapId}"`, { path: '--map' });
          }
        }
        return corpusBuildCommand({
          maps,
          outRoot: optionalString(args, 'out-root'),
          sourceRoot: optionalString(args, 'source-root'),
          force: boolFlag(args, 'force'),
          quiet: boolFlag(args, 'quiet'),
          pretty: boolFlag(args, 'pretty'),
        });
      }
      if (sub === 'prewarm') {
        const args = parseArgs(argv.slice(2), {
          booleans: GLOBAL_BOOLEANS,
          values: ['map', 'route', 'radius', 'manifest'],
        });
        return corpusPrewarm({
          mapId: requireString(args, 'map'),
          routePath: requireString(args, 'route'),
          radius: optionalNumber(args, 'radius') ?? 0,
          manifestPath: optionalString(args, 'manifest'),
          pretty: boolFlag(args, 'pretty'),
        });
      }
      throw new CliError('unknown_command', `simforge corpus ${sub ?? ''}`.trim(), {
        detail: { known: ['build', 'prewarm'] },
      });
    }


    case 'schemas': {
      const args = parseArgs(argv.slice(1), {
        booleans: [...GLOBAL_BOOLEANS, 'content'],
        values: ['name'],
      });
      return schemas({
        name: optionalString(args, 'name'),
        content: boolFlag(args, 'content'),
        pretty: boolFlag(args, 'pretty'),
      });
    }

    default:
      throw new CliError('unknown_command', `no command "${head}"`, {
        detail: { known: COMMANDS.map((c) => c.name) },
      });
  }
}

export async function run(argv: readonly string[]): Promise<number> {
  try {
    return await dispatch(argv);
  } catch (error) {
    emitError(toStructuredError(error));
    return exitCodeOf(error);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('main.ts') ||
    process.argv[1].endsWith('simforge.js') ||
    process.argv[1].endsWith('sf.js'));

if (invokedDirectly) {
  process.exitCode = await run(process.argv.slice(2));
}
