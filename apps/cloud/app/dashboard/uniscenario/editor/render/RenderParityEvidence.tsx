"use client";

import { useEffect, useState } from "react";
import { WorkspacePaneLoading } from "@/app/components/WorkspacePaneLoading";
import type { PresignedArtifact } from "./api";

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

export type RenderParityMetric = {
  key: string;
  label: string;
  maximum: number;
  violations: number;
  unit: string;
};

export type RenderParityDivergence = {
  id: string;
  label: string;
  expectedPhysics: boolean;
  accepted: boolean;
  detail: string | null;
};

export type RenderParityEvidence = {
  accepted: boolean;
  samples: number;
  executionMode: "native-physics" | "diagnostic-replay";
  metrics: RenderParityMetric[];
  divergences: RenderParityDivergence[];
  unrenderedCues: string[];
  planSha256: string;
  sourceInputDigest: string;
  workerImageDigest: string | null;
  workerRevision: string | null;
  carlaVersion: string | null;
  engineVersion: string | null;
};

type ExpectedManifestIdentity = {
  jobId: string;
  executionPackageId: string;
  executionPackageControlSha256: string;
};

/**
 * Read only the public, bounded parity surface from a checksum-verified CARLA render manifest.
 * The worker manifest is evidence, not executable configuration, so unknown fields are ignored and
 * every identity is closed back to the job the author opened before anything is displayed as proof.
 */
export function parseRenderParityEvidence(
  input: unknown,
  expected: ExpectedManifestIdentity,
): RenderParityEvidence {
  const manifest = record(input, "manifest");
  if (manifest.schema !== "uniscenario.render-manifest/v1") {
    throw new Error("The CARLA manifest uses an unsupported evidence contract.");
  }
  if (
    manifest.jobId !== expected.jobId
    || manifest.executionPackageId !== expected.executionPackageId
    || manifest.executionPackageControlSha256 !== expected.executionPackageControlSha256
  ) {
    throw new Error("The CARLA evidence does not belong to this immutable render attempt.");
  }

  const renderSpec = record(manifest.renderSpec, "renderSpec");
  const executionMode = renderSpec.execution_mode ?? renderSpec.executionMode;
  if (executionMode !== "native-physics" && executionMode !== "diagnostic-replay") {
    throw new Error("The CARLA manifest does not identify its execution mode.");
  }
  const parity = record(manifest.parity, "parity");
  const accepted = boolean(parity.accepted, "parity.accepted");
  const samples = nonNegativeInteger(parity.samples, "parity.samples");
  const maximum = record(parity.max_error ?? parity.maxError, "parity.max_error");
  const violations = record(
    parity.violation_counts ?? parity.violationCounts,
    "parity.violation_counts",
  );
  const metricKeys = Object.keys(maximum)
    .filter((key) => typeof maximum[key] === "number")
    .sort()
    .slice(0, 20);
  if (metricKeys.length === 0) throw new Error("The CARLA manifest has no behavior metrics.");
  const metrics = metricKeys.map((key) => {
    const maximumValue = finiteNonNegative(maximum[key], `parity.max_error.${key}`);
    const violationCount = nonNegativeInteger(
      violations[key] ?? 0,
      `parity.violation_counts.${key}`,
    );
    return {
      key,
      ...metricPresentation(key),
      maximum: maximumValue,
      violations: violationCount,
    };
  });
  if (accepted !== metrics.every((metric) => metric.violations === 0)) {
    throw new Error("The CARLA parity verdict conflicts with its measured violations.");
  }

  const capabilities = optionalRecord(manifest.capabilities);
  const appearance = optionalRecord(capabilities?.appearance);
  const unrenderedCues = stringArray(appearance?.unrenderedCues).slice(0, 100);
  const attestation = optionalRecord(manifest.workerAttestation);

  return {
    accepted,
    samples,
    executionMode,
    metrics,
    divergences: parseDivergences(parity.divergences),
    unrenderedCues,
    planSha256: digest(manifest.planSha256, "planSha256"),
    sourceInputDigest: digest(manifest.sourceInputDigest, "sourceInputDigest"),
    workerImageDigest: optionalString(attestation?.workerImageDigest),
    workerRevision: optionalString(attestation?.workerRevision),
    carlaVersion: optionalString(attestation?.carlaVersion),
    engineVersion: optionalString(attestation?.engineVersion),
  };
}

