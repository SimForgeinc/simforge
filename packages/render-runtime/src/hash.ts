import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import { canonicalize, RenderIntentV1Schema, type RenderIntentV1 } from '@uniscenarios/scenario-model';


export function canonicalizeRenderIntent(intent: RenderIntentV1): string {
  return JSON.stringify(canonicalize(RenderIntentV1Schema.parse(intent)));
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
