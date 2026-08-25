"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { CloudLoadingTelemetry } from "@/app/components/CloudLoadingSurface";
import { CloudLoadingSurface } from "@/app/components/CloudLoadingSurface";
import { cn } from "@/app/lib/utils";

const EXIT_MS = 900;
const ROUTE_ENTRY_DELAY_MS = 180;
const ROUTE_PRIORITY = 10;

export type DashboardLoadingKind = "route" | "scene" | "boot";

export type DashboardLoadingSource = {
  kind: DashboardLoadingKind;
  title: string;
  detail?: string | null;
  eyebrow?: string;
  progress?: number | null;
  progressLabel?: string;
  progressValueLabel?: string;
  telemetry?: CloudLoadingTelemetry | null;
  phase?: string;
  priority?: number;
  severity?: "loading" | "error";
  icon?: ReactNode;
  actions?: ReactNode;
};

type RegisteredSource = {
  order: number;
  source: DashboardLoadingSource;
};

type DashboardLoadingContextValue = {
  setSource: (id: string, source: DashboardLoadingSource | null) => void;
};

const DashboardLoadingContext = createContext<DashboardLoadingContextValue | null>(null);

const INITIAL_ROUTE_SOURCE: DashboardLoadingSource = {
  kind: "route",
  title: "Loading your workspace…",
  detail: "Opening the dashboard in your workspace.",
  eyebrow: "SimForge",
  progress: null,
  progressLabel: "Cloud workspace",
  priority: ROUTE_PRIORITY,
};

export function DashboardLoadingProvider({ children }: { children: ReactNode }) {
  const [sources, setSources] = useState<Map<string, RegisteredSource>>(() => new Map());
  const [hydrating, setHydrating] = useState(true);
  const orderRef = useRef(0);
  const candidate = highestPrioritySource(sources) ?? (hydrating ? INITIAL_ROUTE_SOURCE : null);
  const [renderedSource, setRenderedSource] = useState<DashboardLoadingSource>(
    INITIAL_ROUTE_SOURCE,
  );
  const [mounted, setMounted] = useState(true);
  const [visible, setVisible] = useState(true);
  const [entryKind, setEntryKind] = useState<DashboardLoadingKind>("route");
  const exitTimerRef = useRef<number | null>(null);
  const exitFrameRef = useRef<number | null>(null);
  const sessionStartedAtRef = useRef(now());

  const setSource = useCallback(
    (id: string, source: DashboardLoadingSource | null) => {
      setSources((current) => {
        const existing = current.get(id);
        if (!source && !existing) return current;
        if (source && existing && loadingSourcesEqual(existing.source, source)) {
          return current;
        }
        const next = new Map(current);
        if (!source) {
          next.delete(id);
        } else {
          next.set(id, {
            order: existing?.order ?? ++orderRef.current,
            source,
          });
        }
        return next;
      });
    },
    [],
  );

  const contextValue = useMemo(() => ({ setSource }), [setSource]);

  useEffect(() => {
    setHydrating(false);
  }, []);

  useLayoutEffect(() => {
    if (candidate) {
      cancelScheduledExit(exitFrameRef, exitTimerRef);
      if (!mounted) {
        sessionStartedAtRef.current = now();
        setEntryKind(candidate.kind);
      }
      setRenderedSource(candidate);
      setMounted(true);
      setVisible(true);
      return;
    }

    if (!mounted) return;
    exitFrameRef.current = scheduleNextFrame(() => {
      exitFrameRef.current = null;
      if (
        entryKind === "route"
        && now() - sessionStartedAtRef.current < ROUTE_ENTRY_DELAY_MS
      ) {
        setVisible(false);
        setMounted(false);
        return;
      }
      setVisible(false);
      exitTimerRef.current = window.setTimeout(() => {
        setMounted(false);
        exitTimerRef.current = null;
      }, EXIT_MS);
    });

    return () => cancelScheduledExit(exitFrameRef, exitTimerRef);
  }, [candidate, entryKind, mounted]);

  useEffect(
    () => () => cancelScheduledExit(exitFrameRef, exitTimerRef),
    [],
  );

  const failed = renderedSource.severity === "error";
  const enteringScene = visible && entryKind === "scene";

  return (
    <DashboardLoadingContext.Provider value={contextValue}>
      {children}
      {mounted ? (
        <CloudLoadingSurface
          ariaBusy={visible && !failed}
          ariaHidden={!visible}
          backdropClassName={
            visible
              ? enteringScene
                ? "scene-loader-cloud-enter"
                : undefined
              : "scene-loader-cloud-exit"
          }
          className={cn(
            "!z-[250] transition-colors duration-[900ms] ease-out motion-reduce:transition-none",
            entryKind === "route" && "route-loading",
            enteringScene && "dashboard-scene-loading-enter",
            visible
              ? "pointer-events-auto bg-black/70 backdrop-blur-2xl"
              : "pointer-events-none bg-transparent backdrop-blur-none",
          )}
          contentTestId="dashboard-loading-content"
          contentWrapClassName={
            visible
              ? enteringScene
                ? "scene-loader-content-enter"
                : undefined
              : "scene-loader-content-exit"
          }
          dataLoadKind={renderedSource.kind}
          dataLoadPhase={renderedSource.phase}
          dataTransitionState={visible ? "covering" : "revealing"}
          detail={renderedSource.detail}
          eyebrow={renderedSource.eyebrow ?? "SimForge"}
          icon={renderedSource.icon}
          progress={failed ? undefined : renderedSource.progress}
          progressLabel={renderedSource.progressLabel}
          progressValueLabel={renderedSource.progressValueLabel}
          role={failed ? "alert" : "status"}
          scope="screen"
          telemetry={renderedSource.telemetry}
          telemetryTestId="dashboard-loading-telemetry"
          testId="dashboard-loading-surface"
          title={renderedSource.title}
        >
          {renderedSource.actions}
        </CloudLoadingSurface>
      ) : null}
    </DashboardLoadingContext.Provider>
  );
}

