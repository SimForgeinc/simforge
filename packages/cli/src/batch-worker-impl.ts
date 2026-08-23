/**
 * Batch worker thread.
 *
 * The engine is synchronous CPU work, so a promise pool in one thread buys
 * nothing — the parallelism has to be real threads. Each worker parses the
 * template once, builds its own map bundles on demand, and then answers cell
 * requests one at a time; the parent hands out work rather than pre-sharding it,
 * so one slow map cannot leave three workers idle.
 *
 * Determinism is unaffected: a cell's output depends only on its coordinates.
 */

import { parentPort, workerData } from 'node:worker_threads';

import { runCell, type CellOptions, type CellResult } from './batch-cell.js';
import { readTemplate } from '@uniscenarios/scenario-materializer';

interface WorkerInit {
  readonly templateFile: string;
}

interface CellRequest {
  readonly kind: 'cell';
  readonly id: number;
  readonly options: CellOptions;
}

type Request = CellRequest | { kind: 'stop' };

async function main(): Promise<void> {
  const port = parentPort;
  if (!port) throw new Error('batch-worker must run as a worker thread');
  const init = workerData as WorkerInit;
  const template = await readTemplate(init.templateFile);
  let queue: Promise<void> = Promise.resolve();

  port.on('message', (message: Request) => {
    if (message.kind === 'stop') {
      port.close();
      return;
    }
    queue = queue.then(async () => {
      const result: CellResult = await runCell(template, message.options);
      port.postMessage({ kind: 'done', id: message.id, result });
    });
  });
  port.postMessage({ kind: 'ready' });
}

void main();
