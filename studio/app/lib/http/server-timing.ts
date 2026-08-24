type ServerTimingEntry = { name: string; durationMs: number };

function metricName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_");
  return normalized || "operation";
}

/** Small request-scoped Server-Timing recorder for observable loading paths. */
export class ServerTimingRecorder {
  private readonly startedAt = performance.now();
  private readonly entries: ServerTimingEntry[] = [];
  private finished = false;

  async measure<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      return await operation();
    } finally {
      this.entries.push({
        name: metricName(name),
        durationMs: performance.now() - startedAt,
      });
    }
  }

  measureSync<T>(name: string, operation: () => T): T {
    const startedAt = performance.now();
    try {
      return operation();
    } finally {
      this.entries.push({
        name: metricName(name),
        durationMs: performance.now() - startedAt,
      });
    }
  }

  finish<T extends Response>(response: T): T {
    if (this.finished) return response;
    this.finished = true;
    this.entries.push({
      name: "total",
      durationMs: performance.now() - this.startedAt,
    });
    const value = this.entries.map(({ name, durationMs }) => `${name};dur=${durationMs.toFixed(1)}`).join(", ");
    const existing = response.headers.get("server-timing");
    const combined = existing ? `${existing}, ${value}` : value;
    response.headers.set("server-timing", combined);
    // Vercel may consume the standard header at the edge. Mirror the same
    // value so preview/prod diagnostics remain observable end to end.
    response.headers.set("x-simforge-server-timing", combined);
    return response;
  }
}
