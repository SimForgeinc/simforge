/**
 * The editor's view of a canonical ScenarioTemplate v2: roles, undo and autosave.
 *
 * Current viewport placements are v2 `scene_absolute` roles. That role kind is
 * intentionally map-bound and therefore preserves exact editor poses without
 * inventing a portable anchor. Portable role kinds can coexist in the same
 * document and are materialized before playback; this viewport only renders
 * roles whose absolute authoring pose is available.
 *
 * ## Undo groups
 *
 * `TemplateDocument` undoes one operation at a time, but a single user gesture
 * (moving four selected actors) is several operations. This class keeps a stack
 * of group sizes so one Cmd-Z reverses one gesture. Every mutation therefore has
 * to go through here — an op applied behind its back would desynchronise the
 * grouping.
 */

import {
  TemplateDocument,
  AuthoredActorLimitError,
  MAX_AUTHORED_ACTORS,
  ScenarioNotFoundError,
  WebTemplateFileStore,
  newTemplateId,
  type LaneRef,
  type RoleBinding,
  type Interaction,
  type ReasoningTraceSegment,
  type Environment,
  type Invariant,
  type MapSignalPlan,
  type ParamDecl,
  type PropPlacement,
  type Variant,
  type ActorSensor,
  type ScenarioTemplateV2,
  type TemplateFileStore,
  type ValidationReport,
  type DriverProfile,
} from '@uniscenarios/scenario-model';
import { reconcileTemplateMapIdentity } from './map-identity';
import { actorClassForCatalogEntry, getEntry, type CatalogActorClass, type CatalogId, type Dims } from '@uniscenarios/prop-catalog';
import { editorMapVersionId, editorSourceMapId, type MapEntry } from './map';
import { defaultSpeedKph, isActionCompatible } from './timeline-actions';
import { routePlaceholderOnActor } from './route-placeholder';

/** Resolve sensor-derived subject identity in canonical authoring order. */
export function sensorSubjectRole(template: Pick<ScenarioTemplateV2, 'roles'>): string | undefined {
  return template.roles.find((role) => role.actor.sensors.length > 0)?.id;
}

/** Where an actor is stored. */
export type ActorSource = 'role' | 'prop';

/** Broad actor class, driving snapping rules and the palette grouping. */
export type ActorKind = 'vehicle' | 'pedestrian' | 'sidewalk_robot' | 'drone' | 'animal' | 'prop';

/** A lane-relative anchor, as the schema stores it. */
export interface LaneAnchor {
  roadId: string;
  section: number;
  laneId: number;
  s: number;
  t: number;
  headingOffsetRad: number;
}

/** One placed thing, whichever lane it is stored in. */
export interface ActorRecord {
  readonly id: string;
  readonly source: ActorSource;
  readonly kind: ActorKind;
  readonly catalogId: CatalogId;
  readonly label: string | undefined;
  /** Ground-contact position in scene metres. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly headingRad: number;
  readonly laneRef: LaneAnchor | undefined;
  readonly dims: Dims;
  /** Studio-only presentation color, persisted with the role and ignored by export. */
  readonly bodyColor: string | undefined;
  readonly initialSpeedKph?: number;
  /** Authored driving policy. Vehicle physics and appearance are independent. */
  readonly driverProfile?: DriverProfile;
  /** Fixed physical participant: it still collides and occludes, but never follows a route. */
  readonly static?: boolean;
  /** Exact authored lane chain, available without materializing or scanning actions. */
  readonly routeLaneRsls?: readonly string[];
  /** Physical sensors mounted to this actor. */
  readonly sensors: readonly ActorSensor[];
}

/** Fields accepted when placing something new. */
export interface NewActor {
  /** Preallocated stable id, used when deterministic behaviour is planned before commit. */
  id?: string;
  catalogId: CatalogId;
  x: number;
  y: number;
  z: number;
  headingRad: number;
  laneRef?: LaneAnchor | undefined;
  label?: string;
  /** Exact connected lane chain for a default moving road actor. */
  routeLaneRsls?: readonly string[];
  /** Truthful initial/cruise speed paired with the generated route. */
  initialSpeedKph?: number;
  bodyColor?: string;
  driverProfile?: DriverProfile;
  /** Place the actor as a fixed body with no inherent motion. */
  static?: boolean;
}

/** A partial edit of one actor. `laneRef: null` clears the anchor. */
export interface ActorUpdate {
  id: string;
  x?: number;
  y?: number;
  z?: number;
  headingRad?: number;
  label?: string;
  laneRef?: LaneAnchor | null;
  /** Swap only the presentation model; identity and choreography stay intact. */
  catalogId?: CatalogId;
  bodyColor?: string;
  initialSpeedKph?: number;
  driverProfile?: DriverProfile;
  /** Mark a mobile catalog actor as parked/fixed. Static-object catalog entries cannot be unset. */
  static?: boolean;
  /** Replace the actor's authored t=0 lane route; `null` clears it. */
  routeLaneRsls?: readonly string[] | null;
}

/** Which lane a catalog id belongs in. */
export function actorKindFor(catalogId: CatalogId): ActorKind {
  // A loose shopping cart is a small moving conflict actor, not fixed scenery.
  if (catalogId === 'street.shopping_cart') return 'vehicle';
  const cls = getEntry(catalogId).class;
  if (cls === 'vehicle') return 'vehicle';
  if (cls === 'pedestrian') return 'pedestrian';
  if (cls === 'sidewalk_robot' || cls === 'drone' || cls === 'animal') return cls;
  return 'prop';
}

/** Preserve the semantic simulation class for specialized catalog actors. */
export function simulationClassFor(catalogId: CatalogId): CatalogActorClass {
  return actorClassForCatalogEntry(getEntry(catalogId));
}

export interface AuthoringGraphPrunePlan {
  readonly interactionIds: readonly string[];
  readonly propIds: readonly string[];
  readonly invariantIds: readonly string[];
  readonly variantIds: readonly string[];
  readonly clearMetricSubject: boolean;
}

/**
 * Find authored graph nodes that cannot survive after roles disappear.
 *
 * Interaction dependencies are closed transitively: removing an actor-owned
 * event also removes every event whose `after`/`until` trigger names it. Rules,
 * attached props and variants are then evaluated against that final set.
 */