export function RenderParityEvidencePanel({
  artifacts,
  jobId,
  executionPackageId,
  executionPackageControlSha256,
}: ExpectedManifestIdentity & { artifacts: readonly PresignedArtifact[] }) {
  const [evidence, setEvidence] = useState<RenderParityEvidence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const manifest = artifacts.find((artifact) =>
    artifact.artifactKind === "manifest"
    && artifact.artifactState === "available"
    && artifact.mediaType === "application/json"
    && artifact.url,
  );

  useEffect(() => {
    const controller = new AbortController();
    setEvidence(null);
    setError(null);
    if (!manifest || !manifest.url) return () => controller.abort();
    if (manifest.byteLength > MAX_MANIFEST_BYTES) {
      setError("The CARLA evidence manifest exceeds the browser inspection limit.");
      return () => controller.abort();
    }
    void fetch(manifest.url, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`CARLA evidence download failed (${response.status}).`);
        const text = await response.text();
        if (new Blob([text]).size > MAX_MANIFEST_BYTES) {
          throw new Error("The CARLA evidence manifest exceeds the browser inspection limit.");
        }
        return JSON.parse(text) as unknown;
      })
      .then((value) => parseRenderParityEvidence(value, {
        jobId,
        executionPackageId,
        executionPackageControlSha256,
      }))
      .then((value) => {
        if (!controller.signal.aborted) setEvidence(value);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "The CARLA evidence is invalid.");
        }
      });
    return () => controller.abort();
  }, [executionPackageControlSha256, executionPackageId, jobId, manifest]);

  if (error) {
    return <p className="border border-destructive/40 p-3 text-xs text-destructive" role="alert">{error}</p>;
  }
  if (!manifest) {
    return (
      <div className="border border-dashed render-hairline p-4 text-xs text-muted-foreground">
        CARLA parity evidence appears after the checksum-verified render manifest is uploaded.
      </div>
    );
  }
  if (!evidence) {
    return (
      <WorkspacePaneLoading
        className="min-h-56"
        hint="Comparing the rendered behavior with the saved scenario."
        message="Reading CARLA behavior evidence…"
      />
    );
  }

  const nativePhysics = evidence.executionMode === "native-physics";
  return (
    <div className="space-y-4">
      <section
        className={evidence.accepted && nativePhysics
          ? "border border-primary/40 bg-primary/5 p-3"
          : "border border-destructive/40 bg-destructive/5 p-3"}
        aria-labelledby="carla-parity-verdict-heading"
      >
        <p className="text-micro uppercase tracking-meta text-muted-foreground">CARLA behavior verdict</p>
        <h4 className="mt-1 text-sm font-semibold" id="carla-parity-verdict-heading">
          {!nativePhysics
            ? "Diagnostic pose replay — not physical acceptance"
            : evidence.accepted
              ? "Within the native-physics behavior envelope"
              : "Outside the native-physics behavior envelope"}
        </h4>
        <p className="mt-2 text-xs text-muted-foreground">
          {nativePhysics
            ? "CARLA applied vehicle and walker controls and remained the physics authority. Small trajectory differences are expected; per-frame pose forcing was not used."
            : "This attempt replayed poses for diagnosis. Submit a native-physics attempt before treating behavior as equivalent."}
        </p>
      </section>

      <section aria-labelledby="carla-parity-measurements-heading">
        <h4 className="text-xs font-semibold uppercase tracking-meta" id="carla-parity-measurements-heading">
          Measured physics deviations · {evidence.samples} samples
        </h4>
        <dl className="mt-2 render-divide divide-y render-glass border">
          {evidence.metrics.map((metric) => (
            <div className="grid grid-cols-[1fr_auto] gap-3 px-3 py-2 text-xs" key={metric.key}>
              <dt>
                <span className="font-medium">{metric.label}</span>
                <span className="ml-2 text-micro text-muted-foreground">
                  {metric.violations === 0
                    ? "Expected physics difference"
                    : `${metric.violations} out-of-envelope samples`}
                </span>
              </dt>
              <dd className={metric.violations === 0 ? "font-mono" : "font-mono text-destructive"}>
                {formatMetric(metric.maximum)} {metric.unit}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {evidence.divergences.length > 0 ? (
        <section aria-labelledby="carla-parity-divergences-heading">
          <h4 className="text-xs font-semibold uppercase tracking-meta" id="carla-parity-divergences-heading">Classified differences</h4>
          <ul className="mt-2 space-y-1">
            {evidence.divergences.map((divergence) => (
              <li className="render-glass border p-2 text-xs" key={divergence.id}>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 font-medium">{divergence.label}</span>
                  <span className={divergence.accepted ? "text-primary" : "text-destructive"}>
                    {divergence.expectedPhysics ? "Expected physics" : "Semantic mismatch"}
                  </span>
                </div>
                {divergence.detail ? <p className="mt-1 text-micro text-muted-foreground">{divergence.detail}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {evidence.unrenderedCues.length > 0 ? (
        <section className="border border-destructive/40 p-3" aria-labelledby="carla-unrendered-cues-heading">
          <h4 className="text-xs font-semibold" id="carla-unrendered-cues-heading">Unrendered appearance cues</h4>
          <p className="mt-1 text-micro text-muted-foreground">These cues remained in the execution plan but CARLA could not show them:</p>
          <p className="mt-2 break-all font-mono text-micro">{evidence.unrenderedCues.join(", ")}</p>
        </section>
      ) : null}

      <dl className="grid grid-cols-2 gap-3 border-y render-hairline py-3 text-xs">
        <EvidenceValue label="CARLA" value={evidence.carlaVersion ?? "—"} />
        <EvidenceValue label="Engine" value={evidence.engineVersion ?? "—"} />
        <EvidenceValue label="Plan digest" value={shortDigest(evidence.planSha256)} mono />
        <EvidenceValue label="Source input" value={shortDigest(evidence.sourceInputDigest)} mono />
        <EvidenceValue label="Worker revision" value={shortDigest(evidence.workerRevision)} mono />
        <EvidenceValue label="Image digest" value={shortDigest(evidence.workerImageDigest)} mono />
      </dl>
    </div>
  );
}

function EvidenceValue({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className={mono ? "truncate font-mono text-micro" : "truncate font-medium"} title={value}>{value}</dd></div>;
}

function parseDivergences(value: unknown): RenderParityDivergence[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((entry, index) => {
    const item = record(entry, `parity.divergences.${index}`);
    const status = optionalString(item.status);
    const accepted = typeof item.accepted === "boolean"
      ? item.accepted
      : status === "accepted" || status === "within-envelope";
    return {
      id: optionalString(item.id) ?? `divergence-${index + 1}`,
      label: optionalString(item.label) ?? optionalString(item.code) ?? `Difference ${index + 1}`,
      expectedPhysics: item.expectedPhysics === true,
      accepted,
      detail: optionalString(item.detail) ?? optionalString(item.message),
    };
  });
}

function metricPresentation(key: string): { label: string; unit: string } {
  if (key === "positionM") return { label: "Maximum position deviation", unit: "m" };
  if (key === "headingDeg") return { label: "Maximum heading deviation", unit: "°" };
  if (key === "speedMps") return { label: "Maximum speed deviation", unit: "m/s" };
  return { label: key.replaceAll("_", " "), unit: "" };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The CARLA evidence is missing ${label}.`);
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`The CARLA evidence is missing ${label}.`);
  return value;
}

function finiteNonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`The CARLA evidence has an invalid ${label}.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const result = finiteNonNegative(value, label);
  if (!Number.isSafeInteger(result)) throw new Error(`The CARLA evidence has an invalid ${label}.`);
  return result;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`The CARLA evidence has an invalid ${label}.`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 500 ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length <= 500)
    : [];
}

function shortDigest(value: string | null): string {
  if (!value) return "—";
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

function formatMetric(value: number): string {
  if (value === 0) return "0";
  if (value < 0.001) return value.toExponential(2);
  return value.toFixed(3).replace(/\.?0+$/, "");
}
