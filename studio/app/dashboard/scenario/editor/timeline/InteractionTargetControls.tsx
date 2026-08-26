"use client";

import { Input } from "@/app/components/ui/input";
import { SelectMenu, SelectMenuField } from "@/app/components/ui/select-menu";
import type { EditorDocument } from "@simforge-oss/editor";
import {
  InteractionSchema,
  lookupSetKey,
  type FramePose,
  type Interaction,
  type SetValue,
} from "@simforge-oss/scenario";

type SpeedInteraction = Extract<Interaction, { verb: "speed" }>;
type ChangeLaneInteraction = Extract<Interaction, { verb: "changeLane" }>;
type RouteInteraction = Extract<Interaction, { verb: "route" }>;
type RouteTarget = RouteInteraction["target"];

const SPEED_MODES: readonly SpeedInteraction["target"]["mode"][] = [
  "absolute",
  "delta",
  "factor",
  "match",
  "stop",
  "resume",
];
const LANE_CHANGE_MODES: readonly ChangeLaneInteraction["target"]["mode"][] = [
  "relative",
  "absolute",
  "toRole",
];
const ROUTE_MODES: readonly RouteTarget["mode"][] = [
  "turn",
  "nextJunction",
  "toFeature",
  "crossing",
  "polyline",
  "customRoute",
  "customTimedRoute",
  "lanePath",
  "acquire",
  "nearMiss",
];

/**
 * Edits the value carried by one timeline event without changing its identity,
 * trigger, duration, or dynamics. Every commit is parsed by the vendored
 * interaction schema first, so a half-entered id or out-of-range number never
 * escapes the inspector into the document.
 */
