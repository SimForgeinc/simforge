import { chown, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { RenderWorkerConfig } from './config.js';

export interface ContainerIdentity {
  readonly uid: number;
  readonly gid: number;
}

export function configuredContainerIdentity(config: RenderWorkerConfig): ContainerIdentity | undefined {
  const uid = config.engine.options.containerUid;
  if (uid === undefined) return undefined;
  const gid = config.engine.options.containerGid ?? uid;
  if (!Number.isSafeInteger(uid) || (uid as number) < 0) {
    throw new Error('engine.options.containerUid must be a non-negative integer');
  }
  if (!Number.isSafeInteger(gid) || (gid as number) < 0) {
    throw new Error('engine.options.containerGid must be a non-negative integer');
  }
  return { uid: uid as number, gid: gid as number };
}

export async function chownWorkspace(path: string, identity: ContainerIdentity): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await chownWorkspace(child, identity);
    else await chown(child, identity.uid, identity.gid);
  }));
  await chown(path, identity.uid, identity.gid);
}
