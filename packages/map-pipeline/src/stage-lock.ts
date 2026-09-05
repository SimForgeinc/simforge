import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * The A100/Linux builder uses kernel advisory locks, including across shared
 * filesystems. A builder crash closes the pipe and releases the lock; no stale
 * PID eviction or elapsed-time lease can delete another live builder's lock.
 */
export async function withStageLock<T>(directory: string, build: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true });
  const owner = spawn('flock', ['--exclusive', path.join(directory, '.build-lock'), 'cat'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  owner.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
  const closed = new Promise<void>((resolve, reject) => {
    owner.on('error', reject);
    owner.stdin.on('error', reject);
    owner.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`map stage lock failed (${signal ?? code}); flock(1) is required: ${stderr}`));
    });
  });
  const acquired = new Promise<void>((resolve) => owner.stdout.once('data', () => resolve()));
  owner.stdin.write('locked\n');
  await Promise.race([acquired, closed.then(() => { throw new Error('map stage lock exited before acquisition'); })]);
  try {
    return await build();
  } finally {
    owner.stdin.end();
    await closed;
  }
}
