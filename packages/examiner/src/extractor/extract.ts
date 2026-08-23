/**
 * Model-agnostic extraction harness.
 *
 * `extractClaims` takes any completion callable (OpenAI-compatible, local
 * server, test mock) and returns a *validated* claims.v1 set. The callable
 * receives plain chat messages plus the JSON Schema for endpoints that support
 * structured output; the harness never assumes it was honored — every parse
 * goes through the zod boundary, and one repair round-trip feeds validation
 * errors back to the model before failing.
 */
import { claimSetSchema, type ClaimSet } from '../claims.js';
import { EXTRACTION_RESPONSE_FORMAT, EXTRACTION_SYSTEM_PROMPT, extractionUserPrompt } from './prompt.js';

/** A minimal chat-completion callable. Returns the assistant message text. */
export type CompletionFn = (request: {
  readonly messages: ReadonlyArray<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  readonly responseFormat?: unknown;
}) => Promise<string>;

export interface ExtractOptions {
  /** Scenario context block (actor ids, timing) from `scenarioContextLine`. */
  readonly scenarioContext: string;
  /** Repair round-trips on invalid output; default 1. */
  readonly maxRepairs?: number;
}

export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly attempts: number = 1,
  ) {
    super(message);
    this.name = 'ExtractionError';
  }
}

/** Pull the first JSON object out of an assistant message (fence-tolerant). */
function parseJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new SyntaxError('no JSON object in completion');
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * Parse NL description into a validated claim set using `completion`.
 * Truth judgment deliberately does not happen here — the output is only ever
 * as good as the parse; checkers own correctness.
 */
export async function extractClaims(
  completion: CompletionFn,
  description: string,
  options: ExtractOptions,
): Promise<ClaimSet> {
  const maxRepairs = options.maxRepairs ?? 1;
  const baseMessages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
    { role: 'user', content: extractionUserPrompt(description, options.scenarioContext) },
  ];
  let messages = [...baseMessages];
  let lastError = '';
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const text = await completion({ messages, responseFormat: EXTRACTION_RESPONSE_FORMAT });
    let parsed: unknown;
    try {
      parsed = parseJsonObject(text);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      messages = [
        ...messages,
        { role: 'assistant', content: text },
        { role: 'user', content: `That was not a valid JSON object (${lastError}). Reply with exactly one JSON object.` },
      ];
      continue;
    }
    const result = claimSetSchema.safeParse(parsed);
    if (result.success) return result.data;
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    lastError = issues;
    messages = [
      ...messages,
      { role: 'assistant', content: text },
      { role: 'user', content: `Schema violations: ${issues}. Fix them and reply with exactly one conforming JSON object.` },
    ];
  }
  throw new ExtractionError(`extraction failed after ${maxRepairs + 1} attempts: ${lastError}`, maxRepairs + 1);
}
