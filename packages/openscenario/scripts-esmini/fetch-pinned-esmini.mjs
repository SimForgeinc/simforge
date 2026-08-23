#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const pins = {
  linux: ['https://github.com/esmini/esmini/releases/download/v3.6.0/esmini-bin_Linux.zip', '2f45358d21d0dc061692edd97cf9ad6b30d8721e7c0bcc791cff1e1911aaed87'],
  darwin: ['https://github.com/esmini/esmini/releases/download/v3.6.0/esmini-bin_macOS.zip', '49e157478b5839216a314fe21167cf8d13ccb3740b24432b71a62623e0cbaf3b'],
};
const pin = pins[process.platform];
if (!pin) throw new Error(`No pinned esmini 3.6.0 archive for ${process.platform}`);
const destination = join(root, '.tools', 'esmini', '3.6.0');
const archive = join(destination, 'esmini.zip.partial');
await mkdir(destination, { recursive: true });
const response = await fetch(pin[0], { redirect: 'follow' });
if (!response.ok) throw new Error(`Download failed: ${response.status}`);
const bytes = new Uint8Array(await response.arrayBuffer());
const digest = createHash('sha256').update(bytes).digest('hex');
if (digest !== pin[1]) throw new Error(`Digest mismatch: expected ${pin[1]}, got ${digest}`);
await writeFile(archive, bytes, { mode: 0o600 });
const extracted = join(destination, 'payload.partial');
await mkdir(extracted, { recursive: true });
const unzip = spawnSync('unzip', ['-q', archive, '-d', extracted], { stdio: 'inherit' });
if (unzip.status !== 0) throw new Error('unzip failed');
await rename(extracted, join(destination, 'payload'));
await writeFile(join(destination, 'INSTALLATION.json'), `${JSON.stringify({ version: '3.6.0', sourceRevision: '131a5651737fd1e8bd5d800d8e77e89bb3178a1e', archiveSha256: digest, source: pin[0], license: 'MPL-2.0' }, null, 2)}\n`);
await chmod(join(destination, 'payload'), 0o755);
console.log(`Verified esmini 3.6.0 in ${join(destination, 'payload')}`);
