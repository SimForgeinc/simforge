"use client";

import { ArrowLeft, BrainCircuit } from "lucide-react";
import {
  TopBarActionsPortal,
  TopBarTrailingPortal,
  useSetPageTitle,
  useSetTopBarActionsAlignment,
} from "@/app/components/TopBarSlot";
import type { CityViewer } from "@uniscenarios/city-renderer";
import { Button } from "@/app/components/ui/button";
import type { UniScenarioAuthoringQuality } from "@/app/lib/uniscenario/contracts";
import type { EditorDocument } from "@uniscenarios/editor-core";
import {
  solutionForAuthoringIssue,
  type SimulationIssue,
} from "../simulation-issues";
import { ScenarioReadinessButton } from "../readiness";
import { EditorTutorialGuide } from "../tutorial/EditorTutorialGuide";
import { ViewportSettingsPanel } from "./slots/ViewportSettingsPanel";
import type { EditorExperience } from "../simple-timed-routes";

const EXPECTED_MAP_BOUND_ISSUES = new Set([
  "non_portable_role",
  "pin_site_unresolved",
]);

/**
 * V1's focused editor toolbar over the V2 authoring runtime.
 *
 * Dataset-level actions remain in the scenario list. The reasoning-trace
 * action lives here because it directly adds an editor timeline lane.
 */
export function EditorHeader({
  document = null,
  getDebugInformation,
  onExit,
  viewer = null,
  quality,
  onQualityChange,
  simulationIssues = [],
  experience = null,
  onExperienceToggle,
}: {
  document?: EditorDocument | null;
  getDebugInformation?: () => string;
  onExit?: () => void;
  viewer?: CityViewer | null;
  quality?: UniScenarioAuthoringQuality;
  onQualityChange?: (quality: UniScenarioAuthoringQuality) => void;
  simulationIssues?: readonly SimulationIssue[];
  experience?: EditorExperience | null;
  onExperienceToggle?: () => void;
}) {
  useSetPageTitle("Editor");
  useSetTopBarActionsAlignment("start");
  const sensorSubjectId = document?.data.roles.find(
    (role) => role.actor.sensors.length > 0,
  )?.id;
  const reasoningTraceEnabled = Boolean(
    sensorSubjectId && (
      document?.data.reasoningTrace.length > 0 ||
      document?.data.extensions?.["studio.presentation.reasoningTraceLane"] === true
    ),
  );
  const isFullyMapBound = Boolean(
    document?.data.roles?.length &&
    document.data.roles.every((role) => role.kind === "scene_absolute"),
  );
  const readinessIssues: readonly SimulationIssue[] = [
    ...(document?.validation?.issues ?? []).flatMap((issue, index) =>
      issue.severity === "info" ||
      (isFullyMapBound && EXPECTED_MAP_BOUND_ISSUES.has(issue.code))
        ? []
        : [{
            id: `authoring-${issue.code}-${index}`,
            severity: issue.severity,
            title: issue.severity === "error" ? "Scenario needs a change" : "Scenario suggestion",
            detail: `${issue.message} (${issue.path})`,
            solution: solutionForAuthoringIssue(issue.code, issue.path),
          }],
    ),
    ...simulationIssues,
  ];

  return (
    <>
      <TopBarActionsPortal>
        <div
          className="flex min-w-0 items-center gap-2"
          data-testid="uniscenario-editor-toolbar"
          data-tour="toolbar"
        >
          {onExit ? (
            <Button
              aria-label="Exit editor"
              className="h-8 gap-1.5 rounded-none border border-border/70 bg-background/70 shadow-sm"
              onClick={onExit}
              size="sm"
              type="button"
              variant="ghost"
            >
              <ArrowLeft aria-hidden="true" className="size-3.5" />
              <span>Exit editor</span>
            </Button>
          ) : null}
        </div>
      </TopBarActionsPortal>
      <TopBarTrailingPortal>
        <div className="flex items-center gap-2" data-testid="uniscenario-editor-toolbar-trailing">
          <EditorTutorialGuide experience={experience ?? "advanced"} />
          <ScenarioReadinessButton issues={readinessIssues} />
          {/* Weather and traffic moved to the left rail: they are things you add
              to the scenario, like actors, and they now share that panel's tile
              galleries. Reasoning traces stay advanced-only. */}
          {experience !== "simple" ? (
            <>
              <Button
                aria-label="Add reasoning trace"
                className="h-8 gap-2 rounded-none border border-[#E8E044]/45 bg-card/90 px-3 text-[#E8E044] shadow-sm backdrop-blur hover:border-[#E8E044] hover:bg-[#E8E044] hover:text-black disabled:border-border disabled:text-muted-foreground"
                data-testid="editor-add-reasoning-trace"
                disabled={!sensorSubjectId || reasoningTraceEnabled}
                onClick={() => document?.setPresentationExtension("studio.presentation.reasoningTraceLane", true)}
                size="sm"
                title={!sensorSubjectId ? "Add a camera to a vehicle first" : reasoningTraceEnabled ? "Reasoning trace row already added" : "Add one reasoning trace row"}
                type="button"
                variant="outline"
              >
                <BrainCircuit aria-hidden="true" className="size-4" />
                <span>Add reasoning trace</span>
              </Button>
            </>
          ) : null}
          <ViewportSettingsPanel
            experience={experience}
            getDebugInformation={getDebugInformation}
            onExperienceToggle={onExperienceToggle}
            onQualityChange={onQualityChange}
            placement="topbar"
            quality={quality}
            viewer={viewer}
          />
        </div>
      </TopBarTrailingPortal>
    </>
  );
}
