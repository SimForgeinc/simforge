/** Serializable edits supported by {@link TemplateDocument}. */

import { ScenarioOperationError } from './errors.js';
import type { Interaction } from './schema/v2/interactions.js';
import type { Environment } from './schema/v2/environment.js';
import type { Invariant } from './schema/v2/invariants.js';
import type { MapSignalPlan } from './schema/v2/map-signal-plans.js';
import type { ParamDecl } from './schema/v2/params.js';
import type { PropPlacement } from './schema/v2/props.js';
import type { RoleBinding } from './schema/v2/roles.js';
import type { ReasoningTraceSegment } from './schema/v2/reasoning-trace.js';
import type { ScenarioTemplateV2, TemplateMeta } from './schema/v2/template.js';
import type { Variant } from './schema/v2/variants.js';
import type { MapRef } from './schema/v1.js';

/** Metadata fields an editor may change. Timestamps remain document-managed. */
export type TemplateMetaPatch = Partial<
  Pick<
    TemplateMeta,
    'name' | 'description' | 'appVersion' | 'archetype' | 'tags' | 'author' | 'negativeControl'
  >
>;

export type TemplateOp =
  | { type: 'setTemplateMeta'; patch: TemplateMetaPatch }
  | { type: 'setSourceMap'; sourceMap: MapRef | null }
  | { type: 'setEnvironment'; environment: Environment }
  | { type: 'addParam'; param: ParamDecl; index?: number }
  | { type: 'replaceParam'; id: string; param: ParamDecl }
  | { type: 'removeParam'; id: string }
  | { type: 'addRole'; role: RoleBinding; index?: number }
  | { type: 'replaceRole'; id: string; role: RoleBinding }
  | { type: 'removeRole'; id: string }
  | { type: 'moveRole'; id: string; toIndex: number }
  | { type: 'addInteraction'; interaction: Interaction; index?: number }
  | { type: 'replaceInteraction'; id: string; interaction: Interaction }
  | { type: 'removeInteraction'; id: string }
  | { type: 'addReasoningTraceSegment'; segment: ReasoningTraceSegment; index?: number }
  | { type: 'replaceReasoningTraceSegment'; id: string; segment: ReasoningTraceSegment }
  | { type: 'removeReasoningTraceSegment'; id: string }
  | { type: 'addMapSignalPlan'; plan: MapSignalPlan; index?: number }
  | { type: 'replaceMapSignalPlan'; id: string; plan: MapSignalPlan }
  | { type: 'removeMapSignalPlan'; id: string }
  | { type: 'addProp'; prop: PropPlacement; index?: number }
  | { type: 'replaceProp'; id: string; prop: PropPlacement }
  | { type: 'removeProp'; id: string }
  | { type: 'addInvariant'; invariant: Invariant; index?: number }
  | { type: 'replaceInvariant'; id: string; invariant: Invariant }
  | { type: 'removeInvariant'; id: string }
  | { type: 'addVariant'; variant: Variant; index?: number }
  | { type: 'replaceVariant'; id: string; variant: Variant }
  | { type: 'removeVariant'; id: string }
  | { type: 'setMetricSubject'; roleId: string | null }
  | { type: 'setClip'; clipSeconds?: number; warmupSeconds?: number }
  | { type: 'setTemplateExtension'; key: string; value?: unknown };

export function describeTemplateOp(op: TemplateOp): string {
  switch (op.type) {
    case 'setTemplateMeta': return 'Edit scenario info';
    case 'setSourceMap': return 'Change source map';
    case 'setEnvironment': return 'Edit environment';
    case 'addParam': return 'Add parameter';
    case 'replaceParam': return 'Edit parameter';
    case 'removeParam': return 'Delete parameter';
    case 'addRole': return 'Add actor';
    case 'replaceRole': return 'Edit actor';
    case 'removeRole': return 'Delete actor';
    case 'moveRole': return 'Reorder actor';
    case 'addInteraction': return 'Add interaction';
    case 'replaceInteraction': return 'Edit interaction';
    case 'removeInteraction': return 'Delete interaction';
    case 'addReasoningTraceSegment': return 'Add reasoning trace';
    case 'replaceReasoningTraceSegment': return 'Edit reasoning trace';
    case 'removeReasoningTraceSegment': return 'Delete reasoning trace';
    case 'addMapSignalPlan': return 'Add traffic signal plan';
    case 'replaceMapSignalPlan': return 'Edit traffic signal plan';
    case 'removeMapSignalPlan': return 'Delete traffic signal plan';
    case 'addProp': return 'Add prop';
    case 'replaceProp': return 'Edit prop';
    case 'removeProp': return 'Delete prop';
    case 'addInvariant': return 'Add rule';
    case 'replaceInvariant': return 'Edit rule';
    case 'removeInvariant': return 'Delete rule';
    case 'addVariant': return 'Add variant';
    case 'replaceVariant': return 'Edit variant';
    case 'removeVariant': return 'Delete variant';
    case 'setMetricSubject': return 'Set metric subject';
    case 'setClip': return 'Edit scenario duration';
    case 'setTemplateExtension': return 'Edit extension';
  }
}

