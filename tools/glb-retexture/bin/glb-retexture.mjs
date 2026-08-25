#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { retextureGlb, scanImageHashes } from '../src/retexture.mjs';

const [command, ...args] = process.argv.slice(2);
if (command === 'apply') {
  const [input, output, manifestPath, reportPath] = args;
  if (!input || !output || !manifestPath) {
    console.error('usage: glb-retexture apply <input.glb> <output.glb> <replacement-manifest.json> [report.json]');
    process.exit(2);
  }
  const source = fs.readFileSync(input);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const manifestDir = manifest.assetsRoot ?? path.dirname(path.resolve(manifestPath));
  const result = retextureGlb(source, manifest, { manifestDir });
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, result.glb);
  const report = { input, output, ...result.report };
  if (reportPath) fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${path.basename(input)}: ${result.report.replacements.length} images replaced; ${result.report.geometry.ranges} geometry ranges identical; sha256 ${result.report.outputSha256}`);
} else if (command === 'scan') {
  const [input, hashesPath] = args;
  if (!input || !hashesPath) {
    console.error('usage: glb-retexture scan <input.glb> <hashes.json>');
    process.exit(2);
  }
  const hashesDocument = JSON.parse(fs.readFileSync(hashesPath, 'utf8'));
  const hashes = Array.isArray(hashesDocument) ? hashesDocument : hashesDocument.hashes;
  const matches = scanImageHashes(fs.readFileSync(input), hashes);
  console.log(JSON.stringify({ input, matches }, null, 2));
  process.exit(matches.length ? 1 : 0);
} else {
  console.error('usage: glb-retexture <apply|scan> ...');
  process.exit(2);
}
