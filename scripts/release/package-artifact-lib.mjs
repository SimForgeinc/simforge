import { access, glob, readFile } from 'node:fs/promises';
import path from 'node:path';

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function exportedFiles(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(exportedFiles);
}

async function verifyTarget(packageRoot, target) {
  if (!target.includes('*')) {
    await access(path.resolve(packageRoot, target));
    return;
  }
  const matches = await Array.fromAsync(glob(target, { cwd: packageRoot }));
  if (matches.length === 0) {
    throw new Error(`export pattern ${target} does not match a packaged artifact in ${packageRoot}`);
  }
}

export async function verifyPackageArtifacts({ repoRoot }) {
  if (!repoRoot) throw new Error('repoRoot is required');
  const config = await readJson(path.join(repoRoot, 'config/simforge-stack.json'));
  const verified = [];
  for (const entry of config.packages) {
    const packageRoot = path.join(repoRoot, entry.path);
    const packageJson = await readJson(path.join(packageRoot, 'package.json'));
    const targets = new Set([
      packageJson.main,
      packageJson.types,
      ...exportedFiles(packageJson.exports),
      ...Object.values(packageJson.bin ?? {}),
    ].filter((target) => typeof target === 'string'));
    for (const target of targets) {
      await verifyTarget(packageRoot, target);
    }
    verified.push({ name: packageJson.name, version: packageJson.version, targets: targets.size });
  }
  return verified;
}
