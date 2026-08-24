#!/usr/bin/env node
// SimForge local asset fetcher.
//
// Manifest-driven, idempotent, digest-verified. Assets live OUTSIDE git and
// OUTSIDE container images, under the asset root (default ~/simforge-assets,
// override with SIMFORGE_ASSETS). See docs/ops/local-assets.md.
//
// Usage:
//   node scripts/assets/fetch.mjs status            # honest per-asset report
//   node scripts/assets/fetch.mjs fetch [id ...]    # fetch missing/mismatched (all when no ids)
//   node scripts/assets/fetch.mjs verify            # full digest re-verification
//
// Exit codes: 0 ok / everything present; 1 fetch or verify failure; 2 usage.

import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, 'manifest.json');

function assetRoot() {
  const raw = process.env.SIMFORGE_ASSETS || '~/simforge-assets';
  return resolve(raw.replace(/^~(?=$|\/)/, homedir()));
}

async function loadManifest() {
  return JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
}

function sha256File(path) {
  return new Promise((resolvep, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolvep(hash.digest('hex')));
  });
}

function run(cmd, args, opts = {}) {
  return new Promise((resolvep) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (err += d));
    child.on('error', (e) => resolvep({ code: -1, out, err: String(e) }));
    child.on('close', (code) => resolvep({ code, out, err }));
  });
}

async function tcpProbe(host, port, timeoutMs = 1500) {
  const { Socket } = await import('node:net');
  return new Promise((resolvep) => {
    const sock = new Socket();
    const done = (ok) => {
      sock.destroy();
      resolvep(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, host, () => done(true));
  });
}

// ---------------------------------------------------------------------------
// Per-kind status probes. Each returns { state, detail } and NEVER lies:
// unknown provenance is reported as such, not as "ok".
// ---------------------------------------------------------------------------

async function statusHfRepo(asset, root) {
  const cache = join(root, asset.dest);
  const repoDir = join(cache, 'hub', `models--${asset.repo.replaceAll('/', '--')}`);
  const snapshot = join(repoDir, 'snapshots', asset.revision);
  if (!existsSync(snapshot)) {
    return { state: 'missing', detail: `no snapshot ${asset.revision.slice(0, 12)} under ${repoDir}` };
  }
  // Dangling symlinks in the snapshot mean partially-downloaded blobs.
  const { code, out } = await run('find', [snapshot, '-xtype', 'l']);
  const dangling = code === 0 ? out.trim().split('\n').filter(Boolean) : [];
  if (dangling.length > 0) {
    return { state: 'partial', detail: `${dangling.length} blob(s) not downloaded` };
  }
  const du = await run('du', ['-sb', repoDir]);
  const bytes = Number(du.out.split('\t')[0] || 0);
  return { state: 'ok', detail: `snapshot ${asset.revision.slice(0, 12)} complete, ${(bytes / 1e9).toFixed(1)} GB` };
}

async function statusDockerImage(asset) {
  const inspect = await run('docker', ['image', 'inspect', asset.ref, '--format', '{{.Id}}']);
  if (inspect.code !== 0) {
    return { state: 'absent', detail: `user-provided image not present locally (${asset.ref}); users run their own CARLA container` };
  }
  const id = inspect.out.trim();
  const idNote = asset.imageId && asset.imageId !== id ? ` (image id differs from manifest pin ${asset.imageId.slice(7, 19)})` : '';
  const host = process.env.SIMFORGE_CARLA_HOST || 'localhost';
  const port = Number(process.env.SIMFORGE_CARLA_PORT || 2000);
  const up = await tcpProbe(host, port);
  return {
    state: 'ok',
    detail: `present ${id.slice(7, 19)}${idNote}; server ${up ? 'ANSWERING' : 'not answering'} on ${host}:${port}`,
  };
}

async function statusFile(asset, root, { verifyDigest = false } = {}) {
  const dest = join(root, asset.dest);
  if (asset.dest.endsWith('/')) {
    // Directory placeholder (per-file digests pending).
    if (!existsSync(dest)) return { state: 'pending', detail: 'not yet produced (no digest recorded, directory absent)' };
    const { out } = await run('find', [dest, '-type', 'f']);
    const n = out.trim().split('\n').filter(Boolean).length;
    return { state: 'pending', detail: `${n} file(s) present, per-file digests not yet recorded in manifest` };
  }
  if (!existsSync(dest)) {
    const why = asset.url ? '' : ' — no source URL published yet';
    return { state: 'missing', detail: `absent${why}` };
  }
  const st = await stat(dest);
  if (asset.bytes != null && st.size !== asset.bytes) {
    return { state: 'mismatch', detail: `size ${st.size} != manifest ${asset.bytes}` };
  }
  if (verifyDigest && asset.sha256) {
    const digest = await sha256File(dest);
    if (digest !== asset.sha256) return { state: 'mismatch', detail: `sha256 ${digest.slice(0, 12)}… != manifest` };
    return { state: 'ok', detail: 'sha256 verified' };
  }
  return { state: 'ok', detail: `present, ${st.size} bytes${asset.sha256 ? ' (size match; run verify for digest check)' : ''}` };
}

// ---------------------------------------------------------------------------
// Fetchers. Idempotent: anything already ok is skipped.
// ---------------------------------------------------------------------------

async function fetchHfRepo(asset, root) {
  const before = await statusHfRepo(asset, root);
  if (before.state === 'ok') return { skipped: true, detail: before.detail };
  const cache = join(root, asset.dest);
  await mkdir(cache, { recursive: true });
  const env = { ...process.env, HF_HOME: cache };
  // Prefer the modern `hf` CLI, fall back to huggingface-cli.
  for (const cli of [['hf', ['download', asset.repo, '--revision', asset.revision]],
                     ['huggingface-cli', ['download', asset.repo, '--revision', asset.revision]]]) {
    const probe = await run(cli[0], ['--help']);
    if (probe.code !== 0) continue;
    const res = await run(cli[0], cli[1], { env, stdio: ['ignore', 'inherit', 'inherit'] });
    if (res.code === 0) {
      const after = await statusHfRepo(asset, root);
      if (after.state !== 'ok') throw new Error(`post-fetch verification failed: ${after.detail}`);
      return { skipped: false, detail: after.detail };
    }
    throw new Error(`${cli[0]} download failed: ${res.err.slice(-400)}`);
  }
  throw new Error('no huggingface CLI found (pip install -U huggingface_hub)');
}

async function fetchFile(asset, root) {
  const before = await statusFile(asset, root, { verifyDigest: true });
  if (before.state === 'ok') return { skipped: true, detail: before.detail };
  if (before.state === 'pending') return { skipped: true, detail: before.detail };
  if (!asset.url) throw new Error('no source URL published for this asset yet (manifest url is null)');
  const dest = join(root, asset.dest);
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.part-${process.pid}`;
  const res = await fetch(asset.url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${asset.url}`);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  const digest = await sha256File(tmp);
  if (asset.sha256 && digest !== asset.sha256) {
    await unlink(tmp);
    throw new Error(`digest mismatch: got ${digest}, manifest says ${asset.sha256}`);
  }
  await rename(tmp, dest);
  return { skipped: false, detail: `fetched, sha256 verified (${digest.slice(0, 12)}…)` };
}

