import { createAdapterFactory } from "better-auth/adapters";
import type { CleanedWhere } from "better-auth/adapters";
import {
  RDSDataClient,
  ExecuteStatementCommand,
  type SqlParameter,
  type Field,
  type ColumnMetadata,
} from "@aws-sdk/client-rds-data";
import { getOptionalAwsCredentials } from "../aws/credentials";

// ── Aurora Data API helpers (self-contained, independent of app db module) ──

function getConfig() {
  const clusterArn = process.env.AURORA_CLUSTER_ARN?.trim() ?? "";
  const secretArn = process.env.AURORA_SECRET_ARN?.trim() ?? "";
  if (!clusterArn || !secretArn) {
    throw new Error("AURORA_CLUSTER_ARN and AURORA_SECRET_ARN are required");
  }
  return {
    clusterArn,
    secretArn,
    database:
      process.env.AURORA_DATABASE?.trim() ?? "simcloud",
    region:
      process.env.AURORA_REGION?.trim() ??
      process.env.AWS_REGION?.trim() ??
      "us-east-1",
  };
}


let _client: RDSDataClient | null = null;
function getClient(): RDSDataClient {
  if (!_client) {
    _client = new RDSDataClient({
      region: getConfig().region,
      credentials: getOptionalAwsCredentials(),
    });
  }
  return _client;
}

function fieldToValue(field: Field): unknown {
  if (field.isNull) return null;
  if (field.stringValue !== undefined) return field.stringValue;
  if (field.longValue !== undefined) return Number(field.longValue);
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.blobValue !== undefined) return field.blobValue;
  return null;
}

function recordsToObjects<T>(
  columns: ColumnMetadata[],
  records: Field[][],
): T[] {
  return records.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const name = col?.name ?? `col_${i}`;
      const field = row[i];
      if (field) obj[name] = fieldToValue(field);
    }
    return obj as T;
  });
}

async function execute(sql: string, params?: SqlParameter[]) {
  const config = getConfig();
  const command = new ExecuteStatementCommand({
    resourceArn: config.clusterArn,
    secretArn: config.secretArn,
    database: config.database,
    sql,
    parameters: params,
    includeResultMetadata: true,
  });
  return getClient().send(command);
}

async function queryOne<T>(
  sql: string,
  params?: SqlParameter[],
): Promise<T | null> {
  const result = await execute(sql, params);
  const columns = result.columnMetadata ?? [];
  const records = result.records ?? [];
  if (records.length === 0) return null;
  return recordsToObjects<T>(columns, records)[0] ?? null;
}

async function queryRows<T>(
  sql: string,
  params?: SqlParameter[],
): Promise<T[]> {
  const result = await execute(sql, params);
  const columns = result.columnMetadata ?? [];
  const records = result.records ?? [];
  return recordsToObjects<T>(columns, records);
}

function param(
  name: string,
  value: string | number | boolean | null,
): SqlParameter {
  if (value === null) {
    return { name, value: { isNull: true } };
  }
  if (typeof value === "string") {
    return { name, value: { stringValue: value } };
  }
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return { name, value: { longValue: value } };
    }
    return { name, value: { doubleValue: value } };
  }
  if (typeof value === "boolean") {
    return { name, value: { booleanValue: value } };
  }
  return { name, value: { isNull: true } };
}

// ── WHERE clause builder ──

