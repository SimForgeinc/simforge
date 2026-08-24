import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const IGNORED_GENERATED_DIRECTORIES = new Set([
  '.cache',
  '.codex-playwright',
  '.firecrawl',
  '.git',
  '.next',
  '.nyc_output',
  '.playwright-cli',
  '.pytest_cache',
  '.terraform',
  '.turbo',
  '.venv',
  '__pycache__',
  'coverage',
  'dist',
  'node_modules',
]);

const IMPORT_SCAN_EXTENSIONS = new Set([
  '.cjs', '.js', '.jsx', '.json', '.mjs', '.py', '.sh', '.tf', '.toml', '.ts', '.tsx', '.yaml', '.yml',
]);

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function revision(root) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

function digest(algorithm, bytes, encoding = 'hex') {
  return createHash(algorithm).update(bytes).digest(encoding);
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function collectFiles(root, relative = '', result = []) {
  const directory = path.join(root, relative);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return result;
    throw error;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isDirectory() && (entry.name.startsWith('.') || IGNORED_GENERATED_DIRECTORIES.has(entry.name))) continue;
    const child = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) await collectFiles(root, child, result);
    if (entry.isFile() || entry.isSymbolicLink()) result.push(child);
  }
  return result;
}

function allDependencies(packageJson) {
  return {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
    ...(packageJson.optionalDependencies ?? {}),
  };
}

function violation(code, message, details = {}) {
  return { code, message, ...details };
}

