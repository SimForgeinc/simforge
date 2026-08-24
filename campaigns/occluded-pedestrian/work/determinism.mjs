/**
 * Determinism spot-check: re-derive three library cells from their replay keys
 * with a *fresh* `simforge instantiate` + `simforge simulate` and compare against what
 * the batch wrote.
 *
 * Three comparisons, because they fail differently:
 *   - the instance JSON `input` block, byte for byte (the materializer);
 *   - the *decompressed* trace bytes (the engine — the gzip container carries
 *     an OS byte and a compression-level header, so the archive itself is not
 *     the right unit of comparison, its contents are);
 *   - `inputHash` / `traceDigest`, which is what a resumable batch keys on.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const SIMFORGE = path.join(ROOT, 'packages/cli/bin/simforge.js');
const CAMPAIGN = path.join(ROOT, 'campaigns/occluded-pedestrian');
const manifest = JSON.parse(fs.readFileSync(path.join(CAMPAIGN, 'manifest.json'), 'utf8'));

// "Random", but a fixed seed so the check is itself reproducible.
let seed = 0x9e3779b9;
const rnd = () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x100000000;
};
const promoted = manifest.cells.filter((c) => c.promoted);
const picks = [];
const seenTemplates = new Set();
while (picks.length < 3) {
  const c = promoted[Math.floor(rnd() * promoted.length)];
  if (seenTemplates.has(c.template) && seenTemplates.size < 3) continue;
  seenTemplates.add(c.template);
  picks.push(c);
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmp = '/tmp/simforge-determinism';
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

let allOk = true;
const rows = [];
for (const c of picks) {
  const tplFile = path.join(ROOT, 'examples', `${c.template}.template.json`);
  const instOut = path.join(tmp, `${c.template}-${c.siteId}-${c.drawIndex}.instance.json`);
  const traceOut = path.join(tmp, `${c.template}-${c.siteId}-${c.drawIndex}.trace.json.gz`);

  execFileSync('node', [SIMFORGE, 'instantiate', tplFile, '--map', c.mapId, '--site', c.siteId,
    '--draw', String(c.drawIndex), '--out', instOut], { encoding: 'utf8', maxBuffer: 1 << 28 });
  execFileSync('node', [SIMFORGE, 'simulate', instOut, '--trace', traceOut],
    { encoding: 'utf8', maxBuffer: 1 << 28 });

  const original = path.join(CAMPAIGN, 'batches', c.template, c.mapId, c.siteId,
    `draw-${String(c.drawIndex).padStart(3, '0')}`);
  const wasInst = JSON.parse(fs.readFileSync(`${original}.instance.json`, 'utf8'));
  const nowInst = JSON.parse(fs.readFileSync(instOut, 'utf8'));
  const wasTrace = zlib.gunzipSync(fs.readFileSync(`${original}.trace.json.gz`));
  const nowTrace = zlib.gunzipSync(fs.readFileSync(traceOut));

  const inputSame = JSON.stringify(wasInst.input) === JSON.stringify(nowInst.input);
  const traceSame = sha(wasTrace) === sha(nowTrace);
  const hashSame = wasInst.manifest.inputHash === nowInst.manifest.inputHash
    && wasInst.manifest.inputHash === c.inputHash;
  const seedSame = wasInst.manifest.replayKey.paramSeed === nowInst.manifest.replayKey.paramSeed;
  const ok = inputSame && traceSame && hashSame && seedSame;
  allOk &&= ok;
  rows.push({
    cell: `${c.template}/${c.mapId}/${c.siteId}#${c.drawIndex}`,
    inputBytes: inputSame, traceBytes: traceSame, inputHash: hashSame, paramSeed: seedSame,
    traceSha256: sha(nowTrace).slice(0, 16), ok,
  });
}

const report = { kind: 'determinism-check', version: 1, cells: rows, verdict: allOk ? 'PASS' : 'FAIL' };
fs.writeFileSync(path.join(CAMPAIGN, 'determinism-check.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(allOk ? 0 : 1);