export function InteractionTargetControls({
  document,
  interaction,
}: {
  document: EditorDocument;
  interaction: Interaction;
}) {
  const commit = (target: unknown) => {
    const parsed = InteractionSchema.safeParse({ ...interaction, target });
    if (parsed.success) document.replaceInteraction(interaction.id, parsed.data);
  };
  const roleOptions = document.data.roles.map((role) => ({
    value: role.id,
    label: role.label ?? role.id,
  }));
  const peer = roleOptions.find((role) => role.value !== interaction.actor)?.value
    ?? roleOptions[0]?.value
    ?? interaction.actor;

  if (interaction.verb === "speed") {
    return (
      <div className="space-y-2">
        <InteractionTargetModeControls
          document={document}
          interaction={interaction}
        />
        {interaction.target.mode === "absolute"
          ? numberTarget(
              interaction.id,
              "Target speed (kph)",
              "speed",
              interaction.target.valueKph,
              0,
              (valueKph) => commit({ ...interaction.target, valueKph }),
            )
          : interaction.target.mode === "delta"
            ? numberTarget(
                interaction.id,
                "Speed change (kph)",
                "speed-delta",
                interaction.target.deltaKph,
                undefined,
                (deltaKph) => commit({ ...interaction.target, deltaKph }),
              )
            : interaction.target.mode === "factor"
              ? numberTarget(
                  interaction.id,
                  "Speed factor",
                  "speed-factor",
                  interaction.target.factor,
                  0,
                  (factor) => commit({ ...interaction.target, factor }),
                )
              : interaction.target.mode === "match"
                ? (
                    <div className="grid grid-cols-2 gap-2">
                      <SelectMenuField
                        className="h-8 text-xs"
                        label="Match actor"
                        options={roleOptions}
                        value={interaction.target.role}
                        onChange={(role) => commit({ ...interaction.target, role })}
                      />
                      {numberTarget(
                        interaction.id,
                        "Speed offset (kph)",
                        "speed-offset",
                        interaction.target.offsetKph ?? 0,
                        undefined,
                        (offsetKph) => commit({ ...interaction.target, offsetKph }),
                      )}
                    </div>
                  )
                : <TargetSummary value={interaction.target.mode === "stop" ? "0 kph (stop)" : "Resume prior speed"} />}
      </div>
    );
  }

  if (interaction.verb === "gap") {
    return (
      <div className="grid grid-cols-2 gap-2">
        <SelectMenuField
          className="h-8 text-xs"
          label="Follow actor"
          options={roleOptions}
          value={interaction.target.role}
          onChange={(role) => commit({ ...interaction.target, role })}
        />
        <SelectMenuField
          className="h-8 text-xs"
          label="Gap unit"
          options={[
            { value: "time", label: "Time (seconds)" },
            { value: "distance", label: "Distance (metres)" },
          ]}
          value={interaction.target.unit}
          onChange={(unit) => commit({
            ...interaction.target,
            unit: unit as "time" | "distance",
          })}
        />
        <div className="col-span-2">
          {numberTarget(
            interaction.id,
            interaction.target.unit === "time" ? "Gap (seconds)" : "Gap (metres)",
            "gap",
            interaction.target.value,
            0,
            (value) => commit({ ...interaction.target, value }),
          )}
        </div>
      </div>
    );
  }

  if (interaction.verb === "laneOffset") {
    return (
      <div className="grid grid-cols-2 gap-2">
        <SelectMenuField
          className="h-8 text-xs"
          label="Offset reference"
          options={[
            { value: "lane_center", label: "Lane center" },
            { value: "lane_edge_left", label: "Left lane edge" },
            { value: "lane_edge_right", label: "Right lane edge" },
          ]}
          value={interaction.target.reference ?? "lane_center"}
          onChange={(reference) => commit({
            ...interaction.target,
            reference: reference as NonNullable<typeof interaction.target.reference>,
          })}
        />
        {numberTarget(
          interaction.id,
          "Lane offset (fraction)",
          "lane-offset",
          interaction.target.tFrac,
          -1,
          (tFrac) => commit({ ...interaction.target, tFrac }),
          1,
        )}
      </div>
    );
  }

  if (interaction.verb === "changeLane") {
    return (
      <div className="space-y-2">
        <InteractionTargetModeControls
          document={document}
          interaction={interaction}
        />
        {interaction.target.mode === "relative"
          ? numberTarget(
              interaction.id,
              "Relative lane change",
              "lane-change",
              interaction.target.dk,
              -4,
              (dk) => commit({ ...interaction.target, dk: Math.round(dk) }),
              4,
              1,
            )
          : interaction.target.mode === "absolute"
            ? numberTarget(
                interaction.id,
                "Target lane index",
                "lane-index",
                interaction.target.k,
                -8,
                (k) => commit({ ...interaction.target, k: Math.round(k) }),
                8,
                1,
              )
            : (
                <SelectMenuField
                  className="h-8 text-xs"
                  label="Align with actor"
                  options={roleOptions}
                  value={interaction.target.role}
                  onChange={(role) => commit({ ...interaction.target, role })}
                />
              )}
      </div>
    );
  }

  if (interaction.verb === "route") {
    return (
      <RouteTargetControls
        interaction={interaction}
        peer={peer}
        roleOptions={roleOptions}
        onChange={commit}
      />
    );
  }

  if (interaction.verb === "exist") {
    return (
      <SelectMenuField
        className="h-8 text-xs"
        label="Existence state"
        options={[
          { value: "present", label: "Present" },
          { value: "absent", label: "Absent" },
        ]}
        value={interaction.target.state}
        onChange={(state) => commit({ state: state as "present" | "absent" })}
      />
    );
  }

  if (interaction.verb === "set") {
    return (
      <SetValueControl
        interaction={interaction}
        onChange={(value) => commit({ ...interaction.target, value })}
      />
    );
  }

  return null;
}

/**
 * The mode selector is exported because the action popover intentionally puts
 * common speed/lane semantics in a separate panel. Keeping the default builders
 * here makes both inspector layouts switch to the exact same canonical shape.
 */
