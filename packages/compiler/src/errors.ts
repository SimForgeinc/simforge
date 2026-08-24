/**
 * The shared materializer and CLI error shape.
 *
 * Every failure this process can produce leaves through `{code, path?, reason}`
 * on stderr as JSON, because the primary caller is an unattended repair loop
 * and a prose stack trace is not repairable. `detail` carries whatever closed
 * vocabulary or measured value would let the caller fix the input without
 * guessing.
 */

/** Exit codes. `2` is reserved for *findings* — the input parsed but is wrong. */
export const EXIT = {
  ok: 0,
  commandError: 1,
  validationFindings: 2,
} as const;

export interface StructuredError {
  readonly code: string;
  readonly path?: string;
  readonly reason: string;
  readonly detail?: Record<string, unknown>;
}

export class CliError extends Error {
  override readonly name = 'CliError';
  readonly code: string;
  readonly path: string | undefined;
  readonly reason: string;
  readonly detail: Record<string, unknown> | undefined;
  /** Exit code this error should produce. */
  readonly exitCode: number;

  constructor(
    code: string,
    reason: string,
    options: { path?: string; detail?: Record<string, unknown>; exitCode?: number } = {},
  ) {
    super(`${code}${options.path ? ` at ${options.path}` : ''}: ${reason}`);
    this.code = code;
    this.path = options.path;
    this.reason = reason;
    this.detail = options.detail;
    this.exitCode = options.exitCode ?? EXIT.commandError;
  }

  toJSON(): StructuredError {
    return {
      code: this.code,
      ...(this.path === undefined ? {} : { path: this.path }),
      reason: this.reason,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
    };
  }
}

/** Coerce anything thrown into the structured shape. */
export function toStructuredError(error: unknown): StructuredError {
  if (error instanceof CliError) return error.toJSON();
  if (error && typeof error === 'object' && 'code' in error && 'reason' in error) {
    const e = error as { code: unknown; reason: unknown; path?: unknown };
    return {
      code: String(e.code),
      ...(typeof e.path === 'string' ? { path: e.path } : {}),
      reason: String(e.reason),
    };
  }
  if (error instanceof Error) {
    return { code: 'internal_error', reason: `${error.name}: ${error.message}` };
  }
  return { code: 'internal_error', reason: String(error) };
}

/** Exit code an arbitrary throw should produce. */
export function exitCodeOf(error: unknown): number {
  return error instanceof CliError ? error.exitCode : EXIT.commandError;
}