function indexOf(items: readonly { id: string }[], id: string, kind: string): number {
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) throw new ScenarioOperationError(`no ${kind} with id "${id}"`);
  return index;
}

function insertionIndex(index: number | undefined, length: number): number {
  const at = index ?? length;
  if (at < 0 || at > length) throw new ScenarioOperationError(`index ${at} is out of range`);
  return at;
}

/** Apply one operation to an Immer draft. Schema validation happens after this function. */
export function applyTemplateOp(draft: ScenarioTemplateV2, op: TemplateOp): void {
  switch (op.type) {
    case 'setTemplateMeta':
      Object.assign(draft.meta, op.patch);
      return;
    case 'setSourceMap':
      if (op.sourceMap === null) delete draft.sourceMap;
      else draft.sourceMap = { ...op.sourceMap };
      return;
    case 'setEnvironment':
      draft.environment = op.environment;
      return;
    case 'addParam': {
      const items = draft.params.declarations;
      if (items.some((item) => item.id === op.param.id)) throw new ScenarioOperationError(`parameter id "${op.param.id}" already exists`);
      items.splice(insertionIndex(op.index, items.length), 0, op.param);
      return;
    }
    case 'replaceParam': {
      const items = draft.params.declarations;
      const at = indexOf(items, op.id, 'parameter');
      if (op.param.id !== op.id && items.some((item) => item.id === op.param.id)) throw new ScenarioOperationError(`parameter id "${op.param.id}" already exists`);
      items[at] = op.param;
      return;
    }
    case 'removeParam':
      draft.params.declarations.splice(indexOf(draft.params.declarations, op.id, 'parameter'), 1);
      return;
    case 'addRole': {
      if (draft.roles.some((role) => role.id === op.role.id)) {
        throw new ScenarioOperationError(`role id "${op.role.id}" already exists`);
      }
      draft.roles.splice(insertionIndex(op.index, draft.roles.length), 0, op.role);
      return;
    }
    case 'replaceRole': {
      const at = indexOf(draft.roles, op.id, 'role');
      if (op.role.id !== op.id && draft.roles.some((role) => role.id === op.role.id)) {
        throw new ScenarioOperationError(`role id "${op.role.id}" already exists`);
      }
      draft.roles[at] = op.role;
      return;
    }
    case 'removeRole':
      draft.roles.splice(indexOf(draft.roles, op.id, 'role'), 1);
      return;
    case 'moveRole': {
      const from = indexOf(draft.roles, op.id, 'role');
      if (op.toIndex < 0 || op.toIndex >= draft.roles.length) {
        throw new ScenarioOperationError(`index ${op.toIndex} is out of range`);
      }
      const [role] = draft.roles.splice(from, 1);
      draft.roles.splice(op.toIndex, 0, role as RoleBinding);
      return;
    }
    case 'addInteraction': {
      const items = draft.choreography.interactions;
      if (items.some((interaction) => interaction.id === op.interaction.id)) {
        throw new ScenarioOperationError(`interaction id "${op.interaction.id}" already exists`);
      }
      items.splice(insertionIndex(op.index, items.length), 0, op.interaction);
      return;
    }
    case 'replaceInteraction': {
      const items = draft.choreography.interactions;
      const at = indexOf(items, op.id, 'interaction');
      if (op.interaction.id !== op.id && items.some((item) => item.id === op.interaction.id)) {
        throw new ScenarioOperationError(`interaction id "${op.interaction.id}" already exists`);
      }
      items[at] = op.interaction;
      return;
    }
    case 'removeInteraction':
      draft.choreography.interactions.splice(
        indexOf(draft.choreography.interactions, op.id, 'interaction'),
        1,
      );
      return;
    case 'addReasoningTraceSegment': {
      const items = draft.reasoningTrace;
      if (items.some((item) => item.id === op.segment.id)) throw new ScenarioOperationError(`reasoning trace id "${op.segment.id}" already exists`);
      items.splice(insertionIndex(op.index, items.length), 0, op.segment);
      return;
    }
    case 'replaceReasoningTraceSegment': {
      const items = draft.reasoningTrace;
      const at = indexOf(items, op.id, 'reasoning trace');
      if (op.segment.id !== op.id && items.some((item) => item.id === op.segment.id)) throw new ScenarioOperationError(`reasoning trace id "${op.segment.id}" already exists`);
      items[at] = op.segment;
      return;
    }
    case 'removeReasoningTraceSegment':
      draft.reasoningTrace.splice(indexOf(draft.reasoningTrace, op.id, 'reasoning trace'), 1);
      return;
    case 'addMapSignalPlan': {
      if (draft.mapSignalPlans.some((plan) => plan.id === op.plan.id)) {
        throw new ScenarioOperationError(`map signal plan id "${op.plan.id}" already exists`);
      }
      draft.mapSignalPlans.splice(insertionIndex(op.index, draft.mapSignalPlans.length), 0, op.plan);
      return;
    }
    case 'replaceMapSignalPlan': {
      const at = indexOf(draft.mapSignalPlans, op.id, 'map signal plan');
      if (op.plan.id !== op.id && draft.mapSignalPlans.some((plan) => plan.id === op.plan.id)) {
        throw new ScenarioOperationError(`map signal plan id "${op.plan.id}" already exists`);
      }
      draft.mapSignalPlans[at] = op.plan;
      return;
    }
    case 'removeMapSignalPlan':
      draft.mapSignalPlans.splice(indexOf(draft.mapSignalPlans, op.id, 'map signal plan'), 1);
      return;
    case 'addProp':
      if (draft.props.some((item) => item.id === op.prop.id)) throw new ScenarioOperationError(`prop id "${op.prop.id}" already exists`);
      draft.props.splice(insertionIndex(op.index, draft.props.length), 0, op.prop);
      return;
    case 'replaceProp': {
      const at = indexOf(draft.props, op.id, 'prop');
      if (op.prop.id !== op.id && draft.props.some((item) => item.id === op.prop.id)) throw new ScenarioOperationError(`prop id "${op.prop.id}" already exists`);
      draft.props[at] = op.prop;
      return;
    }
    case 'removeProp':
      draft.props.splice(indexOf(draft.props, op.id, 'prop'), 1);
      return;
    case 'addInvariant':
      if (draft.invariants.some((item) => item.id === op.invariant.id)) throw new ScenarioOperationError(`invariant id "${op.invariant.id}" already exists`);
      draft.invariants.splice(insertionIndex(op.index, draft.invariants.length), 0, op.invariant);
      return;
    case 'replaceInvariant': {
      const at = indexOf(draft.invariants, op.id, 'invariant');
      if (op.invariant.id !== op.id && draft.invariants.some((item) => item.id === op.invariant.id)) throw new ScenarioOperationError(`invariant id "${op.invariant.id}" already exists`);
      draft.invariants[at] = op.invariant;
      return;
    }
    case 'removeInvariant':
      draft.invariants.splice(indexOf(draft.invariants, op.id, 'invariant'), 1);
      return;
    case 'addVariant':
      if (draft.variants.some((item) => item.id === op.variant.id)) throw new ScenarioOperationError(`variant id "${op.variant.id}" already exists`);
      draft.variants.splice(insertionIndex(op.index, draft.variants.length), 0, op.variant);
      return;
    case 'replaceVariant': {
      const at = indexOf(draft.variants, op.id, 'variant');
      if (op.variant.id !== op.id && draft.variants.some((item) => item.id === op.variant.id)) throw new ScenarioOperationError(`variant id "${op.variant.id}" already exists`);
      draft.variants[at] = op.variant;
      return;
    }
    case 'removeVariant':
      draft.variants.splice(indexOf(draft.variants, op.id, 'variant'), 1);
      return;
    case 'setMetricSubject':
      if (op.roleId === null) delete draft.metricSubject;
      else draft.metricSubject = op.roleId;
      return;
    case 'setClip':
      if (op.clipSeconds !== undefined) draft.choreography.clipSeconds = op.clipSeconds;
      if (op.warmupSeconds !== undefined) draft.choreography.warmupSeconds = op.warmupSeconds;
      return;
    case 'setTemplateExtension':
      if (op.value === undefined) {
        if (draft.extensions) {
          delete draft.extensions[op.key];
          if (Object.keys(draft.extensions).length === 0) delete draft.extensions;
        }
      } else {
        if (!draft.extensions) draft.extensions = {};
        draft.extensions[op.key] = op.value;
      }
      return;
  }
}
