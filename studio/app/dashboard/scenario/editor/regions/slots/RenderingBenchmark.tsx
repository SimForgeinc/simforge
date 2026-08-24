"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  Clipboard,
  Gauge,
  LoaderCircle,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import { CityView } from "@simforge/viewer/react";
import type { CityViewer } from "@simforge/viewer";
import {
  SCENARIO_AUTHORING_QUALITY_CHOICES,
  SCENARIO_AUTHORING_QUALITY_IDS,
  type ScenarioAuthoringQuality,
} from "@/app/lib/scenario/contracts";
import { Button } from "@/app/components/ui/button";
import { SkyCloudBackdrop } from "@/app/components/SkyCloudBackdrop";
import { cn } from "@/app/lib/utils";
import { AUTHORING_QUALITY } from "../../authoring-quality";
import {
  captureRenderingBenchmarkHardware,
  loadRenderingBenchmark,
  recommendRenderingPreference,
  renderingBenchmarkAssetBase,
  RENDERING_BENCHMARK_CONFIGURATION,
  renderingBenchmarkKey,
  saveRenderingBenchmark,
  waitForViewerSettled,
  type RenderingBenchmarkFailure,
  type RenderingBenchmarkHardware,
  type RenderingBenchmarkResult,
  type RenderingBenchmarkSnapshot,
} from "./rendering-benchmark";

export type BenchmarkState =
  | { phase: "idle"; snapshot: RenderingBenchmarkSnapshot | null }
  | {
      phase: "loading" | "measuring";
      candidateIndex: number;
      results: RenderingBenchmarkResult[];
      failures: RenderingBenchmarkFailure[];
      hardware: RenderingBenchmarkHardware;
      startedAt: number;
    }
  | { phase: "complete"; snapshot: RenderingBenchmarkSnapshot }
  | {
      phase: "error";
      message: string;
      results: RenderingBenchmarkResult[];
      failures: RenderingBenchmarkFailure[];
      hardware: RenderingBenchmarkHardware;
      startedAt: number;
    };

export function useRenderingBenchmark(manifestUrl: string) {
  const [state, setState] = useState<BenchmarkState>(() => ({
    phase: "idle",
    snapshot: loadRenderingBenchmark(manifestUrl),
  }));
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    setState({ phase: "idle", snapshot: loadRenderingBenchmark(manifestUrl) });
  }, [manifestUrl]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const start = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setState({
      phase: "loading",
      candidateIndex: 0,
      results: [],
      failures: [],
      hardware: captureRenderingBenchmarkHardware(),
      startedAt: Date.now(),
    });
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState({ phase: "idle", snapshot: loadRenderingBenchmark(manifestUrl) });
  }, [manifestUrl]);

  const active = state.phase === "loading" || state.phase === "measuring";
  const candidateIndex = active ? state.candidateIndex : null;
  const quality =
    candidateIndex === null
      ? null
      : SCENARIO_AUTHORING_QUALITY_IDS[candidateIndex];

  const finishCandidate = useCallback(
    (result: RenderingBenchmarkResult) => {
      setState((current) => {
        if (current.phase !== "measuring") return current;
        const results = [...current.results, result];
        const nextIndex = current.candidateIndex + 1;
        if (nextIndex < SCENARIO_AUTHORING_QUALITY_IDS.length) {
          return {
            phase: "loading",
            candidateIndex: nextIndex,
            results,
            failures: current.failures,
            hardware: current.hardware,
            startedAt: current.startedAt,
          };
        }
        const recommended = recommendRenderingPreference(results);
        if (!recommended) {
          return {
            phase: "error",
            message: "No renderer completed.",
            results,
            failures: current.failures,
            hardware: current.hardware,
            startedAt: current.startedAt,
          };
        }
        const snapshot: RenderingBenchmarkSnapshot = {
          manifestUrl: renderingBenchmarkKey(manifestUrl),
          recommended,
          results,
          failures: current.failures,
          hardware: current.hardware,
          configuration: RENDERING_BENCHMARK_CONFIGURATION,
          capturedAt: new Date().toISOString(),
        };
        saveRenderingBenchmark(snapshot);
        return { phase: "complete", snapshot };
      });
    },
    [manifestUrl],
  );

  const failCandidate = useCallback(
    (reason: unknown) => {
      if ((reason as { name?: string } | null)?.name === "AbortError") return;
      setState((current) => {
        if (current.phase !== "loading" && current.phase !== "measuring")
          return current;
        const message =
          reason instanceof Error ? reason.message : String(reason);
        const failures = [
          ...current.failures,
          {
            quality: SCENARIO_AUTHORING_QUALITY_IDS[current.candidateIndex]!,
            message,
          },
        ];
        const nextIndex = current.candidateIndex + 1;
        if (nextIndex < SCENARIO_AUTHORING_QUALITY_IDS.length) {
          return {
            phase: "loading",
            candidateIndex: nextIndex,
            results: current.results,
            failures,
            hardware: current.hardware,
            startedAt: current.startedAt,
          };
        }
        const recommended = recommendRenderingPreference(current.results);
        if (!recommended) {
          return {
            phase: "error",
            message: "None of the renderers could be measured.",
            results: current.results,
            failures,
            hardware: current.hardware,
            startedAt: current.startedAt,
          };
        }
        const snapshot: RenderingBenchmarkSnapshot = {
          manifestUrl: renderingBenchmarkKey(manifestUrl),
          recommended,
          results: current.results,
          failures,
          hardware: current.hardware,
          configuration: RENDERING_BENCHMARK_CONFIGURATION,
          capturedAt: new Date().toISOString(),
        };
        saveRenderingBenchmark(snapshot);
        return { phase: "complete", snapshot };
      });
    },
    [manifestUrl],
  );

  const runner = quality ? (
    <BenchmarkCanvas
      key={quality}
      manifestUrl={manifestUrl}
      quality={quality}
      signal={abortRef.current?.signal}
      onMeasuring={() =>
        setState((current) =>
          current.phase === "loading"
            ? { ...current, phase: "measuring" }
            : current,
        )
      }
      onHardware={(hardware) =>
        setState((current) =>
          current.phase === "loading" || current.phase === "measuring"
            ? { ...current, hardware }
            : current,
        )
      }
      onComplete={finishCandidate}
      onError={failCandidate}
    />
  ) : null;

  return { state, start, cancel, runner };
}