export function useDashboardLoadingSource(
  source: DashboardLoadingSource | null,
): void {
  const coordinator = useContext(DashboardLoadingContext);
  const reactId = useId();
  const sourceId = `dashboard-loading-${reactId}`;
  const sourceRef = useRef(source);
  sourceRef.current = source;

  useLayoutEffect(() => {
    if (!coordinator) return;
    coordinator.setSource(sourceId, sourceRef.current);
    return () => coordinator.setSource(sourceId, null);
  }, [coordinator, sourceId]);

  useLayoutEffect(() => {
    coordinator?.setSource(sourceId, source);
  }, [coordinator, source, sourceId]);
}

export function dashboardRouteLoadingSource({
  label,
  detail,
  depth = 1,
}: {
  label: string;
  detail: string;
  depth?: number;
}): DashboardLoadingSource {
  return {
    kind: "route",
    title: detail,
    detail: `Opening ${label.toLowerCase()} in your workspace.`,
    eyebrow: "SimForge",
    progress: null,
    progressLabel: "Cloud workspace",
    priority: ROUTE_PRIORITY + depth,
  };
}

function highestPrioritySource(
  sources: Map<string, RegisteredSource>,
): DashboardLoadingSource | null {
  let selected: RegisteredSource | null = null;
  for (const candidate of sources.values()) {
    if (!selected || compareSources(candidate, selected) > 0) selected = candidate;
  }
  return selected?.source ?? null;
}

function compareSources(left: RegisteredSource, right: RegisteredSource): number {
  const leftPriority = sourcePriority(left.source);
  const rightPriority = sourcePriority(right.source);
  return leftPriority === rightPriority ? left.order - right.order : leftPriority - rightPriority;
}

function sourcePriority(source: DashboardLoadingSource): number {
  if (source.severity === "error") return 100;
  if (source.priority !== undefined) return source.priority;
  switch (source.kind) {
    case "boot": return 30;
    case "scene": return 20;
    case "route": return ROUTE_PRIORITY;
  }
}

function loadingSourcesEqual(
  left: DashboardLoadingSource,
  right: DashboardLoadingSource,
): boolean {
  return (
    left.kind === right.kind
    && left.title === right.title
    && left.detail === right.detail
    && left.eyebrow === right.eyebrow
    && left.progress === right.progress
    && left.progressLabel === right.progressLabel
    && left.progressValueLabel === right.progressValueLabel
    && left.telemetry === right.telemetry
    && left.phase === right.phase
    && left.priority === right.priority
    && left.severity === right.severity
    && left.icon === right.icon
    && left.actions === right.actions
  );
}

function scheduleNextFrame(callback: () => void): number {
  if (typeof window.requestAnimationFrame === "function") {
    return window.requestAnimationFrame(callback);
  }
  return window.setTimeout(callback, 16);
}

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function cancelScheduledExit(
  frameRef: { current: number | null },
  timerRef: { current: number | null },
): void {
  if (frameRef.current !== null) {
    if (typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(frameRef.current);
    } else {
      window.clearTimeout(frameRef.current);
    }
    frameRef.current = null;
  }
  if (timerRef.current !== null) {
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }
}