// Exported for unit testing the timestamptz-cast behaviour; not part of the
// package's public surface (index.ts only re-exports `auroraAdapter`).
export function buildWhereClause(
  where: CleanedWhere[] | undefined,
  startIndex = 0,
): { clause: string; params: SqlParameter[]; paramIndex: number } {
  if (!where || where.length === 0) {
    return { clause: "", params: [], paramIndex: startIndex };
  }

  const conditions: string[] = [];
  const params: SqlParameter[] = [];
  let idx = startIndex;

  for (let i = 0; i < where.length; i++) {
    const w = where[i]!;
    const connector = i === 0 ? "" : ` ${w.connector} `;
    const paramName = `w${idx}`;

    let condition: string;
    switch (w.operator) {
      case "eq":
        if (w.value === null) {
          condition = `${connector}"${w.field}" IS NULL`;
        } else {
          condition = `${connector}"${w.field}" = ${paramPlaceholder(paramName, w.field)}`;
          params.push(toParam(paramName, w.value));
          idx++;
        }
        break;
      case "ne":
        if (w.value === null) {
          condition = `${connector}"${w.field}" IS NOT NULL`;
        } else {
          condition = `${connector}"${w.field}" != ${paramPlaceholder(paramName, w.field)}`;
          params.push(toParam(paramName, w.value));
          idx++;
        }
        break;
      case "lt":
        condition = `${connector}"${w.field}" < ${paramPlaceholder(paramName, w.field)}`;
        params.push(toParam(paramName, w.value));
        idx++;
        break;
      case "lte":
        condition = `${connector}"${w.field}" <= ${paramPlaceholder(paramName, w.field)}`;
        params.push(toParam(paramName, w.value));
        idx++;
        break;
      case "gt":
        condition = `${connector}"${w.field}" > ${paramPlaceholder(paramName, w.field)}`;
        params.push(toParam(paramName, w.value));
        idx++;
        break;
      case "gte":
        condition = `${connector}"${w.field}" >= ${paramPlaceholder(paramName, w.field)}`;
        params.push(toParam(paramName, w.value));
        idx++;
        break;
      case "in": {
        const values = w.value as (string | number)[];
        if (values.length === 0) {
          condition = `${connector}FALSE`;
          break;
        }
        const placeholders = values.map((v) => {
          const pName = `w${idx}`;
          params.push(toParam(pName, v));
          idx++;
          return paramPlaceholder(pName, w.field);
        });
        condition = `${connector}"${w.field}" IN (${placeholders.join(", ")})`;
        break;
      }
      case "not_in": {
        const values = w.value as (string | number)[];
        if (values.length === 0) {
          condition = `${connector}TRUE`;
          break;
        }
        const placeholders = values.map((v) => {
          const pName = `w${idx}`;
          params.push(toParam(pName, v));
          idx++;
          return paramPlaceholder(pName, w.field);
        });
        condition = `${connector}"${w.field}" NOT IN (${placeholders.join(", ")})`;
        break;
      }
      case "contains":
        condition = `${connector}"${w.field}" LIKE :${paramName}`;
        params.push(param(paramName, `%${w.value}%`));
        idx++;
        break;
      case "starts_with":
        condition = `${connector}"${w.field}" LIKE :${paramName}`;
        params.push(param(paramName, `${w.value}%`));
        idx++;
        break;
      case "ends_with":
        condition = `${connector}"${w.field}" LIKE :${paramName}`;
        params.push(param(paramName, `%${w.value}`));
        idx++;
        break;
      default:
        condition = `${connector}"${w.field}" = ${paramPlaceholder(paramName, w.field)}`;
        params.push(toParam(paramName, w.value));
        idx++;
        break;
    }
    conditions.push(condition);
  }

  return {
    clause: ` WHERE ${conditions.join("")}`,
    params,
    paramIndex: idx,
  };
}

function toParam(name: string, value: unknown): SqlParameter {
  if (value === null || value === undefined) {
    return param(name, null);
  }
  if (value instanceof Date) {
    return param(name, value.toISOString());
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return param(name, value);
  }
  return param(name, JSON.stringify(value));
}

/** Fields that are timestamps and need ::timestamptz cast in RDS Data API. */
const TIMESTAMP_FIELDS = new Set([
  "createdAt",
  "updatedAt",
  "expiresAt",
  "accessTokenExpiresAt",
  "refreshTokenExpiresAt",
]);

