import type {
  SemanticMapDiagnostic,
  SemanticMapDiagnosticCode,
} from "./types";

function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function digest24(input: string): string {
  return [0x811c9dc5, 0x9e3779b1, 0xa3b8e1c7]
    .map((seed) => fnv1a32(input, seed).toString(16).padStart(8, "0"))
    .join("");
}

export function semanticId(
  prefix: string,
  scope: string,
  members: readonly string[],
): string {
  return `${prefix}_${digest24(`${scope}|${members.join("|")}`)}`;
}

export function diagnostic(
  code: SemanticMapDiagnosticCode,
  severity: SemanticMapDiagnostic["severity"],
  scope: SemanticMapDiagnostic["scope"],
  message: string,
  options: {
    entityId?: string;
    laneRsls?: string[];
    gateIds?: string[];
    details?: Record<string, unknown>;
  } = {},
): SemanticMapDiagnostic {
  return {
    code,
    severity,
    scope,
    message,
    laneRsls: [...(options.laneRsls ?? [])].sort(),
    gateIds: [...(options.gateIds ?? [])].sort(),
    ...(options.entityId ? { entityId: options.entityId } : {}),
    ...(options.details ? { details: options.details } : {}),
  };
}

export function sortDiagnostics(
  rows: SemanticMapDiagnostic[],
): SemanticMapDiagnostic[] {
  return rows.sort((left, right) =>
    left.code.localeCompare(right.code) ||
    (left.entityId ?? "").localeCompare(right.entityId ?? "") ||
    left.laneRsls.join("|").localeCompare(right.laneRsls.join("|")) ||
    left.gateIds.join("|").localeCompare(right.gateIds.join("|")));
}
