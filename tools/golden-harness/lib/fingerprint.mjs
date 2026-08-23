/**
 * Hardware fingerprint for the native (Bevy/wgpu) golden store — WSB6.
 *
 * Adopts the `hardware.host` shape of WSB4's
 * `tools/render-determinism/gpu-fingerprint.mjs` (same nvidia-smi query, same
 * field names) so fingerprint facts are cross-comparable between the Chrome
 * evidence manifests and the native goldens. The Chrome/WebGL blocks do not
 * apply to the wgpu path and are omitted; instead the wgpu adapter identity is
 * pinned via driver facts + the wgpu backend recorded in the manifest.
 *
 * gpuFingerprint = first 16 hex chars of sha256 over canonical JSON of:
 *   { gpus: [{name,driverVersion,vbiosVersion,pciBusId}], kernel, arch }
 *
 * Policy (docs/determinism-claim.md §Bevy headless): same-device wgpu is
 * empirically byte-stable; cross-driver/cross-vendor equality is NOT claimed,
 * so goldens are keyed per this fingerprint. A new GPU/driver => record a new
 * golden table for it before verifying.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

function safe(fn, fallback = null) {
  try { return fn(); } catch { return fallback; }
}

/** Same query + field names as tools/render-determinism/gpu-fingerprint.mjs. */
export function nvidiaGpus() {
  return safe(() => {
    const out = execFileSync(
      'nvidia-smi',
      ['--query-gpu=name,driver_version,vbios_version,pci.bus_id', '--format=csv,noheader'],
      { encoding: 'utf8' },
    ).trim();
    return out.split('\n').map((line) => {
      const [name, driverVersion, vbiosVersion, pciBusId] = line.split(',').map((s) => s.trim());
      return { name, driverVersion, vbiosVersion, pciBusId };
    });
  }, null);
}

async function osPrettyName() {
  const rel = await readFile('/etc/os-release', 'utf8').catch(() => '');
  return rel.split('\n')
    .map((line) => line.match(/^PRETTY_NAME="(.*)"$/))
    .find(Boolean)?.[1] ?? null;
}

export async function collectNativeHardware() {
  const gpus = nvidiaGpus();
  const host = {
    osPrettyName: await osPrettyName(),
    kernel: os.release(),
    arch: os.arch(),
    cpuModel: os.cpus()[0]?.model ?? null,
    cpuCount: os.cpus().length,
    hostname: os.hostname(),
    ...(gpus ? { gpus } : {}),
  };
  if (!gpus?.length) {
    throw new Error('nvidia-smi returned no GPUs — native golden suite requires the raster GPU host');
  }
  // Canonical JSON: sort object keys recursively for a stable hash input.
  const canon = (v) => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : 1).map(([k, val]) => [k, canon(val)]));
    }
    return v;
  };
  const fingerprintSource = {
    gpus: gpus.map(({ name, driverVersion, vbiosVersion, pciBusId }) =>
      ({ name, driverVersion, vbiosVersion, pciBusId })),
    kernel: host.kernel,
    arch: host.arch,
  };
  const gpuFingerprint = createHash('sha256')
    .update(JSON.stringify(canon(fingerprintSource)))
    .digest('hex')
    .slice(0, 16);
  return { collectedAt: new Date().toISOString(), gpuFingerprint, host };
}
