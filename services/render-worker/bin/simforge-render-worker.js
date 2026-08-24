#!/usr/bin/env node
import('../dist/main.js').then(({ main }) => main(process.argv.slice(2))).catch((error) => {
  process.stderr.write(`${JSON.stringify({
    code: 'render_worker_failed',
    message: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});