export function RenderingBenchmarkCard({
  manifestUrl,
  mapLabel,
  currentQuality,
  onApply,
}: {
  manifestUrl: string;
  mapLabel: string;
  currentQuality: ScenarioAuthoringQuality;
  onApply: (quality: ScenarioAuthoringQuality) => void;
}) {
  const benchmark = useRenderingBenchmark(manifestUrl);
  return (
    <div className="mx-auto mt-6 w-full max-w-4xl text-left">
      <RenderingBenchmarkSection
        state={benchmark.state}
        currentQuality={currentQuality}
        mapLabel={mapLabel}
        onStart={benchmark.start}
        onCancel={benchmark.cancel}
        onApply={onApply}
      />
      {benchmark.runner}
    </div>
  );
}

export function RenderingBenchmarkSection({
  state,
  currentQuality,
  mapLabel = "Current map",
  onStart,
  onCancel,
  onApply,
}: {
  state: BenchmarkState;
  currentQuality: ScenarioAuthoringQuality;
  mapLabel?: string;
  onStart: () => void;
  onCancel: () => void;
  onApply: (quality: ScenarioAuthoringQuality) => void;
}) {
  const [copied, setCopied] = useState(false);
  const snapshot =
    state.phase === "complete" || state.phase === "idle"
      ? state.snapshot
      : null;
  const active = state.phase === "loading" || state.phase === "measuring";
  const results =
    snapshot?.results ?? ("results" in state ? state.results : []);
  const failures =
    snapshot?.failures ?? ("failures" in state ? state.failures : []);
  const startedAt = "startedAt" in state ? state.startedAt : null;
  const elapsedSeconds = useElapsedSeconds(active, startedAt);
  const completedCount = results.length + failures.length;
  const candidate = active
    ? choiceLabel(SCENARIO_AUTHORING_QUALITY_IDS[state.candidateIndex]!)
    : null;

  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);

  return (
    <div data-testid="rendering-benchmark">
      <button
        type="button"
        onClick={onStart}
        className="group relative w-full overflow-hidden px-6 py-8 text-left transition duration-300 hover:-translate-y-0.5 focus-visible:rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044] sm:px-10"
        aria-label={
          snapshot ? "Run benchmark again" : `Start benchmark on ${mapLabel}`
        }
      >
        <span className="relative flex items-center gap-5">
          <span className="grid size-16 shrink-0 place-items-center text-[#E8E044] transition-transform duration-300 group-hover:scale-105">
            <Gauge className="size-9" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-meta text-[10px] font-bold uppercase tracking-[0.18em] text-[#E8E044]">
              Benchmark
            </span>
            <span className="mt-1 block text-xl font-semibold text-white sm:text-2xl">
              {snapshot ? "Run Benchmark Again" : "Start Benchmark"}
            </span>
            <span className="mt-1 block truncate text-xs text-white/45">
              {mapLabel}
            </span>
          </span>
          <ArrowRight
            className="size-5 shrink-0 text-[#E8E044] transition-transform duration-300 group-hover:translate-x-1"
            aria-hidden="true"
          />
        </span>
      </button>

      {snapshot ? (
        <p className="mt-2 text-center text-micro text-muted-foreground">
          Last result:{" "}
          <span className="font-semibold text-foreground">
            {choiceLabel(snapshot.recommended)}
          </span>
        </p>
      ) : null}

      {state.phase === "error" ? (
        <div
          className="mt-3 flex items-start justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs"
          role="alert"
        >
          <span className="min-w-0 text-destructive">
            <span className="block">Benchmark stopped: {state.message}</span>
            {state.failures.length > 0 ? (
              <span className="mt-1 block text-[10px] text-destructive/80">
                {state.failures
                  .map(
                    (failure) =>
                      `${choiceLabel(failure.quality)}: ${failure.message}`,
                  )
                  .join(" · ")}
              </span>
            ) : null}
          </span>
          <Button size="sm" variant="outline" onClick={onStart}>
            Try again
          </Button>
        </div>
      ) : null}

      {active ? (
        <BenchmarkProgressOverlay
          state={state}
          results={results}
          failures={failures}
          elapsedSeconds={elapsedSeconds}
          candidate={candidate ?? "Renderer"}
          completedCount={completedCount}
          onCancel={onCancel}
        />
      ) : null}

      {state.phase === "complete" ? (
        <BenchmarkResultOverlay
          snapshot={state.snapshot}
          currentQuality={currentQuality}
          copied={copied}
          onCopy={() => {
            if (!navigator.clipboard) return;
            void navigator.clipboard
              .writeText(JSON.stringify(state.snapshot, null, 2))
              .then(() => setCopied(true));
          }}
          onApply={onApply}
          onRestart={onStart}
        />
      ) : null}
    </div>
  );
}