export function InteractionTargetModeControls({
  document,
  interaction,
}: {
  document: EditorDocument;
  interaction: SpeedInteraction | ChangeLaneInteraction;
}) {
  const roles = document.data.roles.map((role) => ({
    value: role.id,
    label: role.label ?? role.id,
  }));
  const peer = roles.find((role) => role.value !== interaction.actor)?.value
    ?? roles[0]?.value
    ?? interaction.actor;
  const commit = (target: SpeedInteraction["target"] | ChangeLaneInteraction["target"]) => {
    const parsed = InteractionSchema.safeParse({ ...interaction, target });
    if (parsed.success) document.replaceInteraction(interaction.id, parsed.data);
  };

  if (interaction.verb === "speed") {
    return (
      <SelectMenuField
        className="h-8 text-xs"
        label="Speed target mode"
        options={SPEED_MODES.map((value) => ({ value, label: humanize(value) }))}
        value={interaction.target.mode}
        onChange={(mode) => commit(defaultSpeedTarget(mode as SpeedInteraction["target"]["mode"], peer))}
      />
    );
  }
  return (
    <SelectMenuField
      className="h-8 text-xs"
      label="Lane target mode"
      options={LANE_CHANGE_MODES.map((value) => ({ value, label: humanize(value) }))}
      value={interaction.target.mode}
      onChange={(mode) => commit(defaultLaneChangeTarget(mode as ChangeLaneInteraction["target"]["mode"], peer))}
    />
  );
}

function RouteTargetControls({
  interaction,
  peer,
  roleOptions,
  onChange,
}: {
  interaction: RouteInteraction;
  peer: string;
  roleOptions: Array<{ value: string; label: string }>;
  onChange: (target: RouteTarget) => void;
}) {
  const { target } = interaction;
  return (
    <div className="space-y-2">
      <SelectMenuField
        className="h-8 text-xs"
        label="Route target mode"
        options={ROUTE_MODES.map((value) => ({ value, label: humanize(value) }))}
        value={target.mode}
        onChange={(mode) => onChange(defaultRouteTarget(mode as RouteTarget["mode"], peer))}
      />
      {target.mode === "turn" ? (
        <div className="grid grid-cols-2 gap-2">
          <IdField label="Junction feature" value={target.feature} onChange={(feature) => onChange({ ...target, feature })} />
          <SelectMenuField className="h-8 text-xs" label="Turn" options={["left", "right", "straight", "uturn"]} value={target.turn} onChange={(turn) => onChange({ ...target, turn: turn as typeof target.turn })} />
        </div>
      ) : target.mode === "nextJunction" ? (
        <SelectMenuField className="h-8 text-xs" label="Turn" options={["straight", "left", "right"]} value={target.turn} onChange={(turn) => onChange({ ...target, turn: turn as typeof target.turn })} />
      ) : target.mode === "toFeature" ? (
        <IdField label="Destination feature" value={target.feature} onChange={(feature) => onChange({ ...target, feature })} />
      ) : target.mode === "crossing" ? (
        <div className="grid grid-cols-2 gap-2">
          <div className="col-span-2"><IdField label="Crossing feature" value={target.feature} onChange={(feature) => onChange({ ...target, feature })} /></div>
          {numberTarget(interaction.id, "Start fraction", "crossing-from", target.fromFrac ?? 0, 0, (fromFrac) => onChange({ ...target, fromFrac }), 1)}
          {numberTarget(interaction.id, "End fraction", "crossing-to", target.toFrac ?? 1, 0, (toFrac) => onChange({ ...target, toFrac }), 1)}
        </div>
      ) : target.mode === "polyline" ? (
        <FramePoseList interactionId={interaction.id} points={target.points} onChange={(points) => onChange({ ...target, points })} />
      ) : target.mode === "customRoute" ? (
        <CustomPointList interactionId={interaction.id} points={target.points} onChange={(points) => onChange({ ...target, points })} />
      ) : target.mode === "customTimedRoute" ? (
        <TimedCustomPointList interactionId={interaction.id} points={target.points} onChange={(points) => onChange({ ...target, points })} />
      ) : target.mode === "lanePath" ? (
        <TextListField label="Lane ids (comma separated)" value={target.lanes} onChange={(lanes) => onChange({ ...target, lanes })} />
      ) : target.mode === "acquire" ? (
        <FramePoseControls interactionId={interaction.id} pose={target.pose} onChange={(pose) => onChange({ ...target, pose })} />
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <SelectMenuField className="h-8 text-xs" label="Near-miss actor" options={roleOptions} value={target.target} onChange={(next) => onChange({ ...target, target: next })} />
          <SelectMenuField className="h-8 text-xs" label="Pass" options={["front", "behind", "auto"]} value={target.pass ?? "auto"} onChange={(pass) => onChange({ ...target, pass: pass as NonNullable<typeof target.pass> })} />
          {numberTarget(interaction.id, "Clearance (m)", "near-miss-clearance", target.clearanceM ?? 1, 0, (clearanceM) => onChange({ ...target, clearanceM }))}
          {numberTarget(interaction.id, "Minimum speed (kph)", "near-miss-min-speed", target.minSpeedKph ?? 0, 0, (minSpeedKph) => onChange({ ...target, minSpeedKph }))}
          {numberTarget(interaction.id, "Maximum speed (kph)", "near-miss-max-speed", target.maxSpeedKph ?? 50, 0, (maxSpeedKph) => onChange({ ...target, maxSpeedKph }))}
          {numberTarget(interaction.id, "Deadline (s)", "near-miss-deadline", target.deadlineS ?? 10, 0, (deadlineS) => onChange({ ...target, deadlineS }))}
        </div>
      )}
    </div>
  );
}

