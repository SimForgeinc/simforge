import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import { RenderIntentV1Schema, type RenderIntentV1 } from '@simforge/scenario';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON cannot contain non-finite numbers');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new TypeError(`canonical JSON cannot contain ${typeof value}`);
}

export function canonicalizeRenderIntent(intent: RenderIntentV1): string {
  return canonicalJson(RenderIntentV1Schema.parse(intent));
}

export function hashRenderIntent(intent: RenderIntentV1): string {
  return createHash('sha256').update(canonicalizeRenderIntent(intent), 'utf8').digest('hex');
}

export async function hashFile(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer;
    sizeBytes += bytes.length;
    hash.update(bytes);
  }
  return { sha256: hash.digest('hex'), sizeBytes };
}
