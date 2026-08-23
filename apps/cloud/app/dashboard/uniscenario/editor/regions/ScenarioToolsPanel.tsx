"use client";

import { X } from "lucide-react";
import type { EditorDocument } from "@uniscenarios/editor-core";
import { InvariantEditor } from "../authoring/InvariantEditor";
import { ParameterEditor } from "../authoring/ParameterEditor";
import { VariantEditor } from "../authoring/VariantEditor";
import { AuthoringDiagnostics } from "./AuthoringDiagnostics";

/** Document-global authoring controls, hidden until explicitly requested. */
export function ScenarioToolsPanel({
  onClose,
  document,
}: {
  onClose: () => void;
  document: EditorDocument;
}) {
  return (
    <aside
      aria-label="Scenario tools"
      className="pointer-events-auto fixed bottom-0 right-0 top-14 z-[82] flex w-[420px] max-w-[92vw] flex-col border-l border-white/10 bg-[#0d0d0d] text-white shadow-2xl"
      data-testid="scenario-tools-panel"
    >
      <header className="flex h-14 shrink-0 items-center border-b border-white/10 px-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#E8E044]">Scenario tools</p>
          <p className="text-xs text-white/50">Global document configuration</p>
        </div>
        <button className="ml-auto grid size-8 place-items-center text-white/60 hover:bg-white/10 hover:text-white" aria-label="Close scenario tools" onClick={onClose} type="button">
          <X aria-hidden="true" className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="space-y-5 text-xs">
          <AuthoringDiagnostics document={document} />
          <ParameterEditor document={document} />
          <InvariantEditor document={document} />
          <VariantEditor document={document} />
        </div>
      </div>
    </aside>
  );
}
