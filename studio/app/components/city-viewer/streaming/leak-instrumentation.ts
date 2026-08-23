// Diagnostic Three.js leak-tracking instrumentation. Activated by
// `?debug=1&leaktest=1`; otherwise installs as a no-op.
//
// Pure logic (LeakCounters, findOrphans, isLeakInstrumentationActive,
// readJsHeapMB) is exported for unit testing; installLeakInstrumentation
// performs the side-effectful patching of THREE class references and
// exposes `window.__leakInstr` for DevTools use.

export type LeakCategory = "texture" | "geometry" | "material" | "render-target";

export interface CounterRow {
  category: LeakCategory;
  key: string;
  created: number;
  disposed: number;
  outstanding: number;
}

export interface LeakSnapshot {
  label: string;
  timestamp: number;
  jsHeapMB: number | null;
  counters: CounterRow[];
}

export interface LeakDiffRow {
  category: LeakCategory;
  key: string;
  createdDelta: number;
  disposedDelta: number;
  outstandingDelta: number;
}

export interface LeakDiff {
  labelA: string;
  labelB: string;
  jsHeapDeltaMB: number | null;
  rows: LeakDiffRow[];
}

export class LeakCounters {
  private counters = new Map<string, CounterRow>();
  private snapshots = new Map<string, LeakSnapshot>();

  private id(category: LeakCategory, key: string): string {
    return `${category}:${key}`;
  }

  recordCreate(category: LeakCategory, key: string): void {
    const row = this.ensureRow(category, key);
    row.created += 1;
    row.outstanding = row.created - row.disposed;
  }

  recordDispose(category: LeakCategory, key: string): void {
    const row = this.ensureRow(category, key);
    row.disposed += 1;
    row.outstanding = row.created - row.disposed;
  }

  private ensureRow(category: LeakCategory, key: string): CounterRow {
    const id = this.id(category, key);
    let row = this.counters.get(id);
    if (!row) {
      row = { category, key, created: 0, disposed: 0, outstanding: 0 };
      this.counters.set(id, row);
    }
    return row;
  }

  rows(): CounterRow[] {
    return Array.from(this.counters.values()).map((r) => ({ ...r }));
  }

  rowsSortedByOutstanding(): CounterRow[] {
    return this.rows().sort((a, b) => b.outstanding - a.outstanding);
  }

  size(): number {
    return this.counters.size;
  }

  reset(): void {
    this.counters.clear();
    this.snapshots.clear();
  }

  snapshot(label: string, jsHeapMB: number | null = null): LeakSnapshot {
    const snap: LeakSnapshot = {
      label,
      timestamp: Date.now(),
      jsHeapMB,
      counters: this.rows(),
    };
    this.snapshots.set(label, snap);
    return snap;
  }

  diff(labelA: string, labelB: string): LeakDiff {
    const a = this.snapshots.get(labelA);
    const b = this.snapshots.get(labelB);
    if (!a) throw new Error(`leak-instrumentation: snapshot "${labelA}" missing`);
    if (!b) throw new Error(`leak-instrumentation: snapshot "${labelB}" missing`);

    const aMap = new Map(a.counters.map((r) => [`${r.category}:${r.key}`, r]));
    const bMap = new Map(b.counters.map((r) => [`${r.category}:${r.key}`, r]));
    const allIds = new Set([...aMap.keys(), ...bMap.keys()]);

    const rows: LeakDiffRow[] = [];
    for (const id of allIds) {
      const ra = aMap.get(id);
      const rb = bMap.get(id);
      const seed = ra ?? rb!;
      rows.push({
        category: seed.category,
        key: seed.key,
        createdDelta: (rb?.created ?? 0) - (ra?.created ?? 0),
        disposedDelta: (rb?.disposed ?? 0) - (ra?.disposed ?? 0),
        outstandingDelta: (rb?.outstanding ?? 0) - (ra?.outstanding ?? 0),
      });
    }

    return {
      labelA,
      labelB,
      jsHeapDeltaMB:
        a.jsHeapMB !== null && b.jsHeapMB !== null
          ? Math.round((b.jsHeapMB - a.jsHeapMB) * 10) / 10
          : null,
      rows: rows.sort(
        (x, y) => Math.abs(y.outstandingDelta) - Math.abs(x.outstandingDelta),
      ),
    };
  }

  hasSnapshot(label: string): boolean {
    return this.snapshots.has(label);
  }
}

// ---------------------------------------------------------------------------
// findOrphans — dispose verification
// ---------------------------------------------------------------------------

export interface OrphanReport {
  source: "scene" | "cache";
  type: "mesh" | "geometry" | "material" | "texture";
  uuid: string;
  cacheKey?: string;
}

interface MinimalObject3D {
  uuid: string;
  isMesh?: boolean;
  isGroup?: boolean;
  geometry?: { uuid: string };
  material?: { uuid: string } | { uuid: string }[];
  traverse: (fn: (obj: MinimalObject3D) => void) => void;
}