function FramePoseList({ interactionId, points, onChange }: { interactionId: string; points: readonly FramePose[]; onChange: (points: FramePose[]) => void }) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-micro text-white/45">Polyline points</legend>
      {points.map((point, index) => (
        <div className="border border-white/10 p-2" key={index}>
          <FramePoseControls interactionId={`${interactionId}-${index}`} pose={point} onChange={(pose) => onChange(points.map((item, at) => at === index ? pose : item))} />
          {points.length > 2 ? <button className="mt-2 text-micro text-red-300" type="button" onClick={() => onChange(points.filter((_, at) => at !== index))}>Remove point {index + 1}</button> : null}
        </div>
      ))}
      {points.length < 32 ? <button className="text-micro text-[#E8E044]" type="button" onClick={() => onChange([...points, { s: 0, laneOffset: 0, tFrac: 0, headingOffsetRad: 0 }])}>Add polyline point</button> : null}
    </fieldset>
  );
}

function FramePoseControls({ interactionId, pose, onChange }: { interactionId: string; pose: FramePose; onChange: (pose: FramePose) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {numberTarget(interactionId, "Longitudinal s", "pose-s", pose.s, undefined, (s) => onChange({ ...pose, s }))}
      {numberTarget(interactionId, "Lane index offset", "pose-lane", pose.laneOffset ?? 0, -8, (laneOffset) => onChange({ ...pose, laneOffset: Math.round(laneOffset) }), 8, 1)}
      {numberTarget(interactionId, "Lateral fraction", "pose-frac", pose.tFrac ?? 0, -1, (tFrac) => onChange({ ...pose, tFrac }), 1)}
      {numberTarget(interactionId, "Heading offset (rad)", "pose-heading", pose.headingOffsetRad ?? 0, -Math.PI, (headingOffsetRad) => onChange({ ...pose, headingOffsetRad }), Math.PI)}
    </div>
  );
}

function CustomPointList({ interactionId, points, onChange }: { interactionId: string; points: readonly { x: number; z: number }[]; onChange: (points: { x: number; z: number }[]) => void }) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-micro text-white/45">Scene points</legend>
      {points.map((point, index) => (
        <div className="grid grid-cols-2 gap-2 border border-white/10 p-2" key={index}>
          {numberTarget(interactionId, `Point ${index + 1} x`, `custom-x-${index}`, point.x, undefined, (x) => onChange(points.map((item, at) => at === index ? { ...item, x } : item)))}
          {numberTarget(interactionId, `Point ${index + 1} z`, `custom-z-${index}`, point.z, undefined, (z) => onChange(points.map((item, at) => at === index ? { ...item, z } : item)))}
          {points.length > 2 ? <button className="col-span-2 text-left text-micro text-red-300" type="button" onClick={() => onChange(points.filter((_, at) => at !== index))}>Remove point {index + 1}</button> : null}
        </div>
      ))}
      {points.length < 128 ? <button className="text-micro text-[#E8E044]" type="button" onClick={() => onChange([...points, { x: 0, z: 0 }])}>Add scene point</button> : null}
    </fieldset>
  );
}

