/**
 * The importer's diagnostics channel — the mirror of the writer's.
 *
 * Same discipline, same reason: an import is a whole scene, and the useful
 * answer is almost always "here is the draft, and here are the four things in
 * the file that could not come back exactly". Nothing here throws;
 * `importXoscToDraft` never throws either, and reports even a hard parse
 * rejection as an `error` diagnostic on an empty draft.
 *
 * ## Severity is about the DRAFT, not about how bad it is
 *
 * * `info` — the import is complete; this is a note about how (a defaulted
 *   `mapAssetId`, a synthesized junction id).
 * * `approximated` — something was reconstructed, but reduced or folded. The
 *   draft re-exports to the same file; it does not mean the same thing.
 * * `dropped` — nothing was reconstructed for this thing. It is absent from
 *   the draft.
 * * `error` — the file could not be read at all. The draft is empty.
 */

export type XoscImportDiagnosticSeverity = "info" | "approximated" | "dropped" | "error";

export const XOSC_IMPORT_DIAGNOSTIC_CODES = [
  // Document-level
  "file_rejected",
  "malformed_document",
  "metadata_defaulted",
  "duration_clamped",
  // Entities / placement
  "entity_unplaced",
  "entity_kind_unknown",
  // Actions / clips
  "unknown_action",
  "unknown_condition",
  "clip_action_empty",
  // Signals
  "signal_junction_synthesized",
  "signal_static_order_uncertain",
  // The catch-all for a documented lossy inversion (see the module doc).
  "imported_approximation",
] as const;
export type XoscImportDiagnosticCode = (typeof XOSC_IMPORT_DIAGNOSTIC_CODES)[number];

export type XoscImportDiagnostic = {
  code: XoscImportDiagnosticCode;
  severity: XoscImportDiagnosticSeverity;
  /** One author-facing sentence. Never a stack trace, never a code repeat. */
  detail: string;
  actorId?: string;
  clipId?: string;
  junctionId?: string;
};

const SEVERITY_BY_CODE: Record<XoscImportDiagnosticCode, XoscImportDiagnosticSeverity> = {
  file_rejected: "error",
  malformed_document: "error",
  metadata_defaulted: "info",
  duration_clamped: "approximated",
  entity_unplaced: "dropped",
  entity_kind_unknown: "approximated",
  unknown_action: "dropped",
  unknown_condition: "dropped",
  clip_action_empty: "dropped",
  signal_junction_synthesized: "info",
  signal_static_order_uncertain: "approximated",
  imported_approximation: "approximated",
};

/** Accumulates diagnostics in import order (entities, then clips, then scene). */
export class ImportDiagnosticCollector {
  private readonly entries: XoscImportDiagnostic[] = [];

  add(
    code: XoscImportDiagnosticCode,
    detail: string,
    scope: { actorId?: string; clipId?: string; junctionId?: string } = {},
  ): void {
    this.entries.push({
      code,
      severity: SEVERITY_BY_CODE[code],
      detail,
      ...(scope.actorId === undefined ? {} : { actorId: scope.actorId }),
      ...(scope.clipId === undefined ? {} : { clipId: scope.clipId }),
      ...(scope.junctionId === undefined ? {} : { junctionId: scope.junctionId }),
    });
  }

  all(): XoscImportDiagnostic[] {
    return [...this.entries];
  }
}

/** True when the import lost content a caller may want to gate on. */
export function hasDroppedImportContent(
  diagnostics: readonly XoscImportDiagnostic[],
): boolean {
  return diagnostics.some(
    (entry) => entry.severity === "dropped" || entry.severity === "error",
  );
}