export function authoringGraphPrunePlan(
  template: ScenarioTemplateV2,
  deletingRoleIds: readonly string[] = [],
  deletingInteractionIds: readonly string[] = [],
): AuthoringGraphPrunePlan {
  const deleting = new Set(deletingRoleIds);
  const remainingRoles = new Set(template.roles.map((role) => role.id).filter((id) => !deleting.has(id)));
  const authoredInteractionIds = new Set(template.choreography.interactions.map((interaction) => interaction.id));
  const removedInteractions = new Set<string>(deletingInteractionIds);
  for (const interaction of template.choreography.interactions) {
    if ((interaction.actor !== '@world' && !remainingRoles.has(interaction.actor))
      || (interaction.trigger.kind === 'after' && !authoredInteractionIds.has(interaction.trigger.of))
      || (interaction.until?.kind === 'after' && !authoredInteractionIds.has(interaction.until.of))
      || triggerReferencesMissingRole(interaction.trigger, remainingRoles)
      || (interaction.until && triggerReferencesMissingRole(interaction.until, remainingRoles))
      || targetReferencesMissingRole(interaction.target, remainingRoles)) {
      removedInteractions.add(interaction.id);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const interaction of template.choreography.interactions) {
      if (removedInteractions.has(interaction.id)) continue;
      if (triggerReferencesInteraction(interaction.trigger, removedInteractions)
        || (interaction.until && triggerReferencesInteraction(interaction.until, removedInteractions))) {
        removedInteractions.add(interaction.id);
        changed = true;
      }
    }
  }
  const propIds = template.props.filter((prop) => {
    const attachment = prop.attachment?.role;
    const occludes = prop.occludes;
    return (attachment && !remainingRoles.has(attachment))
      || (occludes && (!remainingRoles.has(occludes.observer) || !remainingRoles.has(occludes.target)));
  }).map((prop) => prop.id);
  const invariantIds = template.invariants.filter((invariant) => invariant.kind === 'event_order'
    ? invariant.events.some((id) => !authoredInteractionIds.has(id) || removedInteractions.has(id))
    : invariantReferencesMissingRole(invariant as unknown as Record<string, unknown>, remainingRoles)).map((invariant) => invariant.id);
  const removedProps = new Set(propIds);
  const removedInvariants = new Set(invariantIds);
  const variantIds = template.variants.filter((variant) => variant.overrides.some((override) => {
    const match = /^(roles|props|invariants)#([A-Za-z][A-Za-z0-9_-]*)/.exec(override.path);
    if (!match) return false;
    return match[1] === 'roles' ? !remainingRoles.has(match[2]!)
      : match[1] === 'props' ? removedProps.has(match[2]!)
        : removedInvariants.has(match[2]!);
  })).map((variant) => variant.id);
  return {
    interactionIds: [...removedInteractions],
    propIds,
    invariantIds,
    variantIds,
    clearMetricSubject: template.metricSubject !== undefined && !remainingRoles.has(template.metricSubject),
  };
}

/** Canonical, non-mutating cleanup used for stale autosaves and explicit saves. */
export function normalizeAuthoringGraph(template: ScenarioTemplateV2): {
  readonly template: ScenarioTemplateV2;
  readonly plan: AuthoringGraphPrunePlan;
} {
  const routeIntent = normalizeRuntimeRouteIntent(template);
  template = routeIntent.template;
  const warmupRemoved = template.choreography.warmupSeconds !== 0;
  if (warmupRemoved) {
    template = {
      ...template,
      choreography: {
        ...template.choreography,
        warmupSeconds: 0,
        interactions: template.choreography.interactions.map(moveWarmupInteractionToRecordedTimeline),
      },
    };
  }
  const plan = authoringGraphPrunePlan(template);
  const changed = plan.interactionIds.length > 0 || plan.propIds.length > 0
    || plan.invariantIds.length > 0 || plan.variantIds.length > 0 || plan.clearMetricSubject
    || warmupRemoved || routeIntent.changed;
  if (!changed) return { template, plan };
  const interactions = new Set(plan.interactionIds);
  const props = new Set(plan.propIds);
  const invariants = new Set(plan.invariantIds);
  const variants = new Set(plan.variantIds);
  const normalized: ScenarioTemplateV2 = {
    ...template,
    choreography: {
      ...template.choreography,
      interactions: template.choreography.interactions.filter((item) => !interactions.has(item.id)),
    },
    props: template.props.filter((item) => !props.has(item.id)),
    invariants: template.invariants.filter((item) => !invariants.has(item.id)),
    variants: template.variants.filter((item) => !variants.has(item.id)),
  };
  if (plan.clearMetricSubject) delete normalized.metricSubject;
  return { template: normalized, plan };
}

/**
 * Editor cars persist only their lane pose. Their route is rebuilt against the
 * current topology when a simulation is prepared, using semantic timeline
 * direction actions. This also upgrades drafts created while the direction
 * menu wrote three indistinguishable `acquire` commands.
 */
function normalizeRuntimeRouteIntent(template: ScenarioTemplateV2): {
  readonly template: ScenarioTemplateV2;
  readonly changed: boolean;
} {
  let changed = false;
  const roles = template.roles.map((role) => {
    if (role.kind !== 'scene_absolute' || !role.initialRoute) return role;
    changed = true;
    const { initialRoute: _initialRoute, ...runtimeRouted } = role;
    return runtimeRouted;
  });
  const interactions = template.choreography.interactions.flatMap((interaction) => {
    if (interaction.verb !== 'route') return [interaction];
    const generatedLanePath = interaction.target.mode === 'lanePath' &&
      (interaction.id === `route_${interaction.actor}_initial`.slice(0, 64) ||
        /^(random turns|default route)$/i.test(interaction.label?.trim() ?? ''));
    if (generatedLanePath) {
      changed = true;
      return [];
    }
    if (interaction.target.mode !== 'acquire') return [interaction];
    const key = `${interaction.id} ${interaction.label ?? ''}`.toLowerCase();
    const turn = key.includes('turn_left') || key.includes('turn left')
      ? 'left' as const
      : key.includes('turn_right') || key.includes('turn right')
        ? 'right' as const
        : key.includes('keep_lane') || key.includes('keep lane') || key.includes('go straight')
          ? 'straight' as const
          : null;
    if (!turn) return [interaction];
    changed = true;
    return [{ ...interaction, target: { mode: 'nextJunction' as const, turn } } as Interaction];
  });
  if (!changed) return { template, changed: false };
  return {
    changed: true,
    template: {
      ...template,
      roles,
      choreography: { ...template.choreography, interactions },
    },
  };
}

