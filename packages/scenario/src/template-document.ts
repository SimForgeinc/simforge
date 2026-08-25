/** V2 template editing with immutable state, patch history, validation and migration provenance. */

import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer';

import { ScenarioMigrationError, ScenarioOperationError, ScenarioValidationError } from './errors.js';
import { parseTemplate, serializeTemplate, deepFreeze } from './serialize.js';
import type { Interaction } from './schema/v2/interactions.js';
import type { Environment } from './schema/v2/environment.js';
import type { Invariant } from './schema/v2/invariants.js';
import type { MapSignalPlan } from './schema/v2/map-signal-plans.js';
import type { ParamDecl } from './schema/v2/params.js';
import type { PropPlacement } from './schema/v2/props.js';
import type { RoleBinding } from './schema/v2/roles.js';
import type { ReasoningTraceSegment } from './schema/v2/reasoning-trace.js';
import type { ActorSensor } from './schema/v2/sensors.js';
import type { LogicalAnchorInput } from './schema/v2/anchor.js';
import type { ScenarioTemplateV2 } from './schema/v2/template.js';
import type { Variant } from './schema/v2/variants.js';
import type { MapRef } from './schema/v1.js';
import {
  applyTemplateOp,
  describeTemplateOp,
  type TemplateMetaPatch,
  type TemplateOp,
} from './template-operations.js';
import { validateTemplate, type MapContext, type ValidationReport } from './validate/index.js';

enablePatches();

export type TemplateChangeReason = 'apply' | 'undo' | 'redo' | 'clean';
export interface TemplateChange {
  template: ScenarioTemplateV2;
  reason: TemplateChangeReason;
  op?: TemplateOp;
  dirty: boolean;
  validation: ValidationReport;
}

export interface TemplateDocumentOptions {
  historyLimit?: number;
  now?: () => string;
  validateSchema?: boolean;
}

export interface CreateTemplateInit {
  name: string;
  appVersion?: string;
  description?: string;
  sourceMap?: MapRef;
  anchor?: LogicalAnchorInput;
  createdAt?: string;
}

interface HistoryEntry {
  label: string;
  op: TemplateOp;
  patches: Patch[];
  inverse: Patch[];
}


/** Generate a schema-legal v2 id. Callers may supply semantic ids instead. */
export function newTemplateId(prefix: string = 'item'): string {
  const safe = (/^[A-Za-z]/.test(prefix) ? prefix : `x${prefix}`)
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .slice(0, 24);
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `${safe}-${time}-${random}`.slice(0, 64);
}

function schemaCheck(template: ScenarioTemplateV2, context: string): ScenarioTemplateV2 {
  try {
    return parseTemplate(template);
  } catch (error) {
    if (error instanceof ScenarioValidationError) {
      throw new ScenarioValidationError(`${context} would produce an invalid v2 template`, error.issues);
    }
    throw error;
  }
}

/** The canonical editable document for Studio and non-UI authoring clients. */
export class TemplateDocument {
  #state: ScenarioTemplateV2;
  #history: HistoryEntry[] = [];
  #index = 0;
  #cleanIndex: number | null = 0;
  readonly #listeners = new Set<(change: TemplateChange) => void>();
  readonly #historyLimit: number;
  readonly #now: () => string;
  readonly #validateSchema: boolean;

  private constructor(state: ScenarioTemplateV2, options: TemplateDocumentOptions = {}) {
    this.#state = deepFreeze(state);
    this.#historyLimit = Math.max(0, options.historyLimit ?? 200);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#validateSchema = options.validateSchema ?? true;
  }

