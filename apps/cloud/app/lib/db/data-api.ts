import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { Pool, type PoolClient } from "pg";
import { LOCAL_DATABASE_DIR } from "./config";

export type SqlPrimitive = string | number | boolean | null | Date;
export type SqlValue = SqlPrimitive | Record<string, unknown> | unknown[];
export type SqlParams = Record<string, SqlValue>;

type ExecuteOptions = {
  transactionId?: string;
  continueAfterTimeout?: boolean;
};

type Queryable = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
};

export type Transaction = {
  execute: (sql: string, params?: SqlParams) => Promise<void>;
  batchExecute: (sql: string, paramSets: SqlParams[]) => Promise<void>;
  queryRows: <T>(sql: string, params?: SqlParams) => Promise<T[]>;
  queryOne: <T>(sql: string, params?: SqlParams) => Promise<T | null>;
};

let pglitePromise: Promise<PGlite> | undefined;
let pool: Pool | undefined;
let operationTail: Promise<void> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const run = operationTail.then(operation, operation);
  operationTail = run.then(() => undefined, () => undefined);
  return run;
}

async function getPGlite(): Promise<PGlite> {
  if (!pglitePromise) {
    pglitePromise = (async () => {
      await mkdir(LOCAL_DATABASE_DIR, { recursive: true });
      return new PGlite(pathToFileURL(LOCAL_DATABASE_DIR).href);
    })();
  }
  return pglitePromise;
}

function getPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

function bindValue(value: SqlValue | undefined): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value) || typeof value === "object") return JSON.stringify(value);
  return value;
}

/** Convert Aurora Data API `:name` parameters without touching casts, strings or comments. */
function bindNamed(sql: string, params: SqlParams = {}): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  const positions = new Map<string, number>();
  let output = "";
  let index = 0;
  let state: "code" | "single" | "double" | "line" | "block" = "code";

  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (state === "single") {
      output += char;
      if (char === "'" && next === "'") { output += next; index += 2; continue; }
      if (char === "'") state = "code";
      index += 1;
      continue;
    }
    if (state === "double") {
      output += char;
      if (char === '"' && next === '"') { output += next; index += 2; continue; }
      if (char === '"') state = "code";
      index += 1;
      continue;
    }
    if (state === "line") {
      output += char;
      if (char === "\n") state = "code";
      index += 1;
      continue;
    }
    if (state === "block") {
      output += char;
      if (char === "*" && next === "/") { output += next; index += 2; state = "code"; continue; }
      index += 1;
      continue;
    }
    if (char === "'") { state = "single"; output += char; index += 1; continue; }
    if (char === '"') { state = "double"; output += char; index += 1; continue; }
    if (char === "-" && next === "-") { state = "line"; output += "--"; index += 2; continue; }
    if (char === "/" && next === "*") { state = "block"; output += "/*"; index += 2; continue; }
    if (char === ":" && sql[index - 1] !== ":" && next && /[A-Za-z_]/.test(next)) {
      let end = index + 2;
      while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end]!)) end += 1;
      const name = sql.slice(index + 1, end);
      if (!Object.prototype.hasOwnProperty.call(params, name)) {
        throw new Error(`Missing SQL parameter :${name}`);
      }
      let position = positions.get(name);
      if (!position) {
        values.push(bindValue(params[name]));
        position = values.length;
        positions.set(name, position);
      }
      output += `$${position}`;
      index = end;
      continue;
    }
    output += char;
    index += 1;
  }
  return { sql: output, values };
}

async function runRows<T>(target: Queryable, sql: string, params?: SqlParams): Promise<T[]> {
  const bound = bindNamed(sql, params);
  const result = await target.query(bound.sql, bound.values);
  return result.rows as T[];
}

async function standaloneTarget(): Promise<Queryable> {
  return process.env.DATABASE_URL?.trim() ? getPool() : getPGlite();
}

export async function execute(sql: string, params?: SqlParams, _options?: ExecuteOptions): Promise<void> {
  await serialize(async () => { await runRows(await standaloneTarget(), sql, params); });
}

export async function queryRows<T>(sql: string, params?: SqlParams, _options?: ExecuteOptions): Promise<T[]> {
  return serialize(async () => runRows<T>(await standaloneTarget(), sql, params));
}

export async function queryOne<T>(sql: string, params?: SqlParams, options?: ExecuteOptions): Promise<T | null> {
  const rows = await queryRows<T>(sql, params, options);
  return rows[0] ?? null;
}

export async function batchExecute(sql: string, paramSets: SqlParams[], _options?: ExecuteOptions): Promise<void> {
  if (paramSets.length === 0) return;
  await serialize(async () => {
    const target = await standaloneTarget();
    for (const params of paramSets) await runRows(target, sql, params);
  });
}

function transactionFacade(target: Queryable): Transaction {
  const rows = <T>(sql: string, params?: SqlParams) => runRows<T>(target, sql, params);
  return {
    execute: async (sql, params) => { await rows(sql, params); },
    batchExecute: async (sql, paramSets) => { for (const params of paramSets) await rows(sql, params); },
    queryRows: rows,
    queryOne: async <T>(sql: string, params?: SqlParams) => (await rows<T>(sql, params))[0] ?? null,
  };
}

export async function withTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return serialize(async () => {
    if (process.env.DATABASE_URL?.trim()) {
      const client: PoolClient = await getPool().connect();
      try {
        await client.query("BEGIN");
        const result = await fn(transactionFacade(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    const db = await getPGlite();
    return db.transaction(async (tx) => fn(transactionFacade(tx)));
  });
}

/** Execute a trusted multi-statement migration file without named parameters. */
export async function executeScript(sql: string): Promise<void> {
  await serialize(async () => {
    if (process.env.DATABASE_URL?.trim()) {
      await getPool().query(sql);
      return;
    }
    await (await getPGlite()).exec(sql);
  });
}
