"use client";

import { SelectMenu, SelectMenuField } from "@/app/components/ui/select-menu";
import { Input } from "@/app/components/ui/input";
import {
  TriggerSchema,
  type Condition,
  type Interaction,
  type LeafCondition,
  type PointRef,
  type SignalRef,
  type Trigger,
} from "@simforge-oss/scenario";
import type { EditorDocument } from "@simforge-oss/editor";
import { NumberField, TextField } from "../authoring/fields";
import {
  CONDITION_KINDS,
  TRIGGER_KINDS,
  buildDefaultScenarioCondition,
  buildDefaultScenarioTrigger,
  numeric,
  type ConditionKind,
} from "./trigger-defaults";

const PHASES = [
  "green",
  "yellow",
  "red",
  "flashing_yellow",
  "flashing_red",
  "off",
  "green_arrow",
  "yellow_arrow",
  "red_x",
  "proceed",
  "stop",
] as const;

const COMPARISONS = ["<", "<=", ">", ">="] as const;
const LEAF_CONDITION_KINDS = CONDITION_KINDS.filter(
  (kind): kind is LeafCondition["kind"] => kind !== "and" && kind !== "or" && kind !== "not",
);

/**
 * One side of an interaction's window — when it starts, or when it ends.
 *
 * Changing the kind rebuilds the whole trigger from `buildDefaultScenarioTrigger`
 * rather than merging fields: a `when` trigger and an `arrival` trigger share no
 * fields, and a merged object would carry properties its own schema rejects,
 * which the export would only discover at compile time.
 *
 * "after" is disabled while there is nothing to be after. An action referencing
 * a nonexistent prior action parses but never fires.
 */
export function TriggerControls({
  label,
  value,
  document,
  actorId,
  interactionId,
  interactions,
  optional = false,
  onChange,
}: {
  label: string;
  value: Trigger | undefined;
  document: EditorDocument;
  actorId: string;
  interactionId: string;
  interactions: readonly Interaction[];
  optional?: boolean;
  onChange: (value: Trigger | undefined) => void;
}) {
  const roles = document.data.roles;
  const actor = actorId === "@world" ? (roles[0]?.id ?? "actor") : actorId;
  const peer = roles.find((role) => role.id !== actor)?.id ?? actor;
  const kind = value?.kind ?? "at";
  const references = interactions.filter((item) => item.id !== interactionId);
  const commit = (next: Trigger | undefined) => {
    if (next === undefined) {
      onChange(undefined);
      return;
    }
    const parsed = TriggerSchema.safeParse(next);
    if (parsed.success) onChange(parsed.data);
  };
  const setKind = (next: Trigger["kind"]) =>
    commit(buildDefaultScenarioTrigger(next, actor, peer, references));

  return (
    <fieldset className="min-w-0 space-y-2 text-meta">
      <legend className="font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </legend>
      <SelectMenu
        label={`${label} trigger`}
        value={value ? kind : "none"}
        onChange={(next) =>
          next === "none" ? commit(undefined) : setKind(next as Trigger["kind"])
        }
        options={[
          ...(optional ? [{ value: "none", label: "No end condition" }] : []),
          ...TRIGGER_KINDS.map((item) => ({
            value: item,
            disabled: item === "after" && references.length === 0,
          })),
        ]}
        className="h-8 text-xs"
      />
      {!value ? null : value.kind === "at" ? (
        <NumberField
          label="Time (s)"
          value={numeric(value.t)}
          onChange={(t) => commit({ ...value, t })}
        />
      ) : value.kind === "after" ? (
        <>
          <SelectMenuField
            label="Referenced action"
            value={value.of}
            options={references.map((item) => ({
              value: item.id,
              label: item.label ?? item.id,
            }))}
            onChange={(of) => commit({ ...value, of })}
            className="h-8 text-xs"
          />
          <SelectMenuField
            label="Referenced event"
            value={value.event ?? "start"}
            options={[
              { value: "start", label: "Action start" },
              { value: "end", label: "Action end" },
            ]}
            onChange={(event) => commit({
              ...value,
              event: event as "start" | "end",
            })}
            className="h-8 text-xs"
          />
          <NumberField
            label="Delay (s)"
            value={numeric(value.delayS)}
            onChange={(delayS) => commit({ ...value, delayS })}
          />
        </>
      ) : value.kind === "arrival" ? (
        <>
          <SelectMenuField
            label="Arriving actor"
            value={value.of}
            options={roles.map((role) => ({
              value: role.id,
              label: role.label ?? role.id,
            }))}
            onChange={(of) => commit({ ...value, of })}
            className="h-8 text-xs"
          />
          <SelectMenuField
            label="Synchronize with"
            value={value.syncWith}
            options={roles.map((role) => ({
              value: role.id,
              label: role.label ?? role.id,
            }))}
            onChange={(syncWith) => commit({ ...value, syncWith })}
            className="h-8 text-xs"
          />
          <PointRefControls
            label="Arrival point"
            value={value.at}
            roles={roles.map((role) => role.id)}
            onChange={(at) => commit({ ...value, at })}
          />
          <SelectMenuField
            label="Arrival timing"
            value={value.ttc !== undefined ? "ttc" : "deltaT"}
            options={[
              { value: "ttc", label: "Time to collision" },
              { value: "deltaT", label: "Arrival offset" },
            ]}
            onChange={(mode) => commit(
              mode === "ttc"
                ? { kind: "arrival", of: value.of, at: value.at, syncWith: value.syncWith, ttc: 0 }
                : { kind: "arrival", of: value.of, at: value.at, syncWith: value.syncWith, deltaT: 0 },
            )}
            className="h-8 text-xs"
          />
          <NumberField
            label={value.ttc !== undefined ? "TTC (s)" : "Arrival offset (s)"}
            value={numeric(value.ttc ?? value.deltaT)}
            onChange={(number) =>
              commit(
                value.ttc !== undefined
                  ? { ...value, ttc: number }
                  : { ...value, deltaT: number },
              )
            }
          />
        </>
      ) : (
        <WhenControls
          value={value}
          actor={actor}
          peer={peer}
          roles={roles.map((role) => role.id)}
          onChange={commit}
        />
      )}
    </fieldset>
  );
}

