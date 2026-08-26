import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const config = JSON.parse(await readFile(path.join(repoRoot, 'config/simforge-oss-stack.json'), 'utf8'));
const root = await mkdtemp(path.join(tmpdir(), 'simforge-packed-stack-'));
const tarballs = path.join(root, 'tarballs');
await mkdir(tarballs);

const dependencies = {};
const supportPackagePaths = ['packages/map-registry', 'packages/map-pipeline'];
const packedEntries = [
  ...supportPackagePaths.map((packagePath) => ({ path: packagePath })),
  ...config.packages,
];
for (const entry of packedEntries) {
  const packageRoot = path.join(repoRoot, entry.path);
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  execFileSync('pnpm', ['pack', '--pack-destination', tarballs], {
    cwd: packageRoot,
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
    stdio: 'pipe',
  });
  const archive = `${packageJson.name.slice(1).replace('/', '-')}-${packageJson.version}.tgz`;
  dependencies[packageJson.name] = `file:${path.join(tarballs, archive)}`;
}

await writeFile(path.join(root, 'package.json'), `${JSON.stringify({
  name: 'simforge-packed-stack-smoke',
  private: true,
  type: 'module',
  dependencies,
}, null, 2)}\n`);

execFileSync('npm', [
  'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false',
], { cwd: root, stdio: 'pipe' });

const names = config.packages.map((entry) => entry.name);
const smokeScript = path.join(root, 'smoke-import.mjs');
await writeFile(smokeScript, [
  `const names = ${JSON.stringify(names)};`,
  'const verified = [];',
  'for (const name of names) {',
  '  const imported = await import(name);',
  '  verified.push({ name, exports: Object.keys(imported).length });',
  '}',
  'process.stdout.write(JSON.stringify(verified));',
  '',
].join('\n'));
const verified = JSON.parse(execFileSync(process.execPath, [smokeScript], {
  cwd: root,
  encoding: 'utf8',
}));

await writeFile(path.join(root, 'smoke-result.json'), `${JSON.stringify({
  schema: 'simforge-oss.packed-stack-smoke/v1',
  stackVersion: config.stackVersion,
  verified,
}, null, 2)}\n`);

process.stdout.write(`${JSON.stringify({ root, stackVersion: config.stackVersion, verified }, null, 2)}\n`);