/** Returns the SQL placeholder, with ::timestamptz cast if needed. */
function paramPlaceholder(paramName: string, fieldName: string): string {
  if (TIMESTAMP_FIELDS.has(fieldName)) {
    return `:${paramName}::timestamptz`;
  }
  return `:${paramName}`;
}

type JoinConfig = Record<string, true | { limit?: number } | undefined>;
type ModelNameResolver = (model: string) => string;

async function applyJoins(
  getModelName: ModelNameResolver,
  model: string,
  row: Record<string, unknown> | null,
  join: JoinConfig | undefined,
): Promise<Record<string, unknown> | null> {
  if (!row || !join) return row;

  if (model === "member") {
    if (join.user) {
      row.user = await queryOne<Record<string, unknown>>(
        `SELECT * FROM "${getModelName("user")}" WHERE id = :userId LIMIT 1`,
        [param("userId", String(row.userId ?? ""))],
      );
    }
    if (join.organization) {
      row.organization = await queryOne<Record<string, unknown>>(
        `SELECT * FROM "${getModelName("organization")}" WHERE id = :organizationId LIMIT 1`,
        [param("organizationId", String(row.organizationId ?? ""))],
      );
    }
    return row;
  }

  if (model === "organization") {
    const organizationId = String(row.id ?? "");
    if (join.invitation) {
      row.invitation = await queryRows<Record<string, unknown>>(
        `SELECT * FROM "${getModelName("invitation")}" WHERE "organizationId" = :organizationId ORDER BY "createdAt" DESC`,
        [param("organizationId", organizationId)],
      );
    }
    if (join.member) {
      const limit =
        typeof join.member === "object" && join.member.limit
          ? ` LIMIT ${Number(join.member.limit)}`
          : "";
      row.member = await queryRows<Record<string, unknown>>(
        `SELECT * FROM "${getModelName("member")}" WHERE "organizationId" = :organizationId ORDER BY "createdAt" ASC${limit}`,
        [param("organizationId", organizationId)],
      );
    }
    if (join.team) {
      row.team = [];
    }
  }

  return row;
}

async function applyJoinsToRows(
  getModelName: ModelNameResolver,
  model: string,
  rows: Record<string, unknown>[],
  join: JoinConfig | undefined,
): Promise<Record<string, unknown>[]> {
  if (!join) return rows;
  return Promise.all(
    rows.map(async (row) => (await applyJoins(getModelName, model, row, join)) ?? row),
  );
}

// ── Adapter factory ──

