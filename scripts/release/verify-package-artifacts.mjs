import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyPackageArtifacts } from './package-artifact-lib.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const verified = await verifyPackageArtifacts({ repoRoot });
process.stdout.write(`${JSON.stringify({ schema: 'simforge.package-artifacts/v1', verified }, null, 2)}\n`);
