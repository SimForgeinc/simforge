"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { Input } from "@/app/components/ui/input";
import {
  actionsForActor,
  interactionForAction,
  type EditorDocument,
} from "@simforge/editor";
import { snapToTimeGrid } from "@/app/lib/scenario/timeline";
import type { Interaction } from "@simforge/scenario";
import { CanonicalInteractionComposer } from "./CanonicalInteractionComposer";

type Role = EditorDocument["data"]["roles"][number];

/** How long a directly-added `gap` or `exist` occupies before the author narrows it. */
const DIRECT_ADD_DURATION_S = 1;

/**
 * The catalog of actions the selected actor can perform, plus the time they land
 * at.
 *
 * The time field is shared by every button rather than per-action, because the
 * author's mental model is "at 3 seconds, do these three things" — asking for the
 * time again per action is what a form would do, not a timeline.
 *
 * The editor and playback share one clock. Actions are authored from t=0 through
 * the visible clip; there is no hidden pre-roll authoring range.
 */
export function ActionPalette({
  document,
  role,
  otherRole,
  interactions,
  time,
  onTimeChange,
}: {
  document: EditorDocument;
  role: Role | null;
  otherRole: Role | null;
  interactions: readonly Interaction[];
  time: number;
  onTimeChange: (time: number) => void;
}) {
  const timeId = useId();
  const clipSeconds = document.data.choreography?.clipSeconds ?? 20;
  const actions = useMemo(
    () =>
      role && !role.actor.static
        ? actionsForActor(role.actor.class, role.actor.catalogId)
        : [],
    [role],
  );
  const targetSpeedAction = actions.find(
    (action) =>
      action.verb === "speed" &&
      action.target.mode === "absolute",
  );
  const defaultTargetSpeed =
    typeof targetSpeedAction?.target.valueKph === "number"
      ? targetSpeedAction.target.valueKph
      : 0;
  const [targetSpeedKph, setTargetSpeedKph] = useState(defaultTargetSpeed);
  useEffect(() => setTargetSpeedKph(defaultTargetSpeed), [defaultTargetSpeed, role?.id]);

  const addDirect = (verb: "gap" | "exist", target: Interaction["target"]) => {
    if (!role) return;
    const continuous = verb === "gap";
    document.addInteraction({
      id: `${verb}_${role.id}_${interactions.length + 1}`,
      actor: role.id,
      label: verb === "gap" ? "Follow gap" : "Become absent",
      trigger: { kind: "at", t: snapToTimeGrid(Math.max(0, time)) },
      until: { kind: "at", t: snapToTimeGrid(Math.max(0, time) + DIRECT_ADD_DURATION_S) },
      verb,
      target,
      ...(continuous
        ? { dynamics: { shape: "linear", constraint: "time", value: 1 } }
        : {}),
    } as Interaction);
  };

  return (
    <div className="w-editor-rail shrink-0 overflow-y-auto border-r border-white/10 bg-[#0d0d0d] p-3 text-white xl:w-editor-rail-xl">
      <label
        className="block text-micro font-semibold uppercase tracking-meta-wide text-white/45"
        htmlFor={timeId}
      >
        Add action at time
      </label>
      <div className="mt-2 flex gap-2">
        <Input
          id={timeId}
          type="number"
          step={0.5}
          min={0}
          max={clipSeconds}
          value={time}
          onChange={(event) => onTimeChange(Number(event.target.value))}
          className="h-8 w-20 border-white/15 bg-white/5 text-xs text-white"
          aria-describedby={`${timeId}-range`}
        />
        <span aria-hidden="true" className="self-center text-xs text-white/45">
          seconds
        </span>
      </div>
      <p id={`${timeId}-range`} className="mt-1 text-micro leading-4 text-white/35">
        Choose a time from 0 to {clipSeconds} seconds.
      </p>
      {targetSpeedAction ? (
        <label className="mt-2 block text-micro font-semibold uppercase tracking-meta-wide text-white/45">
          Target speed (kph)
          <Input
            className="mt-1 h-8 border-white/15 bg-white/5 text-xs text-white"
            data-testid="action-palette-target-speed"
            step={1}
            type="number"
            value={targetSpeedKph}
            onChange={(event) => {
              const value = Number(event.currentTarget.value);
              if (Number.isFinite(value)) setTargetSpeedKph(Math.max(0, value));
            }}
          />
        </label>
      ) : null}
      {role ? (
        <div className="mt-3">
          <CanonicalInteractionComposer
            document={document}
            interactions={interactions}
            otherRole={otherRole}
            role={role}
            testIdPrefix="action-palette-canonical"
            time={time}
          />
        </div>
      ) : null}
      <div className="mt-2 max-h-36 overflow-y-auto">
        {actions.map((action) => (
          <PaletteButton
            key={action.id}
            testId={`action-palette-${action.id}`}
            onClick={() =>
              role &&
              document.addInteraction(
                interactionForAction(
                  action === targetSpeedAction
                    ? {
                        ...action,
                        target: { ...action.target, valueKph: targetSpeedKph },
                      }
                    : action,
                  role.id,
                  time,
                  interactions.length + 1,
                ),
              )
            }
          >
            {action.label}
          </PaletteButton>
        ))}
        {role && !role.actor.static && otherRole ? (
          <PaletteButton
            onClick={() =>
              addDirect("gap", { role: otherRole.id, value: 2, unit: "time" })
            }
          >
            Follow gap
          </PaletteButton>
        ) : null}
        {role ? (
          <PaletteButton onClick={() => addDirect("exist", { state: "absent" })}>
            Become absent
          </PaletteButton>
        ) : null}
        {!role ? (
          <p className="text-xs text-white/40">
            Select an actor to author behavior.
          </p>
        ) : role.actor.static ? (
          <p className="text-xs text-white/40" data-testid="static-actor-action-message">
            Static actors stay fixed. Turn off Static / parked to add motion.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function PaletteButton({
  children,
  onClick,
  testId,
}: {
  children: React.ReactNode;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="editor-motion mr-1 mt-1 rounded-sm border border-white/10 bg-white/5 px-2 py-1 text-meta text-white/70 hover:border-[#E8E044]/60 hover:bg-[#E8E044]/10 hover:text-[#E8E044] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044] focus-visible:ring-offset-1 focus-visible:ring-offset-[#0d0d0d]"
    >
      {children}
    </button>
  );
}
