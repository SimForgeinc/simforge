"use client";

import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileUp } from "lucide-react";
import { CloudActivityIndicator } from "@/app/components/CloudLoadingSurface";
import type { UniScenarioDocumentDto } from "@/app/lib/uniscenario/contracts";
import { Button } from "@/app/components/ui/button";
import type { UniScenarioMapOption } from "./document-map-groups";

type Diagnostic = {
  code: string;
  path: string;
  disposition: "supported" | "approximated" | "unsupported";
  message: string;
};

type ImportAnalysis = {
  standard: string;
  source: { byteLength: number; sha256: string; fileName: string };
  title: string;
  logicFile: string | null;
  embeddedMapIdentity: { mapVersionId: string | null; mapId: string | null; xodrSha256: string | null };
  diagnostics: Diagnostic[];
  capabilities: Record<Diagnostic["disposition"], number>;
};

type MapResolution = {
  status: "resolved" | "ambiguous" | "unresolved" | "conflict";
  source: "embedded-identity" | "logic-file" | "explicit" | null;
  requestedIdentity: string | null;
  candidates: Array<{ mapVersionId: string; label: string }>;
  selectedMapVersionId: string | null;
};

type ImportResponse = { analysis: ImportAnalysis; resolution: MapResolution; document?: UniScenarioDocumentDto; error?: string; message?: string };

async function submit(file: File, datasetId: string, mode: "analyze" | "create", mapVersionId?: string | null) {
  const form = new FormData();
  form.set("file", file);
  form.set("datasetId", datasetId);
  form.set("mode", mode);
  if (mapVersionId) form.set("mapVersionId", mapVersionId);
  const response = await fetch("/api/uniscenario/imports/openscenario", { method: "POST", body: form, cache: "no-store" });
  const body = (await response.json().catch(() => ({}))) as ImportResponse;
  if (!response.ok) throw new Error(body.message ?? body.error ?? `OpenSCENARIO import failed (${response.status}).`);
  return body;
}