async function auditPackages({ simforgeRoot, simcloudRoot, config, sourceRevision, violations }) {
  const stack = await readJson(path.join(simforgeRoot, config.sourceStackConfig));
  if (stack.schema !== 'uniscenarios.stack-config/v1') {
    throw new Error(`Unsupported stack config schema: ${String(stack.schema)}`);
  }
  const vendorLock = await readJson(path.join(simcloudRoot, config.vendorLock));
  if (vendorLock.schema !== 'simcloud.uniscenarios-vendor/v1') {
    throw new Error(`Unsupported SimCloud vendor lock schema: ${String(vendorLock.schema)}`);
  }
  const consumerManifest = await readJson(path.join(simcloudRoot, config.consumerManifest));
  const consumerLock = await readJson(path.join(simcloudRoot, config.consumerLock));
  const dependencies = allDependencies(consumerManifest);
  const lockedByName = new Map(vendorLock.packages.map((entry) => [entry.name, entry]));
  const expectedNames = new Set();
  const packages = [];

  if (vendorLock.stackVersion !== stack.stackVersion) {
    violations.push(violation('STACK_VERSION_MISMATCH', `SimCloud stack ${vendorLock.stackVersion} does not match SimForge ${stack.stackVersion}.`));
  }
  if (vendorLock.source?.repository !== stack.repository) {
    violations.push(violation('SOURCE_REPOSITORY_MISMATCH', 'SimCloud vendor lock does not name the canonical SimForge repository.'));
  }
  if (config.requireExactSourceRevision && vendorLock.source?.revision !== sourceRevision) {
    violations.push(violation('SOURCE_REVISION_MISMATCH', `SimCloud consumes ${vendorLock.source?.revision ?? 'no revision'}, not SimForge HEAD ${sourceRevision}.`));
  }

  for (const packageEntry of stack.packages) {
    const packageJson = await readJson(path.join(simforgeRoot, packageEntry.path, 'package.json'));
    const name = packageJson.name;
    expectedNames.add(name);
    const locked = lockedByName.get(name);
    const packageViolations = [];
    if (packageJson.version !== stack.stackVersion) packageViolations.push('source-version');
    if (!locked) {
      packageViolations.push('missing-vendor-lock-entry');
      violations.push(violation('PACKAGE_MISSING', `${name} is absent from the SimCloud vendor lock.`, { package: name }));
      packages.push({ name, role: packageEntry.role, status: 'fail', violations: packageViolations });
      continue;
    }
    if (locked.version !== packageJson.version || locked.version !== vendorLock.stackVersion) packageViolations.push('version');
    if (locked.role !== packageEntry.role) packageViolations.push('role');
    const expectedReference = `file:vendor/uniscenarios/${locked.tarball}`;
    if (dependencies[name] !== expectedReference) packageViolations.push('consumer-reference');

    const tarballPath = path.join(simcloudRoot, 'vendor/uniscenarios', locked.tarball);
    if (!(await exists(tarballPath))) {
      packageViolations.push('missing-tarball');
    } else {
      const bytes = await readFile(tarballPath);
      if (digest('sha256', bytes) !== locked.sha256) packageViolations.push('sha256');
      const installedLock = consumerLock.packages?.[`node_modules/${name}`];
      const expectedIntegrity = `sha512-${digest('sha512', bytes, 'base64')}`;
      if (!installedLock?.resolved?.endsWith(`vendor/uniscenarios/${locked.tarball}`)) packageViolations.push('lock-resolution');
      if (installedLock?.integrity !== expectedIntegrity) packageViolations.push('lock-integrity');
    }
    if (packageViolations.length > 0) {
      violations.push(violation('PACKAGE_CONTRACT_MISMATCH', `${name} violates: ${packageViolations.join(', ')}.`, { package: name }));
    }
    packages.push({
      name,
      role: packageEntry.role,
      version: packageJson.version,
      tarball: locked.tarball,
      status: packageViolations.length === 0 ? 'pass' : 'fail',
      violations: packageViolations,
    });
  }

  for (const name of lockedByName.keys()) {
    if (!expectedNames.has(name)) violations.push(violation('UNEXPECTED_PACKAGE', `${name} is not in the canonical public stack.`, { package: name }));
  }

  const expectedPythonVersion = stack.stackVersion.replace(/-rc\.(\d+)$/u, 'rc$1');
  const lockedPythonByName = new Map((vendorLock.pythonPackages ?? []).map((entry) => [entry.name, entry]));
  const expectedPythonNames = new Set();
  const pythonPackages = [];
  const pythonConsumer = config.pythonConsumerManifest
    ? await readFile(path.join(simcloudRoot, config.pythonConsumerManifest), 'utf8')
    : '';
  const pythonConsumerLock = config.pythonConsumerLock
    ? await readFile(path.join(simcloudRoot, config.pythonConsumerLock), 'utf8')
    : '';
  for (const source of stack.pythonPackages ?? []) {
    expectedPythonNames.add(source.name);
    const locked = lockedPythonByName.get(source.name);
    const packageViolations = [];
    if (source.version !== expectedPythonVersion) packageViolations.push('source-version');
    if (!locked) {
      packageViolations.push('missing-vendor-lock-entry');
      violations.push(violation('PYTHON_PACKAGE_MISSING', `${source.name} is absent from the SimCloud vendor lock.`, { package: source.name }));
      pythonPackages.push({ name: source.name, role: source.role, status: 'fail', violations: packageViolations });
      continue;
    }
    if (locked.version !== source.version || locked.version !== expectedPythonVersion) packageViolations.push('version');
    if (locked.role !== source.role || locked.registry !== source.registry) packageViolations.push('publication');
    const wheelPath = path.join(simcloudRoot, 'vendor/uniscenarios', locked.wheel);
    if (!(await exists(wheelPath))) {
      packageViolations.push('missing-wheel');
    } else if (digest('sha256', await readFile(wheelPath)) !== locked.sha256) {
      packageViolations.push('sha256');
    }
    if (!pythonConsumer.includes(`${source.name}==${source.version}`)) packageViolations.push('consumer-version');
    if (!pythonConsumerLock.includes(locked.wheel)) packageViolations.push('consumer-lock');
    if (packageViolations.length > 0) {
      violations.push(violation('PYTHON_PACKAGE_CONTRACT_MISMATCH', `${source.name} violates: ${packageViolations.join(', ')}.`, { package: source.name }));
    }
    pythonPackages.push({
      name: source.name,
      role: source.role,
      version: source.version,
      wheel: locked.wheel,
      status: packageViolations.length === 0 ? 'pass' : 'fail',
      violations: packageViolations,
    });
  }
  for (const name of lockedPythonByName.keys()) {
    if (!expectedPythonNames.has(name)) {
      violations.push(violation('UNEXPECTED_PYTHON_PACKAGE', `${name} is not in the canonical public stack.`, { package: name }));
    }
  }
  return { stack, vendorLock, packages, pythonPackages };
}

