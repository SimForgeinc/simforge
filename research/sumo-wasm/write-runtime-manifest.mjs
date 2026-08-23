import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [outputArgument, sumoSourceArgument, xercesSourceArgument] = process.argv.slice(2);
if (!outputArgument || !sumoSourceArgument || !xercesSourceArgument) {
  console.error('usage: node write-runtime-manifest.mjs <output> <sumo-source> <xerces-source>');
  process.exit(2);
}
const output = resolve(outputArgument);
const licenses = join(output, 'licenses');
await mkdir(licenses, { recursive: true });
await copyFile(join(resolve(sumoSourceArgument), 'LICENSE'), join(licenses, 'SUMO-EPL-2.0.txt'));
await copyFile(join(resolve(xercesSourceArgument), 'LICENSE'), join(licenses, 'Xerces-Apache-2.0.txt'));
const wasmBytes = (await stat(join(output, 'sumo.wasm'))).size;
const wasmGzipBytes = (await stat(join(output, 'sumo.wasm.gz'))).size;
const sourceOffer = 'https://github.com/eclipse-sumo/sumo/tree/v1_27_1 plus research/sumo-wasm/patches/sumo-1.27.1-emscripten.patch and research/sumo-wasm/build.sh';
const notice = `# Browser traffic runtime notices

This distribution contains Eclipse SUMO 1.27.1 under the EPL-2.0 option and
Apache Xerces-C++ 3.2.5 under Apache-2.0. Exact license texts are in licenses/.

Corresponding source and local changes: ${sourceOffer}

SUMO commit: 7717f2379d9e314a0c81c5cec748444de06a2a91
Xerces commit: 53c16411466bf90c62617831fe92ed0f41e70882
`;
await writeFile(join(output, 'THIRD_PARTY_NOTICES.md'), notice);
await writeFile(join(output, 'runtime-manifest.json'), `${JSON.stringify({
  schema: 'uniscenarios.sumo-runtime.v1',
  sumoVersion: '1.27.1',
  sumoCommit: '7717f2379d9e314a0c81c5cec748444de06a2a91',
  xercesVersion: '3.2.5',
  xercesCommit: '53c16411466bf90c62617831fe92ed0f41e70882',
  wasmBytes,
  wasmGzipBytes,
  licenseNotice: 'THIRD_PARTY_NOTICES.md',
  sourceOffer,
}, null, 2)}\n`);

// Fail the package step if a license source unexpectedly disappeared.
await readFile(join(licenses, 'SUMO-EPL-2.0.txt'));
await readFile(join(licenses, 'Xerces-Apache-2.0.txt'));
