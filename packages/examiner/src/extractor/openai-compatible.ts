/**
 * OpenAI-compatible chat-completions adapter.
 *
 * Works with any endpoint that speaks `POST {base}/chat/completions` —
 * OpenAI, vLLM, llama.cpp server, Ollama's compat layer, a gateway. The API
 * key is read at call time from the environment variable named by
 * `apiKeyEnv`; no secret is ever baked into code, config, or logs.
 */

import type { CompletionFn } from './extract.js';
import type { ClaimSet } from '../claims.js';
import { extractClaims, type ExtractOptions } from './extract.js';

export interface OpenAiCompatibleOptions {
  /** Base URL, e.g. `http://localhost:8000/v1`. */
  readonly baseUrl: string;
  readonly model: string;
  /** Environment variable holding the bearer token; omit for keyless servers. */
  readonly apiKeyEnv?: string;
  readonly timeoutMs?: number;
}

/** Build a {@link CompletionFn} against an OpenAI-compatible endpoint. */
export function openAiCompatibleCompletion(options: OpenAiCompatibleOptions): CompletionFn {
  const apiKey = options.apiKeyEnv ? (process.env[options.apiKeyEnv] ?? '') : '';
  return async ({ messages, responseFormat }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
    try {
      const res = await fetch(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: options.model,
          messages,
          temperature: 0,
          ...(responseFormat ? { response_format: responseFormat } : {}),
        }),
      });
      if (!res.ok) {
        throw new Error(`endpoint returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const body = (await res.json()) as {
        choices?: ReadonlyArray<{ message?: { content?: string } }>;
      };
      return body.choices?.[0]?.message?.content ?? '';
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * One-shot helper: description in, validated claim set out.
 * The caller decides what to do with it — typically feed it to the grader.
 */
export function extractFromDescription(
  completion: CompletionFn,
  description: string,
  options: ExtractOptions,
): Promise<ClaimSet> {
  return extractClaims(completion, description, options);
}