function WhenControls({
  value,
  actor,
  peer,
  roles,
  onChange,
}: {
  value: Extract<Trigger, { kind: "when" }>;
  actor: string;
  peer: string;
  roles: string[];
  onChange: (value: Trigger) => void;
}) {
  const conditionKind = value.condition.kind as ConditionKind;
  return (
    <>
      <SelectMenu
        label="Condition type"
        value={conditionKind}
        onChange={(next) =>
          onChange({
            ...value,
            condition: buildDefaultScenarioCondition(
              next as ConditionKind,
              actor,
              peer,
            ),
          })
        }
        options={CONDITION_KINDS.map((kind) => ({
          value: kind,
          label: kind.replace("_", " "),
        }))}
        className="h-8 text-xs"
      />
      <ConditionControls
        value={value.condition}
        roles={roles}
        onChange={(condition) => onChange({ ...value, condition })}
      />
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="Deadline (s)"
          value={numeric(value.byLatest)}
          onChange={(byLatest) => onChange({ ...value, byLatest })}
        />
        <SelectMenuField
          label="If never"
          value={value.ifNever}
          options={[
            { value: "skip", label: "Skip" },
            { value: "fire", label: "Fire" },
          ]}
          onChange={(ifNever) =>
            onChange({ ...value, ifNever: ifNever as "skip" | "fire" })
          }
          className="h-8 text-xs"
        />
      </div>
    </>
  );
}