function TimedCustomPointList({ interactionId, points, onChange }: {
  interactionId: string;
  points: readonly { timeS: number; x: number; z: number }[];
  onChange: (points: { timeS: number; x: number; z: number }[]) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-micro text-white/45">Exact timed scene points</legend>
      {points.map((point, index) => (
        <div className="grid grid-cols-3 gap-2 border border-white/10 p-2" key={index}>
          {numberTarget(interactionId, `Point ${index + 1} time`, `timed-time-${index}`, point.timeS, 0, (timeS) => onChange(points.map((item, at) => at === index ? { ...item, timeS } : item)))}
          {index === 0
            ? pinnedCoordinate(interactionId, "Point 1 x", "timed-x-0", point.x)
            : numberTarget(interactionId, `Point ${index + 1} x`, `timed-x-${index}`, point.x, undefined, (x) => onChange(points.map((item, at) => at === index ? { ...item, x } : item)))}
          {index === 0
            ? pinnedCoordinate(interactionId, "Point 1 z", "timed-z-0", point.z)
            : numberTarget(interactionId, `Point ${index + 1} z`, `timed-z-${index}`, point.z, undefined, (z) => onChange(points.map((item, at) => at === index ? { ...item, z } : item)))}
          {index === 0 ? (
            // Not an authored waypoint: it is where the simulation starts the actor, so it
            // is the actor's own position. The map tool refuses to drag it for the same
            // reason, and moving the actor carries the whole route.
            <p className="col-span-3 text-micro text-white/35">
              The first point is the actor&apos;s position. Move the actor to move it.
            </p>
          ) : null}
          {index > 0 && points.length > 2 ? <button className="col-span-3 text-left text-micro text-red-300" type="button" onClick={() => onChange(points.filter((_, at) => at !== index))}>Remove point {index + 1}</button> : null}
        </div>
      ))}
      {points.length < 1024 ? <button className="text-micro text-[#E8E044]" type="button" onClick={() => {
        const last = points.at(-1) ?? { timeS: 0, x: 0, z: 0 };
        onChange([...points, { timeS: last.timeS + 1, x: last.x, z: last.z }]);
      }}>Add one-second point</button> : null}
    </fieldset>
  );
}

function defaultSpeedTarget(mode: SpeedInteraction["target"]["mode"], peer: string): SpeedInteraction["target"] {
  if (mode === "absolute") return { mode, valueKph: 30 };
  if (mode === "delta") return { mode, deltaKph: 0 };
  if (mode === "factor") return { mode, factor: 1 };
  if (mode === "match") return { mode, role: peer, offsetKph: 0 };
  return { mode };
}

function defaultLaneChangeTarget(mode: ChangeLaneInteraction["target"]["mode"], peer: string): ChangeLaneInteraction["target"] {
  if (mode === "relative") return { mode, dk: 1 };
  if (mode === "absolute") return { mode, k: 0 };
  return { mode, role: peer };
}

function defaultRouteTarget(mode: RouteTarget["mode"], peer: string): RouteTarget {
  if (mode === "turn") return { mode, feature: "feature", turn: "left" };
  if (mode === "nextJunction") return { mode, turn: "straight" };
  if (mode === "toFeature") return { mode, feature: "feature" };
  if (mode === "crossing") return { mode, feature: "feature", fromFrac: 0, toFrac: 1 };
  if (mode === "polyline") return {
    mode,
    points: [
      { s: 0, laneOffset: 0, tFrac: 0, headingOffsetRad: 0 },
      { s: 10, laneOffset: 0, tFrac: 0, headingOffsetRad: 0 },
    ],
  };
  // One point on the origin is the canonical undrawn route. The document seeds
  // it onto the actor when this target is committed, so the inspector does not
  // need the pose to hand out a sane default.
  if (mode === "customRoute") return { mode, points: [{ x: 0, z: 0 }] };
  if (mode === "customTimedRoute") return { mode, points: [{ timeS: 0, x: 0, z: 0 }] };
  if (mode === "lanePath") return { mode, lanes: ["1:0:-1"] };
  if (mode === "acquire") return { mode, pose: { s: 0, laneOffset: 0, tFrac: 0, headingOffsetRad: 0 } };
  return { mode, target: peer, clearanceM: 1, pass: "auto", minSpeedKph: 0, maxSpeedKph: 50, deadlineS: 10 };
}

