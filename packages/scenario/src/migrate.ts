/**
 * Version dispatch for `.scenario.json`.
 *
 * v1 is the baseline, so {@link SCENARIO_MIGRATIONS} ships empty — the point of
 * this module is that adding v2 is mechanical:
 *
 * ```ts
 * export const SCENARIO_MIGRATIONS: ScenarioMigration[] = [
 *   {
 *     from: 1,
 *     to: 2,
 *     description: 'promote laneRef to authoritative',
 *     up: (raw) => ({ ...raw, scenarioVersion: 2, ... }),
 *   },
 * ];
 * ```
 *
 * plus a `schema/v2.ts` and a fixture test. Migrations are pure
 * `Record<string, unknown> -> Record<string, unknown>` functions over raw JSON,
 * deliberately *not* typed against the zod schemas: a migration has to be able
 * to read shapes that no current schema describes, and freezing an old schema
 * in the codebase forever just to type its migration is a tax with no payer.
 * Correctness comes from the final validation pass and from per-step tests.
 */

import { ScenarioMigrationError } from './errors.js';
import { SCENARIO_VERSION, type ScenarioV1 } from './schema/v1.js';
import { parseScenario } from './serialize.js';

/** The version this build reads and writes. */
export const CURRENT_SCENARIO_VERSION = SCENARIO_VERSION;

/** One version step. `up` must return a document whose `scenarioVersion` is `to`. */
export interface ScenarioMigration {
  /** Version this step consumes. */
  from: number;
  /** Version this step produces. Conventionally `from + 1`. */
  to: number;
  /** One line, shown in {@link MigrateResult.applied} and in error messages. */
  description: string;
  up(raw: Record<string, unknown>): Record<string, unknown>;
}

/** Ordered migration chain. Empty at v1. */
export const SCENARIO_MIGRATIONS: ScenarioMigration[] = [];

/** Outcome of {@link migrate}. */
export interface MigrateResult {
  /** The validated, current-version document. */
  doc: ScenarioV1;
  /** True when at least one migration step ran. */
  migrated: boolean;
  /** The `scenarioVersion` found in the input. */
  fromVersion: number;
  /** Descriptions of the steps that ran, in order. */
  applied: string[];
}

/** Options for {@link runMigrations}. Exposed so each step can be tested in isolation. */
export interface RunMigrationsOptions {
  /** Chain to search. Defaults to {@link SCENARIO_MIGRATIONS}. */
  migrations?: ScenarioMigration[];
  /** Version to migrate up to. Defaults to {@link CURRENT_SCENARIO_VERSION}. */
  targetVersion?: number;
  /**
   * Validator for the final document. Defaults to the v1 parser. Tests for a
   * synthetic chain pass their own, so migration dispatch can be exercised
   * without inventing a real future schema.
   */
  validate?: (json: unknown) => ScenarioV1;
}

function readVersion(json: unknown): number {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new ScenarioMigrationError('not a scenario document: expected a JSON object');
  }
  const raw = (json as Record<string, unknown>).scenarioVersion;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new ScenarioMigrationError(
      `not a scenario document: scenarioVersion must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/**
 * Drive a migration chain over raw JSON.
 *
 * @throws {ScenarioMigrationError} If the input has no usable version, is newer
 *   than the target, or the chain has a gap.
 * @throws {ScenarioValidationError} If the migrated document fails validation.
 */
export function runMigrations(json: unknown, options: RunMigrationsOptions = {}): MigrateResult {
  const migrations = options.migrations ?? SCENARIO_MIGRATIONS;
  const target = options.targetVersion ?? CURRENT_SCENARIO_VERSION;
  const validate = options.validate ?? parseScenario;

  const fromVersion = readVersion(json);
  if (fromVersion > target) {
    throw new ScenarioMigrationError(
      `scenario was written by a newer version of the app (file schema v${fromVersion}, this build reads v${target}). Upgrade UniScenarios to open it.`,
      fromVersion,
    );
  }

  let current = json as Record<string, unknown>;
  let version = fromVersion;
  const applied: string[] = [];
  const guard = migrations.length + 1;

  while (version < target) {
    const step = migrations.find((m) => m.from === version);
    if (!step) {
      throw new ScenarioMigrationError(
        `no migration from schema v${version} to v${target}`,
        fromVersion,
      );
    }
    current = step.up(current);
    const produced = current?.scenarioVersion;
    if (produced !== step.to) {
      throw new ScenarioMigrationError(
        `migration "${step.description}" was supposed to produce v${step.to} but produced ${JSON.stringify(produced)}`,
        fromVersion,
      );
    }
    applied.push(step.description);
    version = step.to;
    if (applied.length > guard) {
      throw new ScenarioMigrationError('migration chain does not terminate', fromVersion);
    }
  }

  return { doc: validate(current), migrated: applied.length > 0, fromVersion, applied };
}

/**
 * Bring a parsed `.scenario.json` up to the current schema version and validate it.
 *
 * @param json The result of `JSON.parse` on a scenario file.
 *
 * @example
 * ```ts
 * const { doc, migrated } = migrate(JSON.parse(text));
 * if (migrated) markDirty(); // the file on disk is stale
 * ```
 */
export function migrate(json: unknown): MigrateResult {
  return runMigrations(json);
}

/**
 * Parse `.scenario.json` text, migrating older versions forward.
 *
 * @throws {SyntaxError} If the text is not JSON.
 * @throws {ScenarioMigrationError} If the version cannot be reached.
 * @throws {ScenarioValidationError} If the migrated document is invalid.
 */
export function deserializeScenario(text: string): ScenarioV1 {
  return migrate(JSON.parse(text)).doc;
}
