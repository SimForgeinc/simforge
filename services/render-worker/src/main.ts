import { loadRenderWorkerConfig } from './config.js';
import { startWorkerHealthServer } from './health.js';
import { assertWorkerBinaries } from './preflight.js';
import { createControlTransport } from './transport.js';
import { runRenderWorker } from './worker.js';

function configPath(argv: readonly string[]): string {
  const index = argv.indexOf('--config');
  const path = index >= 0 ? argv[index + 1] : undefined;
  if (!path || argv.length !== 2) throw new Error('usage: uniscenarios-render-worker --config <worker.json>');
  return path;
}

export async function main(argv: readonly string[]): Promise<void> {
  const config = await loadRenderWorkerConfig(configPath(argv));
  await assertWorkerBinaries(config);
  const health = await startWorkerHealthServer(config.health.host, config.health.port);
  const drain = new AbortController();
  let signalCount = 0;
  const onSignal = (signal: NodeJS.Signals): void => {
    signalCount += 1;
    if (signalCount === 1) drain.abort(new Error(`draining after ${signal}`));
    else process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const transport = await createControlTransport(config);
    await runRenderWorker(config, transport, health, drain.signal);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await health.close();
  }
}

if (process.argv[1]?.endsWith('/main.js') || process.argv[1]?.endsWith('/main.ts')) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      code: 'render_worker_failed',
      message: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  });
}