/** The interactive editor has one visible clock beginning at t=0. */
function moveWarmupInteractionToRecordedTimeline(interaction: Interaction): Interaction {
  const offset = negativeLiteralOffset(interaction.trigger);
  const trigger = shiftLiteralTrigger(interaction.trigger, offset);
  const until = interaction.until ? shiftLiteralTrigger(interaction.until, offset) : undefined;
  if (trigger === interaction.trigger && until === interaction.until) return interaction;
  return { ...interaction, trigger, ...(until ? { until } : {}) } as Interaction;
}

function negativeLiteralOffset(trigger: Interaction['trigger']): number {
  if (trigger.kind === 'at' && typeof trigger.t === 'number') return Math.max(0, -trigger.t);
  if (trigger.kind === 'when' && typeof trigger.byLatest === 'number') return Math.max(0, -trigger.byLatest);
  return 0;
}

function shiftLiteralTrigger<T extends Interaction['trigger']>(trigger: T, offset: number): T {
  if (trigger.kind === 'at' && typeof trigger.t === 'number' && (offset > 0 || trigger.t < 0)) {
    return { ...trigger, t: Math.max(0, trigger.t + offset) } as T;
  }
  if (trigger.kind === 'when' && typeof trigger.byLatest === 'number' && (offset > 0 || trigger.byLatest < 0)) {
    return { ...trigger, byLatest: Math.max(0, trigger.byLatest + offset) } as T;
  }
  return trigger;
}

function triggerReferencesInteraction(trigger: Interaction['trigger'], removed: ReadonlySet<string>): boolean {
  return trigger.kind === 'after' && removed.has(trigger.of);
}

function triggerReferencesMissingRole(trigger: Interaction['trigger'], roles: ReadonlySet<string>): boolean {
  if (trigger.kind === 'arrival') return !roles.has(trigger.of) || !roles.has(trigger.syncWith) || pointReferencesMissingRole(trigger.at, roles);
  if (trigger.kind === 'when') return conditionReferencesMissingRole(trigger.condition as unknown as Record<string, unknown>, roles);
  return false;
}

function pointReferencesMissingRole(point: unknown, roles: ReadonlySet<string>): boolean {
  return isRecord(point) && typeof point.role === 'string' && !roles.has(point.role);
}

function conditionReferencesMissingRole(condition: Record<string, unknown>, roles: ReadonlySet<string>): boolean {
  if (condition.kind === 'and' || condition.kind === 'or') {
    return Array.isArray(condition.operands) && condition.operands.some((item) => isRecord(item) && conditionReferencesMissingRole(item, roles));
  }
  if (condition.kind === 'not') return isRecord(condition.operand) && conditionReferencesMissingRole(condition.operand, roles);
  for (const key of ['from', 'of', 'to', 'with'] as const) {
    const value = condition[key];
    if (typeof value === 'string' && value !== 'any' && !roles.has(value)) return true;
    if (key === 'to' && pointReferencesMissingRole(value, roles)) return true;
  }
  if (pointReferencesMissingRole(condition.region, roles)) return true;
  return false;
}

function targetReferencesMissingRole(target: Interaction['target'], roles: ReadonlySet<string>): boolean {
  if (!isRecord(target)) return false;
  const candidate = target as unknown as Record<string, unknown>;
  return (typeof candidate.role === 'string' && !roles.has(candidate.role))
    || (candidate.mode === 'nearMiss' && typeof candidate.target === 'string' && !roles.has(candidate.target));
}

