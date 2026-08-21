import { useMemo } from 'react';
import {
  V1TimelineRail,
  type EditorExperience,
  type V1TimelineBrowserPlayback,
  type V1TimelineCrashMarker,
  type V1TimelineRailProps,
  type V1TimelineSignalLane,
} from '@uniscenarios/editor-ui';
import type { EditorController, EditorDocument, EditorState } from '@uniscenarios/editor-core';
import type { PlaybackBundle, PlaybackController } from '@uniscenarios/playback';
import type { MapSignalPlan } from '@uniscenarios/scenario-model';
import type { StudioSessionApi } from '../session/useStudioSession';
import './workspace-shell.css';

export interface WorkspaceTimelineDockProps {
  controller: EditorController | null;
  editorState: EditorState | null;
  session: StudioSessionApi;
  /** Live playback driver; present only while an authored trace is mounted. */
  playbackController: PlaybackController | null;
  authoredPlayback: PlaybackBundle | null;
  experience: EditorExperience;
  signalLanes: readonly V1TimelineSignalLane[];
  selectedInteractionId?: string | null;
  onSelectActor?: (actorId: string) => void;
  onFocusActor?: (actorId: string) => void;
  onSelectInteraction?: (interactionId: string, actorId: string) => void;
  onClearSelection?: () => void;
  onSelectSignal?: (headId: string) => void;
  /** Dash-camera transport preserved from the split-pane timeline. */
  dashCameras?: readonly { id: string; label: string }[];
  selectedDashCameraId?: string | null;
  onDashCameraChange?: (id: string) => void;
  onCameraPlay?: () => void;
}

const crashMarkers = (bundle: PlaybackBundle, document: EditorDocument): readonly V1TimelineCrashMarker[] =>
  bundle.trace.events
    .filter((event) => event.kind === 'collision')
    .map((event) => ({
      timeS: event.t,
      actorLabels: [event.a, event.b].map((actorId) =>
        document.data.roles.find((role) => role.id === actorId)?.label
        ?? document.actor(actorId)?.label
        ?? actorId,
      ),
    }));

/**
 * SimCloud's floating timeline dock: bottom-center, 920 px wide, height
 * author-resizable inside the rail itself. The studio's canonical session and
 * playback controller feed the shared V1TimelineRail, so authoring edits,
 * transport and crash markers stay one authority.
 */
export function WorkspaceTimelineDock({
  controller,
  editorState,
  session,
  playbackController,
  authoredPlayback,
  experience,
  signalLanes,
  selectedInteractionId = null,
  onSelectActor,
  onFocusActor,
  onSelectInteraction,
  onClearSelection,
  onSelectSignal,
  dashCameras = [],
  selectedDashCameraId = null,
  onDashCameraChange,
  onCameraPlay,
}: WorkspaceTimelineDockProps): JSX.Element | null {
  const document = controller?.doc ?? null;
  const inspecting = session.state.mode !== 'authoring';
  const playing = session.state.mode === 'playing';

  const playback = useMemo<V1TimelineBrowserPlayback | null>(() => {
    if (!authoredPlayback || !playbackController || !document) return null;
    return {
      sessionId: authoredPlayback.instance.manifest.inputHash,
      playing,
      inspecting,
      time: session.state.time,
      crashes: crashMarkers(authoredPlayback, document),
      onPlay: () => session.playPause(),
      onStop: () => {
        if (session.state.mode === 'playing') session.playPause();
      },
      onReset: () => session.seek(0),
      onPlayPause: () => session.playPause(),
      onSeek: (time) => session.seek(time),
      onExitInspection: () => session.stop(),
    };
  }, [authoredPlayback, document, inspecting, playbackController, playing, session]);

  if (!controller || !document) return null;

  const railProps: V1TimelineRailProps = {
    document,
    state: editorState ? { selection: editorState.selection, mode: editorState.mode } : null,
    signalLanes,
    playback,
    selectedInteractionId,
    onSelectActor,
    onFocusActor,
    onSelectInteraction,
    onClearSelection,
    onSelectSignal,
    disableInteractionCreation: experience === 'simple',
    lockSimpleTimedRoutes: experience === 'simple',
    readOnly: false,
  };

  return (
    <div
      className="studio-timeline-layer"
      data-testid="floating-timeline-layer"
      data-simulation={String(inspecting)}
    >
      <div className="studio-timeline-dock" data-testid="studio-timeline-dock">
        {inspecting ? (
          <p className="studio-timeline-escape-hint">Press Escape to exit simulation</p>
        ) : null}
        <div className="studio-timeline-ground-shadow" aria-hidden="true" />
        {authoredPlayback && dashCameras.length > 0 ? (
          <div className="studio-dash-camera-bar" data-testid="studio-dash-camera-bar">
            <label>
              Dash camera{' '}
              <select
                value={selectedDashCameraId ?? dashCameras[0]?.id ?? ''}
                onChange={(event) => onDashCameraChange?.(event.target.value)}
                aria-label="Dash camera"
              >
                {dashCameras.map((camera) => (
                  <option key={camera.id} value={camera.id}>{camera.label}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="studio-dash-camera-play"
              onClick={onCameraPlay}
              disabled={!selectedDashCameraId && !dashCameras[0]}
            >
              ▶ Play camera
            </button>
          </div>
        ) : null}
        <V1TimelineRail {...railProps} />
      </div>
    </div>
  );
}

/**
 * Studio's map-bound controller plans as V1 signal lanes. Bands come from the
 * authored clips; the lane is display + selection only — phase editing stays
 * with Studio's signal selection model.
 */
export function signalLanesFromPlans(
  plans: readonly MapSignalPlan[],
  mapId: string,
  selectedHeadId: string | null,
  onRemovePlan: (planId: string) => void,
): readonly V1TimelineSignalLane[] {
  return plans
    .filter((plan) => plan.binding.mapId === mapId && plan.clips.length > 0)
    .map((plan) => {
      const clips = [...plan.clips].sort((left, right) => left.startS - right.startS);
      const headIds = [...new Set(clips.map((clip) => clip.reference.headId))];
      const selected = clips.find((clip) => clip.reference.headId === selectedHeadId);
      return {
        junctionId: plan.binding.junctionId,
        controllerId: clips[0]!.reference.controllerId,
        headIds,
        referenceHeadId: selected?.reference.headId ?? clips[0]!.reference.headId,
        bands: clips.map((clip) => ({
          startS: clip.startS,
          endS: clip.endS,
          indication: clip.indication,
          source: 'authored' as const,
          clipId: clip.id,
        })),
        onRemoveControl: () => onRemovePlan(plan.id),
      };
    });
}
