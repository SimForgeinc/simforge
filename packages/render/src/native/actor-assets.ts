import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const PINNED_ACTOR_ASSETS_DIGEST = '18a0289bcce82ad0742b5d5d47cce5dc905397cd015fac22c509662afdf6d058';
export const DEFAULT_ACTOR_ASSETS_BASE_URL = 'https://da3tufozhdsvl.cloudfront.net';

interface ClosureMember { readonly sha256: string; readonly bytes: number }
interface ActorAssetsClosure {
  readonly schema: 'simforge.actor-assets-closure/v1';
  readonly members: Readonly<Record<string, ClosureMember>>;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function hashFile(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

function safeMemberPath(memberPath: string): string[] {
  const parts = memberPath.split('/');
  if (parts.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\\'))) {
    throw new Error(`unsafe actor asset closure path: ${memberPath}`);
  }
  return parts;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  if (url.startsWith('file://')) return fs.readFile(new URL(url));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`actor asset download failed ${response.status}: ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function downloadBlob(baseUrl: string, member: ClosureMember, destination: string): Promise<void> {
  if (existsSync(destination)) {
    const existing = await hashFile(destination);
    if (existing.bytes === member.bytes && existing.sha256 === member.sha256) return;
    await fs.rm(destination, { force: true });
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.rm(temporary, { force: true });
  if (baseUrl.startsWith('file://')) {
    const source = new URL(`blobs/sha256/${member.sha256.slice(0, 2)}/${member.sha256}`, `${baseUrl.replace(/\/?$/u, '/')}`);
    await fs.copyFile(source, temporary);
  } else {
    const url = `${baseUrl.replace(/\/$/u, '')}/blobs/sha256/${member.sha256.slice(0, 2)}/${member.sha256}`;
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`actor asset blob download failed ${response.status}: ${url}`);
    await pipeline(Readable.fromWeb(response.body as never), await fs.open(temporary, 'w').then((file) => file.createWriteStream()));
  }
  const actual = await hashFile(temporary);
  if (actual.bytes !== member.bytes || actual.sha256 !== member.sha256) {
    await fs.rm(temporary, { force: true });
    throw new Error(`actor asset blob digest mismatch: expected ${member.sha256}, got ${actual.sha256}`);
  }
  await fs.rename(temporary, destination);
}

export interface ActorAssetsOptions {
  readonly digest?: string;
  readonly baseUrl?: string;
  readonly cacheDir?: string;
}

let pending: Promise<string> | undefined;

export function ensureActorAssets(options: ActorAssetsOptions = {}): Promise<string> {
  if (pending) return pending;
  pending = materializeActorAssets(options).catch((error) => {
    pending = undefined;
    throw error;
  });
  return pending;
}

async function materializeActorAssets(options: ActorAssetsOptions): Promise<string> {
  const digest = options.digest ?? process.env.SIMFORGE_ACTOR_ASSETS_DIGEST ?? PINNED_ACTOR_ASSETS_DIGEST;
  if (!/^[0-9a-f]{64}$/u.test(digest)) throw new Error(`invalid actor asset closure digest: ${digest}`);
  const baseUrl = options.baseUrl ?? process.env.SIMFORGE_ACTOR_ASSETS_BASE_URL ?? DEFAULT_ACTOR_ASSETS_BASE_URL;
  const cacheRoot = options.cacheDir ?? process.env.SIMFORGE_ACTOR_ASSETS_CACHE_DIR ?? path.join(process.env.SIMFORGE_CACHE_DIR ?? '/tmp/simforge-cache', 'actor-assets');
  const destination = path.join(cacheRoot, digest);
  const marker = path.join(destination, '.complete');
  if (existsSync(marker) && (await fs.readFile(marker, 'utf8')).trim() === digest) return destination;

  const closureUrl = `${baseUrl.replace(/\/$/u, '')}/actor-assets/closures/${digest}.json`;
  const closureBytes = await fetchBytes(closureUrl);
  if (sha256(closureBytes) !== digest) throw new Error(`actor asset closure digest mismatch for ${closureUrl}`);
  const closure = JSON.parse(Buffer.from(closureBytes).toString('utf8')) as ActorAssetsClosure;
  if (closure.schema !== 'simforge.actor-assets-closure/v1' || !closure.members || typeof closure.members !== 'object') {
    throw new Error('unsupported actor asset closure schema');
  }

  const blobRoot = path.join(cacheRoot, 'blobs', 'sha256');
  const entries = Object.entries(closure.members).sort(([left], [right]) => left.localeCompare(right));
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
    while (cursor < entries.length) {
      const [memberPath, member] = entries[cursor++]!;
      safeMemberPath(memberPath);
      const blob = path.join(blobRoot, member.sha256.slice(0, 2), member.sha256);
      await downloadBlob(baseUrl, member, blob);
    }
  }));

  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.rm(temporary, { recursive: true, force: true });
  for (const [memberPath, member] of entries) {
    const target = path.join(temporary, ...safeMemberPath(memberPath));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.link(path.join(blobRoot, member.sha256.slice(0, 2), member.sha256), target);
  }
  await fs.writeFile(path.join(temporary, '.complete'), `${digest}\n`);
  await fs.rm(destination, { recursive: true, force: true });
  await fs.rename(temporary, destination);
  return destination;
}
