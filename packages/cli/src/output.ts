/**
 * Output discipline.
 *
 * **stdout is the result, stderr is everything else.** A caller may pipe stdout
 * straight into `jq` or into another `simforge` command, so a warning, a progress
 * line or a structured error never lands there.
 *
 * `--pretty` is for humans and is a *rendering* of the same object, never a
 * different object: anything the pretty form shows, the JSON form carries.
 */

export interface EmitOptions {
  readonly pretty: boolean;
}

export function emit(value: unknown, options: EmitOptions): void {
  process.stdout.write(`${JSON.stringify(value, null, options.pretty ? 2 : 0)}\n`);
}

export function emitError(value: unknown): void {
  process.stderr.write(`${JSON.stringify(value)}\n`);
}

/** Human-readable lines, for `--pretty`. Always stderr-free of data. */
export function emitLines(lines: readonly string[]): void {
  process.stdout.write(`${lines.join('\n')}\n`);
}

export function fixed(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : value.toFixed(digits);
}

/** Left-aligned fixed-width column padding for the pretty tables. */
export function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

export function padLeft(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value;
}
