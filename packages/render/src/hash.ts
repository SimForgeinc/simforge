import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export { canonicalizeRenderIntent, hashRenderIntent } from '@simforge-oss/scenario';

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