async function auditOwnership({ simcloudRoot, config, violations }) {
  const ownership = [];
  for (const relativePath of config.forbiddenPaths) {
    const absolutePath = path.join(simcloudRoot, relativePath);
    let files = [];
    if (await exists(absolutePath)) {
      const metadata = await stat(absolutePath);
      files = metadata.isDirectory() ? await collectFiles(absolutePath) : [path.basename(relativePath)];
    }
    const status = files.length === 0 ? 'pass' : 'fail';
    if (status === 'fail') {
      violations.push(violation('FORBIDDEN_IMPLEMENTATION', `Shared implementation returned at ${relativePath}.`, { path: relativePath, files }));
    }
    ownership.push({ type: 'forbidden-path', path: relativePath, status, files });
  }

  for (const adapter of config.adapterSurfaces) {
    const files = await collectFiles(path.join(simcloudRoot, adapter.path));
    const allowed = new Set(adapter.allowedFiles);
    const unexpected = files.filter((file) => !allowed.has(file));
    const status = unexpected.length === 0 ? 'pass' : 'fail';
    if (status === 'fail') {
      violations.push(violation('UNAPPROVED_ADAPTER_FILE', `${adapter.id} contains shared or unapproved files.`, { path: adapter.path, files: unexpected }));
    }
    ownership.push({ type: 'adapter-surface', id: adapter.id, path: adapter.path, status, files, unexpected });
  }
  return ownership;
}

async function auditImports({ simcloudRoot, config, violations }) {
  const patterns = config.forbiddenImportPatterns.map((pattern) => new RegExp(pattern, 'u'));
  const ignoredFiles = new Set(config.importScanIgnoreFiles ?? []);
  const findings = [];
  for (const root of config.sourceScanRoots) {
    for (const relativeFile of await collectFiles(path.join(simcloudRoot, root))) {
      const file = path.posix.join(root, relativeFile);
      if (ignoredFiles.has(file)) continue;
      if (!IMPORT_SCAN_EXTENSIONS.has(path.extname(file))) continue;
      let source;
      try {
        source = await readFile(path.join(simcloudRoot, file), 'utf8');
      } catch (error) {
        if (error?.code === 'EISDIR') continue;
        throw error;
      }
      for (const pattern of patterns) {
        if (pattern.test(source)) findings.push({ file, pattern: pattern.source });
      }
    }
  }
  if (findings.length > 0) {
    violations.push(violation('FORBIDDEN_IMPORT', 'SimCloud source still references retired private implementations.', { findings }));
  }
  return findings;
}

export async function auditDivergence({ simforgeRoot, simcloudRoot, includeGitRevisions = true }) {
  const config = await readJson(path.join(simforgeRoot, 'config/simcloud-integration.json'));
  if (config.schema !== 'uniscenarios.simcloud-integration/v2') {
    throw new Error(`Unsupported integration config schema: ${String(config.schema)}`);
  }
  if (!(await stat(simcloudRoot)).isDirectory()) throw new Error('simcloudRoot must be a directory');

  const sourceRevision = includeGitRevisions ? revision(simforgeRoot) : undefined;
  const violations = [];
  const { stack, vendorLock, packages, pythonPackages } = await auditPackages({
    simforgeRoot,
    simcloudRoot,
    config,
    sourceRevision,
    violations,
  });
  const ownership = await auditOwnership({ simcloudRoot, config, violations });
  const forbiddenImports = await auditImports({ simcloudRoot, config, violations });

  return {
    schema: 'uniscenarios.simcloud-anti-drift/v2',
    status: violations.length === 0 ? 'pass' : 'fail',
    repositories: {
      simforge: {
        repository: stack.repository,
        stackVersion: stack.stackVersion,
        ...(includeGitRevisions ? { revision: sourceRevision } : {}),
      },
      simcloud: {
        repository: config.platformRepository,
        stackVersion: vendorLock.stackVersion,
        sourceRevision: vendorLock.source?.revision,
        ...(includeGitRevisions ? { revision: revision(simcloudRoot) } : {}),
      },
    },
    packages,
    pythonPackages,
    ownership,
    forbiddenImports,
    violations,
  };
}