  static create(init: CreateTemplateInit, options: TemplateDocumentOptions = {}): TemplateDocument {
    const now = options.now ?? (() => new Date().toISOString());
    const createdAt = init.createdAt ?? now();
    const template = parseTemplate({
      scenarioVersion: 2,
      meta: {
        name: init.name,
        description: init.description ?? '',
        createdAt,
        modifiedAt: createdAt,
        appVersion: init.appVersion ?? '0.0.0-dev',
      },
      ...(init.sourceMap ? { sourceMap: init.sourceMap } : {}),
      anchor: init.anchor ?? { features: [] },
      roles: [],
      props: [],
      choreography: { interactions: [] },
      reasoningTrace: [],
      invariants: [],
      variants: [],
    });
    return new TemplateDocument(template, options);
  }

  /** Load v2 only. Legacy scenes are rejected rather than becoming a second source of truth. */
  static fromJSON(json: unknown, options: TemplateDocumentOptions = {}): TemplateDocument {
    const version = typeof json === 'object' && json !== null
      ? (json as { scenarioVersion?: unknown }).scenarioVersion
      : undefined;
    if (version !== 2) {
      throw new ScenarioMigrationError(
        `unsupported Studio document format: expected ScenarioTemplate v2, got ${String(version ?? 'unversioned')}`,
        typeof version === 'number' ? version : 0,
      );
    }
    return new TemplateDocument(parseTemplate(json), options);
  }

  static parse(text: string, options: TemplateDocumentOptions = {}): TemplateDocument {
    return TemplateDocument.fromJSON(JSON.parse(text), options);
  }

