#!/usr/bin/env node
/**
 * glb-orm-repair — wire packed ORM textures into an existing GLB and fix
 * spec/gloss-as-baseColor mis-wiring, preserving every authored byte.
 *
 * Subcommands:
 *   audit  <input.glb>                       material wiring table + defect flags
 *   repair --config <repair.json> --input <in.glb> --output <out.glb> [--dry-run]
 *   pack   --ao <img> --roughness <img> [--metalness <img>] --output <orm.png> [--size N]
 *
 * Repair config (texture paths resolve against the config file's directory):
 *   {
 *     "version": 1,
 *     "materials": {
 *       "Asphalt1":       { "orm": "asphalt_02_arm_1k.png" },
 *       "Curb_Saratoga":  { "orm": "concrete_arm.png", "baseColor": "concrete_diff.png",
 *                           "normal": "concrete_nor_gl.png" },
 *       "sidewalk_material": { "baseColor": null, "baseColorFactor": [0.6,0.6,0.6,1] }
 *     }
 *   }
 * `"baseColor": null` removes a mis-wired base color texture and falls back to
 * the factor. Optional per-material keys: baseColorFactor, metallicFactor,
 * roughnessFactor, occlusionStrength, normalScale, optional.
 *
 * `pack` requires the workspace's sharp install (packages/cli); everything
 * else is dependency-free. Channel layout: R=AO, G=roughness, B=metallic —
 * identical to RoadRunner AORM and Poly Haven `*_arm_*` maps, which need no
 * packing at all.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditGlb, repairGlb } from '../src/repair.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) flags[name] = true;
    else flags[name] = argv[++index];
  }
  return { flags, positional };
}

function usage(code) {
  process.stderr.write(
    'usage: glb-orm-repair audit <input.glb>\n' +
      '       glb-orm-repair repair --config <repair.json> --input <in.glb> --output <out.glb> [--dry-run]\n' +
      '       glb-orm-repair pack --ao <img> --roughness <img> [--metalness <img>] --output <orm.png> [--size N]\n',
  );
  process.exit(code);
}

async function loadEntries(configPath) {
  const configDir = path.dirname(path.resolve(configPath));
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (config.version !== 1 || typeof config.materials !== 'object' || config.materials === null) {
    throw new Error('repair config must be {"version":1,"materials":{...}}');
  }
  const sidecar = async (value) => ({
    bytes: await readFile(path.resolve(configDir, value)),
    name: path.parse(value).name,
  });
  const entries = [];
  for (const [material, spec] of Object.entries(config.materials)) {
    const entry = { material };
    if (spec.orm) entry.orm = await sidecar(spec.orm);
    if (spec.baseColor === null) entry.baseColor = 'remove';
    else if (spec.baseColor) entry.baseColor = await sidecar(spec.baseColor);
    if (spec.normal) entry.normal = await sidecar(spec.normal);
    for (const key of ['baseColorFactor', 'metallicFactor', 'roughnessFactor', 'occlusionStrength', 'normalScale', 'optional']) {
      if (spec[key] !== undefined) entry[key] = spec[key];
    }
    entries.push(entry);
  }
  return entries;
}

async function audit(positional) {
  const [input] = positional;
  if (!input) usage(1);
  const result = auditGlb(await readFile(input));
  for (const row of result.materials) {
    const slot = (s) => (s ? `${s.name ?? `img${s.image}`}` : '—');
    const flags = row.flags.length ? `  !! ${row.flags.join(', ')}` : '';
    process.stdout.write(
      `${String(row.index).padStart(4)}  ${(row.name ?? '(unnamed)').padEnd(36)} bc=${slot(row.baseColor).padEnd(38)} mr=${slot(row.metallicRoughness).padEnd(24)} occ=${slot(row.occlusion).padEnd(24)} nrm=${slot(row.normal).padEnd(30)} mf=${row.metallicFactor} rf=${row.roughnessFactor}${flags}\n`,
    );
  }
  const flagged = result.materials.filter((row) => row.flags.length > 0);
  process.stdout.write(`\n${result.materials.length} materials, ${result.textures} textures, ${result.images} images; ${flagged.length} flagged\n`);
  return 0;
}

async function repair(flags) {
  if (!flags.config || !flags.input || !flags.output) usage(1);
  const source = await readFile(flags.input);
  const entries = await loadEntries(flags.config);
  const { output, report } = repairGlb(source, entries);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (flags.dryRun) {
    process.stdout.write('[dry-run] identity verified; nothing written\n');
    return 0;
  }
  await writeFile(flags.output, output);
  process.stdout.write(`wrote ${flags.output} (${output.length} bytes)\n`);
  return 0;
}

async function pack(flags) {
  if (!flags.ao || !flags.roughness || !flags.output) usage(1);
  let sharp;
  try {
    sharp = createRequire(path.join(repoRoot, 'packages/cli/package.json'))('sharp');
  } catch {
    throw new Error('pack requires sharp from the workspace install; run `pnpm install` first');
  }
  const size = Number(flags.size ?? 0) || null;
  const channel = async (file) => {
    if (!file) return null;
    let image = sharp(file).toColourspace('b-w');
    if (size) image = image.resize(size, size, { fit: 'fill' });
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  };
  const [ao, roughness, metalness] = await Promise.all([channel(flags.ao), channel(flags.roughness), channel(flags.metalness)]);
  if (ao.width !== roughness.width || ao.height !== roughness.height) {
    throw new Error(`ao (${ao.width}x${ao.height}) and roughness (${roughness.width}x${roughness.height}) differ; pass --size to unify`);
  }
  if (metalness && (metalness.width !== ao.width || metalness.height !== ao.height)) {
    throw new Error('metalness dimensions differ; pass --size to unify');
  }
  const pixels = ao.width * ao.height;
  const rgb = Buffer.alloc(pixels * 3);
  for (let index = 0; index < pixels; index += 1) {
    rgb[index * 3] = ao.data[index];
    rgb[index * 3 + 1] = roughness.data[index];
    rgb[index * 3 + 2] = metalness ? metalness.data[index] : 0;
  }
  const png = await sharp(rgb, { raw: { width: ao.width, height: ao.height, channels: 3 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(flags.output, png);
  process.stdout.write(`wrote ${flags.output} (${ao.width}x${ao.height}, R=AO G=roughness B=metallic)\n`);
  return 0;
}

const [command, ...rest] = process.argv.slice(2);
const { flags, positional } = parseFlags(rest);
try {
  if (command === 'audit') process.exit(await audit(positional));
  else if (command === 'repair') process.exit(await repair(flags));
  else if (command === 'pack') process.exit(await pack(flags));
  else usage(command === undefined || command === '--help' ? 0 : 1);
} catch (error) {
  process.stderr.write(`glb-orm-repair: ${error.message}\n`);
  process.exit(1);
}
