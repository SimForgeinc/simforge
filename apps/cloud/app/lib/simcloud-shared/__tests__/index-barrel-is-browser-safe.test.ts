import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `packages/shared/src/index.ts` is imported by browser code. Anything
 * transitively reachable from it therefore ends up in the client bundle, and a
 * `node:` builtin there fails `next build` with:
 *
 *   Module build failed: UnhandledSchemeError:
 *   Reading from "node:crypto" is not handled by plugins
 *
 * That is a build-time failure, so unit tests, typecheck and lint all pass
 * while the app cannot compile — which is exactly how it reached CI once
 * (the autogen-import builder was re-exported from the barrel, dragging
 * node:crypto and node:fs/promises into the browser).
 *
 * This walks the real import graph so the mistake fails here in seconds
 * instead of several minutes into a build.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

/** Node-only modules that must never be reachable from the barrel. */
const NODE_SCHEME = /^node:/;
/** Bare specifiers that are node builtins without the `node:` prefix. */
const BARE_BUILTINS = new Set([
  "fs",
  "path",
  "crypto",
  "os",
  "child_process",
  "worker_threads",
  "http",
  "https",
  "net",
  "tls",
  "zlib",
  "stream",
  "readline",
]);

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;

function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    resolve(base, "index.ts"),
    resolve(base, "index.tsx"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function walk(entry: string): { file: string; spec: string }[] {
  const seen = new Set<string>();
  const offenders: { file: string; spec: string }[] = [];
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);

    const source = readFileSync(file, "utf8");
    const specs: string[] = [];
    for (const re of [IMPORT_RE, BARE_IMPORT_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) specs.push(m[1] as string);
    }

    for (const spec of specs) {
      if (NODE_SCHEME.test(spec) || BARE_BUILTINS.has(spec)) {
        offenders.push({ file: file.slice(SRC.length + 1), spec });
        continue;
      }
      const next = resolveLocal(file, spec);
      if (next) queue.push(next);
    }
  }

  return offenders;
}

describe("shared barrel stays browser-safe", () => {
  it("reaches no node builtin from src/index.ts", () => {
    const offenders = walk(resolve(SRC, "index.ts"));
    expect(
      offenders,
      `node builtins reachable from the shared barrel — these will break ` +
        `next build:\n` +
        offenders.map((o) => `  ${o.file} imports "${o.spec}"`).join("\n"),
    ).toEqual([]);
  });

  it("still detects a builtin when one is reachable", () => {
    // Guards the guard: the walker must actually find node: imports, so a
    // silently-broken traversal cannot make the check above vacuously pass.
    const nodeOnly = resolve(SRC, "autogen-import/evidence.ts");
    expect(existsSync(nodeOnly)).toBe(true);
    expect(walk(nodeOnly).length).toBeGreaterThan(0);
  });
});
