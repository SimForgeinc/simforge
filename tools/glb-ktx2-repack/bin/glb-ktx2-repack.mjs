#!/usr/bin/env node
/**
 * WebP -> KTX2 image-only GLB repacker.
 *
 *   node tools/glb-ktx2-repack/bin/glb-ktx2-repack.mjs repack <in.glb> <out.glb> \
 *     [--ktx-bin <dir>] [--no-core-source] [--report <path.json>]
 *   node tools/glb-ktx2-repack/bin/glb-ktx2-repack.mjs verify <src.glb> <out.glb>
 *
 * `repack` converts every embedded image/webp payload to KTX2 (ETC1S for
 * color, UASTC+zstd for normal/data) and rewrites texture/image references;
 * geometry bytes are proven identical before the output is written.
 * `verify` re-proves geometry identity between any source/output pair and
 * prints the per-range digest table.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { repackGlb, verifyGeometryIdentity } from '../src/repack.mjs';

function parseArgs(argv) {
  const positional = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-core-source') flags.set('core-source', false);
    else if (arg.startsWith('--')) flags.set(arg.slice(2), argv[++i]);
    else positional.push(arg);
  }
  return { positional, flags };
}

const [command, ...rest] = process.argv.slice(2);
const { positional, flags } = parseArgs(rest);

if (command === 'repack') {
  const [input, output] = positional;
  if (!input || !output) {
    console.error('usage: glb-ktx2-repack repack <in.glb> <out.glb> [--ktx-bin dir] [--color-codec uastc|etc1s] [--no-core-source] [--report path]');
    process.exit(2);
  }
  const colorCodec = flags.get('color-codec') ?? 'uastc';
  if (!['uastc', 'etc1s'].includes(colorCodec)) {
    console.error(`--color-codec must be uastc or etc1s, got ${colorCodec}`);
    process.exit(2);
  }
  const src = fs.readFileSync(input);
  const { glb, report } = await repackGlb(src, {
    ktxBinDir: flags.get('ktx-bin'),
    keepCoreSource: flags.get('core-source') !== false,
    colorCodec,
  });
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, glb);
  if (report.skipped) {
    console.log(`SKIP ${input}: ${report.reason}`);
  } else {
    const webp = report.images.reduce((sum, r) => sum + r.webpBytes, 0);
    const ktx2 = report.images.reduce((sum, r) => sum + r.ktx2Bytes, 0);
    console.log(
      `${path.basename(input)}: ${report.images.length} images webp ${(webp / 1e6).toFixed(2)}MB -> ktx2 ${(ktx2 / 1e6).toFixed(2)}MB | file ${(report.bytes.src / 1e6).toFixed(2)}MB -> ${(report.bytes.out / 1e6).toFixed(2)}MB | geometry ranges ${report.geometry.ranges} identical=${report.geometry.identical}`,
    );
  }
  const reportPath = flags.get('report');
  if (reportPath) {
    fs.writeFileSync(reportPath, `${JSON.stringify({ input, output, ...report }, null, 2)}\n`);
  }
} else if (command === 'verify') {
  const [srcPath, outPath] = positional;
  if (!srcPath || !outPath) {
    console.error('usage: glb-ktx2-repack verify <src.glb> <out.glb>');
    process.exit(2);
  }
  const result = verifyGeometryIdentity(fs.readFileSync(srcPath), fs.readFileSync(outPath));
  for (const range of result.ranges) {
    console.log(`view ${String(range.view).padStart(4)} ${range.kind.padEnd(7)} len ${String(range.length).padStart(9)} sha256 ${range.sha256}`);
  }
  console.log(result.ok ? `OK: ${result.ranges.length} geometry ranges identical` : `FAIL: ${JSON.stringify(result.failures)}`);
  process.exit(result.ok ? 0 : 1);
} else {
  console.error('usage: glb-ktx2-repack <repack|verify> ...');
  process.exit(2);
}