/** The recursively rendered logical tree and its canonical leaf thresholds. */
function ConditionControls({
  value,
  roles,
  onChange,
}: {
  value: Condition;
  roles: string[];
  onChange: (value: Condition) => void;
}) {
  const fallbackActor = roles[0] ?? "actor";
  const fallbackPeer = roles.find((role) => role !== fallbackActor) ?? fallbackActor;
  if (value.kind === "and" || value.kind === "or") {
    return (
      <fieldset className="space-y-2 border border-border bg-muted/20 p-2">
        <legend className="px-1 text-muted-foreground">{value.kind.toUpperCase()} conditions</legend>
        {value.operands.map((operand, index) => (
          <div className="space-y-2 border border-border/70 p-2" key={index}>
            <SelectMenuField
              label={`Condition ${index + 1} type`}
              value={operand.kind}
              options={LEAF_CONDITION_KINDS.map((kind) => ({ value: kind, label: kind.replace("_", " ") }))}
              onChange={(kind) => onChange({
                ...value,
                operands: value.operands.map((item, at) => at === index
                  ? buildDefaultScenarioCondition(kind as LeafCondition["kind"], fallbackActor, fallbackPeer) as LeafCondition
                  : item),
              })}
              className="h-8 text-xs"
            />
            <ConditionControls
              value={operand}
              roles={roles}
              onChange={(condition) => onChange({
                ...value,
                operands: value.operands.map((item, at) => at === index ? condition as LeafCondition : item),
              })}
            />
          </div>
        ))}
      </fieldset>
    );
  }
  if (value.kind === "not") {
    return (
      <fieldset className="space-y-2 border border-border bg-muted/20 p-2">
        <legend className="px-1 text-muted-foreground">NOT condition</legend>
        <SelectMenuField
          label="Negated condition type"
          value={value.operand.kind}
          options={LEAF_CONDITION_KINDS.map((kind) => ({ value: kind, label: kind.replace("_", " ") }))}
          onChange={(kind) => onChange({
            ...value,
            operand: buildDefaultScenarioCondition(kind as LeafCondition["kind"], fallbackActor, fallbackPeer) as LeafCondition,
          })}
          className="h-8 text-xs"
        />
        <ConditionControls
          value={value.operand}
          roles={roles}
          onChange={(operand) => onChange({ ...value, operand: operand as LeafCondition })}
        />
      </fieldset>
    );
  }
  const roleOptions = roles.length ? roles : ["actor"];
  const roleField = (
    label: string,
    selected: string,
    update: (role: string) => Condition,
  ) => (
    <SelectMenuField
      label={label}
      value={selected}
      options={roleOptions}
      onChange={(role) => onChange(update(role))}
      className="h-8 text-xs"
    />
  );
  const opField = (
    selected: (typeof COMPARISONS)[number],
    update: (op: (typeof COMPARISONS)[number]) => Condition,
  ) => (
    <SelectMenuField
      label="Comparison"
      value={selected}
      options={[...COMPARISONS]}
      onChange={(op) => onChange(update(op as (typeof COMPARISONS)[number]))}
      className="h-8 text-xs"
    />
  );

  if (value.kind === "distance") {
    return (
      <div className="grid grid-cols-2 gap-2">
        {roleField("From", value.from, (from) => ({ ...value, from }))}
        <PointRefControls
          label="To point"
          value={value.to}
          roles={roles}
          onChange={(to) => onChange({ ...value, to })}
        />
        <SelectMenuField
          label="Distance measure"
          value={value.measure ?? "alongLane"}
          options={[
            { value: "alongLane", label: "Along lane" },
            { value: "euclidean", label: "Euclidean" },
          ]}
          onChange={(measure) => onChange({
            ...value,
            measure: measure as "alongLane" | "euclidean",
          })}
          className="h-8 text-xs"
        />
        {opField(value.op, (op) => ({ ...value, op }))}
        <NumberField
          label="Distance (m)"
          value={numeric(value.valueM)}
          onChange={(valueM) => onChange({ ...value, valueM })}
        />
        <OptionalNumberField
          label="Hysteresis (m)"
          value={typeof value.hysteresisM === "number" ? value.hysteresisM : undefined}
          min={0}
          onChange={(hysteresisM) => onChange({
            ...value,
            ...(hysteresisM === undefined ? { hysteresisM: undefined } : { hysteresisM }),
          })}
        />
      </div>
    );
  }
  if (value.kind === "ttc" || value.kind === "headway") {
    return (
      <div className="grid grid-cols-2 gap-2">
        {roleField("Actor", value.of, (of) => ({ ...value, of }))}
        {roleField("To", value.to, (to) => ({ ...value, to }))}
        {opField(value.op, (op) => ({ ...value, op }))}
        <NumberField
          label={value.kind === "ttc" ? "TTC (s)" : "Headway (s)"}
          value={numeric(value.valueS)}
          onChange={(valueS) => onChange({ ...value, valueS })}
        />
      </div>
    );
  }
  if (value.kind === "reaches") {
    return (
      <div className="grid grid-cols-2 gap-2">
        {roleField("Actor", value.of, (of) => ({ ...value, of }))}
        <PointRefControls
          label="Region"
          value={value.region}
          roles={roles}
          onChange={(region) => onChange({ ...value, region })}
        />
        <NumberField
          label="Tolerance (m)"
          value={numeric(value.toleranceM)}
          onChange={(toleranceM) => onChange({ ...value, toleranceM })}
        />
      </div>
    );
  }
  if (value.kind === "speed") {
    return (
      <div className="grid grid-cols-2 gap-2">
        {roleField("Actor", value.of, (of) => ({ ...value, of }))}
        {opField(value.op, (op) => ({ ...value, op }))}
        <NumberField
          label="Speed (kph)"
          value={numeric(value.valueKph)}
          onChange={(valueKph) => onChange({ ...value, valueKph })}
        />
      </div>
    );
  }
  if (value.kind === "signal") {
    return (
      <div className="grid grid-cols-2 gap-2">
        <SignalRefControls
          value={value.signal}
          onChange={(signal) => onChange({ ...value, signal })}
        />
        <SelectMenuField
          label="Phase"
          value={value.phase}
          options={[...PHASES]}
          onChange={(phase) =>
            onChange({ ...value, phase: phase as typeof value.phase })
          }
          className="h-8 text-xs"
        />
        <OptionalNumberField
          label="Minimum duration (s)"
          value={typeof value.minDurationS === "number" ? value.minDurationS : undefined}
          min={0}
          onChange={(minDurationS) => onChange({
            ...value,
            ...(minDurationS === undefined ? { minDurationS: undefined } : { minDurationS }),
          })}
        />
      </div>
    );
  }
  if (value.kind === "visible") {
    return (
      <div className="grid grid-cols-2 gap-2">
        {roleField("Observer", value.of, (of) => ({ ...value, of }))}
        {roleField("Target", value.to, (to) => ({ ...value, to }))}
        <SelectMenuField
          label="Visibility state"
          value={(value.visible ?? true) ? "visible" : "hidden"}
          options={[
            { value: "visible", label: "Visible" },
            { value: "hidden", label: "Not visible" },
          ]}
          onChange={(visibility) => onChange({
            ...value,
            visible: visibility === "visible",
          })}
          className="h-8 text-xs"
        />
        <NumberField
          label="Visible fraction"
          value={value.minFraction ?? 0.5}
          onChange={(minFraction) =>
            onChange({
              ...value,
              minFraction: Math.max(0, Math.min(1, minFraction)),
            })
          }
        />
      </div>
    );
  }
  if (value.kind === "standstill") {
    return (
      <div className="grid grid-cols-2 gap-2">
        {roleField("Actor", value.of, (of) => ({ ...value, of }))}
        <NumberField
          label="Duration (s)"
          value={numeric(value.forS)}
          onChange={(forS) => onChange({ ...value, forS })}
        />
      </div>
    );
  }
  if (value.kind === "detected") {
    return (
      <div className="grid grid-cols-2 gap-2">
        {roleField("Object", value.of, (of) => ({ ...value, of }))}
        {roleField("Detected by", value.by, (by) => ({ ...value, by }))}
        <SelectMenuField
          label="Detection state"
          value={value.detected ? "detected" : "not_detected"}
          options={[
            { value: "detected", label: "Detected" },
            { value: "not_detected", label: "Not detected" },
          ]}
          onChange={(next) => onChange({ ...value, detected: next === "detected" })}
          className="h-8 text-xs"
        />
        <TextField
          label="Sensor (optional)"
          value={value.sensor ?? ""}
          onChange={(sensor) => onChange({ ...value, ...(sensor ? { sensor } : { sensor: undefined }) })}
        />
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      {roleField("Actor", value.of, (of) => ({ ...value, of }))}
      <SelectMenuField
        label="Collides with"
        value={value.with}
        options={["any", ...roleOptions]}
        onChange={(next) => onChange({ ...value, with: next })}
        className="h-8 text-xs"
      />
    </div>
  );
}

function PointRefControls({
  label,
  value,
  roles,
  onChange,
}: {
  label: string;
  value: PointRef;
  roles: string[];
  onChange: (value: PointRef) => void;
}) {
  const role = roles[0] ?? "actor";
  const mode = "role" in value ? "role" : "feature" in value ? "feature" : "pose";
  return (
    <fieldset className="col-span-2 grid grid-cols-2 gap-2 border border-border/70 p-2">
      <legend className="px-1 text-muted-foreground">{label}</legend>
      <SelectMenuField
        label="Reference type"
        value={mode}
        options={[
          { value: "role", label: "Actor" },
          { value: "feature", label: "Map feature" },
          { value: "pose", label: "Route pose" },
        ]}
        onChange={(next) => onChange(
          next === "role"
            ? { role }
            : next === "feature"
              ? { feature: "feature", at: "entry" }
              : { pose: { s: 0, laneOffset: 0, tFrac: 0, headingOffsetRad: 0 } },
        )}
        className="h-8 text-xs"
      />
      {mode === "role" ? (
        <SelectMenuField
          label="Actor"
          value={(value as { role: string }).role}
          options={roles.length ? roles : [role]}
          onChange={(nextRole) => onChange({ role: nextRole })}
          className="h-8 text-xs"
        />
      ) : mode === "feature" ? (
        <>
          <TextField
            label="Feature id"
            value={(value as { feature: string }).feature}
            onChange={(feature) => onChange({
              ...(value as Extract<PointRef, { feature: string }>),
              feature,
            })}
          />
          <SelectMenuField
            label="Feature point"
            value={(value as Extract<PointRef, { feature: string }>).at ?? "entry"}
            options={["entry", "center", "exit"]}
            onChange={(at) => onChange({
              ...(value as Extract<PointRef, { feature: string }>),
              at: at as "entry" | "center" | "exit",
            })}
            className="h-8 text-xs"
          />
        </>
      ) : (
        <>
          <NumberField
            label="Longitudinal s"
            value={numeric((value as Extract<PointRef, { pose: unknown }>).pose.s)}
            onChange={(s) => onChange({ pose: { ...(value as Extract<PointRef, { pose: unknown }>).pose, s } })}
          />
          <NumberField
            label="Lane offset"
            value={(value as Extract<PointRef, { pose: unknown }>).pose.laneOffset ?? 0}
            step={1}
            min={-8}
            onChange={(laneOffset) => onChange({ pose: { ...(value as Extract<PointRef, { pose: unknown }>).pose, laneOffset: Math.round(laneOffset) } })}
          />
          <NumberField
            label="Lateral fraction"
            value={numeric((value as Extract<PointRef, { pose: unknown }>).pose.tFrac)}
            min={-1}
            onChange={(tFrac) => onChange({ pose: { ...(value as Extract<PointRef, { pose: unknown }>).pose, tFrac } })}
          />
          <NumberField
            label="Heading offset (rad)"
            value={(value as Extract<PointRef, { pose: unknown }>).pose.headingOffsetRad ?? 0}
            min={-Math.PI}
            onChange={(headingOffsetRad) => onChange({ pose: { ...(value as Extract<PointRef, { pose: unknown }>).pose, headingOffsetRad } })}
          />
        </>
      )}
    </fieldset>
  );
}

function SignalRefControls({ value, onChange }: { value: SignalRef; onChange: (value: SignalRef) => void }) {
  const mode = "handle" in value ? "handle" : "feature" in value ? "feature" : "control";
  return (
    <fieldset className="col-span-2 grid grid-cols-2 gap-2 border border-border/70 p-2">
      <legend className="px-1 text-muted-foreground">Signal reference</legend>
      <SelectMenuField
        label="Reference type"
        value={mode}
        options={[
          { value: "handle", label: "Signal handle" },
          { value: "feature", label: "Map feature" },
          { value: "control", label: "Control id" },
        ]}
        onChange={(next) => onChange(
          next === "handle"
            ? { handle: "signal-handle" }
            : next === "feature"
              ? { feature: "feature", approach: "subject" }
              : { control: "signal-1" },
        )}
        className="h-8 text-xs"
      />
      {mode === "handle" ? (
        <TextField label="Signal handle" value={(value as { handle: string }).handle} onChange={(handle) => onChange({ handle })} />
      ) : mode === "control" ? (
        <TextField label="Control id" value={(value as { control: string }).control} onChange={(control) => onChange({ control })} />
      ) : (
        <>
          <TextField label="Feature id" value={(value as Extract<SignalRef, { feature: string }>).feature} onChange={(feature) => onChange({ ...(value as Extract<SignalRef, { feature: string }>), feature })} />
          <SelectMenuField
            label="Approach"
            value={(value as Extract<SignalRef, { feature: string }>).approach}
            options={["subject", "opposing", "left", "right"]}
            onChange={(approach) => onChange({ ...(value as Extract<SignalRef, { feature: string }>), approach: approach as "subject" | "opposing" | "left" | "right" })}
            className="h-8 text-xs"
          />
        </>
      )}
    </fieldset>
  );
}

function OptionalNumberField({
  label,
  value,
  min,
  onChange,
}: {
  label: string;
  value: number | undefined;
  min?: number;
  onChange: (value: number | undefined) => void;
}) {
  return (
    <label className="block min-w-0 text-muted-foreground">
      {label}
      <Input
        className="mt-1 h-8"
        min={min}
        step={0.1}
        type="number"
        value={value ?? ""}
        onChange={(event) => {
          if (event.currentTarget.value === "") onChange(undefined);
          else {
            const next = Number(event.currentTarget.value);
            if (Number.isFinite(next)) onChange(next);
          }
        }}
      />
    </label>
  );
}