function BenchmarkProgressOverlay({
  state,
  results,
  failures,
  elapsedSeconds,
  candidate,
  completedCount,
  onCancel,
}: {
  state: Extract<BenchmarkState, { phase: "loading" | "measuring" }>;
  results: RenderingBenchmarkResult[];
  failures: RenderingBenchmarkFailure[];
  elapsedSeconds: number;
  candidate: string;
  completedCount: number;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[220] grid place-items-center overflow-hidden text-white"
      role="status"
      aria-live="polite"
    >
      <SkyCloudBackdrop className="fixed" />
      <Button
        className="absolute right-5 top-5 z-10 gap-2 rounded-full bg-transparent text-white/60 hover:bg-transparent hover:text-white"
        size="sm"
        variant="ghost"
        onClick={onCancel}
      >
        <X className="size-4" aria-hidden="true" /> Cancel
      </Button>

      <div
        className="relative z-10 w-full max-w-3xl px-6 py-10 text-center sm:px-10"
        data-testid="benchmark-progress-content"
        data-visual-treatment="flat"
      >
        <div className="relative mx-auto grid size-44 place-items-center sm:size-52">
          <div className="absolute inset-0 animate-spin rounded-full border border-primary/25 border-t-primary [animation-duration:3s]" />
          <div className="absolute inset-5 animate-spin rounded-full border border-dashed border-primary/30 border-b-primary [animation-direction:reverse] [animation-duration:5s]" />
          <div className="absolute inset-10 animate-pulse rounded-full bg-primary/10" />
          <div className="relative grid size-20 place-items-center rounded-full bg-primary text-primary-foreground shadow-[0_0_60px_hsl(var(--primary)/.45)]">
            {state.phase === "loading" ? (
              <LoaderCircle
                className="size-9 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Activity className="size-9 animate-pulse" aria-hidden="true" />
            )}
          </div>
        </div>

        <p className="mt-8 font-meta text-[10px] font-bold uppercase tracking-[0.28em] text-primary">
          {state.phase === "loading"
            ? "Preparing renderer"
            : "Testing orbit smoothness"}
        </p>
        <h2 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          {candidate}
        </h2>
        <p className="mt-2 text-sm tabular-nums text-muted-foreground">
          {elapsedSeconds}s elapsed · {completedCount} of{" "}
          {SCENARIO_AUTHORING_QUALITY_IDS.length} complete
        </p>

        <div
          className="mx-auto mt-9 grid max-w-2xl grid-cols-4 gap-2"
          aria-label="Benchmark progress"
        >
          {SCENARIO_AUTHORING_QUALITY_IDS.map((quality, index) => {
            const result = results.find((item) => item.quality === quality);
            const failed = failures.some((item) => item.quality === quality);
            const current = index === state.candidateIndex;
            return (
              <div key={quality} className="min-w-0">
                <div
                  className={cn(
                    "relative h-2 overflow-hidden rounded-full bg-border/70",
                    result && "bg-primary",
                    failed && "bg-destructive/70",
                  )}
                >
                  {current ? (
                    <span className="absolute inset-y-0 left-0 w-1/2 animate-pulse rounded-full bg-primary" />
                  ) : null}
                </div>
                <p
                  className={cn(
                    "mt-2 truncate text-[10px] text-muted-foreground",
                    current && "font-semibold text-foreground",
                  )}
                >
                  {choiceLabel(quality)}
                </p>
                {result ? (
                  <p className="mt-0.5 text-micro font-semibold tabular-nums text-primary">
                    {result.metrics.avgFps.toFixed(0)} FPS
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function BenchmarkResultOverlay({
  snapshot,
  currentQuality,
  copied,
  onCopy,
  onApply,
  onRestart,
}: {
  snapshot: RenderingBenchmarkSnapshot;
  currentQuality: ScenarioAuthoringQuality;
  copied: boolean;
  onCopy: () => void;
  onApply: (quality: ScenarioAuthoringQuality) => void;
  onRestart: () => void;
}) {
  const recommendedResult = snapshot.results.find(
    (result) => result.quality === snapshot.recommended,
  );
  return (
    <div
      className="fixed inset-0 z-[220] overflow-y-auto text-white"
      role="dialog"
      aria-modal="true"
      aria-labelledby="benchmark-result-title"
    >
      <SkyCloudBackdrop className="fixed" />
      <div className="relative mx-auto flex min-h-full w-full max-w-4xl flex-col items-center justify-center px-5 py-12 text-center">
        <div className="relative grid size-20 place-items-center rounded-full bg-primary text-primary-foreground shadow-[0_0_70px_hsl(var(--primary)/.4)]">
          <span className="absolute inset-0 animate-ping rounded-full border border-primary opacity-25" />
          <Sparkles className="size-9" aria-hidden="true" />
        </div>
        <p className="mt-7 font-meta text-[10px] font-bold uppercase tracking-[0.28em] text-primary">
          Your best match
        </p>
        <h2
          id="benchmark-result-title"
          className="mt-2 text-4xl font-semibold tracking-tight text-foreground sm:text-6xl"
        >
          {choiceLabel(snapshot.recommended)}
        </h2>
        {recommendedResult ? (
          <div className="mt-5 flex items-center justify-center gap-6 text-sm text-muted-foreground">
            <span>
              <strong className="text-xl font-semibold tabular-nums text-foreground">
                {recommendedResult.metrics.avgFps.toFixed(0)}
              </strong>{" "}
              FPS
            </span>
            <span className="h-8 w-px bg-border" />
            <span>
              <strong className="text-xl font-semibold tabular-nums text-foreground">
                {recommendedResult.metrics.p95FrameMs.toFixed(1)}
              </strong>{" "}
              ms p95
            </span>
          </div>
        ) : null}
        <Button
          autoFocus
          className="mt-8 h-12 min-w-64 gap-2 rounded-full bg-[#E8E044] px-8 text-sm text-black hover:bg-[#f1ea55] focus-visible:ring-[#E8E044]"
          size="lg"
          onClick={() => onApply(snapshot.recommended)}
        >
          {currentQuality === snapshot.recommended
            ? "Continue with recommendation"
            : `Use recommended ${choiceLabel(snapshot.recommended)}`}
          <ArrowRight className="size-4" aria-hidden="true" />
        </Button>

        <section
          className="mt-9 w-full max-w-3xl"
          aria-labelledby="benchmark-manual-selection-title"
        >
          <div className="flex items-center gap-4">
            <span className="h-px flex-1 bg-border" />
            <h3
              id="benchmark-manual-selection-title"
              className="font-meta text-[10px] font-bold uppercase tracking-meta-wider text-muted-foreground"
            >
              Manual selection
            </h3>
            <span className="h-px flex-1 bg-border" />
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {SCENARIO_AUTHORING_QUALITY_CHOICES.map((choice) => {
              const result = snapshot.results.find(
                (candidate) => candidate.quality === choice.id,
              );
              const failed = snapshot.failures.some(
                (candidate) => candidate.quality === choice.id,
              );
              return (
                <button
                  key={choice.id}
                  type="button"
                  aria-label={`Use ${choice.label}`}
                  onClick={() => onApply(choice.id)}
                  className={cn(
                    "group min-h-24 p-3 text-left transition hover:-translate-y-0.5 focus-visible:rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]",
                    currentQuality === choice.id
                      ? "text-[#E8E044]"
                      : "text-white/70",
                  )}
                >
                  <span className="flex items-start justify-between gap-2">
                    <span className="text-sm font-semibold text-foreground">
                      {choice.label}
                    </span>
                    {choice.id === snapshot.recommended ? (
                      <span className="rounded-full bg-primary/15 px-1.5 py-0.5 font-meta text-[8px] font-bold uppercase tracking-meta text-primary">
                        Best
                      </span>
                    ) : currentQuality === choice.id ? (
                      <span className="rounded-full border border-border px-1.5 py-0.5 font-meta text-[8px] font-bold uppercase tracking-meta text-muted-foreground">
                        Current
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-3 block text-micro tabular-nums text-muted-foreground">
                    {result
                      ? `${result.metrics.avgFps.toFixed(0)} FPS · ${result.metrics.orbit.p95FrameMs.toFixed(1)} ms orbit p95`
                      : failed
                        ? "Test unavailable · select anyway"
                        : "Select this profile"}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <details className="mt-8 w-full max-w-3xl rounded-xl border border-border bg-card/70 text-left">
          <summary className="cursor-pointer list-none px-4 py-3 text-xs font-semibold text-muted-foreground hover:text-foreground">
            Benchmark details
          </summary>
          <div className="space-y-3 border-t border-border p-4">
            <HardwareSummary hardware={snapshot.hardware} />
            <div className="space-y-2" aria-label="Renderer benchmark results">
              {snapshot.results.map((result) => (
                <BenchmarkResultCard
                  key={result.quality}
                  result={result}
                  recommended={result.quality === snapshot.recommended}
                />
              ))}
              {snapshot.failures.map((failure) => (
                <div
                  key={failure.quality}
                  className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-semibold text-foreground">
                      {choiceLabel(failure.quality)}
                    </span>
                    <span className="text-destructive">Unavailable</span>
                  </div>
                  <p className="mt-1 text-micro text-muted-foreground">
                    {failure.message}
                  </p>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                className="gap-2"
                size="sm"
                variant="outline"
                onClick={onCopy}
              >
                <Clipboard className="size-3.5" aria-hidden="true" />
                {copied ? "Report copied" : "Copy developer report"}
              </Button>
              <Button
                className="gap-2"
                size="sm"
                variant="ghost"
                onClick={onRestart}
              >
                <RotateCcw className="size-3.5" aria-hidden="true" /> Run again
              </Button>
            </div>
          </div>
        </details>
      </div>
    </div>
  );
}

function useElapsedSeconds(active: boolean, startedAt: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [active, startedAt]);
  return startedAt === null
    ? 0
    : Math.max(0, Math.floor((now - startedAt) / 1000));
}

function HardwareSummary({
  hardware,
}: {
  hardware: RenderingBenchmarkHardware;
}) {
  const display =
    hardware.display.width && hardware.display.height
      ? `${hardware.display.width}×${hardware.display.height} @ ${hardware.display.pixelRatio.toFixed(2)}×`
      : "Unavailable";
  return (
    <section
      className="border border-border bg-surface-raised p-3"
      aria-label="Benchmark hardware"
    >
      <h3 className="font-meta text-micro font-bold uppercase tracking-meta text-muted-foreground">
        Hardware and runtime
      </h3>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-micro sm:grid-cols-3">
        <Diagnostic label="Browser" value={hardware.browser} />
        <Diagnostic label="Operating system" value={hardware.operatingSystem} />
        <Diagnostic
          label="CPU threads"
          value={hardware.logicalProcessors?.toString() ?? "Unavailable"}
        />
        <Diagnostic
          label="Device memory"
          value={
            hardware.deviceMemoryGB
              ? `${hardware.deviceMemoryGB} GB`
              : "Unavailable"
          }
        />
        <Diagnostic label="Display" value={display} />
        <Diagnostic
          label="Graphics API"
          value={
            hardware.renderer
              ? hardware.renderer.webgl2
                ? "WebGL 2"
                : "WebGL 1"
              : "Detecting…"
          }
        />
        <Diagnostic
          label="Benchmark canvas"
          value={`${RENDERING_BENCHMARK_CONFIGURATION.viewportWidth}×${RENDERING_BENCHMARK_CONFIGURATION.viewportHeight}`}
        />
        <Diagnostic
          label="Sample window"
          value={`${(RENDERING_BENCHMARK_CONFIGURATION.sampleDurationMs / 1000).toFixed(1)} seconds per bundle`}
        />
      </dl>
      <dl className="mt-2 border-t border-border/60 pt-2 text-micro">
        <Diagnostic
          label="GPU / renderer"
          value={
            hardware.renderer
              ? `${hardware.renderer.renderer} · ${hardware.renderer.vendor}${hardware.renderer.software ? " · software" : ""}`
              : "Detecting from benchmark canvas…"
          }
        />
      </dl>
    </section>
  );
}

function Diagnostic({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className="mt-0.5 break-words font-medium text-foreground"
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function BenchmarkResultCard({
  result,
  recommended,
}: {
  result: RenderingBenchmarkResult;
  recommended: boolean;
}) {
  const { metrics } = result;
  return (
    <article
      className={cn(
        "border p-3",
        recommended
          ? "border-primary/60 bg-primary/10"
          : "border-border bg-card",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="font-semibold text-foreground">
          {choiceLabel(result.quality)}
        </h4>
        {recommended ? (
          <span className="bg-primary px-1.5 py-0.5 font-meta text-[9px] font-bold uppercase text-primary-foreground">
            Recommended
          </span>
        ) : null}
      </div>
      <div className="mt-2 grid grid-cols-4 gap-2">
        <Metric label="Average" value={`${metrics.avgFps.toFixed(1)} FPS`} />
        <Metric label="Minimum" value={`${metrics.minFps.toFixed(1)} FPS`} />
        <Metric
          label="Orbit p95"
          value={`${metrics.orbit.p95FrameMs.toFixed(1)} ms`}
        />
        <Metric
          label="Orbit p99"
          value={`${metrics.orbit.p99FrameMs.toFixed(1)} ms`}
        />
        <Metric
          label="Orbit stalls"
          value={metrics.orbit.over33_3.toLocaleString()}
        />
        <Metric label="Draw calls" value={metrics.drawCalls.toLocaleString()} />
        <Metric label="Resident" value={formatBytes(metrics.residentBytes)} />
        <Metric
          label="CPU proxy"
          value={`${metrics.cpuUtilizationProxy.toFixed(0)}%`}
        />
        <Metric
          label={
            result.assetLoading.streamingSettled
              ? "Assets ready"
              : "Load window"
          }
          value={`${(result.assetLoading.settleMs / 1000).toFixed(1)} s${result.assetLoading.streamingSettled ? "" : "+"}`}
        />
        <Metric
          label="Transferred"
          value={formatBytes(result.assetLoading.transferBytes)}
        />
        <Metric
          label="Asset requests"
          value={result.assetLoading.requestCount.toLocaleString()}
        />
        <Metric
          label="Cache hits"
          value={result.assetLoading.cachedResponses.toLocaleString()}
        />
      </div>
      <p className="mt-2 text-micro text-muted-foreground">
        {metrics.frames.toLocaleString()} frames over{" "}
        {(metrics.durationMs / 1000).toFixed(1)}s · three orbit passes reverse
        direction and change viewing angle · worst orbit frame{" "}
        {metrics.orbit.maxFrameMs.toFixed(1)} ms
      </p>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[9px] uppercase tracking-meta text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 text-micro font-semibold tabular-nums text-foreground">
        {value}
      </p>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function BenchmarkCanvas({
  manifestUrl,
  quality,
  signal,
  onMeasuring,
  onHardware,
  onComplete,
  onError,
}: {
  manifestUrl: string;
  quality: ScenarioAuthoringQuality;
  signal?: AbortSignal;
  onMeasuring: () => void;
  onHardware: (hardware: RenderingBenchmarkHardware) => void;
  onComplete: (result: RenderingBenchmarkResult) => void;
  onError: (reason: unknown) => void;
}) {
  const viewerRef = useRef<CityViewer | null>(null);
  const loadStartedAt = useRef(performance.now());
  const preset = AUTHORING_QUALITY[quality];

  const run = useCallback(async () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    try {
      const streamingSettled = await waitForViewerSettled(viewer, {
        signal,
        allowUsableOnTimeout: true,
      });
      if (signal?.aborted) return;
      const settledAt = performance.now();
      const assetBase = renderingBenchmarkAssetBase(manifestUrl);
      const resources = (
        performance.getEntriesByType("resource") as PerformanceResourceTiming[]
      ).filter(
        (entry) =>
          entry.startTime >= loadStartedAt.current &&
          entry.name.startsWith(assetBase),
      );
      onMeasuring();
      const metrics = await viewer.runBenchmark(
        RENDERING_BENCHMARK_CONFIGURATION.sampleDurationMs,
      );
      if (!signal?.aborted)
        onComplete({
          quality,
          metrics,
          assetLoading: {
            settleMs: settledAt - loadStartedAt.current,
            streamingSettled,
            requestCount: resources.length,
            transferBytes: resources.reduce(
              (sum, entry) => sum + entry.transferSize,
              0,
            ),
            encodedBodyBytes: resources.reduce(
              (sum, entry) => sum + entry.encodedBodySize,
              0,
            ),
            decodedBodyBytes: resources.reduce(
              (sum, entry) => sum + entry.decodedBodySize,
              0,
            ),
            cachedResponses: resources.filter(
              (entry) => entry.transferSize === 0 && entry.decodedBodySize > 0,
            ).length,
          },
        });
    } catch (reason) {
      onError(reason);
    }
  }, [manifestUrl, onComplete, onError, onMeasuring, quality, signal]);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed left-[-10000px] top-0 h-[720px] w-[1280px] overflow-hidden opacity-0"
      data-testid="rendering-benchmark-canvas"
    >
      <CityView
        manifestUrl={manifestUrl}
        options={{
          maxPixelRatio: preset.maxPixelRatio,
          antialias: preset.antialias,
          ultraLowFidelity: preset.ultraLow,
          roadsOnlyFidelity: preset.roadsOnly,
          vegetationMaxDistance: preset.live.vegetationMaxDistance,
          byteBudget: preset.live.byteBudget,
          maxScreenSpaceError: preset.live.maxScreenSpaceError,
          vegetationScreenSpaceError: preset.live.vegetationScreenSpaceError,
          uploadBudgetMs: preset.live.uploadBudgetMs,
          uploadPixelsPerFrame: preset.live.uploadPixelsPerFrame,
          exposure: preset.live.exposure,
        }}
        onReady={(viewer) => {
          viewerRef.current = viewer;
          onHardware(captureRenderingBenchmarkHardware(viewer));
        }}
        onMapLoaded={() => void run()}
        onError={onError}
      />
    </div>
  );
}

function choiceLabel(quality: ScenarioAuthoringQuality) {
  return (
    SCENARIO_AUTHORING_QUALITY_CHOICES.find(
      (choice) => choice.id === quality,
    )?.label ?? quality
  );
}