function invariantReferencesMissingRole(invariant: Record<string, unknown>, roles: ReadonlySet<string>): boolean {
  for (const key of ['of', 'to', 'syncWith', 'pedestrian', 'target'] as const) {
    const value = invariant[key];
    if (typeof value === 'string' && !roles.has(value)) return true;
  }
  return pointReferencesMissingRole(invariant.at, roles);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Quantise to the serializer's 6-decimal precision so save/load is an identity. */
function q(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number.isInteger(value) ? value : Number(value.toFixed(6));
}

function quantizeAnchor(anchor: LaneAnchor): LaneAnchor {
  return {
    roadId: anchor.roadId,
    section: anchor.section,
    laneId: anchor.laneId,
    s: q(Math.max(0, anchor.s)),
    t: q(anchor.t),
    headingOffsetRad: q(anchor.headingOffsetRad),
  };
}

const APP_VERSION = '0.1.0-editor';

/** Exact SI conversion of the authored default: 30 mph = 13.4112 m/s. */
export const DEFAULT_AUTHORED_VEHICLE_SPEED_MPS = 13.4112;
export const DEFAULT_AUTHORED_VEHICLE_SPEED_KPH = 48.28032;

/** Autosave debounce. Long enough to coalesce a drag, short enough to trust. */
const AUTOSAVE_DEBOUNCE_MS = 400;

/** Deep enough that a session's worth of gestures survives; see "Undo groups". */
const HISTORY_LIMIT = 1000;

export interface EditorDocumentOptions {
  store?: TemplateFileStore;
  /** Override the debounce (tests, verification scripts). */
  autosaveMs?: number;
  /** Internal save slot override used by isolated, fresh authoring sessions. */
  autosaveSlot?: string;
}

/**
 * The autosave slot for one immutable map version.
 *
 * One scenario per immutable map version, so switching derivatives parks the
 * current work independently and switching back restores the exact draft.
 */
export function autosaveName(mapVersionId: string): string {
  return `autosave-${mapVersionId}`;
}

/**
 * A fresh page-load draft must never replace the last resumable map autosave.
 * The slot is deliberately stable: each new page load starts from a newly
 * constructed blank document and may replace only the previous blank draft.
 */
export function blankAutosaveName(mapVersionId: string): string {
  return `blank-autosave-${mapVersionId}`;
}

export class EditorDocument {
  readonly map: MapEntry;

  #doc: TemplateDocument;
  readonly #store: TemplateFileStore;
  readonly #autosaveMs: number;
  readonly #autosaveSlot: string;
  readonly #listeners = new Set<() => void>();

  #actors: ActorRecord[] = [];
  /** Monotonic authoring revision. Background products must carry this tag. */
  #revision = 0;
  /** Ops applied since construction; the group bookkeeping counts against it. */
  #opCount = 0;
  #groups: number[] = [];
  #redoGroups: number[] = [];
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #savePromise: Promise<void> | null = null;
  /** Optional user-facing saved-scenario slot mirrored alongside map autosave. */
  #namedSave: string | null = null;
  #savedAt: number | null = null;
  #saveError: string | null = null;
  #unsubscribe: () => void;
  #disposed = false;

  private constructor(map: MapEntry, doc: TemplateDocument, options: EditorDocumentOptions) {
    this.map = map;
    this.#doc = doc;
    this.#store = options.store ?? new WebTemplateFileStore();
    this.#autosaveMs = options.autosaveMs ?? AUTOSAVE_DEBOUNCE_MS;
    this.#autosaveSlot = options.autosaveSlot ?? autosaveName(editorMapVersionId(map));
    this.#unsubscribe = doc.subscribe((change) => {
      if (change.reason === 'apply') this.#opCount++;
    });
    this.#rebuild();
  }

  /** Load this map's autosave, or start a fresh scenario for it. */
  static async open(map: MapEntry, options: EditorDocumentOptions = {}): Promise<EditorDocument> {
    const store = options.store ?? new WebTemplateFileStore();
    let doc: TemplateDocument;
    try {
      const data = await store.read(autosaveName(editorMapVersionId(map)));
      const stored = TemplateDocument.fromJSON(data, { historyLimit: HISTORY_LIMIT });
      const bound = reconcileTemplateMapIdentity(stored.data, {
        mapVersionId: editorMapVersionId(map),
        sourceMapId: editorSourceMapId(map),
        label: map.label,
      });
      const normalized = normalizeAuthoringGraph(bound);
      doc = normalized.template === stored.data
        ? stored
        : TemplateDocument.fromJSON(normalized.template, { historyLimit: HISTORY_LIMIT });
      if (bound !== stored.data || normalized.template !== bound) {
        try {
          await store.write(autosaveName(editorMapVersionId(map)), doc.data);
        } catch (writeError) {
          // Keep the repaired in-memory document usable even when persistence
          // is temporarily unavailable; normal autosave will retry later.
          console.warn(`[editor] repaired stale references for ${map.id}, but could not persist them yet`, writeError);
        }
      }
    } catch (err) {
      if (!(err instanceof ScenarioNotFoundError)) {
        // A corrupt or outdated autosave must not lock the user out of the map.
        console.warn(`[editor] could not read autosave for ${map.id}; starting fresh`, err);
      }
      doc = TemplateDocument.create(
        {
          name: `${map.label} scratch`,
          sourceMap: { mapId: editorSourceMapId(map), mapName: map.label },
          anchor: { features: [], pin: { mapId: editorSourceMapId(map) } },
          appVersion: APP_VERSION,
        },
        { historyLimit: HISTORY_LIMIT },
      );
      // A fresh editor document is already authored at its intended t=0 pose.
      // Hidden prologue motion would make Play start somewhere else.
      doc.setClip(undefined, 0);
    }
    return new EditorDocument(map, doc, { ...options, store });
  }

  /**
   * Start a clean, untitled authoring session without reading or overwriting
   * either the map's resumable autosave or any named Gallery scenario.
   */
  static async openBlank(map: MapEntry, options: EditorDocumentOptions = {}): Promise<EditorDocument> {
    const store = options.store ?? new WebTemplateFileStore();
    const doc = TemplateDocument.create(
      {
        name: 'Untitled scenario',
        sourceMap: { mapId: editorSourceMapId(map), mapName: map.label },
        anchor: { features: [], pin: { mapId: editorSourceMapId(map) } },
        appVersion: APP_VERSION,
      },
      { historyLimit: HISTORY_LIMIT },
    );
    doc.setClip(undefined, 0);
    return new EditorDocument(map, doc, {
      ...options,
      store,
      autosaveSlot: blankAutosaveName(editorMapVersionId(map)),
    });
  }

  // ------------------------------------------------------------------ reads

  get actors(): readonly ActorRecord[] {
    return this.#actors;
  }

  get data(): ScenarioTemplateV2 {
    return this.#doc.data;
  }

  get revision(): number {
    return this.#revision;
  }

  get name(): string {
    return this.#doc.data.meta.name;
  }

  get canUndo(): boolean {
    return this.#groups.length > 0;
  }

  get canRedo(): boolean {
    return this.#redoGroups.length > 0;
  }

  get isDirty(): boolean {
    return this.#doc.isDirty;
  }

  /** `Date.now()` of the last successful autosave. */
  get savedAt(): number | null {
    return this.#savedAt;
  }

  get saveError(): string | null {
    return this.#saveError;
  }

  /** Tier-1 template validation, suitable for the future Validate panel. */
  get validation(): ValidationReport {
    return this.#doc.validate();
  }

  actor(id: string): ActorRecord | undefined {
    return this.#actors.find((a) => a.id === id);
  }

  /** Stable input for deterministic per-actor route choice. */
  get routeSeed(): string {
    return `${editorMapVersionId(this.map)}|${this.#doc.data.meta.createdAt}|${this.#doc.data.meta.name}`;
  }

  allocateActorId(catalogId: CatalogId): string {
    const kind = actorKindFor(catalogId);
    let id = newTemplateId(kind);
    while (this.#doc.role(id)) id = newTemplateId(kind);
    return id;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // ----------------------------------------------------------------- writes

  /**
   * Place one or more actors as a single undoable gesture.
   *
   * @returns The new actor ids, in input order.
   */
  add(inputs: readonly NewActor[]): string[] {
    const nextActorCount = this.#doc.roles.length + inputs.length;
    if (nextActorCount > MAX_AUTHORED_ACTORS) {
      // Preflight the whole gesture so a multi-place operation cannot partially
      // commit before the shared TemplateDocument guard rejects a later actor.
      throw new AuthoredActorLimitError(nextActorCount);
    }
    const ids: string[] = [];
    this.#transaction(() => {
      for (const input of inputs) {
        const kind = actorKindFor(input.catalogId);
        const dims = getEntry(input.catalogId).dims;
        const id = input.id ?? this.allocateActorId(input.catalogId);
        if (this.#doc.role(id)) throw new Error(`actor id "${id}" already exists`);
        this.#doc.addRole({
          id,
          kind: 'scene_absolute',
          actor: {
            class: simulationClassFor(input.catalogId),
            catalogId: input.catalogId,
            dims: { length: dims.l, width: dims.w, height: dims.h },
            static: kind === 'prop' || input.static === true,
            sensors: [],
          },
          pose: {
            position: { x: q(input.x), y: q(input.y), z: q(input.z) },
            headingRad: q(input.headingRad),
          },
          ...(input.label === undefined ? {} : { label: input.label }),
          initialSpeedKph: input.static === true ? 0 : q(Math.max(0, input.initialSpeedKph ?? defaultSpeedKph(simulationClassFor(input.catalogId), input.catalogId))),
          ...(kind === 'vehicle' ? { driverProfile: input.driverProfile ?? 'lawful' } : {}),
          ...(input.laneRef ? { laneRef: quantizeAnchor(input.laneRef) } : {}),
          essentiality: kind === 'prop' ? 'preferred' : 'required',
          ...(input.bodyColor ? { extensions: { 'studio.presentation.bodyColor': input.bodyColor } } : {}),
        });
        ids.push(id);
      }
    });
    return ids;
  }

  /** Patch any number of actors as one gesture. */
  update(updates: readonly ActorUpdate[]): void {
    if (updates.length === 0) return;
    this.#transaction(() => {
      for (const update of updates) {
        const current = this.#doc.role(update.id);
        if (!current || current.kind !== 'scene_absolute') continue;
        const role: RoleBinding = {
          ...current,
          ...(update.label === undefined ? {} : { label: update.label }),
          pose: {
            position: {
              x: q(update.x ?? current.pose.position.x),
              y: q(update.y ?? current.pose.position.y),
              z: q(update.z ?? current.pose.position.z),
            },
            headingRad: q(update.headingRad ?? current.pose.headingRad),
          },
        };
        if (update.catalogId !== undefined) {
          const entry = getEntry(update.catalogId);
          role.actor = {
            ...current.actor,
            class: simulationClassFor(update.catalogId),
            catalogId: update.catalogId,
            dims: { length: entry.dims.l, width: entry.dims.w, height: entry.dims.h },
            static: actorKindFor(update.catalogId) === 'prop' ? true : current.actor.static,
          };
          if (current.actor.class !== role.actor.class) {
            role.initialSpeedKph = defaultSpeedKph(role.actor.class, update.catalogId);
            for (const interaction of [...this.#doc.data.choreography.interactions]) {
              if (interaction.actor === update.id && !isActionCompatible(interaction, role.actor.class, update.catalogId)) this.#doc.removeInteraction(interaction.id);
            }
          }
        }
        if (update.initialSpeedKph !== undefined) role.initialSpeedKph = q(Math.max(0, update.initialSpeedKph));
        if (update.driverProfile !== undefined && !['pedestrian', 'sidewalk_robot', 'drone', 'animal', 'static_object'].includes(role.actor.class)) {
          role.driverProfile = update.driverProfile;
        }
        // Exact lane chains are runtime products, never editor-owned actor state.
        delete role.initialRoute;
        if (update.bodyColor !== undefined) {
          role.extensions = { ...current.extensions, 'studio.presentation.bodyColor': update.bodyColor };
        }
        if (update.laneRef === null) delete role.laneRef;
        else if (update.laneRef !== undefined) role.laneRef = quantizeAnchor(update.laneRef);
        if (update.static !== undefined) {
          // MiscObject export and simulation require static-object catalog entries to remain fixed.
          // Mobile actors may be deliberately parked, which is the authoring gap this field closes.
          role.actor = {
            ...role.actor,
            static: role.actor.class === 'static_object' ? true : update.static,
          };
        }
        if (role.actor.static) {
          role.initialSpeedKph = 0;
          delete role.initialRoute;
          const motionIds = this.#doc.data.choreography.interactions
            .filter((interaction) =>
              interaction.actor === update.id &&
              ['speed', 'gap', 'changeLane', 'laneOffset', 'route'].includes(interaction.verb))
            .map((interaction) => interaction.id);
          const plan = authoringGraphPrunePlan(this.#doc.data, [], motionIds);
          for (const id of plan.variantIds) this.#doc.removeVariant(id);
          for (const id of plan.invariantIds) this.#doc.removeInvariant(id);
          for (const id of plan.interactionIds) this.#doc.removeInteraction(id);
        } else {
          // A timed route is absolute world geometry and the simulation starts the actor
          // from `points[0]`, not from the role pose, so a move that rewrote only the pose
          // was undone the instant playback began. The route travels with the actor.
          //
          // Rigidly, not by dragging `points[0]` alone onto the new pose: the simple-mode
          // timeline is locked to one point per second, so moving the first point without
          // the rest demands the entire displacement inside that first second at an
          // arbitrary speed. Translation keeps the authored shape and timing.
          //
          // `points[0]` is then pinned to the pose outright. It is not an authored waypoint
          // at all — it is where the simulation starts the actor, so it is the actor's own
          // position, and the map tool refuses to drag it for the same reason. Translation
          // alone lands it there whenever the route was seeded at the actor; pinning also
          // repairs the imported and legacy routes that start somewhere else, which are
          // exactly the ones that teleport the car on the first tick.
          //
          // Here rather than in the drag commit because every pose write arrives here -
          // drag, grab, the inspector's world-pose and lane-station fields - and because
          // this is the only place that can share the pose write's transaction. Split
          // across two, undo would need two presses and would expose a state with the
          // route back at the old start and the actor still moved.
          const timedRouteDx = role.pose.position.x - current.pose.position.x;
          const timedRouteDz = role.pose.position.z - current.pose.position.z;
          if (Math.hypot(timedRouteDx, timedRouteDz) > 1e-6) {
            for (const interaction of [...this.#doc.data.choreography.interactions]) {
              if (
                interaction.actor !== update.id ||
                interaction.verb !== 'route' ||
                interaction.target.mode !== 'customTimedRoute'
              ) continue;
              this.#doc.replaceInteraction(interaction.id, {
                ...interaction,
                target: {
                  ...interaction.target,
                  points: interaction.target.points.map((point, index) => (index === 0
                    ? { ...point, x: role.pose.position.x, z: role.pose.position.z }
                    : {
                      ...point,
                      x: Number((point.x + timedRouteDx).toFixed(3)),
                      z: Number((point.z + timedRouteDz).toFixed(3)),
                    })),
                },
              });
            }
          }
        }
        this.#doc.replaceRole(update.id, role);
      }
    });
  }

  /**
   * Replace one actor's complete physical sensor suite as one undoable edit.
   *
   * Sensor ids are authored identity, so the supplied records are installed
   * unchanged rather than regenerated or merged by modality.
   */
  replaceActorSensors(actorId: string, sensors: readonly ActorSensor[]): void {
    const current = this.#doc.role(actorId);
    if (!current || current.kind !== 'scene_absolute') {
      throw new Error(`actor "${actorId}" does not exist`);
    }
    this.#transaction(() => {
      this.#doc.replaceRole(actorId, {
        ...current,
        actor: { ...current.actor, sensors: [...sensors] },
      });
      this.#reconcileSensorSubject(actorId);
    });
  }

  /** Delete actors and every now-orphaned authored reference as one gesture. */
  remove(ids: readonly string[]): void {
    const deleting = [...new Set(ids)].filter((id) => this.#doc.role(id) !== undefined);
    if (deleting.length === 0) return;
    this.#transaction(() => {
      const plan = authoringGraphPrunePlan(this.#doc.data, deleting);
      for (const id of plan.variantIds) this.#doc.removeVariant(id);
      for (const id of plan.invariantIds) this.#doc.removeInvariant(id);
      for (const id of plan.propIds) this.#doc.removeProp(id);
      for (const id of plan.interactionIds) this.#doc.removeInteraction(id);
      for (const segment of this.#doc.data.reasoningTrace) {
        if (deleting.includes(segment.actor)) this.#doc.removeReasoningTraceSegment(segment.id);
      }
      if (plan.clearMetricSubject) this.#doc.setMetricSubject(null);
      for (const id of deleting) this.#doc.removeRole(id);
    });
  }

  /** Rename the scenario itself. */
  rename(name: string): void {
    this.#transaction(() => {
      this.#doc.setMeta({ name });
    });
  }

  /**
   * Open a validated canonical v2 template in this map session.
   *
   * Campaign and Saved Scenario imports replace the undo-bearing document as
   * one explicit navigation operation. The previous autosave is already
   * preserved by the named-scenario store; history must not cross documents.
   */
  importTemplate(value: unknown, options: { saveName?: string } = {}): void {
    const parsed = TemplateDocument.fromJSON(value, { historyLimit: HISTORY_LIMIT });
    // The editor session is opened by immutable map version, but authored
    // templates must carry that version's canonical source-map identity. This
    // also repairs the exact active-version legacy binding created before the
    // public DTO exposed both identities. Foreign canonical bindings remain
    // untouched so downstream validation fails closed instead of retargeting.
    const bound = reconcileTemplateMapIdentity(parsed.data, {
      mapVersionId: editorMapVersionId(this.map),
      sourceMapId: editorSourceMapId(this.map),
      label: this.map.label,
    });
    const boundDocument = TemplateDocument.fromJSON(bound, { historyLimit: HISTORY_LIMIT });
    const normalized = normalizeAuthoringGraph(boundDocument.data);
    const next = normalized.template === boundDocument.data
      ? boundDocument
      : TemplateDocument.fromJSON(normalized.template, { historyLimit: HISTORY_LIMIT });
    this.#unsubscribe();
    this.#doc = next;
    this.#opCount = 0;
    this.#groups = [];
    this.#redoGroups = [];
    this.#unsubscribe = next.subscribe((change) => {
      if (change.reason === 'apply') this.#opCount++;
    });
    this.#savedAt = null;
    this.#saveError = null;
    this.#namedSave = options.saveName ?? null;
    this.#revision++;
    this.#rebuild();
    this.#scheduleSave();
    this.#emit();
  }

  /**
   * Add one semantic timeline interaction as an undoable/autosaved gesture.
   *
   * An unconfigured custom route is seeded on its actor first. Doing it here
   * rather than at each call site makes it an invariant of the document: no
   * caller can add a route that starts somewhere its actor is not.
   */
  addInteraction(interaction: Interaction): void {
    const seeded = routePlaceholderOnActor(interaction, this.actor(interaction.actor));
    this.#transaction(() => { this.#doc.addInteraction(seeded); });
  }

  /**
   * Add an exact map-head override and relinquish a conflicting cycle plan in
   * the same undo step. The materializer intentionally rejects dual ownership.
   */
  addSignalOverride(
    interaction: Extract<Interaction, { verb: 'set' }>,
    conflictingPlanId?: string,
  ): void {
    this.#transaction(() => {
      if (
        conflictingPlanId &&
        this.#doc.data.mapSignalPlans.some((plan) => plan.id === conflictingPlanId)
      ) {
        this.#doc.removeMapSignalPlan(conflictingPlanId);
      }
      this.#doc.addInteraction(interaction);
    });
  }

  /** Commit a near-miss route goal and its required clearance rule as one gesture. */
  addInteractionWithInvariant(interaction: Interaction, invariant: Invariant): void {
    this.#transaction(() => {
      this.#doc.addInteraction(interaction);
      this.#doc.addInvariant(invariant);
    });
  }

  replaceInteractionWithInvariant(id: string, interaction: Interaction, invariant: Invariant): void {
    this.#transaction(() => {
      this.#doc.replaceInteraction(id, interaction);
      const existing = this.#doc.data.invariants.find((item) => item.id === invariant.id);
      if (existing) this.#doc.replaceInvariant(existing.id, invariant);
      else this.#doc.addInvariant(invariant);
    });
  }


  replaceInteractionRemovingInvariant(id: string, interaction: Interaction, invariantId: string): void {
    this.#transaction(() => {
      this.#doc.replaceInteraction(id, interaction);
      if (this.#doc.data.invariants.some((item) => item.id === invariantId)) this.#doc.removeInvariant(invariantId);
    });
  }

  /**
   * Replace one timeline interaction while retaining its stable identity.
   *
   * Seeds an unconfigured custom route on its actor for the same reason
   * `addInteraction` does: switching an existing interaction's target mode
   * produces a fresh placeholder, and it must not land at the scene origin
   * either. Drawn geometry covers ground, so committing a gesture is untouched.
   */
  replaceInteraction(id: string, interaction: Interaction): void {
    const seeded = routePlaceholderOnActor(interaction, this.actor(interaction.actor));
    this.#transaction(() => { this.#doc.replaceInteraction(id, seeded); });
  }

  /** Commit a timeline gesture's semantic edit and presentation layout as one
   * undoable/autosaved transaction. Unrelated presentation keys are retained. */
  replaceInteractionWithPresentation(
    id: string,
    interaction: Interaction,
    key: string,
    value: unknown,
  ): void {
    if (!key.startsWith('studio.presentation.')) {
      throw new Error(`presentation extension key must start with "studio.presentation.": ${key}`);
    }
    this.#transaction(() => {
      this.#doc.replaceInteraction(id, interaction);
      this.#doc.setExtension(key, value);
    });
  }

  /** Delete one semantic timeline interaction. Validation surfaces dangling references. */
  removeInteraction(id: string): void {
    this.#transaction(() => { this.#doc.removeInteraction(id); });
  }

  /**
   * Change the metric subject and discard trace annotations owned by any
   * previous subject. Sensor commands call the underlying document operation
   * directly so removing hardware can never erase authored trace work.
   */
  setMetricSubject(roleId: string | null): void {
    this.#transaction(() => {
      for (const segment of this.#doc.data.reasoningTrace) {
        if (roleId === null || segment.actor !== roleId) this.#doc.removeReasoningTraceSegment(segment.id);
      }
      this.#doc.setExtension('studio.presentation.reasoningTraceLane', undefined);
      this.#doc.setMetricSubject(roleId);
    });
  }

  addReasoningTraceSegment(segment: ReasoningTraceSegment): void {
    this.#transaction(() => { this.#doc.addReasoningTraceSegment(segment); });
  }

  replaceReasoningTraceSegment(id: string, segment: ReasoningTraceSegment): void {
    this.#transaction(() => { this.#doc.replaceReasoningTraceSegment(id, segment); });
  }

  removeReasoningTraceSegment(id: string): void {
    this.#transaction(() => { this.#doc.removeReasoningTraceSegment(id); });
  }

  /** Add one physical-junction signal plan as an undoable/autosaved gesture. */
  addMapSignalPlan(plan: MapSignalPlan): void {
    this.#transaction(() => { this.#doc.addMapSignalPlan(plan); });
  }

  /** Replace one signal plan while retaining its stable identity. */
  replaceMapSignalPlan(id: string, plan: MapSignalPlan): void {
    this.#transaction(() => { this.#doc.replaceMapSignalPlan(id, plan); });
  }

  /** Delete one authored physical-junction signal plan. */
  removeMapSignalPlan(id: string): void {
    this.#transaction(() => { this.#doc.removeMapSignalPlan(id); });
  }

  /** Replace the canonical environment block as one validated gesture. */
  setEnvironment(environment: Environment): void {
    this.#transaction(() => { this.#doc.setEnvironment(environment); });
  }

  addParameter(param: ParamDecl): void {
    this.#transaction(() => { this.#doc.addParam(param); });
  }

  replaceParameter(id: string, param: ParamDecl): void {
    this.#transaction(() => { this.#doc.replaceParam(id, param); });
  }

  removeParameter(id: string): void {
    this.#transaction(() => { this.#doc.removeParam(id); });
  }

  addProp(prop: PropPlacement): void {
    this.#transaction(() => { this.#doc.addProp(prop); });
  }

  replaceProp(id: string, prop: PropPlacement): void {
    this.#transaction(() => { this.#doc.replaceProp(id, prop); });
  }

  removeProp(id: string): void {
    this.#transaction(() => { this.#doc.removeProp(id); });
  }

  addInvariant(invariant: Invariant): void {
    this.#transaction(() => { this.#doc.addInvariant(invariant); });
  }

  replaceInvariant(id: string, invariant: Invariant): void {
    this.#transaction(() => { this.#doc.replaceInvariant(id, invariant); });
  }

  removeInvariant(id: string): void {
    this.#transaction(() => { this.#doc.removeInvariant(id); });
  }

  addVariant(variant: Variant): void {
    this.#transaction(() => { this.#doc.addVariant(variant); });
  }

  replaceVariant(id: string, variant: Variant): void {
    this.#transaction(() => { this.#doc.replaceVariant(id, variant); });
  }

  removeVariant(id: string): void {
    this.#transaction(() => { this.#doc.removeVariant(id); });
  }

  /** Add one validated actor-attached sensor as an undoable/autosaved gesture. */
  addActorSensor(actorId: string, sensor: ActorSensor): string {
    let id = sensor.id;
    this.#transaction(() => {
      id = this.#doc.addActorSensor(actorId, sensor);
      this.#reconcileSensorSubject(actorId);
    });
    return id;
  }

  /** Replace one sensor while retaining its stable identity. */
  updateActorSensor(actorId: string, sensorId: string, sensor: ActorSensor): void {
    if (sensor.id !== sensorId) throw new Error('sensor identity cannot change during update');
    this.#transaction(() => { this.#doc.replaceActorSensor(actorId, sensorId, sensor); });
  }

  /** Remove one actor-attached sensor. */
  removeActorSensor(actorId: string, sensorId: string): void {
    this.#transaction(() => {
      this.#doc.removeActorSensor(actorId, sensorId);
      this.#reconcileSensorSubject(actorId);
    });
  }

  #reconcileSensorSubject(actorId: string): void {
    const sensors = this.#doc.role(actorId)?.actor.sensors ?? [];
    if (sensors.length > 0) {
      if (this.#doc.data.metricSubject === undefined) {
        this.#doc.setMetricSubject(sensorSubjectRole(this.#doc.data) ?? null);
      }
      return;
    }
    if (
      this.#doc.data.metricSubject === actorId
      && !this.#doc.data.reasoningTrace.some((segment) => segment.actor === actorId)
    ) {
      this.#doc.setMetricSubject(null);
    }
  }

  /** Set recorded/warm-up duration as one editor gesture. */
  setClip(clip: { clipSeconds?: number; warmupSeconds?: number }): void {
    this.#transaction(() => { this.#doc.setClip(clip.clipSeconds, clip.warmupSeconds); });
  }

  /**
   * Persist editor presentation state (cameras, layout, render preferences).
   * Materialization deliberately ignores these extensions, so these edits do
   * not change SimScenarioInput or its deterministic hash.
   */
  setPresentationExtension(key: string, value?: unknown): void {
    if (!key.startsWith('studio.presentation.')) {
      throw new Error(`presentation extension key must start with "studio.presentation.": ${key}`);
    }
    this.#transaction(() => { this.#doc.setExtension(key, value); });
  }

  /** Persist an execution-bearing Studio ambient-traffic option as one undoable gesture. */
  setAmbientTrafficExtension(key: string, value?: unknown): void {
    if (!key.startsWith('studio.ambientTraffic.')) {
      throw new Error(`ambient traffic extension key must start with "studio.ambientTraffic.": ${key}`);
    }
    this.#transaction(() => { this.#doc.setExtension(key, value); });
  }

  undo(): boolean {
    const size = this.#groups.pop();
    if (size === undefined) return false;
    for (let i = 0; i < size; i++) this.#doc.undo();
    this.#redoGroups.push(size);
    this.#afterMutation();
    return true;
  }

  redo(): boolean {
    const size = this.#redoGroups.pop();
    if (size === undefined) return false;
    for (let i = 0; i < size; i++) this.#doc.redo();
    this.#groups.push(size);
    this.#afterMutation();
    return true;
  }

  /** Write now, cancelling any pending debounce. Resolves when the bytes land. */
  async flush(): Promise<void> {
    if (this.#saveTimer !== null) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    await this.#write();
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#saveTimer !== null) clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    this.#unsubscribe();
    this.#listeners.clear();
  }

  // -------------------------------------------------------------- internals

  #transaction(fn: () => void): void {
    const before = this.#opCount;
    try {
      fn();
    } finally {
      const applied = this.#opCount - before;
      if (applied > 0) {
        this.#groups.push(applied);
        this.#redoGroups.length = 0;
        this.#afterMutation();
      }
    }
  }

  #afterMutation(): void {
    this.#revision++;
    this.#rebuild();
    this.#scheduleSave();
    this.#emit();
  }

  #rebuild(): void {
    const out: ActorRecord[] = [];
    for (const role of this.#doc.data.roles) {
      const record = recordFromRole(role);
      if (record) out.push(record);
    }
    this.#actors = out;
  }

  #scheduleSave(): void {
    if (this.#disposed) return;
    if (this.#saveTimer !== null) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      void this.#write();
    }, this.#autosaveMs);
  }

  async #write(): Promise<void> {
    // Serialise writes: two overlapping saves would race on the same key.
    const run = async (): Promise<void> => {
      try {
        await this.#store.write(this.#autosaveSlot, this.#doc);
        if (this.#namedSave && this.#namedSave !== this.#autosaveSlot) {
          await this.#store.write(this.#namedSave, this.#doc);
        }
        this.#doc.markClean();
        this.#savedAt = Date.now();
        this.#saveError = null;
      } catch (err) {
        this.#saveError = err instanceof Error ? err.message : String(err);
        console.error('[editor] autosave failed', err);
      }
      this.#emit();
    };
    this.#savePromise = (this.#savePromise ?? Promise.resolve()).then(run);
    await this.#savePromise;
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

