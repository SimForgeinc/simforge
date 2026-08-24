/** Rolling frame-time window with an avg/p95 readout. */
export class FrameStats {
  private readonly samples: number[];
  private index = 0;
  private filled = 0;
  private readonly scratch: number[];

  constructor(private readonly window = 120) {
    this.samples = new Array<number>(window).fill(0);
    this.scratch = new Array<number>(window).fill(0);
  }

  push(ms: number): void {
    this.samples[this.index] = ms;
    this.index = (this.index + 1) % this.window;
    if (this.filled < this.window) this.filled++;
  }

  get count(): number {
    return this.filled;
  }

  avg(): number {
    if (this.filled === 0) return 0;
    let total = 0;
    for (let i = 0; i < this.filled; i++) total += this.samples[i] ?? 0;
    return total / this.filled;
  }

  percentile(p: number): number {
    if (this.filled === 0) return 0;
    for (let i = 0; i < this.filled; i++) this.scratch[i] = this.samples[i] ?? 0;
    const slice = this.scratch.slice(0, this.filled).sort((a, b) => a - b);
    const idx = Math.min(slice.length - 1, Math.max(0, Math.round(p * (slice.length - 1))));
    return slice[idx] ?? 0;
  }

  max(): number {
    let worst = 0;
    for (let i = 0; i < this.filled; i++) worst = Math.max(worst, this.samples[i] ?? 0);
    return worst;
  }

  countAbove(ms: number): number {
    let count = 0;
    for (let i = 0; i < this.filled; i++) {
      if ((this.samples[i] ?? 0) > ms) count++;
    }
    return count;
  }

  snapshot(): number[] {
    return this.samples.slice(0, this.filled);
  }

  reset(): void {
    this.index = 0;
    this.filled = 0;
  }
}

export function jsHeapMB(): number | null {
  const perf = performance as unknown as { memory?: { usedJSHeapSize: number } };
  const used = perf.memory?.usedJSHeapSize;
  return typeof used === 'number' ? used / (1024 * 1024) : null;
}