export function useUniScenarioOpenScenarioImport({
  datasetId,
  maps,
  onImported,
}: {
  datasetId: string;
  maps: ReadonlyArray<UniScenarioMapOption>;
  onImported: (document: UniScenarioDocumentDto) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [selectedMapVersionId, setSelectedMapVersionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acknowledgedUnsupported, setAcknowledgedUnsupported] = useState(false);

  const reset = () => {
    setFile(null);
    setResult(null);
    setSelectedMapVersionId("");
    setError(null);
    setAcknowledgedUnsupported(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  const analyze = async (nextFile: File) => {
    setFile(nextFile);
    setBusy(true);
    setError(null);
    setResult(null);
    setAcknowledgedUnsupported(false);
    try {
      const next = await submit(nextFile, datasetId, "analyze");
      setResult(next);
      setSelectedMapVersionId(next.resolution.selectedMapVersionId ?? "");
    } catch (value) {
      setError(value instanceof Error ? value.message : "Could not analyze this OpenSCENARIO file.");
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!file || !selectedMapVersionId) return;
    setBusy(true);
    setError(null);
    try {
      const created = await submit(file, datasetId, "create", selectedMapVersionId);
      if (!created.document) throw new Error("The server did not return the imported scenario.");
      setOpen(false);
      reset();
      onImported(created.document);
    } catch (value) {
      setError(value instanceof Error ? value.message : "Could not import this OpenSCENARIO file.");
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (busy) return;
    setOpen(false);
    reset();
  };

  const dialog = open ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <button type="button" aria-label="Close OpenSCENARIO dialog" className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={close} />
      <div className="relative z-10 max-h-[88vh] w-full max-w-2xl space-y-4 overflow-y-auto border border-border bg-background p-6 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="xosc-import-title" data-testid="xosc-import-dialog">
        <div>
          <h2 id="xosc-import-title" className="text-lg font-semibold text-foreground">Open OpenSCENARIO as reference</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Create a new scenario from the parts we can convert. The original file stays attached as the source reference.
          </p>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept=".xosc,application/xml,text/xml"
          aria-label="Choose OpenSCENARIO file"
          className="hidden"
          onChange={(event) => { const next = event.target.files?.[0]; if (next) void analyze(next); }}
        />
        <Button type="button" variant="outline" className="w-full gap-2" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy && !result ? <CloudActivityIndicator /> : <FileUp className="size-4" aria-hidden="true" />}
          {file ? file.name : "Choose .xosc file"}
        </Button>

        {error ? <div role="alert" className="border border-destructive/60 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}

        {result ? (
          <div className="space-y-4" data-testid="xosc-import-report">
            <div className="grid gap-2 border border-border bg-surface-deep p-3 text-sm sm:grid-cols-2">
              <div><span className="text-muted-foreground">Format:</span> {result.analysis.standard}</div>
              <div><span className="text-muted-foreground">Size:</span> {result.analysis.source.byteLength.toLocaleString()} bytes</div>
              <div className="sm:col-span-2 break-all"><span className="text-muted-foreground">SHA-256:</span> {result.analysis.source.sha256}</div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                {result.resolution.status === "resolved" ? <CheckCircle2 className="size-4 text-emerald-500" /> : <AlertTriangle className="size-4 text-amber-500" />}
                Map {result.resolution.status}
                {result.resolution.requestedIdentity ? ` from ${result.resolution.requestedIdentity}` : " — choose explicitly"}
              </div>
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">Map</span>
                <select
                  aria-label="Resolved map"
                  className="h-10 w-full border border-input bg-background px-3"
                  value={selectedMapVersionId}
                  onChange={(event) => setSelectedMapVersionId(event.target.value)}
                >
                  <option value="">Select a known map…</option>
                  {maps.map((map) => <option key={map.mapVersionId} value={map.mapVersionId}>{map.label}</option>)}
                </select>
              </label>
              {result.resolution.status === "ambiguous" ? <p className="text-xs text-amber-600">Multiple maps matched. No map was selected automatically.</p> : null}
              {result.resolution.status === "unresolved" ? <p className="text-xs text-amber-600">No known map matched. Select the intended map; this importer never guesses.</p> : null}
              {result.resolution.status === "conflict" ? <p className="text-xs text-destructive">The file contains contradictory strong map identity. Correct the file before importing.</p> : null}
            </div>

            <div className="border border-border p-3" data-testid="xosc-conversion-summary">
              <h3 className="text-sm font-semibold">What will be converted</h3>
              <ul className="mt-2 space-y-1 text-xs">
                <li>{result.analysis.capabilities.supported} {result.analysis.capabilities.supported === 1 ? "part" : "parts"} will carry over.</li>
                <li>{result.analysis.capabilities.approximated} {result.analysis.capabilities.approximated === 1 ? "part" : "parts"} will be simplified.</li>
                <li>{result.analysis.capabilities.unsupported} {result.analysis.capabilities.unsupported === 1 ? "part" : "parts"} will remain only in the source file.</li>
              </ul>
              {result.analysis.capabilities.unsupported > 0 ? (
                <label className="mt-3 flex items-start gap-2 text-xs">
                  <input
                    checked={acknowledgedUnsupported}
                    className="mt-0.5 size-4"
                    data-testid="xosc-unsupported-acknowledgement"
                    onChange={(event) => setAcknowledgedUnsupported(event.target.checked)}
                    type="checkbox"
                  />
                  <span>I understand that unsupported behavior will not be editable in the new scenario.</span>
                </label>
              ) : null}
            </div>

            <details>
              <summary className="cursor-pointer text-sm font-medium">Technical conversion details</summary>
              <ul className="mt-2 space-y-2" aria-label="OpenSCENARIO import diagnostics">
                {result.analysis.diagnostics.map((diagnostic, index) => (
                  <li key={`${diagnostic.code}-${index}`} className="border border-border p-2 text-xs">
                    <div className="font-mono">{diagnostic.disposition.toUpperCase()} · {diagnostic.path} · {diagnostic.code}</div>
                    <div className="mt-1 text-muted-foreground">{diagnostic.message}</div>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={close}>Cancel</Button>
          <Button
            type="button"
            disabled={busy || !result || !selectedMapVersionId || (result.analysis.capabilities.unsupported > 0 && !acknowledgedUnsupported)}
            onClick={() => void create()}
          >
            {busy ? <CloudActivityIndicator /> : null}
            Create reference scenario
          </Button>
        </div>
      </div>
    </div>
  ) : null;

  return { openDialog: () => setOpen(true), busy, dialog };
}