export function findOrphans(
  disposedGroup: MinimalObject3D,
  scene: MinimalObject3D,
  remainingEntries: Iterable<{ key: string; group: MinimalObject3D }>,
): OrphanReport[] {
  const meshUUIDs = new Set<string>();
  const geomUUIDs = new Set<string>();
  const matUUIDs = new Set<string>();

  disposedGroup.traverse((obj) => {
    if (obj.isMesh) {
      meshUUIDs.add(obj.uuid);
      if (obj.geometry) geomUUIDs.add(obj.geometry.uuid);
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) if (m) matUUIDs.add(m.uuid);
      }
    }
  });

  const orphans: OrphanReport[] = [];

  const checkObject = (obj: MinimalObject3D, source: "scene" | "cache", cacheKey?: string) => {
    if (obj.isMesh) {
      if (meshUUIDs.has(obj.uuid)) {
        orphans.push({ source, type: "mesh", uuid: obj.uuid, ...(cacheKey ? { cacheKey } : {}) });
      }
      if (obj.geometry && geomUUIDs.has(obj.geometry.uuid)) {
        orphans.push({
          source,
          type: "geometry",
          uuid: obj.geometry.uuid,
          ...(cacheKey ? { cacheKey } : {}),
        });
      }
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (m && matUUIDs.has(m.uuid)) {
            orphans.push({
              source,
              type: "material",
              uuid: m.uuid,
              ...(cacheKey ? { cacheKey } : {}),
            });
          }
        }
      }
    }
  };

  scene.traverse((obj) => checkObject(obj, "scene"));
  for (const entry of remainingEntries) {
    entry.group.traverse((obj) => checkObject(obj, "cache", entry.key));
  }

  return orphans;
}

// ---------------------------------------------------------------------------
// Activation flag + heap reader
// ---------------------------------------------------------------------------

export function isLeakInstrumentationActive(search?: string): boolean {
  let s = search;
  if (s === undefined) {
    if (typeof window === "undefined") return false;
    s = window.location.search;
  }
  const params = new URLSearchParams(s);
  return params.get("debug") === "1" && params.get("leaktest") === "1";
}

interface PerfMemory {
  memory?: { usedJSHeapSize?: number };
}

export function readJsHeapMB(perf?: PerfMemory): number | null {
  // typed-narrow: prefer the explicit arg over global performance
  const target =
    perf ?? (typeof performance !== "undefined" ? (performance as unknown as PerfMemory) : undefined);
  if (!target || !target.memory || typeof target.memory.usedJSHeapSize !== "number") return null;
  return Math.round((target.memory.usedJSHeapSize / (1024 * 1024)) * 10) / 10;
}

// ---------------------------------------------------------------------------
// installLeakInstrumentation — side-effectful prototype/class patching
// ---------------------------------------------------------------------------

interface ThreeNamespace {
  Texture: new (...args: unknown[]) => { name?: string; uuid?: string; dispose?: () => void };
  BufferGeometry: new (...args: unknown[]) => { name?: string; uuid?: string; dispose?: () => void };
  Material: new (...args: unknown[]) => { name?: string; uuid?: string; dispose?: () => void };
  WebGLRenderTarget?: new (...args: unknown[]) => { dispose?: () => void };
  WebGPURenderTarget?: new (...args: unknown[]) => { dispose?: () => void };
}

export interface InstalledLeakInstr {
  active: boolean;
  counters: LeakCounters;
  uninstall: () => void;
}

interface InstallOpts {
  THREE?: ThreeNamespace;
  windowRef?: Record<string, unknown>;
  search?: string;
  intervalMs?: number;
  measureRenderTargets?: () => { count: number; estimatedBytes: number };
  setIntervalRef?: typeof setInterval;
  clearIntervalRef?: typeof clearInterval;
}

