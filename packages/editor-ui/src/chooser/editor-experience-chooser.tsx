"use client";

import { Clock3, SlidersHorizontal } from "../icons";

/** The two authoring experiences. The simulation format never changes between them. */
export type EditorExperience = "simple" | "advanced";

export function EditorExperienceChooser({ onChoose }: { onChoose: (mode: EditorExperience) => void }) {
  return (
    <div className="ueui-chooser" data-testid="editor-experience-chooser">
      <div className="ueui-chooser-card">
        <h2 className="ueui-chooser-title">How do you want to build this scenario?</h2>
        <p className="ueui-chooser-subtitle">You can switch views later without changing the simulation format.</p>
        <div className="ueui-chooser-options">
          <button className="ueui-chooser-option ueui-chooser-option-simple" onClick={() => onChoose("simple")} type="button">
            <Clock3 className="ueui-chooser-icon-accent" size={24} />
            <strong className="ueui-chooser-option-title">Simple</strong>
            <span className="ueui-chooser-option-detail">Every movable actor gets one custom timed route. After its final authored point, the actor brakes under physics; the timeline stays visible but locked.</span>
          </button>
          <button className="ueui-chooser-option ueui-chooser-option-advanced" onClick={() => onChoose("advanced")} type="button">
            <SlidersHorizontal className="ueui-chooser-icon-muted" size={24} />
            <strong className="ueui-chooser-option-title">Advanced</strong>
            <span className="ueui-chooser-option-detail">Use the current multi-track timeline, triggers, actions, signals, and detailed controls.</span>
          </button>
        </div>
      </div>
    </div>
  );
}