export const auroraAdapter = createAdapterFactory({
  config: {
    adapterId: "aurora-data-api",
    adapterName: "Aurora Data API",
    supportsDates: false,
    supportsBooleans: true,
    supportsJSON: false,
  },
  adapter: ({ getModelName }) => ({
    create: async ({ data, model, select }) => {
      const tableName = getModelName(model);
      const dataRecord = data as Record<string, unknown>;
      const entries = Object.entries(dataRecord);
      const columns = entries.map(([key]) => `"${key}"`);
      const paramNames = entries.map(([key], i) => paramPlaceholder(`p${i}`, key));
      const params = entries.map(([key], i) => toParam(`p${i}`, dataRecord[key]));

      const selectClause =
        select && select.length > 0
          ? select.map((s) => `"${s}"`).join(", ")
          : "*";

      const sql = `INSERT INTO "${tableName}" (${columns.join(", ")}) VALUES (${paramNames.join(", ")}) RETURNING ${selectClause}`;

      const result = await queryOne<Record<string, unknown>>(sql, params);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (result ?? data) as any;
    },

    findOne: async (input) => {
      const { model, where, select } = input;
      const join = (input as { join?: JoinConfig }).join;
      const tableName = getModelName(model);
      const selectClause =
        select && select.length > 0
          ? select.map((s) => `"${s}"`).join(", ")
          : "*";

      const { clause, params } = buildWhereClause(where);
      const sql = `SELECT ${selectClause} FROM "${tableName}"${clause} LIMIT 1`;

      const row = await queryOne<Record<string, unknown>>(sql, params);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (await applyJoins(getModelName, model, row, join)) as any;
    },

    findMany: async (input) => {
      const { model, where, limit, select, sortBy, offset } = input;
      const join = (input as { join?: JoinConfig }).join;
      const tableName = getModelName(model);
      const selectClause =
        select && select.length > 0
          ? select.map((s) => `"${s}"`).join(", ")
          : "*";

      const { clause, params } = buildWhereClause(where);
      let sql = `SELECT ${selectClause} FROM "${tableName}"${clause}`;

      if (sortBy) {
        const dir = sortBy.direction === "desc" ? "DESC" : "ASC";
        sql += ` ORDER BY "${sortBy.field}" ${dir}`;
      }

      if (limit !== undefined && limit !== null) {
        sql += ` LIMIT ${Number(limit)}`;
      }

      if (offset !== undefined && offset !== null && offset !== 0) {
        sql += ` OFFSET ${Number(offset)}`;
      }

      const rows = await queryRows<Record<string, unknown>>(sql, params);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (await applyJoinsToRows(getModelName, model, rows, join)) as any;
    },

    update: async ({ model, where, update: updateData }) => {
      const tableName = getModelName(model);
      const updateRecord = updateData as Record<string, unknown>;
      const entries = Object.entries(updateRecord);
      if (entries.length === 0) return null;

      const setClauses = entries.map(
        ([key], i) => `"${key}" = ${paramPlaceholder(`u${i}`, key)}`,
      );
      const setParams = entries.map(([key], i) =>
        toParam(`u${i}`, updateRecord[key]),
      );

      const { clause, params: whereParams } = buildWhereClause(
        where,
        entries.length,
      );
      if (!clause) throw new Error(`update on "${tableName}" requires a WHERE clause`);

      const sql = `UPDATE "${tableName}" SET ${setClauses.join(", ")}${clause} RETURNING *`;
      const allParams = [...setParams, ...whereParams];

      return queryOne(sql, allParams);
    },

    updateMany: async ({ model, where, update: updateData }) => {
      const tableName = getModelName(model);
      const updateRecord = updateData as Record<string, unknown>;
      const entries = Object.entries(updateRecord);
      if (entries.length === 0) return 0;

      const setClauses = entries.map(
        ([key], i) => `"${key}" = ${paramPlaceholder(`u${i}`, key)}`,
      );
      const setParams = entries.map(([key], i) =>
        toParam(`u${i}`, updateRecord[key]),
      );

      const { clause, params: whereParams } = buildWhereClause(
        where,
        entries.length,
      );
      if (!clause) throw new Error(`updateMany on "${tableName}" requires a WHERE clause`);

      const sql = `UPDATE "${tableName}" SET ${setClauses.join(", ")}${clause}`;
      const allParams = [...setParams, ...whereParams];

      const result = await execute(sql, allParams);
      return result.numberOfRecordsUpdated ?? 0;
    },

    delete: async ({ model, where }) => {
      const tableName = getModelName(model);
      const { clause, params } = buildWhereClause(where);
      if (!clause) throw new Error(`delete on "${tableName}" requires a WHERE clause`);
      const sql = `DELETE FROM "${tableName}"${clause}`;
      await execute(sql, params);
    },

    deleteMany: async ({ model, where }) => {
      const tableName = getModelName(model);
      const { clause, params } = buildWhereClause(where);
      if (!clause) throw new Error(`deleteMany on "${tableName}" requires a WHERE clause`);
      const sql = `DELETE FROM "${tableName}"${clause}`;
      const result = await execute(sql, params);
      return result.numberOfRecordsUpdated ?? 0;
    },

    count: async ({ model, where }) => {
      const tableName = getModelName(model);
      const { clause, params } = buildWhereClause(where);
      const sql = `SELECT COUNT(*) AS cnt FROM "${tableName}"${clause}`;
      const result = await queryOne<{ cnt: number }>(sql, params);
      return result?.cnt ?? 0;
    },
  }),
});
