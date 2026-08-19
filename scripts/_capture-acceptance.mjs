#!/usr/bin/env node
/**
 * Capture-robustness acceptance loop (diagnostic harness, not product code).
 *
 * Renders the same showcase-data trace N times in a row through the real 3D
 * exporter and proves, per run: exit 0, the four named phase stills, an MP4 whose
 * ffprobe frame count matches the manifest, and that every captured PNG carries
 * real image content (per-channel standard deviation), not a uniform clear-colour
 * frame. Byte size is deliberately not the criterion -- pixel statistics are.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const url = process.argv[2] ?? 'http://127.0.0.1:5311';
const runs = Number(process.argv[3] ?? 10);
const quality = process.argv[4] ?? 'balanced';
const cell = process.argv[5]
  ?? 'showcase-data/gallery-seed/001/40-cells/emergent-h2-ml.dense32.s7-yale-street-40a54393-0-p7c01bdb7';

/** Free VRAM in MiB, or -1 where nvidia-smi is absent. The host is shared. */
function freeVramMiB() {
  const smi = spawnSync('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { encoding: 'utf8' });
  return smi.status === 0 ? Number(smi.stdout.trim().split('\n')[0]) : -1;
}

async function pngStats(file) {
  const { channels } = await sharp(file).stats();
  return {
    stdev: Math.max(...channels.map((channel) => channel.stdev)),
    mean: Math.min(...channels.map((channel) => channel.mean)),
  };
}

async function runExport(index) {
  const outDir = `/tmp/cap-accept/run-${String(index).padStart(2, '0')}`;
  await rm(outDir, { recursive: true, force: true });
  const args = [
    'scripts/export-render.mjs',
    '--url', url,
    '--instance', `${cell}/instance.json`,
    '--trace', `${cell}/trace.json.gz`,
    '--out', outDir,
    '--fps', '12', '--width', '1600', '--height', '960',
    '--camera-search', '--pin-page', '--full-clip', 'true',
    // Headless is the only mode that reaches the discrete GPU on this host:
    // headful Chrome plus `--use-angle=vulkan` yields no WebGL2 context at all
    // (verified against about:blank), so the viewer would never mount.
    '--headless', 'true',
    '--quality', quality,
    '--chrome-flags', 'use-gl=angle,use-angle=vulkan,enable-features=Vulkan',
  ];
  const vramFreeMiB = freeVramMiB();
  const startedAt = Date.now();
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = [];
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const code = await new Promise((resolve) => child.once('exit', resolve));
  const elapsedMs = Date.now() - startedAt;
  const text = Buffer.concat(stderr).toString('utf8');
  if (code !== 0) {
    // The exporter's own message is the first non-banner line; the tail is the
    // node stack. Keep both, or the reason for the failure is invisible.
    const lines = text.trim().split('\n').filter((line) => line.trim().length > 0);
    return { index, ok: false, code, elapsedMs, vramFreeMiB, error: lines.slice(0, 6).join(' | ') };
  }

  const manifest = JSON.parse(await readFile(path.join(outDir, 'manifest.json'), 'utf8'));
  const problems = [];
  const phases = manifest.frames.map((frame) => frame.phase);
  const expected = ['pre-event', 'reveal', 'conflict', 'aftermath'];
  if (phases.join(',') !== expected.join(',')) problems.push(`phases ${phases.join(',')}`);
  if (manifest.machineAssessment.verdict !== 'pass') problems.push(`verdict ${manifest.machineAssessment.verdict}`);

  const stills = manifest.frames.map((frame) => path.join(outDir, frame.artifact.file));
  const bad = [];
  let minStdev = Infinity;
  let minMean = Infinity;
  for (const file of stills) {
    const { stdev, mean } = await pngStats(file);
    minStdev = Math.min(minStdev, stdev);
    minMean = Math.min(minMean, mean);
    // stdev separates a uniform clear-colour frame (0.85 on a reproduced blank
    // capture) from real content (>20). The mean floor separates a scene drawn
    // before the sky HDR landed (3.7: unlit city on the clear colour) from this
    // fixture's daylight framing (~148).
    if (stdev < 5) bad.push(`${path.basename(file)} blank stdev=${stdev.toFixed(3)}`);
    else if (mean < 40) bad.push(`${path.basename(file)} unlit mean=${mean.toFixed(1)}`);
  }
  if (bad.length > 0) problems.push(bad.join(', '));

  const framesDir = path.join(outDir, 'frames');
  const frameFiles = (await readdir(framesDir)).filter((name) => /^frame-\d{3}\.png$/.test(name));
  if (frameFiles.length !== 3) problems.push(`frames/ has ${frameFiles.length} pngs, expected 3`);

  const video = manifest.video;
  if (!video || video.unavailable) problems.push('no video');
  else {
    const probe = spawnSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-count_frames', '-show_entries', 'stream=nb_read_frames,r_frame_rate,width,height',
      '-of', 'json', path.join(outDir, video.file),
    ], { encoding: 'utf8' });
    const stream = JSON.parse(probe.stdout).streams?.[0];
    if (Number(stream?.nb_read_frames) !== video.frameCount) {
      problems.push(`mp4 has ${stream?.nb_read_frames} frames, manifest says ${video.frameCount}`);
    }
    if (video.frameCount !== manifest.videoSequence.frameCount) {
      problems.push(`video ${video.frameCount} != sequence ${manifest.videoSequence.frameCount}`);
    }
    if (Math.abs(video.durationSeconds - video.frameCount / video.fps) > 1e-9) {
      problems.push(`duration ${video.durationSeconds} != ${video.frameCount}/${video.fps}`);
    }
  }

  return {
    index,
    ok: problems.length === 0,
    code,
    elapsedMs,
    vramFreeMiB,
    stills: stills.length,
    videoFrames: video?.frameCount ?? 0,
    minStdev: Number(minStdev.toFixed(2)),
    minMean: Number(minMean.toFixed(1)),
    diagnostics: manifest.machineAssessment.gates
      .find((gate) => gate.id === 'browser-diagnostics-empty')?.evidence.count ?? -1,
    ...(problems.length > 0 ? { problems } : {}),
  };
}

const results = [];
for (let index = 0; index < runs; index += 1) {
  const result = await runExport(index);
  results.push(result);
  console.log(JSON.stringify(result));
}
const failed = results.filter((result) => !result.ok);
console.log(JSON.stringify({
  quality,
  runs: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  emptyCaptures: results.filter((r) => /empty scene/.test(String(r.error ?? ''))
    || (r.problems ?? []).some((p) => /blank|unlit/.test(p))).length,
  transientFailures: results.filter((r) => /context is lost|Target closed|Timeout|Execution context/.test(String(r.error ?? ''))).length,
  videoFrameCounts: [...new Set(results.map((r) => r.videoFrames))],
  medianElapsedMs: results.map((r) => r.elapsedMs).sort((a, b) => a - b)[Math.floor(results.length / 2)],
  vramFreeMiB: { min: Math.min(...results.map((r) => r.vramFreeMiB)), max: Math.max(...results.map((r) => r.vramFreeMiB)) },
}, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
