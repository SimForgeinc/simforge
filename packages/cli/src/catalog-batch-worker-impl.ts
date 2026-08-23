import { parentPort, workerData } from 'node:worker_threads';

import { runCell, type CellOptions } from './batch-cell.js';
import { readTemplate } from '@simforge/compiler';

interface WorkerInput {
  readonly templateFile: string;
  readonly options: CellOptions;
}

async function main(): Promise<void> {
  const port = parentPort;
  if (!port) throw new Error('catalog-batch-worker must run in a worker thread');
  const input = workerData as WorkerInput;
  const template = await readTemplate(input.templateFile);
  port.postMessage(await runCell(template, input.options));
}

void main();
