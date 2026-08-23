"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/app/components/ui/button";
import {
  downloadExportArtifact,
  getUniScenarioJobProvenance,
  openUniScenarioArtifact,
} from "@/app/lib/uniscenario/editor/api";
import type {
  UniScenarioJobProvenanceDto,
  UniScenarioRenderJobDto,
} from "@/app/lib/uniscenario/contracts";

/**
 * The provenance panel for a submitted render or 2D-interaction job.
 *
 * Every digest row here is load-bearing, not decoration: source revision,
 * execution package, compiler version, map version, XODR and asset-catalog
 * digests together are what makes a render reproducible after the fact. This is
 * the surface an OEM certification review reads. Do not thin it out.
 */
export function UniScenarioJobDetails({
  job,
  onClose,
}: {
  job: UniScenarioRenderJobDto;
  onClose: () => void;
}) {
  const [provenance, setProvenance] =
    useState<UniScenarioJobProvenanceDto | null>(null);

  useEffect(() => {
    let active = true;
    void getUniScenarioJobProvenance(job.id)
      .then((value) => {
        if (active) setProvenance(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [job.id]);

  const percent = Math.round(job.progress * 100);
  const renderSpecV3 =
    job.renderSpec?.schema === "uniscenario.render-spec/v3" ? job.renderSpec : null;
  const legacyRenderSpec =
    job.renderSpec?.schema === "uniscenario.render-spec/v1" ? job.renderSpec : null;

  return (
    <aside
      className="h-full overflow-y-auto border border-border bg-card p-5 shadow-2xl"
      data-testid="uniscenario-job-details"
    >
      <div className="flex items-start">
        <div>
          <p className="text-xs uppercase tracking-meta text-muted-foreground">
            {job.mode === "interaction_2d" ? "2D interaction" : "Full render"}
          </p>
          <h2 className="mt-1 font-semibold">{job.status}</h2>
        </div>
        <button
          type="button"
          aria-label="Close job details"
          className="editor-motion -mr-1 -mt-1 ml-auto inline-flex size-7 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card"
          onClick={onClose}
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      <div
        aria-label={`${job.mode === "interaction_2d" ? "2D interaction" : "Render"} progress`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={percent}
        className="mt-4 h-1.5 overflow-hidden bg-muted"
        role="progressbar"
      >
        {/* A floor of 4% so a just-queued job still shows a sliver: a 0-width
            bar is indistinguishable from a missing bar. The announced value
            stays honest. */}
        <div
          className="h-full bg-primary"
          style={{ width: `${Math.max(4, percent)}%` }}
        />
      </div>
      <Details title="Cost">
        <Row label="Billing" value="Free" />
        <Row label="Estimated cost" value="$0.00" />
      </Details>
      <Details title="OpenSCENARIO provenance">
        <Row label="Document" value={provenance?.documentId ?? "Loading…"} />
        <Row
          label="Revision"
          value={
            provenance
              ? `${provenance.revisionId} · #${provenance.revisionNumber}`
              : job.revisionId
          }
        />
        <Row label="XML profile" value="ASAM OpenSCENARIO XML 1.4.0" />
        <Row label="Validation" value={provenance?.validationStatus ?? "Pending"} />
        <Row label="Source digest" value={provenance?.sourceRevisionSha256 ?? "—"} />
        <Row
          label="Package digest"
          value={provenance?.executionPackageSha256 ?? "—"}
        />
        <Row label="Compiler" value={provenance?.compilerVersion ?? "—"} />
        <Row label="Map version" value={provenance?.mapVersionId ?? "—"} />
        <Row label="XODR digest" value={provenance?.xodrSha256 ?? "—"} />
        <Row label="Catalog digest" value={provenance?.assetCatalogSha256 ?? "—"} />
        <Row
          label="Coordinates"
          value={
            provenance
              ? `${provenance.coordinateSystemId} · ${provenance.coordinateSystemSha256}`
              : "—"
          }
        />
        <Row label="Traffic" value={String(provenance?.traffic.mode ?? "—")} />
        <Row
          label="Warnings"
          value={String(provenance?.capabilityWarnings.length ?? 0)}
        />
        <Row label="2D parity" value={job.parityResult ? "Available" : "Pending"} />
        <Row
          label="CARLA/local image"
          value={job.workerAttestation ? "Attested" : "Pending"}
        />
      </Details>
      <Details title="Configuration">
        <Row label="Execution" value="CARLA native physics" />
        <Row
          label="Sensors"
          value={
            job.mode === "interaction_2d"
              ? "None (sensor-free)"
              : String(renderSpecV3?.sources.length ?? legacyRenderSpec?.sensors.length ?? 0)
          }
        />
        <Row
          label="Environment"
          value={
            renderSpecV3
              ? JSON.stringify(renderSpecV3.authoredEnvironment)
              : legacyRenderSpec
                ? JSON.stringify(legacyRenderSpec.environment)
                : "Scenario execution only"
          }
        />
        <Row
          label="Outputs"
          value={
            renderSpecV3?.artifacts.join(", ")
            ?? legacyRenderSpec?.outputs.join(", ")
            ?? "trace, manifest"
          }
        />
      </Details>
      <Details title="Artifacts" list={!provenance?.artifacts.length}>
        {provenance?.artifacts.length ? (
          provenance.artifacts.map((artifact) => (
            <div
              key={artifact.id}
              className="mb-2 flex border border-border p-2 text-xs"
            >
              <button
                type="button"
                onClick={() => void openUniScenarioArtifact(artifact.id)}
                className="editor-motion min-w-0 flex-1 text-left hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card"
              >
                <span className="text-primary">{artifact.kind}</span>
                <span className="ml-2 text-muted-foreground">
                  {artifact.sizeBytes.toLocaleString()} bytes
                </span>
              </button>
              <Button
                aria-label={`Download ${artifact.kind} artifact`}
                className="ml-2 h-auto p-0 text-xs text-muted-foreground hover:text-foreground"
                size="sm"
                variant="link"
                onClick={() => void downloadExportArtifact(artifact.id)}
              >
                Download
              </Button>
            </div>
          ))
        ) : (
          <Row label="Status" value="No completed artifacts yet" />
        )}
      </Details>
      <Details title="Logs">
        {provenance?.events.length ? (
          provenance.events.map((event) => (
            <Row
              key={event.sequence}
              label={`#${event.sequence}`}
              value={`${event.type} · ${event.occurredAt}`}
            />
          ))
        ) : (
          <Row label="Status" value="Waiting for worker events" />
        )}
      </Details>
      {job.failureCode ? (
        <Details title="Error">
          <Row label="Code" value={job.failureCode} />
          <Row label="Details" value={JSON.stringify(job.failureDetail)} />
        </Details>
      ) : null}
    </aside>
  );
}

/**
 * `list` is false where the body is not label/value pairs — the artifact rows
 * are buttons, and a `<div>` of buttons inside a `<dl>` is not valid content.
 */
function Details({
  title,
  children,
  list = true,
}: {
  title: string;
  children: ReactNode;
  list?: boolean;
}) {
  const Body = list ? "dl" : "div";
  return (
    <section className="mt-5 border-t border-border pt-4">
      <h3 className="text-xs font-semibold uppercase tracking-meta text-muted-foreground">
        {title}
      </h3>
      <Body className="mt-3 space-y-2">{children}</Body>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-4 text-xs">
      <dt className="w-32 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all text-foreground/90">{value}</dd>
    </div>
  );
}
