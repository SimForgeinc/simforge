#!/usr/bin/env node
// Turn a known-good full render spec (render-spec/v3) into a cheap staged
// validation probe: ~3 s clip, one tiny rgb camera, and the validation-lane
// fence capability in `capabilityIntent.required` so ONLY a "-staged" worker
// (which declares the fence via its validationLane config) can claim it.
//
//   node make-probe-spec.mjs <full-spec.json> [fenceCapability] > probe-spec.json
//
// Defaults match staged-worker.example.json: fence artifact.frames, 320x192@12,
// clip [0, 3). Keep the dimensions inside the staged worker's validationLane
// maxWidth/maxHeight clamp or the staged worker itself will refuse the probe.
import { readFileSync } from 'node:fs';

const specPath = process.argv[2];
if (!specPath) {
  console.error('usage: make-probe-spec.mjs <full-spec.json> [fenceCapability]');
  process.exit(64);
}
const fence = process.argv[3] ?? 'artifact.frames';
const WIDTH = 320;
const HEIGHT = 192;
const FPS = 12;
const CLIP_SECONDS = 3;

const spec = JSON.parse(readFileSync(specPath, 'utf8'));
if (spec.schema !== 'uniscenario.render-spec/v3') {
  console.error(`expected uniscenario.render-spec/v3, got ${spec.schema}`);
  process.exit(65);
}

const rgb = spec.sources.find((source) => source.modality === 'rgb');
if (!rgb) {
  console.error('spec has no rgb source to probe with');
  process.exit(65);
}

const probe = {
  ...spec,
  sources: [{
    ...rgb,
    attributes: { ...rgb.attributes, width: WIDTH, height: HEIGHT, fps: FPS },
    outputName: `${rgb.actorId}-${rgb.sensorId}-staged-probe`,
  }],
  clip: { startSeconds: spec.clip.startSeconds, endSeconds: spec.clip.startSeconds + CLIP_SECONDS },
  video: spec.video
    ? { ...spec.video, width: WIDTH, height: HEIGHT, fps: FPS }
    : undefined,
  artifacts: ['video', 'manifest', 'trace'],
  capabilityIntent: {
    ...spec.capabilityIntent,
    required: [...new Set([
      ...spec.capabilityIntent.required.filter((item) => !item.startsWith('sensor.')),
      'sensor.rgb',
      fence,
    ])],
    preferred: [],
  },
};
if (!probe.video) delete probe.video;

process.stdout.write(`${JSON.stringify(probe, null, 2)}\n`);
