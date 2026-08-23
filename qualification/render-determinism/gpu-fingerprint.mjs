/**
 * Hardware fingerprint for render-determinism evidence manifests.
 *
 * Collects, in authority order:
 *  - in-browser WebGL facts (vendor/renderer strings, GL version) from the same
 *    Chrome channel and launch flags the exporter uses, so the fingerprint
 *    describes the exact rasterizer that produced the frames;
 *  - host facts: NVIDIA driver/GPU via nvidia-smi when present, OS, kernel,
 *    CPU model.
 *
 * No secret values are ever included.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function safe(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

async function hostFacts() {
  const osRelease = await readFile('/etc/os-release', 'utf8').catch(() => '');
  const prettyName = osRelease.split('\n')
    .map((line) => line.match(/^PRETTY_NAME="(.*)"$/))
    .find(Boolean)?.[1] ?? null;
  const nvidia = safe(() => {
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
  return {
    osPrettyName: prettyName,
    kernel: os.release(),
    arch: os.arch(),
    cpuModel: os.cpus()[0]?.model ?? null,
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    hostname: os.hostname(),
    ...(nvidia ? { gpus: nvidia } : {}),
  };
}

/** In-Chrome rasterizer identity, captured under the exporter's launch flags. */
async function chromeWebglFacts(chromium) {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--ignore-gpu-blocklist'],
  });
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    const facts = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      if (!gl) return { webglAvailable: false };
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        webglAvailable: true,
        webglVersion: gl.getParameter(gl.VERSION),
        glslVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
        unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      };
    });
    return { ...facts, chromeVersion: browser.version(), userAgent: await page.evaluate(() => navigator.userAgent) };
  } finally {
    await browser.close();
  }
}

export async function collectHardwareFingerprint(chromium) {
  const [host, webgl] = await Promise.all([hostFacts(), chromeWebglFacts(chromium)]);
  return {
    collectedAt: new Date().toISOString(),
    chrome: {
      version: webgl.chromeVersion,
      userAgent: webgl.userAgent,
      launchArgs: ['--ignore-gpu-blocklist'],
      headless: true,
    },
    webgl: {
      available: webgl.webglAvailable ?? false,
      version: webgl.webglVersion ?? null,
      glslVersion: webgl.glslVersion ?? null,
      unmaskedVendor: webgl.unmaskedVendor ?? null,
      unmaskedRenderer: webgl.unmaskedRenderer ?? null,
      maxTextureSize: webgl.maxTextureSize ?? null,
    },
    host,
  };
}