function numberTarget(
  interactionId: string,
  label: string,
  selector: string,
  value: unknown,
  min: number | undefined,
  onChange: (value: number) => void,
  max?: number,
  step = 0.1,
) {
  if (typeof value !== "number") return <TargetSummary value="Expression-authored value" />;
  return (
    <label className="block text-micro text-white/45">
      {label}
      <Input
        className="mt-1 h-8 border-white/15 bg-white/5 text-xs text-white"
        data-testid={`interaction-target-${selector}-${interactionId}`}
        max={max}
        min={min}
        step={step}
        type="number"
        value={value}
        onChange={(event) => {
          const next = Number(event.currentTarget.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
    </label>
  );
}

/**
 * A timed route's first coordinate, shown but not editable. It is the position the
 * simulation starts the actor from, which makes it the actor's own pose rather than a
 * waypoint; the field is kept visible because reading the start is still useful.
 */
function pinnedCoordinate(interactionId: string, label: string, selector: string, value: unknown) {
  if (typeof value !== "number") return <TargetSummary value="Expression-authored value" />;
  return (
    <label className="block text-micro text-white/35">
      {label}
      <Input
        className="mt-1 h-8 border-white/10 bg-white/[0.02] text-xs text-white/50"
        data-testid={`interaction-target-${selector}-${interactionId}`}
        readOnly
        step={0.1}
        type="number"
        value={value}
      />
    </label>
  );
}

function IdField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block text-micro text-white/45">
      {label}
      <Input className="mt-1 h-8 border-white/15 bg-white/5 text-xs text-white" value={value} onChange={(event) => onChange(event.currentTarget.value)} />
    </label>
  );
}

function TextListField({ label, value, onChange }: { label: string; value: readonly string[]; onChange: (value: string[]) => void }) {
  return (
    <label className="block text-micro text-white/45">
      {label}
      <Input className="mt-1 h-8 border-white/15 bg-white/5 text-xs text-white" value={value.join(", ")} onChange={(event) => onChange(event.currentTarget.value.split(",").map((item) => item.trim()).filter(Boolean))} />
    </label>
  );
}

function SetValueControl({ interaction, onChange }: { interaction: Extract<Interaction, { verb: "set" }>; onChange: (value: SetValue) => void }) {
  const declaration = lookupSetKey(interaction.target.key);
  const selector = `interaction-target-value-${interaction.id}`;
  if (declaration?.valueType === "enum" && declaration.values) {
    return <div data-testid={selector}><SelectMenu className="h-8 text-xs" label="Target value" options={declaration.values.map((value) => ({ value, label: value }))} value={String(interaction.target.value)} onChange={onChange} /></div>;
  }
  if (declaration?.valueType === "boolean") {
    return <div data-testid={selector}><SelectMenu className="h-8 text-xs" label="Target value" options={[{ value: "true", label: "True" }, { value: "false", label: "False" }]} value={String(interaction.target.value)} onChange={(value) => onChange(value === "true")} /></div>;
  }
  return (
    <label className="block text-micro text-white/45">
      Target value
      <Input className="mt-1 h-8 border-white/15 bg-white/5 text-xs text-white" data-testid={selector} max={declaration?.range?.[1]} min={declaration?.range?.[0]} step={declaration?.valueType === "number" ? 0.1 : undefined} type={declaration?.valueType === "number" ? "number" : "text"} value={String(interaction.target.value)} onChange={(event) => {
        if (declaration?.valueType === "number") {
          const next = Number(event.currentTarget.value);
          if (Number.isFinite(next)) onChange(next);
        } else onChange(event.currentTarget.value);
      }} />
    </label>
  );
}

function TargetSummary({ value }: { value: string }) {
  return <p className="text-micro text-white/40">Target <span className="text-white/65">{value}</span></p>;
}

function humanize(value: string) {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}
