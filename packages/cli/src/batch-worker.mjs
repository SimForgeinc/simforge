/**
 * Worker-thread entry.
 *
 * A plain `.mjs` shim rather than the TypeScript module itself: a worker thread
 * gets its own module registry, so it needs its own `tsx` registration before
 * it can resolve `./batch-cell.js` onto `batch-cell.ts`. Doing that with
 * `execArgv: ['--import', 'tsx']` registers hooks for the worker's *entry* but
 * not for the `.js`-specifier rewrite its imports rely on; registering inside
 * the thread — exactly as `bin/simforge.js` does for the main thread — does.
 */
import { register } from 'tsx/esm/api';

register();
await import('./batch-worker-impl.ts');