  get data(): ScenarioTemplateV2 { return this.#state; }
  get roles(): readonly RoleBinding[] { return this.#state.roles; }
  get interactions(): readonly Interaction[] { return this.#state.choreography.interactions; }
  get reasoningTrace(): readonly ReasoningTraceSegment[] { return this.#state.reasoningTrace; }
  get isDirty(): boolean { return this.#cleanIndex !== this.#index; }
  get canUndo(): boolean { return this.#index > 0; }
  get canRedo(): boolean { return this.#index < this.#history.length; }
  get undoLabel(): string | undefined { return this.canUndo ? this.#history[this.#index - 1]?.label : undefined; }
  get redoLabel(): string | undefined { return this.canRedo ? this.#history[this.#index]?.label : undefined; }
  get history(): readonly string[] { return this.#history.slice(0, this.#index).map((item) => item.label); }

  role(id: string): RoleBinding | undefined { return this.#state.roles.find((role) => role.id === id); }
  interaction(id: string): Interaction | undefined {
    return this.#state.choreography.interactions.find((interaction) => interaction.id === id);
  }
  mapSignalPlan(id: string): MapSignalPlan | undefined {
    return this.#state.mapSignalPlans.find((plan) => plan.id === id);
  }
  validate(map?: MapContext): ValidationReport { return validateTemplate(this.#state, map); }

  apply(op: TemplateOp): boolean {
    const [afterOp, opPatches, opInverse] = produceWithPatches(this.#state, (draft) => {
      applyTemplateOp(draft as ScenarioTemplateV2, op);
    });
    if (opPatches.length === 0) return false;
    const [stamped, stampPatches, stampInverse] = produceWithPatches(afterOp, (draft) => {
      draft.meta.modifiedAt = this.#now();
    });
    const next = this.#validateSchema ? schemaCheck(stamped, `operation "${op.type}"`) : stamped;
    this.#history.length = this.#index;
    if (this.#cleanIndex !== null && this.#cleanIndex > this.#index) this.#cleanIndex = null;
    this.#history.push({
      label: describeTemplateOp(op),
      op,
      patches: [...opPatches, ...stampPatches],
      inverse: [...stampInverse, ...opInverse],
    });
    this.#index++;
    const overflow = this.#history.length - this.#historyLimit;
    if (overflow > 0) {
      this.#history.splice(0, overflow);
      this.#index -= overflow;
      if (this.#cleanIndex !== null) {
        this.#cleanIndex -= overflow;
        if (this.#cleanIndex < 0) this.#cleanIndex = null;
      }
    }
    this.#state = deepFreeze(next);
    this.#emit('apply', op);
    return true;
  }

  setMeta(patch: TemplateMetaPatch): boolean { return this.apply({ type: 'setTemplateMeta', patch }); }
  setSourceMap(sourceMap: MapRef | null): boolean { return this.apply({ type: 'setSourceMap', sourceMap }); }
  setEnvironment(environment: Environment): boolean { return this.apply({ type: 'setEnvironment', environment }); }
  addParam(param: ParamDecl, index?: number): string {
    this.apply(index === undefined ? { type: 'addParam', param } : { type: 'addParam', param, index });
    return param.id;
  }
  replaceParam(id: string, param: ParamDecl): boolean { return this.apply({ type: 'replaceParam', id, param }); }
  removeParam(id: string): boolean { return this.apply({ type: 'removeParam', id }); }
  addRole(role: RoleBinding, index?: number): string {
    this.apply(index === undefined ? { type: 'addRole', role } : { type: 'addRole', role, index });
    return role.id;
  }
  replaceRole(id: string, role: RoleBinding): boolean { return this.apply({ type: 'replaceRole', id, role }); }
  removeRole(id: string): boolean { return this.apply({ type: 'removeRole', id }); }
  moveRole(id: string, toIndex: number): boolean { return this.apply({ type: 'moveRole', id, toIndex }); }
  actorSensor(roleId: string, sensorId: string): ActorSensor | undefined {
    return this.role(roleId)?.actor.sensors.find((sensor) => sensor.id === sensorId);
  }
  addActorSensor(roleId: string, sensor: ActorSensor): string {
    const role = this.role(roleId);
    if (!role) throw new ScenarioOperationError(`no role with id "${roleId}"`);
    if (role.actor.sensors.some((item) => item.id === sensor.id)) {
      throw new ScenarioOperationError(`sensor id "${sensor.id}" already exists on role "${roleId}"`);
    }
    this.replaceRole(roleId, {
      ...role,
      actor: { ...role.actor, sensors: [...role.actor.sensors, sensor] },
    });
    return sensor.id;
  }
  replaceActorSensor(roleId: string, sensorId: string, sensor: ActorSensor): boolean {
    const role = this.role(roleId);
    if (!role) throw new ScenarioOperationError(`no role with id "${roleId}"`);
    const index = role.actor.sensors.findIndex((item) => item.id === sensorId);
    if (index < 0) throw new ScenarioOperationError(`no sensor with id "${sensorId}" on role "${roleId}"`);
    if (sensor.id !== sensorId && role.actor.sensors.some((item) => item.id === sensor.id)) {
      throw new ScenarioOperationError(`sensor id "${sensor.id}" already exists on role "${roleId}"`);
    }
    const sensors = [...role.actor.sensors];
    sensors[index] = sensor;
    return this.replaceRole(roleId, { ...role, actor: { ...role.actor, sensors } });
  }
  removeActorSensor(roleId: string, sensorId: string): boolean {
    const role = this.role(roleId);
    if (!role) throw new ScenarioOperationError(`no role with id "${roleId}"`);
    const sensors = role.actor.sensors.filter((item) => item.id !== sensorId);
    if (sensors.length === role.actor.sensors.length) {
      throw new ScenarioOperationError(`no sensor with id "${sensorId}" on role "${roleId}"`);
    }
    return this.replaceRole(roleId, { ...role, actor: { ...role.actor, sensors } });
  }
  addInteraction(interaction: Interaction, index?: number): string {
    this.apply(index === undefined ? { type: 'addInteraction', interaction } : { type: 'addInteraction', interaction, index });
    return interaction.id;
  }
  replaceInteraction(id: string, interaction: Interaction): boolean {
    return this.apply({ type: 'replaceInteraction', id, interaction });
  }
  removeInteraction(id: string): boolean { return this.apply({ type: 'removeInteraction', id }); }
  addReasoningTraceSegment(segment: ReasoningTraceSegment, index?: number): string {
    this.apply(index === undefined ? { type: 'addReasoningTraceSegment', segment } : { type: 'addReasoningTraceSegment', segment, index });
    return segment.id;
  }
  replaceReasoningTraceSegment(id: string, segment: ReasoningTraceSegment): boolean {
    return this.apply({ type: 'replaceReasoningTraceSegment', id, segment });
  }
  removeReasoningTraceSegment(id: string): boolean { return this.apply({ type: 'removeReasoningTraceSegment', id }); }
  addMapSignalPlan(plan: MapSignalPlan, index?: number): string {
    this.apply(index === undefined ? { type: 'addMapSignalPlan', plan } : { type: 'addMapSignalPlan', plan, index });
    return plan.id;
  }
  replaceMapSignalPlan(id: string, plan: MapSignalPlan): boolean {
    return this.apply({ type: 'replaceMapSignalPlan', id, plan });
  }
  removeMapSignalPlan(id: string): boolean { return this.apply({ type: 'removeMapSignalPlan', id }); }
  addProp(prop: PropPlacement, index?: number): string {
    this.apply(index === undefined ? { type: 'addProp', prop } : { type: 'addProp', prop, index });
    return prop.id;
  }
  replaceProp(id: string, prop: PropPlacement): boolean { return this.apply({ type: 'replaceProp', id, prop }); }
  removeProp(id: string): boolean { return this.apply({ type: 'removeProp', id }); }
  addInvariant(invariant: Invariant, index?: number): string {
    this.apply(index === undefined ? { type: 'addInvariant', invariant } : { type: 'addInvariant', invariant, index });
    return invariant.id;
  }
  replaceInvariant(id: string, invariant: Invariant): boolean { return this.apply({ type: 'replaceInvariant', id, invariant }); }
  removeInvariant(id: string): boolean { return this.apply({ type: 'removeInvariant', id }); }
  addVariant(variant: Variant, index?: number): string {
    this.apply(index === undefined ? { type: 'addVariant', variant } : { type: 'addVariant', variant, index });
    return variant.id;
  }
  replaceVariant(id: string, variant: Variant): boolean { return this.apply({ type: 'replaceVariant', id, variant }); }
  removeVariant(id: string): boolean { return this.apply({ type: 'removeVariant', id }); }
  setMetricSubject(roleId: string | null): boolean { return this.apply({ type: 'setMetricSubject', roleId }); }
  setClip(clipSeconds?: number, warmupSeconds?: number): boolean {
    return this.apply({ type: 'setClip', clipSeconds, warmupSeconds });
  }
  setExtension(key: string, value?: unknown): boolean {
    return this.apply({ type: 'setTemplateExtension', key, value });
  }

  undo(): boolean {
    if (!this.canUndo) return false;
    const entry = this.#history[this.#index - 1] as HistoryEntry;
    this.#state = deepFreeze(applyPatches(this.#state, entry.inverse));
    this.#index--;
    this.#emit('undo', entry.op);
    return true;
  }
  redo(): boolean {
    if (!this.canRedo) return false;
    const entry = this.#history[this.#index] as HistoryEntry;
    this.#state = deepFreeze(applyPatches(this.#state, entry.patches));
    this.#index++;
    this.#emit('redo', entry.op);
    return true;
  }
  markClean(): void { this.#cleanIndex = this.#index; this.#emit('clean'); }
  clearHistory(): void { this.#history = []; this.#index = 0; this.#cleanIndex = 0; }
  subscribe(listener: (change: TemplateChange) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  toJSON(): ScenarioTemplateV2 { return this.#state; }
  serialize(): string { return serializeTemplate(this.#state); }

  #emit(reason: TemplateChangeReason, op?: TemplateOp): void {
    const change: TemplateChange = {
      template: this.#state,
      reason,
      ...(op ? { op } : {}),
      dirty: this.isDirty,
      validation: this.validate(),
    };
    for (const listener of [...this.#listeners]) listener(change);
  }
}