/** Fail-closed boundary for installing asynchronously compiled editor worlds. */
export function compiledWorldMatchesRevision(
  document: Pick<EditorDocument, 'revision'>,
  compiledRevision: number,
): boolean {
  return document.revision === compiledRevision;
}

function anchorFrom(laneRef: LaneRef | LaneAnchor | undefined): LaneAnchor | undefined {
  if (!laneRef) return undefined;
  return {
    roadId: laneRef.roadId,
    section: laneRef.section,
    laneId: laneRef.laneId,
    s: laneRef.s,
    t: laneRef.t ?? 0,
    headingOffsetRad: laneRef.headingOffsetRad ?? 0,
  };
}

function recordFromRole(role: RoleBinding): ActorRecord | null {
  if (role.kind !== 'scene_absolute' || !role.actor.catalogId) return null;
  const catalogId = role.actor.catalogId as CatalogId;
  const dims = role.actor.dims
    ? { l: role.actor.dims.length, w: role.actor.dims.width, h: role.actor.dims.height }
    : safeDims(catalogId);
  const isProp = role.actor.class === 'static_object';
  return {
    id: role.id,
    source: isProp ? 'prop' : 'role',
    kind: isProp ? 'prop'
      : role.actor.class === 'pedestrian' ? 'pedestrian'
        : role.actor.class === 'sidewalk_robot' ? 'sidewalk_robot'
          : role.actor.class === 'drone' ? 'drone'
            : role.actor.class === 'animal' ? 'animal'
              : 'vehicle',
    catalogId,
    label: role.label,
    x: role.pose.position.x,
    y: role.pose.position.y,
    z: role.pose.position.z,
    headingRad: role.pose.headingRad,
    laneRef: anchorFrom(role.laneRef),
    dims,
    bodyColor: typeof role.extensions?.['studio.presentation.bodyColor'] === 'string'
      ? role.extensions['studio.presentation.bodyColor']
      : undefined,
    initialSpeedKph: typeof role.initialSpeedKph === 'number' ? role.initialSpeedKph : defaultSpeedKph(role.actor.class, catalogId),
    driverProfile: ['pedestrian', 'sidewalk_robot', 'drone', 'animal', 'static_object'].includes(role.actor.class)
      ? undefined
      : role.driverProfile ?? 'lawful',
    static: role.actor.static,
    routeLaneRsls: role.initialRoute?.lanes,
    sensors: role.actor.sensors,
  };
}

/** Catalog dims, or a 1 m cube for an id this build does not know. */
function safeDims(catalogId: CatalogId): Dims {
  try {
    return getEntry(catalogId).dims;
  } catch {
    return { l: 1, w: 1, h: 1 };
  }
}