export function installLeakInstrumentation(opts: InstallOpts = {}): InstalledLeakInstr {
  const counters = new LeakCounters();
  const active = isLeakInstrumentationActive(opts.search);

  if (!active || !opts.THREE) {
    return {
      active: false,
      counters,
      uninstall: () => {},
    };
  }

  const THREE = opts.THREE;
  const intervalMs = opts.intervalMs ?? 10_000;
  const setIntervalFn = opts.setIntervalRef ?? setInterval;
  const clearIntervalFn = opts.clearIntervalRef ?? clearInterval;

  const restoreFns: Array<() => void> = [];

  // The THREE binding here is the ES Module Namespace Object that
  // webpack/Next emits in prod (`next build`). Its exports are
  // spec-mandated getter-only — writing back to `holder[propName]` throws
  // `TypeError: Cannot set property Texture of #<Object> which has only a
  // getter`, which is exactly the boot crash from ABH-108. We therefore
  // never assign to the namespace; we only *read* (which works fine
  // through the getter) and patch the resulting classes' prototypes
  // instead — those objects are mutable in their properties even when
  // the namespace slot they live behind is frozen.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const holder = THREE as unknown as Record<string, any>;

  // Some THREE-class shapes resolve through aliases to the same constructor
  // (e.g. in tests where WebGLRenderTarget and WebGPURenderTarget point at
  // a single fake). Track prototypes we've already patched in this install
  // call so the second wrapClass call is a no-op for those aliases and we
  // don't double-count disposes.
  const patchedProtos = new WeakSet<object>();

  const wrapClass = (propName: string, category: LeakCategory): void => {
    let Original: unknown;
    try {
      Original = holder[propName];
    } catch {
      return;
    }
    if (typeof Original !== "function") return;
    const proto = (Original as { prototype?: object }).prototype as
      | Record<string, unknown>
      | undefined;
    if (!proto || typeof proto !== "object") return;

    if (patchedProtos.has(proto)) return;
    patchedProtos.add(proto);

    // 1. Patch `prototype.dispose` to count disposes. The prototype object
    //    itself is writable in its data properties even when the
    //    namespace export that points at the constructor is getter-only.
    const disposeWasOwn = Object.prototype.hasOwnProperty.call(proto, "dispose");
    const origDispose = proto.dispose;
    if (typeof origDispose === "function") {
      const wrappedDispose = function (
        this: { name?: string; uuid?: string },
        ...args: unknown[]
      ): unknown {
        counters.recordDispose(category, originKey(this));
        return (origDispose as (...a: unknown[]) => unknown).apply(this, args);
      };
      proto.dispose = wrappedDispose;
      restoreFns.push(() => {
        if (disposeWasOwn) {
          proto.dispose = origDispose;
        } else {
          delete proto.dispose;
        }
      });
    }

    // 2. Install a property-setter trap on the prototype for a property
    //    the constructor writes every instance — that's how we count
    //    creates without owning the `new` call (which would require
    //    rebinding the namespace slot).
    //
    //    For Texture / BufferGeometry / Material we trap `name`, because
    //    three.js writes `this.name = ''` AFTER `this.uuid = generateUUID()`
    //    so the originKey lookup inside our setter gets a populated uuid.
    //    For render targets the constructor doesn't set `name`, so we
    //    trap the per-class `is<X>` flag (`isWebGLRenderTarget`,
    //    `isWebGPURenderTarget`); render targets have neither name nor
    //    uuid in three.js, so the key collapses to "unnamed" — matching
    //    the pre-ABH-108 wrapper behavior.
    const trapProp =
      propName === "WebGLRenderTarget" || propName === "WebGPURenderTarget"
        ? `is${propName}`
        : "name";

    // Defensive: if something else already installed a setter or made
    // this slot non-configurable, skip create-tracking rather than break
    // their semantics. Dispose tracking already landed above.
    const existing = Object.getOwnPropertyDescriptor(proto, trapProp);
    if (existing && (existing.set || existing.configurable === false)) {
      return;
    }

    const seen = new WeakSet<object>();
    Object.defineProperty(proto, trapProp, {
      configurable: true,
      enumerable: true,
      get(): unknown {
        // Absent until the constructor writes to it; the setter below
        // promotes the value to an own property, which shadows this
        // accessor for the rest of the instance's lifetime.
        return undefined;
      },
      set(this: { name?: string; uuid?: string }, value: unknown) {
        if (!seen.has(this)) {
          seen.add(this);
          counters.recordCreate(category, originKey(this));
        }
        Object.defineProperty(this, trapProp, {
          value,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      },
    });
    restoreFns.push(() => {
      if (existing) {
        Object.defineProperty(proto, trapProp, existing);
      } else {
        delete proto[trapProp];
      }
    });
  };

  wrapClass("Texture", "texture");
  wrapClass("BufferGeometry", "geometry");
  wrapClass("Material", "material");
  wrapClass("WebGLRenderTarget", "render-target");
  wrapClass("WebGPURenderTarget", "render-target");

  // Periodic render-target snapshot
  let intervalId: ReturnType<typeof setInterval> | null = null;
  if (opts.measureRenderTargets) {
    const measure = opts.measureRenderTargets;
    intervalId = setIntervalFn(() => {
      const { count, estimatedBytes } = measure();
      console.debug(
        `[LeakInstr] render-targets: count=${count} bytes=${(estimatedBytes / (1024 * 1024)).toFixed(1)}MB`,
      );
    }, intervalMs);
  }

  // Install global API
  if (opts.windowRef) {
    opts.windowRef.__leakInstr = {
      counters,
      dump: () => {
        const rows = counters.rowsSortedByOutstanding();
        console.table(rows);
        return rows;
      },
      snapshot: (label: string) => counters.snapshot(label, readJsHeapMB()),
      diff: (a: string, b: string) => {
        const d = counters.diff(a, b);
        console.table(d.rows);
        return d;
      },
    };
  }

  console.log("[LeakInstr] active — call window.__leakInstr.dump() in console");

  return {
    active: true,
    counters,
    uninstall: () => {
      for (const r of restoreFns) r();
      if (intervalId !== null) clearIntervalFn(intervalId);
      if (opts.windowRef) delete opts.windowRef.__leakInstr;
    },
  };
}

function originKey(inst: { name?: string; uuid?: string }): string {
  if (inst.name && inst.name.length > 0) return inst.name;
  if (inst.uuid) return inst.uuid;
  return "unnamed";
}