async function fetchDockerImage(asset) {
  const before = await statusDockerImage(asset);
  return {
    skipped: true,
    detail: `${before.detail} — CARLA is user-provided; this tool never pulls or builds it (see docs/ops/local-assets.md)`,
  };
}

// ---------------------------------------------------------------------------

const STATUS_FNS = {
  'hf-repo': (a, root, opts) => statusHfRepo(a, root, opts),
  'docker-image': (a) => statusDockerImage(a),
  file: (a, root, opts) => statusFile(a, root, opts),
};

const FETCH_FNS = {
  'hf-repo': fetchHfRepo,
  'docker-image': fetchDockerImage,
  file: fetchFile,
};

function pad(s, n) {
  return String(s).padEnd(n);
}

async function main() {
  const [cmd = 'status', ...ids] = process.argv.slice(2);
  const manifest = await loadManifest();
  const root = assetRoot();
  const selected = ids.length
    ? manifest.assets.filter((a) => ids.includes(a.id))
    : manifest.assets;
  if (ids.length && selected.length !== ids.length) {
    const known = new Set(manifest.assets.map((a) => a.id));
    console.error(`unknown asset id(s): ${ids.filter((i) => !known.has(i)).join(', ')}`);
    process.exit(2);
  }

  if (cmd === 'status' || cmd === 'verify') {
    const verifyDigest = cmd === 'verify';
    console.log(`asset root: ${root} (${process.env.SIMFORGE_ASSETS ? 'from SIMFORGE_ASSETS' : 'default'})`);
    let bad = 0;
    for (const asset of selected) {
      const { state, detail } = await STATUS_FNS[asset.kind](asset, root, { verifyDigest });
      if (!['ok', 'pending'].includes(state)) bad += 1;
      console.log(`${pad(state.toUpperCase(), 9)} ${pad(asset.id, 26)} ${detail}`);
    }
    process.exit(verifyDigest && bad > 0 ? 1 : 0);
  }

  if (cmd === 'fetch') {
    let failed = 0;
    for (const asset of selected) {
      try {
        const { skipped, detail } = await FETCH_FNS[asset.kind](asset, root);
        console.log(`${pad(skipped ? 'SKIP' : 'FETCHED', 9)} ${pad(asset.id, 26)} ${detail}`);
      } catch (err) {
        failed += 1;
        console.error(`${pad('FAIL', 9)} ${pad(asset.id, 26)} ${err.message}`);
      }
    }
    process.exit(failed ? 1 : 0);
  }

  console.error('usage: fetch.mjs [status|fetch|verify] [asset-id ...]');
  process.exit(2);
}

await main();
