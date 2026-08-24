/**
 * `tsx src/cli.ts <trace.json.gz|trace.json> <out.scenestate.json>`
 *
 * Converts a simulated trace into a scene-state.v1 document (JSON).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import { emitSceneState } from './emit.js';
import { sceneStateSchema } from './schema.js';

function main(): void {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('usage: tsx src/cli.ts <trace.json.gz|trace.json> <out.scenestate.json>');
    process.exit(2);
  }
  const bytes = readFileSync(input);
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const trace = JSON.parse((isGzip ? gunzipSync(bytes) : bytes).toString('utf8'));
  const doc = sceneStateSchema.parse(emitSceneState(trace));
  writeFileSync(output, JSON.stringify(doc));
  console.log(
    `scene-state ${doc.version}: map=${doc.mapId} actors=${doc.actors.length} frames=${doc.frames.length} -> ${output}`,
  );
}

main();
