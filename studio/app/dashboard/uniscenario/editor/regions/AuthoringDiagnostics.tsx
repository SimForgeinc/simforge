"use client";

import type { EditorDocument } from "@simforge/editor";
import { Readout } from "./Readout";

/**
 * OWNS: the document's validation summary.
 *
 * It reports counts *and* the first issue's text, because a count alone tells
 * an author that something is wrong without telling them what — and the export
 * path refuses invalid documents, so this is the only place the reason appears
 * before a failed export.
 */
export function AuthoringDiagnostics({ document }: { document: EditorDocument }) {
  const issues = document.validation.issues;
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter((issue) => issue.severity === "warning").length;
  const portable = document.data.roles.filter(
    (role) => role.kind !== "scene_absolute",
  ).length;
  const mapBound = document.data.roles.length - portable;
  const first = issues[0];

  return (
    <section className="mt-5 border-t border-border pt-4 text-xs">
      <h3 className="font-semibold uppercase tracking-meta text-muted-foreground">
        Authoring diagnostics
      </h3>
      <dl className="mt-3 grid grid-cols-2 gap-2">
        <Readout label="Errors" value={String(errors)} />
        <Readout label="Warnings" value={String(warnings)} />
        <Readout label="Portable roles" value={String(portable)} />
        <Readout label="Map-bound roles" value={String(mapBound)} />
      </dl>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
        <span>{Object.keys(document.data.params).length} parameters</span>
        <span>{document.data.variants.length} variants</span>
        <span>{document.data.invariants.length} invariants</span>
      </div>
      {first ? (
        <p
          aria-live="polite"
          className={`mt-3 border p-2 ${
            errors
              ? "border-destructive/50 bg-destructive/15 text-foreground"
              : "border-amber-400/40 bg-amber-500/15 text-foreground"
          }`}
          role={errors ? "alert" : "status"}
        >
          {first.message}
        </p>
      ) : (
        <p
          aria-live="polite"
          className="mt-3 border border-emerald-400/40 bg-emerald-500/15 p-2 text-foreground"
          role="status"
        >
          Document is structurally valid.
        </p>
      )}
    </section>
  );
}
