"use client";

import {
  BookOpen,
  Box,
  Camera,
  CarFront,
  FileInput,
  Gauge,
  MousePointer2,
  Play,
  Route,
  SlidersHorizontal,
  Sparkles,
  Timer,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/app/components/ui/button";
import { startInteractiveTutorial } from "./interactive-tutorial-events";
import type { EditorExperience } from "../simple-timed-routes";

const GUIDE_SECTIONS = [
  { href: "#tutorial-controls", label: "Controls" },
  { href: "#tutorial-viewport", label: "Settings" },
  { href: "#tutorial-actors", label: "Actors" },
  { href: "#tutorial-timeline", label: "Timeline" },
  { href: "#tutorial-simulation", label: "Simulation" },
  { href: "#tutorial-imports", label: "Imports" },
] as const;

const CONTROL_ITEMS = [
  {
    keys: ["Esc"],
    title: "Cancel or reset",
    body: "Cancel the current placement or edit. During simulation, stop, rewind, and return to authoring.",
  },
  {
    keys: ["Space"],
    title: "Play or pause",
    body: "Start or pause the timeline whenever you are not typing in a field.",
  },
  {
    keys: ["W", "A", "S", "D"],
    title: "Move across the map",
    body: "Pan the viewport forward, left, backward, and right.",
  },
] as const;

const POINTER_ITEMS = [
  {
    title: "Click",
    body: "Select an actor, interaction, or traffic light to open its details.",
  },
  {
    title: "Left-drag",
    body: "Orbit the camera around the current view target.",
  },
  {
    title: "Middle/right-drag · Wheel",
    body: "Pan the camera with a drag and zoom with the wheel.",
  },
] as const;

export function EditorTutorialGuide({
  experience = "advanced",
}: {
  experience?: EditorExperience;
}) {
  const [choiceOpen, setChoiceOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [guideMode, setGuideMode] = useState<EditorExperience>(experience);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const guidedButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setGuideMode(experience), [experience]);

  useEffect(() => {
    if (!choiceOpen && !open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (choiceOpen) guidedButtonRef.current?.focus();
    else closeButtonRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (choiceOpen) setChoiceOpen(false);
      else setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = previousOverflow;
    };
  }, [choiceOpen, open]);

  return (
    <>
      <Button
        aria-label="Tutorial"
        className="h-8 gap-2 rounded-none border border-border bg-card/90 px-3 shadow-sm backdrop-blur"
        onClick={() => setChoiceOpen(true)}
        size="sm"
        type="button"
        variant="outline"
      >
        <BookOpen aria-hidden="true" className="size-4" />
        <span>Tutorial</span>
      </Button>
      {choiceOpen
        ? createPortal(
            <div
              className="fixed inset-0 z-[145] grid place-items-center bg-black/60 p-4 backdrop-blur-sm"
              data-testid="tutorial-format-backdrop"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setChoiceOpen(false);
              }}
            >
              <section
                aria-describedby="tutorial-format-description"
                aria-labelledby="tutorial-format-title"
                aria-modal="true"
                className="w-full max-w-xl border border-white/15 bg-[#111111]/95 p-5 text-white shadow-[0_24px_80px_rgba(0,0,0,0.72)]"
                role="dialog"
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#E8E044]">
                      {experience} mode
                    </p>
                    <h2 className="mt-1 text-lg font-semibold" id="tutorial-format-title">
                      How would you like to learn?
                    </h2>
                    <p className="mt-1 text-xs leading-5 text-white/55" id="tutorial-format-description">
                      Follow the live editor step by step, or browse the complete written reference.
                    </p>
                  </div>
                  <button
                    aria-label="Close tutorial options"
                    className="grid size-8 shrink-0 place-items-center text-white/50 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]"
                    onClick={() => setChoiceOpen(false)}
                    type="button"
                  >
                    <X aria-hidden="true" className="size-4" />
                  </button>
                </div>

                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  <button
                    aria-label="Start guided tutorial"
                    className="group border border-[#E8E044]/55 bg-[#E8E044]/[0.07] p-4 text-left transition-colors hover:bg-[#E8E044]/[0.13] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]"
                    onClick={() => {
                      setChoiceOpen(false);
                      startInteractiveTutorial(experience);
                    }}
                    ref={guidedButtonRef}
                    type="button"
                  >
                    <Sparkles aria-hidden="true" className="size-5 text-[#E8E044]" />
                    <strong className="mt-3 block text-sm text-white">Guided tutorial</strong>
                    <span className="mt-1.5 block text-xs leading-5 text-white/55">
                      Complete actions in the live editor. This walkthrough authors content in the current scenario.
                    </span>
                  </button>
                  <button
                    aria-label="Open written guide"
                    className="group border border-white/15 bg-white/[0.03] p-4 text-left transition-colors hover:bg-white/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]"
                    onClick={() => {
                      setChoiceOpen(false);
                      setGuideMode(experience);
                      setOpen(true);
                    }}
                    type="button"
                  >
                    <BookOpen aria-hidden="true" className="size-5 text-white/70" />
                    <strong className="mt-3 block text-sm text-white">Written guide</strong>
                    <span className="mt-1.5 block text-xs leading-5 text-white/55">
                      Review controls and authoring concepts without changing the current scenario.
                    </span>
                  </button>
                </div>
              </section>
            </div>,
            document.body,
          )
        : null}
      {open
        ? createPortal(
            <div
              className="fixed inset-0 z-[140] bg-black/45 p-3 md:p-7"
              data-testid="editor-tutorial-backdrop"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setOpen(false);
              }}
            >
              <div
                aria-describedby="editor-tutorial-description"
                aria-labelledby="editor-tutorial-title"
                aria-modal="true"
                className="mx-auto flex h-full w-full max-w-[1180px] flex-col overflow-hidden rounded-[28px] border border-border/80 bg-background/95 text-foreground shadow-2xl backdrop-blur-xl"
                data-testid="editor-tutorial-guide"
                role="dialog"
              >
              <header className="flex shrink-0 items-center gap-4 border-b border-border bg-card/90 px-5 py-3 backdrop-blur md:px-8">
                <BookOpen aria-hidden="true" className="size-5 text-primary" />
                <div className="min-w-0">
                  <h2 className="text-base font-semibold" id="editor-tutorial-title">
                    Editor tutorial · {guideMode === "simple" ? "Simple" : "Advanced"}
                  </h2>
                  <p className="truncate text-xs text-muted-foreground" id="editor-tutorial-description">
                    {guideMode === "simple"
                      ? "Place actors, draw timed routes, and preview the result."
                      : "Configure actors, interactions, triggers, and simulation behavior."}
                  </p>
                </div>
                <nav aria-label="Tutorial sections" className="ml-auto hidden items-center gap-1 lg:flex">
                  {GUIDE_SECTIONS.map((section) => (
                    <a
                      className="px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      href={section.href}
                      key={section.href}
                    >
                      {section.label}
                    </a>
                  ))}
                </nav>
                <div className="hidden shrink-0 border border-border bg-background/60 p-0.5 sm:flex" role="group" aria-label="Tutorial mode">
                  {(["simple", "advanced"] as const).map((mode) => (
                    <button
                      aria-pressed={guideMode === mode}
                      className={guideMode === mode
                        ? "bg-[#E8E044] px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-black"
                        : "px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground"}
                      key={mode}
                      onClick={() => setGuideMode(mode)}
                      type="button"
                    >
                      {mode}
                    </button>
                  ))}
                </div>
                <Button
                  aria-label={`Start ${guideMode} interactive tutorial`}
                  className="ml-auto size-8 shrink-0 gap-2 px-0 sm:h-8 sm:w-auto sm:px-3 lg:ml-2"
                  disabled={guideMode !== experience}
                  onClick={() => {
                    setOpen(false);
                    startInteractiveTutorial(guideMode);
                  }}
                  size="sm"
                  title={guideMode === experience
                    ? `Start the ${guideMode} walkthrough in this scenario`
                    : `Switch the editor to ${guideMode} mode in Settings before starting`}
                  type="button"
                >
                  <Sparkles aria-hidden="true" className="size-3.5" />
                  <span className="hidden sm:inline">Start {guideMode} tutorial</span>
                </Button>
                <Button
                  aria-label="Close tutorial"
                  className="ml-auto size-8 shrink-0 md:ml-2"
                  onClick={() => setOpen(false)}
                  ref={closeButtonRef}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <X aria-hidden="true" className="size-4" />
                </Button>
              </header>

              <div className="min-h-0 flex-1 overflow-y-auto scroll-smooth">
                <main className="mx-auto w-full max-w-6xl space-y-10 px-5 py-8 md:px-8 md:py-12">
                  <section aria-labelledby="tutorial-controls-title" id="tutorial-controls">
                    <SectionHeading
                      eyebrow="Start here"
                      id="tutorial-controls-title"
                      title="Controls"
                    >
                      These are the only shortcuts you need to begin. Timeline playback takes priority
                      over camera controls while a simulation is ready.
                    </SectionHeading>
                    <div className="mt-6 grid gap-3 lg:grid-cols-3">
                      {CONTROL_ITEMS.map((item) => (
                        <article className="border border-primary/30 bg-primary/[0.06] p-4" key={item.title}>
                          <div className="flex min-h-9 flex-wrap items-center gap-1.5">
                            {item.keys.map((key) => <Keycap key={key}>{key}</Keycap>)}
                          </div>
                          <h3 className="mt-4 text-sm font-semibold">{item.title}</h3>
                          <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{item.body}</p>
                        </article>
                      ))}
                    </div>
                    <div className="mt-3 grid gap-3 md:grid-cols-3">
                      {POINTER_ITEMS.map((item) => (
                        <article className="flex gap-3 border border-border bg-card/60 p-4" key={item.title}>
                          <MousePointer2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
                          <div>
                            <h3 className="text-sm font-semibold">{item.title}</h3>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.body}</p>
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>

                  <section aria-labelledby="tutorial-viewport-title" id="tutorial-viewport">
                    <SectionHeading eyebrow="Make it yours" id="tutorial-viewport-title" title="Tune the viewport in Settings">
                      Open Settings in the top-right toolbar. We recommend tuning these controls for
                      your mouse, display, and device before detailed authoring; changes apply to the
                      live viewport immediately.
                    </SectionHeading>
                    <div className="mt-6 grid gap-3 lg:grid-cols-3">
                      <SettingCard icon={<Gauge aria-hidden="true" className="size-5" />} title="Render quality">
                        Choose Roads Only, Low, Balanced, or High. Start with Balanced, then raise
                        quality for sharper scene context or lower it if navigation feels sluggish.
                      </SettingCard>
                      <SettingCard icon={<Camera aria-hidden="true" className="size-5" />} title="Camera mode">
                        Orbit is best for authoring around a road target. Fly enables free inspection
                        with pointer-lock mouse look and WASD movement.
                      </SettingCard>
                      <SettingCard icon={<SlidersHorizontal aria-hidden="true" className="size-5" />} title="Camera and layers">
                        Adjust Look X/Y, pan, wheel zoom, keyboard speed, and invert options. Toggle
                        buildings, vegetation, or roads to keep the viewport readable.
                      </SettingCard>
                    </div>
                  </section>

                  <div className="grid gap-4 lg:grid-cols-3">
                    <GuideCard
                      icon={<CarFront aria-hidden="true" className="size-5" />}
                      id="tutorial-actors"
                      step="01"
                      title="Place actors"
                    >
                      <GuideStep>Open Cars, Pedestrians, or Objects from the floating toolbar.</GuideStep>
                      <GuideStep>Choose an asset, then click a valid road or surface to place it.</GuideStep>
                      {guideMode === "simple" ? (
                        <>
                          <GuideStep>Placement creates a red unfinished route interaction at the bottom of the editor.</GuideStep>
                          <GuideStep>Route drawing starts only after you click that interaction.</GuideStep>
                        </>
                      ) : (
                        <>
                          <GuideStep>Select the actor to edit its name, initial speed, driver behavior, color, and pose.</GuideStep>
                          <GuideStep>Placement warnings identify ambiguous or turning lanes; move along the road if you want a cleaner route.</GuideStep>
                        </>
                      )}
                    </GuideCard>

                    <GuideCard
                      icon={<Timer aria-hidden="true" className="size-5" />}
                      id="tutorial-timeline"
                      step="02"
                      title="Configure the timeline"
                    >
                      {guideMode === "simple" ? (
                        <>
                          <GuideStep>Each moving actor has one timed route. Click its red bar to configure the exact position constraints.</GuideStep>
                          <GuideStep>The actor starts at 0 seconds. Every route point represents one additional second.</GuideStep>
                          <GuideStep>Click the highlighted last point again to add a one-second wait. The actor holds its position and keeps facing the same direction.</GuideStep>
                          <GuideStep>Press Enter to finish. If the path ends early, the actor stops at its last point.</GuideStep>
                        </>
                      ) : (
                        <>
                          <GuideStep>Each actor gets a row. Right-click an empty part of that row to add an action.</GuideStep>
                          <GuideStep>Drag an interaction or its edges to move it and adjust its start and end.</GuideStep>
                          <GuideStep>Click an interaction to edit its timing, trigger, target, and dynamics.</GuideStep>
                        </>
                      )}
                      <GuideStep>Click the time grid or drag the yellow playhead to inspect another moment. Use Space to play or pause and Esc to reset.</GuideStep>
                    </GuideCard>

                    <GuideCard
                      icon={<Play aria-hidden="true" className="size-5" />}
                      id="tutorial-simulation"
                      step="03"
                      title="Run the simulation"
                    >
                      <GuideStep>Use the play control under Timeline—or press Space—to prepare and start browser playback.</GuideStep>
                      {guideMode === "advanced" ? (
                        <>
                          <GuideStep>Use Environment and Traffic settings for weather, map traffic, and signal behavior.</GuideStep>
                          <GuideStep>Select a traffic light to author its plan, and use a metric subject plus reasoning trace when the scenario needs decision context.</GuideStep>
                        </>
                      ) : (
                        <GuideStep>Actors meet their timed route points, then brake under normal physics after the final authored time.</GuideStep>
                      )}
                      <GuideStep>Open Simulation warnings in the top bar to review anything omitted, ambiguous, or unable to run.</GuideStep>
                      <GuideStep>Press Esc to stop, rewind to the beginning, and return to authoring.</GuideStep>
                    </GuideCard>
                  </div>

                  <section aria-labelledby="tutorial-imports-title" className="border border-border bg-card/50 p-5 md:p-6" id="tutorial-imports">
                    <div className="flex items-start gap-4">
                      <FileInput aria-hidden="true" className="mt-1 size-5 shrink-0 text-primary" />
                      <div className="min-w-0">
                        <SectionHeading
                          eyebrow="Bring work in"
                          id="tutorial-imports-title"
                          title="Imports"
                        >
                          Importing happens from the scenario list so the editor can resolve the map
                          before opening the document.
                        </SectionHeading>
                        <div className="mt-5 grid gap-3 md:grid-cols-2">
                          <ImportCard
                            icon={<Box aria-hidden="true" className="size-4" />}
                            title="Scenario JSON"
                          >
                            Restores a SimForge scenario document, then asks you to confirm the target map when needed.
                          </ImportCard>
                          <ImportCard
                            icon={<Route aria-hidden="true" className="size-4" />}
                            title="OpenSCENARIO file"
                          >
                            Opens ASAM OpenSCENARIO, analyzes its map references, and reports anything that needs resolution before import.
                          </ImportCard>
                        </div>
                      </div>
                    </div>
                  </section>
                </main>
              </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function SectionHeading({
  eyebrow,
  id,
  title,
  children,
}: {
  eyebrow: string;
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-primary">{eyebrow}</p>
      <h2 className="mt-1 text-xl font-semibold tracking-tight md:text-2xl" id={id}>{title}</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{children}</p>
    </div>
  );
}

function Keycap({ children }: { children: ReactNode }) {
  return (
    <kbd className="grid min-w-9 place-items-center border border-primary/50 bg-background px-2 py-1.5 font-mono text-xs font-semibold text-primary shadow-[0_2px_0_hsl(var(--border))]">
      {children}
    </kbd>
  );
}

function GuideCard({
  icon,
  id,
  step,
  title,
  children,
}: {
  icon: ReactNode;
  id: string;
  step: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-title`} className="border border-border bg-card/60 p-5" id={id}>
      <div className="flex items-center gap-3 text-primary">
        {icon}
        <span className="font-mono text-[10px] font-semibold tracking-[0.16em]">{step}</span>
      </div>
      <h2 className="mt-4 text-lg font-semibold" id={`${id}-title`}>{title}</h2>
      <ol className="mt-4 space-y-3">{children}</ol>
    </section>
  );
}

function GuideStep({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2.5 text-xs leading-5 text-muted-foreground">
      <span aria-hidden="true" className="mt-2 size-1 shrink-0 bg-primary" />
      <span>{children}</span>
    </li>
  );
}

function ImportCard({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <article className="border border-border bg-background/60 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <span className="text-primary">{icon}</span>
        {title}
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{children}</p>
    </article>
  );
}

function SettingCard({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <article className="rounded-xl border border-primary/25 bg-card/70 p-5">
      <div className="flex items-center gap-3 text-primary">
        {icon}
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      </div>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">{children}</p>
    </article>
  );
}
