/**
 * Drawing placed actors.
 *
 * ## The draw-call problem
 *
 * `prop-catalog` builds every prop from primitives, which is what makes it
 * parametric and asset-free — and leaves a sedan as **19 separate meshes**.
 * Thirty actors placed naively is ~570 extra draw calls on top of the city's
 * ~970, i.e. a 60% increase to draw 30 cars. Two passes fix that:
 *
 * 1. **Merge by material, once per catalog id.** A built prop is baked into one
 *    `BufferGeometry` per distinct material (a sedan: 19 meshes -> 7 parts).
 *    `prop-catalog` caches materials globally, so props of the same kind already
 *    share them; the merged geometries are cached here alongside.
 * 2. **Instance across actors.** Every actor of one catalog id shares those
 *    geometries, so each part becomes a single `InstancedMesh`. Ten sedans, ten
 *    SUVs and five pedestrians draw in 7 + 7 + 5 = 19 calls regardless of count.
 *
 * Contact shadows are a thirty-first draw call for any number of actors: one
 * instanced quad with a radial-gradient texture, laid 3 cm above the ground.
 * Deliberately not a shadow map — the city ships baked lighting and a real
 * shadow pass is a separate quality lane.
 *
 * ## Picking
 *
 * Instances have no names. Each batch carries `userData.actorIds` indexed by
 * `instanceId`, so a raycast resolves to an actor id in O(1) — see
 * {@link ActorRenderer.actorIdForHit}.
 */

import {
  AnimationMixer,
  Box3,
  BufferAttribute,
  BufferGeometry,
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  SpotLight,
  Vector3,
  type AnimationClip,
  type Intersection,
  type Material,
  type Object3D
} from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { LOW_FIDELITY_HIDDEN_ROLE } from './roads-only';
import { buildProp, getEntry, type Dims, type ExternalModelBinding } from '@simforge/asset-catalog';
import type { ActorKind } from '@simforge/engine';
import type { ActorSensor } from '@simforge/scenario';
import {
  externalModelClips,
  externalModelScene,
  onExternalModelChange,
  requestExternalModel,
} from './externalModel';
import { ActorSensorOverlay } from './sensorOverlay';

export type DoorName = 'left' | 'right' | 'rear';
export type DoorState = 'closed' | 'opening' | 'open' | 'closing';
export type DoorStates = Readonly<Partial<Record<DoorName, DoorState>>>;

export type ActorRenderIdentity =
  | { readonly source: 'catalog'; readonly catalogId: string }
  | { readonly source: 'semantic'; readonly kind: 'animal' | 'scooter' | 'static_object' };

/** What the renderer needs to draw one actor. */
export interface ActorView {
  readonly id: string;
  readonly catalogId: string;
  /** Ground-contact position in scene metres (prop origins are ground-centred). */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly headingRad: number;
  readonly dims: Dims;
  /** Simulation identity. Omitted by the editor, whose catalog id is authored. */
  readonly kind?: ActorKind;
  /** True only when the concrete input carried a catalog:* tag. */
  readonly catalogIdAuthored?: boolean;
  /** Sampled render-facing articulation at this actor's current trace time. */
  readonly doors?: DoorStates;
  /** The trace says the body is travelling rear-first; heading remains body orientation. */
  readonly reversing?: boolean;
  /** Emergency beacon state sampled from timeline state_set events. */
  readonly emergency?: 'off' | 'flashing' | 'flashing_siren';
  /** Audio has no geometry, but retaining it here makes sampled playback inspectable. */
  readonly hornActive?: boolean;
  /** Turn-signal state sampled from timeline state_set events. */
  readonly indicator?: 'off' | 'left' | 'right' | 'hazard';
  /** Explicit or environment-derived low-beam state. */
  readonly headlights?: boolean;
  /** Optional per-instance studio body tint. */
  readonly bodyColor?: string;
  /** Scenario clock and sampled speed drive procedural motion until a rigged GLB is installed. */
  readonly animationTimeS?: number;
  readonly speedMps?: number;
  /** Physical sensors authored on this actor. Playback-only views omit them. */
  readonly sensors?: readonly ActorSensor[];
  /**
   * How far through being knocked down this body is: 0 standing, 1 flat on the
   * ground. Derived from the trace's `downSinceS`, so it is a presentation of a
   * recorded fact rather than a second source of truth.
   */
  readonly downProgress?: number;
}

/** One material's worth of a merged prop. */
interface TemplatePart {
  geometry: BufferGeometry;
  material: Material;
}

interface PropTemplate {
  parts: TemplatePart[];
  dims: Dims;
  ownedMaterials?: Material[];
}

const templates = new Map<string, PropTemplate>();
const proxyMaterials = new Map<string, MeshStandardMaterial>();


const SEMANTIC_TEMPLATE_DIMS = {
  animal: { l: 1.2, w: 0.45, h: 0.9 },
  scooter: { l: 1.1, w: 0.45, h: 1.2 },
  static_object: { l: 1, w: 1, h: 1 }
} as const satisfies Record<'animal' | 'scooter' | 'static_object', Dims>;

/**
 * Build (or fetch) the merged geometry set for a catalog id.
 *
 * Procedural catalog props retain the compact position-and-normal path. Loaded
 * GLBs additionally retain UVs and every material group so textured assets can
 * share the same instanced batching path without losing their appearance.
 */
export function propTemplate(catalogId: string): PropTemplate {
  const entry = getEntry(catalogId);
  const binding = entry.model;
  if (binding?.kind === 'proxy') {
    const key = `placeholder:${catalogId}`;
    const cached = templates.get(key);
    if (cached) return cached;
    const root = buildProp(catalogId);
    if (binding.tint) {
      let material = proxyMaterials.get(binding.tint);
      if (!material) {
        material = new MeshStandardMaterial({
          color: binding.tint,
          roughness: 0.8,
          metalness: 0,
        });
        proxyMaterials.set(binding.tint, material);
      }
      root.traverse((object) => {
        const mesh = object as Mesh;
        if (mesh.isMesh) mesh.material = material;
      });
    }
    const template = mergeTemplate(root, entry.dims);
    templates.set(key, template);
    return template;
  }
  if (binding?.kind === 'glb') {
    const scene = externalModelScene(binding.contentHash);
    if (scene) {
      const key = `external:${binding.contentHash}`;
      const cached = templates.get(key);
      if (cached) return cached;
      const bounds = new Box3().setFromObject(scene);
      const size = bounds.getSize(new Vector3());
      const template = mergeTemplate(scene, { l: size.x, w: size.z, h: size.y }, {
        preserveUv: true,
        disposeSourceGeometry: false,
      });
      templates.set(key, template);
      return template;
    }
    requestExternalModel(binding);
    const key = `placeholder:${catalogId}`;
    const cached = templates.get(key);
    if (cached) return cached;
    const template = mergeTemplate(buildProp(catalogId), entry.dims);
    templates.set(key, template);
    return template;
  }

  const key = `catalog:${catalogId}`;
  const cached = templates.get(key);
  if (cached) return cached;
  const template = mergeTemplate(buildProp(catalogId), entry.dims);
  templates.set(key, template);
  return template;
}

/** Pick a visual without erasing a simulation class behind a fallback catalog id. */
export function renderIdentity(actor: ActorView): ActorRenderIdentity {
  if (
    !actor.catalogIdAuthored &&
    (actor.kind === 'animal' || actor.kind === 'scooter' || actor.kind === 'static_object')
  ) {
    return { source: 'semantic', kind: actor.kind };
  }
  return { source: 'catalog', catalogId: actor.catalogId };
}

function templateFor(identity: ActorRenderIdentity): PropTemplate {
  if (identity.source === 'catalog') return propTemplate(identity.catalogId);
  const key = `semantic:${identity.kind}`;
  const cached = templates.get(key);
  if (cached) return cached;
  const root = buildSemanticProp(identity.kind);
  const materials = new Set<Material>();
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(material);
    }
  });
  const template = mergeTemplate(root, SEMANTIC_TEMPLATE_DIMS[identity.kind]);
  template.ownedMaterials = [...materials];
  templates.set(key, template);
  return template;
}

interface MergeTemplateOptions {
  preserveUv?: boolean;
  disposeSourceGeometry?: boolean;
}

function mergeTemplate(
  root: Object3D,
  dims: Dims,
  options: MergeTemplateOptions = {},
): PropTemplate {
  root.updateMatrixWorld(true);

  interface MaterialBucket {
    material: Material;
    positions: number[];
    normals: number[];
    uvs?: number[];
  }
  const byMaterial = new Map<string, MaterialBucket>();
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const flat = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    flat.applyMatrix4(mesh.matrixWorld);
    if (!flat.attributes.normal) flat.computeVertexNormals();
    const position = flat.attributes.position as BufferAttribute;
    const normal = flat.attributes.normal as BufferAttribute;
    const uv = flat.attributes.uv as BufferAttribute | undefined;
    const groups = flat.groups.length > 0
      ? flat.groups
      : [{ start: 0, count: position.count, materialIndex: 0 }];

    for (const group of groups) {
      const material = materials[group.materialIndex ?? 0] ?? materials[0];
      if (!material) continue;
      let bucket = byMaterial.get(material.uuid);
      if (!bucket) {
        bucket = {
          material,
          positions: [],
          normals: [],
          ...(options.preserveUv ? { uvs: [] } : {}),
        };
        byMaterial.set(material.uuid, bucket);
      }
      const end = Math.min(position.count, group.start + group.count);
      for (let i = group.start; i < end; i++) {
        bucket.positions.push(position.getX(i), position.getY(i), position.getZ(i));
        bucket.normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
        if (bucket.uvs) bucket.uvs.push(uv?.getX(i) ?? 0, uv?.getY(i) ?? 0);
      }
    }
    flat.dispose();
  });

  if (options.disposeSourceGeometry !== false) {
    root.traverse((object) => {
      const mesh = object as Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
  }

  const parts: TemplatePart[] = [];
  for (const bucket of byMaterial.values()) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(bucket.positions), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(bucket.normals), 3));
    if (bucket.uvs) {
      geometry.setAttribute('uv', new BufferAttribute(new Float32Array(bucket.uvs), 2));
    }
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    parts.push({ geometry, material: bucket.material });
  }

  return { parts, dims };
}

function buildSemanticProp(kind: 'animal' | 'scooter' | 'static_object'): Group {
  const root = new Group();
  if (kind === 'animal') {
    const coat = new MeshStandardMaterial({ color: 0x8a5a3b, roughness: 0.92 });
    const dark = new MeshStandardMaterial({ color: 0x2e241f, roughness: 0.9 });
    addBox(root, [0, 0.56, 0], [0.72, 0.38, 0.34], coat);
    addMesh(root, new SphereGeometry(0.21, 10, 7), coat, [0.43, 0.69, 0]);
    addBox(root, [0.55, 0.65, 0], [0.22, 0.15, 0.25], dark);
    for (const x of [-0.24, 0.27]) {
      for (const z of [-0.13, 0.13]) addBox(root, [x, 0.23, z], [0.1, 0.46, 0.1], dark);
    }
    const tail = addMesh(root, new CylinderGeometry(0.035, 0.055, 0.42, 7), coat, [-0.48, 0.7, 0]);
    tail.rotation.z = -Math.PI / 3;
  } else if (kind === 'scooter') {
    const frame = new MeshStandardMaterial({ color: 0x2b85c7, roughness: 0.48, metalness: 0.22 });
    const rubber = new MeshStandardMaterial({ color: 0x17191c, roughness: 0.96 });
    addBox(root, [0, 0.14, 0], [0.72, 0.09, 0.18], frame);
    for (const x of [-0.34, 0.34]) {
      const wheel = addMesh(root, new CylinderGeometry(0.13, 0.13, 0.08, 14), rubber, [x, 0.13, 0]);
      wheel.rotation.x = Math.PI / 2;
    }
    const stem = addMesh(root, new CylinderGeometry(0.025, 0.025, 0.88, 8), frame, [0.3, 0.63, 0]);
    stem.rotation.z = -0.09;
    addBox(root, [0.34, 1.05, 0], [0.08, 0.06, 0.42], frame);
  } else {
    // A solid, footprint-filling crate reads as collidable fixed geometry. A
    // traffic cone here would silently specialize an otherwise generic
    // static-object actor and visually understate its authored OBB.
    const face = new MeshStandardMaterial({ color: 0xb77b38, roughness: 0.88 });
    const brace = new MeshStandardMaterial({ color: 0x5c3a20, roughness: 0.94 });
    addBox(root, [0, 0.48, 0], [0.92, 0.84, 0.92], face);
    addBox(root, [0, 0.49, 0.47], [0.78, 0.1, 0.035], brace);
    addBox(root, [0, 0.49, -0.47], [0.78, 0.1, 0.035], brace);
    addBox(root, [0.47, 0.49, 0], [0.035, 0.1, 0.78], brace);
    addBox(root, [-0.47, 0.49, 0], [0.035, 0.1, 0.78], brace);
  }
  return root;
}

function addBox(
  root: Group,
  position: readonly [number, number, number],
  size: readonly [number, number, number],
  material: Material,
): Mesh {
  return addMesh(root, new BoxGeometry(...size), material, position);
}

function addMesh(
  root: Group,
  geometry: BufferGeometry,
  material: Material,
  position: readonly [number, number, number],
): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.position.set(...position);
  root.add(mesh);
  return mesh;
}

/** Drop cached geometry and renderer-owned semantic materials. Catalog materials stay. */
export function disposePropTemplates(): void {
  for (const template of templates.values()) disposeTemplate(template);
  templates.clear();
  for (const material of proxyMaterials.values()) material.dispose();
  proxyMaterials.clear();
}

function disposeTemplate(template: PropTemplate): void {
  for (const part of template.parts) part.geometry.dispose();
  for (const material of template.ownedMaterials ?? []) material.dispose();
}

/** A soft dark blob, used as the contact shadow under every actor. */
function contactShadowTexture(): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    // Soft-edged rather than linear: a linear falloff reads as a hard disc.
    gradient.addColorStop(0, 'rgba(0,0,0,0.85)');
    gradient.addColorStop(0.45, 'rgba(0,0,0,0.45)');
    gradient.addColorStop(0.8, 'rgba(0,0,0,0.08)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  return new CanvasTexture(canvas);
}

interface Batch {
  mesh: InstancedMesh;
  capacity: number;
}

interface AnimatedClone {
  bindingHash: string;
  container: Group;
  root: Object3D;
  mixer: AnimationMixer;
  templateDims: Dims;
  activeClip: AnimationClip | null;
  drawCalls: number;
}

const _matrix = new Matrix4();
const _position = new Vector3();
const _quaternion = new Quaternion();
const _scale = new Vector3(1, 1, 1);
const _up = new Vector3(0, 1, 0);
/** Body lateral axis in model space: the axis a body pitches forward about. */
const _lateral = new Vector3(0, 0, 1);
const WHITE_INSTANCE_TINT = new Color('#ffffff');
const instanceTintCache = new Map<string, Color>();

/**
 * Height of the contact shadow above the sampled ground, metres.
 *
 * Not a cosmetic number. `GroundIndex` answers with the *lowest* covering
 * surface (that is what keeps draped overlays off lamp posts), and the road
 * glTF stacks lane-marking decals over the asphalt, so "the ground" under an
 * actor can be a centimetre or two below the surface actually on screen. At the
 * 3 cm this started with, the shadow was depth-buried and invisible. 6 cm clears
 * the decals *and* the lane overlay's own 4 cm drape, and the polygon offset on
 * the material covers the co-planar remainder.
 */
const SHADOW_LIFT = 0.06;
/** Real spotlights are the expensive part; emissive lenses remain unbounded. */
export const MAX_PROJECTED_HEADLIGHTS = 8;

/** Selection colour — amber, the one hue the city never produces. */
export const SELECTION_COLOR = 0xffb020;

/**
 * Instanced renderer for the placed-actor layer.
 *
 * Owns one `Group` (`actors`) that the caller adds to the viewer's scene.
 * {@link sync} is idempotent and cheap enough to call on every pointer move
 * during a drag.
 */
export class ActorRenderer {
  readonly group = new Group();

  private readonly batches = new Map<string, Batch>();
  /** Actor id per instance slot, shared by every batch of one catalog id. */
  private readonly slots = new Map<string, string[]>();
  private readonly animatedGroup = new Group();
  private readonly animatedClones = new Map<string, AnimatedClone>();
  private readonly unsubscribeExternalModelChanges: () => void;
  private readonly shadowTexture: CanvasTexture;
  private readonly shadowMaterial: MeshBasicMaterial;
  private readonly shadowGeometry: PlaneGeometry;
  private shadows: InstancedMesh | null = null;
  private shadowCapacity = 0;
  /**
   * Painted contact shadows are a stand-in for a real shadow pass: a soft blob
   * under the footprint that does not track the sun. When the host renderer
   * casts a real sun shadow they must be switched off, or every actor carries
   * two shadows, one of which points the wrong way.
   */
  private contactShadows = true;
  private readonly doorGeometry = new BoxGeometry(1, 1, 1);
  private readonly doorMaterial = new MeshStandardMaterial({
    color: 0x26384b,
    roughness: 0.48,
    metalness: 0.12
  });
  private readonly doorBatches = new Map<DoorName, Batch>();
  private readonly reverseLightGeometry = new BoxGeometry(1, 1, 1);
  private readonly reverseLightMaterial = new MeshStandardMaterial({
    color: 0xf4f8ff,
    emissive: 0xc9dcff,
    emissiveIntensity: 2.2,
    roughness: 0.28
  });
  private reverseLightBatch: Batch | null = null;
  private readonly headlightGeometry = new BoxGeometry(1, 1, 1);
  private readonly headlightMaterial = new MeshStandardMaterial({
    color: 0xfff4d6,
    emissive: 0xffd89a,
    emissiveIntensity: 4,
    roughness: 0.18
  });
  private headlightBatch: Batch | null = null;
  private readonly headlightBeams: Array<{ light: SpotLight; target: Object3D }> = [];
  private headlightsEnabled = false;
  private readonly emergencyGeometry = new BoxGeometry(1, 1, 1);
  private readonly emergencyRedMaterial = new MeshBasicMaterial({ color: 0xff2f38, toneMapped: false });
  private readonly emergencyBlueMaterial = new MeshBasicMaterial({ color: 0x2786ff, toneMapped: false });
  private emergencyRedBatch: Batch | null = null;
  private emergencyBlueBatch: Batch | null = null;
  private readonly indicatorGeometry = new BoxGeometry(1, 1, 1);
  private readonly indicatorMaterial = new MeshBasicMaterial({ color: 0xffa21a, toneMapped: false });
  private readonly indicatorBatches = new Map<'left' | 'right', Batch>();
  private readonly selection: LineSegments;
  private readonly sensorOverlay = new ActorSensorOverlay();
  private drawCalls = 0;
  private disposed = false;
  private readonly layers = new Map<string, readonly ActorView[]>();
  private readonly hiddenLayers = new Set<string>();

  constructor() {
    this.group.name = 'actors';
    this.animatedGroup.name = 'animated-actors';
    this.group.add(this.animatedGroup);
    this.unsubscribeExternalModelChanges = onExternalModelChange((contentHash) => {
      if (this.disposed) return;
      if (!externalModelScene(contentHash)) return;
      for (const key of [...templates.keys()]) {
        if (!key.startsWith('placeholder:')) continue;
        const catalogId = key.slice('placeholder:'.length);
        try {
          const model = getEntry(catalogId).model;
          if (model?.kind === 'glb' && model.contentHash === contentHash) {
            const placeholder = templates.get(key);
            if (placeholder) disposeTemplate(placeholder);
            templates.delete(key);
          }
        } catch {
          // A concurrently unregistered gallery entry has no template to refresh.
        }
      }
      this.syncLayers();
    });

    this.shadowTexture = contactShadowTexture();
    this.shadowMaterial = new MeshBasicMaterial({
      map: this.shadowTexture,
      transparent: true,
      depthWrite: false,
      opacity: 0.55,
      toneMapped: false,
      // Co-planar with the road for most of its area; the offset is what stops
      // the asphalt winning the depth test along the blob's outer edge.
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4
    });
    // A unit quad in the XZ plane, so the instance matrix carries footprint size.
    this.shadowGeometry = new PlaneGeometry(1, 1);
    this.shadowGeometry.rotateX(-Math.PI / 2);

    this.selection = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({
        color: SELECTION_COLOR,
        toneMapped: false,
        // Editors need the selection visible even when it is behind a parked
        // van; that is worth more than depth correctness on an overlay.
        depthTest: false,
        transparent: true
      }),
    );
    this.selection.name = 'actor-selection';
    this.selection.renderOrder = 30;
    this.selection.frustumCulled = false;
    this.group.add(this.selection);
    this.group.add(this.sensorOverlay.group);
  }

  get stats(): { batches: number; drawCalls: number } {
    const sensorStats = this.sensorOverlay.stats;
    return {
      batches: this.batches.size + this.doorBatches.size + this.indicatorBatches.size + (this.reverseLightBatch ? 1 : 0) + (this.emergencyRedBatch ? 1 : 0) + (this.emergencyBlueBatch ? 1 : 0) + sensorStats.housingDrawCalls,
      drawCalls: this.drawCalls + sensorStats.housingDrawCalls + sensorStats.coverageDrawCalls
    };
  }

  /** Rebuild every instance matrix from `actors`. */
  sync(actors: readonly ActorView[]): void {
    this.syncLayer('editor', actors);
  }

  /**
   * Update one logical actor source without replacing the renderer. Editor,
   * ambient preview and trace playback can therefore share GPU allocations.
   */
  syncLayer(layer: string, actors: readonly ActorView[]): void {
    this.layers.set(layer, actors);
    this.syncLayers();
  }

  clearLayer(layer: string): void {
    if (!this.layers.delete(layer)) return;
    this.hiddenLayers.delete(layer);
    this.syncLayers();
  }

  setLayerVisible(layer: string, visible: boolean): void {
    const changed = visible ? this.hiddenLayers.delete(layer) : !this.hiddenLayers.has(layer);
    if (!visible) this.hiddenLayers.add(layer);
    if (changed) this.syncLayers();
  }

  /**
   * Turns the painted contact shadow blobs off, for hosts whose renderer casts
   * a real sun shadow. Actors keep casting into that shadow map either way.
   */
  setContactShadows(enabled: boolean): void {
    if (this.contactShadows === enabled) return;
    this.contactShadows = enabled;
    this.syncLayers();
  }

  /**
   * Applies the scene's automatic low-beam policy.
   *
   * Per-actor `headlights` remains authoritative when present. The pool is
   * bounded: every active vehicle gets emissive lenses, while only eight
   * deterministic vehicles project real light into the city.
   */
  setHeadlightsEnabled(enabled: boolean): void {
    if (this.headlightsEnabled === enabled) return;
    this.headlightsEnabled = enabled;
    this.syncLayers();
  }

  private syncLayers(): void {
    const actors = [...this.layers]
      .filter(([name]) => !this.hiddenLayers.has(name))
      .flatMap(([, values]) => [...values]);
    const byIdentity = new Map<string, { identity: ActorRenderIdentity; actors: ActorView[] }>();
    for (const actor of actors) {
      const identity = renderIdentity(actor);
      const key = renderIdentityKey(identity);
      let group = byIdentity.get(key);
      if (!group) {
        group = { identity, actors: [] };
        byIdentity.set(key, group);
      }
      group.actors.push(actor);
    }

    let draws = 0;
    const activeBatchKeys = new Set<string>();
    const activeAnimatedIds = new Set<string>();
    for (const [identityKey, group] of [...byIdentity].sort(([a], [b]) => a.localeCompare(b))) {
      const list = group.actors.sort((a, b) => a.id.localeCompare(b.id));
      const binding = group.identity.source === 'catalog'
        ? getEntry(group.identity.catalogId).model
        : undefined;
      const animatedScene = binding?.kind === 'glb' && binding.animated
        ? externalModelScene(binding.contentHash)
        : null;
      if (binding?.kind === 'glb' && binding.animated && animatedScene) {
        const clips = externalModelClips(binding.contentHash);
        for (const actor of list) {
          activeAnimatedIds.add(actor.id);
          draws += this.syncAnimatedActor(actor, binding, animatedScene, clips);
        }
        this.slots.delete(identityKey);
        continue;
      }

      const template = templateFor(group.identity);
      const ids = list.map((actor) => actor.id);
      // A catalog prop has several material batches, but every part of an
      // actor has the same world transform and tint. Compute those once per
      // actor rather than once per material part (a sedan has seven parts).
      const matrices = list.map((actor) => poseMatrix(actor, template.dims));
      const colors = list.map(instanceBodyTint);
      this.slots.set(identityKey, ids);
      for (let part = 0; part < template.parts.length; part++) {
        const key = `${identityKey}#${part}`;
        activeBatchKeys.add(key);
        const spec = template.parts[part] as TemplatePart;
        const batch = this.ensureBatch(key, spec, list.length);
        batch.mesh.userData.actorIds = ids;
        batch.mesh.userData.renderIdentity = group.identity;
        batch.mesh.count = list.length;
        list.forEach((_actor, index) => {
          batch.mesh.setMatrixAt(index, matrices[index]!);
          batch.mesh.setColorAt(index, colors[index]!);
        });
        batch.mesh.instanceMatrix.needsUpdate = true;
        if (batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true;
        batch.mesh.computeBoundingSphere();
        batch.mesh.visible = list.length > 0;
        draws++;
      }
    }
    for (const [actorId, animated] of this.animatedClones) {
      if (!activeAnimatedIds.has(actorId)) this.disposeAnimatedClone(actorId, animated);
    }

    // Visuals that no longer have actors remain allocated because scrubbing and
    // editor placement commonly bring them back. Their identity stays stable.
    for (const [key, batch] of this.batches) {
      if (!activeBatchKeys.has(key)) {
        batch.mesh.count = 0;
        batch.mesh.visible = false;
      }
    }

    this.syncShadows(actors);
    draws += this.syncDoors(actors);
    draws += this.syncReverseLights(actors);
    draws += this.syncEmergencyLights(actors);
    draws += this.syncIndicators(actors);
    draws += this.syncHeadlights(actors);
    this.sensorOverlay.sync(actors);
    this.drawCalls = draws + (actors.length > 0 ? 1 : 0);
  }

  /** Highlight boxes around the selected actors. */
  setSelection(actors: readonly ActorView[]): void {
    const verts: number[] = [];
    for (const actor of actors) {
      pushBoxEdges(verts, actor);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(verts), 3));
    geometry.computeBoundingSphere();
    this.selection.geometry.dispose();
    this.selection.geometry = geometry;
    this.sensorOverlay.setSelectedActorIds(new Set(actors.map((actor) => actor.id)));
    this.selection.visible = verts.length > 0;
  }

  /** Objects a picking raycast should test. */
  pickables(): Object3D[] {
    const out: Object3D[] = [];
    for (const batch of this.batches.values()) {
      if (batch.mesh.count > 0) out.push(batch.mesh);
    }
    for (const batch of this.doorBatches.values()) {
      if (batch.mesh.count > 0) out.push(batch.mesh);
    }
    if (this.reverseLightBatch && this.reverseLightBatch.mesh.count > 0) {
      out.push(this.reverseLightBatch.mesh);
    }
    for (const animated of this.animatedClones.values()) out.push(animated.root);
    return out;
  }

  /** Resolve a raycast hit against {@link pickables} to an actor id. */
  actorIdForHit(hit: Pick<Intersection, 'object' | 'instanceId'>): string | null {
    const ids = hit.object.userData.actorIds as string[] | undefined;
    if (ids && hit.instanceId !== undefined) return ids[hit.instanceId] ?? null;
    let object: Object3D | null = hit.object;
    while (object) {
      const actorId = object.userData.actorId;
      if (typeof actorId === 'string') return actorId;
      object = object.parent;
    }
    return null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeExternalModelChanges();
    for (const [actorId, animated] of this.animatedClones) {
      this.disposeAnimatedClone(actorId, animated);
    }
    this.layers.clear();
    this.hiddenLayers.clear();
    for (const batch of this.batches.values()) {
      batch.mesh.dispose();
      this.group.remove(batch.mesh);
    }
    this.batches.clear();
    this.slots.clear();
    for (const batch of this.doorBatches.values()) {
      batch.mesh.dispose();
      this.group.remove(batch.mesh);
    }
    this.doorBatches.clear();
    this.doorGeometry.dispose();
    this.doorMaterial.dispose();
    if (this.reverseLightBatch) {
      this.reverseLightBatch.mesh.dispose();
      this.group.remove(this.reverseLightBatch.mesh);
      this.reverseLightBatch = null;
    }
    this.reverseLightGeometry.dispose();
    this.reverseLightMaterial.dispose();
    if (this.headlightBatch) {
      this.headlightBatch.mesh.dispose();
      this.group.remove(this.headlightBatch.mesh);
      this.headlightBatch = null;
    }
    this.headlightGeometry.dispose();
    this.headlightMaterial.dispose();
    for (const beam of this.headlightBeams) {
      beam.light.removeFromParent();
      beam.target.removeFromParent();
      beam.light.dispose();
    }
    this.headlightBeams.length = 0;
    for (const batch of [this.emergencyRedBatch, this.emergencyBlueBatch]) {
      if (batch) {
        batch.mesh.dispose();
        this.group.remove(batch.mesh);
      }
    }
    this.emergencyRedBatch = null;
    this.emergencyBlueBatch = null;
    this.emergencyGeometry.dispose();
    this.emergencyRedMaterial.dispose();
    this.emergencyBlueMaterial.dispose();
    for (const batch of this.indicatorBatches.values()) { batch.mesh.dispose(); this.group.remove(batch.mesh); }
    this.indicatorBatches.clear();
    this.indicatorGeometry.dispose();
    this.indicatorMaterial.dispose();
    this.shadows?.dispose();
    this.shadows = null;
    this.shadowCapacity = 0;
    this.shadowGeometry.dispose();
    this.shadowMaterial.dispose();
    this.shadowTexture.dispose();
    this.selection.geometry.dispose();
    (this.selection.material as Material).dispose();
    this.sensorOverlay.dispose();
    this.group.clear();
    this.group.removeFromParent();
    this.drawCalls = 0;
  }

  private syncAnimatedActor(
    actor: ActorView,
    binding: Extract<ExternalModelBinding, { readonly kind: 'glb' }>,
    scene: Group,
    clips: readonly AnimationClip[],
  ): number {
    let animated = this.animatedClones.get(actor.id);
    if (animated && animated.bindingHash !== binding.contentHash) {
      this.disposeAnimatedClone(actor.id, animated);
      animated = undefined;
    }
    if (!animated) {
      const root = cloneSkeleton(scene);
      root.traverse((object) => {
        object.userData.actorId = actor.id;
      });
      const bounds = new Box3().setFromObject(scene);
      const size = bounds.getSize(new Vector3());
      const templateDims = { l: size.x, w: size.z, h: size.y };
      const container = new Group();
      container.name = `animated-actor.${actor.id}`;
      container.matrixAutoUpdate = false;
      container.userData.actorId = actor.id;
      container.add(root);
      this.animatedGroup.add(container);
      let drawCalls = 0;
      root.traverse((object) => {
        const mesh = object as Mesh;
        if (!mesh.isMesh) return;
        // Skinned actors are the reason a bake can never hold every shadow.
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        drawCalls += Array.isArray(mesh.material) && mesh.geometry.groups.length > 0
          ? mesh.geometry.groups.length
          : 1;
      });
      animated = {
        bindingHash: binding.contentHash,
        container,
        root,
        mixer: new AnimationMixer(root),
        activeClip: null,
        drawCalls,
        templateDims,
      };
      this.animatedClones.set(actor.id, animated);
    }

    animated.container.matrix.copy(poseMatrix(actor, animated.templateDims));
    animated.container.matrixWorldNeedsUpdate = true;
    const requestedName = (actor.speedMps ?? 0) > 0.1
      ? binding.clips?.locomotion
      : binding.clips?.idle;
    const clip = clips.find((candidate) => candidate.name === requestedName) ?? clips[0] ?? null;
    if (clip !== animated.activeClip) {
      animated.mixer.stopAllAction();
      if (clip) animated.mixer.clipAction(clip).reset().play();
      animated.activeClip = clip;
    }
    animated.mixer.setTime(actor.animationTimeS ?? 0);
    return animated.drawCalls;
  }

  private disposeAnimatedClone(actorId: string, animated: AnimatedClone): void {
    animated.mixer.stopAllAction();
    animated.mixer.uncacheRoot(animated.root);
    animated.container.removeFromParent();
    this.animatedClones.delete(actorId);
  }

  private ensureBatch(key: string, spec: TemplatePart, needed: number): Batch {
    const existing = this.batches.get(key);
    if (
      existing
      && existing.capacity >= needed
      && existing.mesh.geometry === spec.geometry
      && existing.mesh.material === spec.material
    ) return existing;
    if (existing) {
      this.group.remove(existing.mesh);
      existing.mesh.dispose();
    }
    // Grow in powers of two so a run of placements does not reallocate on every
    // click.
    const capacity = Math.max(8, 1 << Math.ceil(Math.log2(Math.max(1, needed))));
    const mesh = new InstancedMesh(spec.geometry, spec.material, capacity);
    mesh.name = `actor-batch.${key}`;
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const batch: Batch = { mesh, capacity };
    this.batches.set(key, batch);
    this.group.add(mesh);
    return batch;
  }

  private syncShadows(actors: readonly ActorView[]): void {
    if (!this.contactShadows || actors.length === 0) {
      if (this.shadows) this.shadows.count = 0;
      return;
    }
    if (!this.shadows || this.shadowCapacity < actors.length) {
      this.shadows?.dispose();
      if (this.shadows) this.group.remove(this.shadows);
      this.shadowCapacity = Math.max(16, 1 << Math.ceil(Math.log2(actors.length)));
      this.shadows = new InstancedMesh(
        this.shadowGeometry,
        this.shadowMaterial,
        this.shadowCapacity,
      );
      this.shadows.name = 'actor-contact-shadows';
      this.shadows.userData.uniscenariosRole = LOW_FIDELITY_HIDDEN_ROLE;
      // After the lane overlay (10), so the shadow reads as contact with the
      // road rather than as something seen through 28% cyan.
      this.shadows.renderOrder = 12;
      this.group.add(this.shadows);
    }
    this.shadows.count = actors.length;
    actors.forEach((actor, index) => {
      _position.set(actor.x, actor.y + SHADOW_LIFT, actor.z);
      _quaternion.setFromAxisAngle(_up, actor.headingRad);
      // Wider than the body: a hard-edged blob the size of the footprint reads
      // as a decal, a slightly larger soft one reads as ambient occlusion.
      _scale.set(actor.dims.l * 1.3, 1, actor.dims.w * 1.7);
      this.shadows?.setMatrixAt(index, _matrix.compose(_position, _quaternion, _scale));
    });
    this.shadows.instanceMatrix.needsUpdate = true;
    this.shadows.computeBoundingSphere();
  }

  private syncDoors(actors: readonly ActorView[]): number {
    let draws = 0;
    for (const name of ['left', 'right', 'rear'] as const) {
      const articulated = actors
        .filter((actor) => actor.doors?.[name] !== undefined)
        .sort((a, b) => a.id.localeCompare(b.id));
      const existing = this.doorBatches.get(name);
      if (articulated.length === 0) {
        if (existing) {
          existing.mesh.count = 0;
          existing.mesh.visible = false;
        }
        continue;
      }
      const batch = this.ensureDoorBatch(name, articulated.length);
      const ids = articulated.map((actor) => actor.id);
      batch.mesh.userData.actorIds = ids;
      batch.mesh.userData.articulation = `doors.${name}`;
      batch.mesh.count = articulated.length;
      batch.mesh.visible = true;
      articulated.forEach((actor, index) => {
        batch.mesh.setMatrixAt(index, doorMatrix(actor, name, actor.doors?.[name] ?? 'closed'));
      });
      batch.mesh.instanceMatrix.needsUpdate = true;
      batch.mesh.computeBoundingSphere();
      draws++;
    }
    return draws;
  }

  private ensureDoorBatch(name: DoorName, needed: number): Batch {
    const existing = this.doorBatches.get(name);
    if (existing && existing.capacity >= needed) return existing;
    if (existing) {
      this.group.remove(existing.mesh);
      existing.mesh.dispose();
    }
    const capacity = Math.max(4, 1 << Math.ceil(Math.log2(Math.max(1, needed))));
    const mesh = new InstancedMesh(this.doorGeometry, this.doorMaterial, capacity);
    mesh.name = `actor-doors.${name}`;
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const batch = { mesh, capacity };
    this.doorBatches.set(name, batch);
    this.group.add(mesh);
    return batch;
  }

  private syncReverseLights(actors: readonly ActorView[]): number {
    const reversing = actors.filter((actor) => actor.reversing).sort((a, b) => a.id.localeCompare(b.id));
    if (reversing.length === 0) {
      if (this.reverseLightBatch) {
        this.reverseLightBatch.mesh.count = 0;
        this.reverseLightBatch.mesh.visible = false;
      }
      return 0;
    }
    if (!this.reverseLightBatch || this.reverseLightBatch.capacity < reversing.length) {
      if (this.reverseLightBatch) {
        this.group.remove(this.reverseLightBatch.mesh);
        this.reverseLightBatch.mesh.dispose();
      }
      const capacity = Math.max(4, 1 << Math.ceil(Math.log2(reversing.length)));
      const mesh = new InstancedMesh(
        this.reverseLightGeometry,
        this.reverseLightMaterial,
        capacity,
      );
      mesh.name = 'actor-reverse-lights';
      this.reverseLightBatch = { mesh, capacity };
      this.group.add(mesh);
    }
    const ids = reversing.map((actor) => actor.id);
    this.reverseLightBatch.mesh.userData.actorIds = ids;
    this.reverseLightBatch.mesh.userData.state = 'reversing';
    this.reverseLightBatch.mesh.count = reversing.length;
    this.reverseLightBatch.mesh.visible = true;
    reversing.forEach((actor, index) => {
      this.reverseLightBatch?.mesh.setMatrixAt(index, reverseLightMatrix(actor));
    });
    this.reverseLightBatch.mesh.instanceMatrix.needsUpdate = true;
    this.reverseLightBatch.mesh.computeBoundingSphere();
    return 1;
  }

  private syncHeadlights(actors: readonly ActorView[]): number {
    const active = actors
      .filter((actor) => isVehicleActor(actor) && (actor.headlights ?? this.headlightsEnabled))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (active.length === 0) {
      if (this.headlightBatch) {
        this.headlightBatch.mesh.count = 0;
        this.headlightBatch.mesh.visible = false;
      }
      for (const beam of this.headlightBeams) beam.light.visible = false;
      return 0;
    }

    const lensCount = active.length * 2;
    if (!this.headlightBatch || this.headlightBatch.capacity < lensCount) {
      if (this.headlightBatch) {
        this.group.remove(this.headlightBatch.mesh);
        this.headlightBatch.mesh.dispose();
      }
      const capacity = Math.max(8, 1 << Math.ceil(Math.log2(lensCount)));
      const mesh = new InstancedMesh(this.headlightGeometry, this.headlightMaterial, capacity);
      mesh.name = 'actor-headlights';
      mesh.userData.state = 'lights.lowBeam';
      this.headlightBatch = { mesh, capacity };
      this.group.add(mesh);
    }
    this.headlightBatch.mesh.count = lensCount;
    this.headlightBatch.mesh.visible = true;
    this.headlightBatch.mesh.userData.actorIds = active.flatMap((actor) => [actor.id, actor.id]);
    active.forEach((actor, index) => {
      this.headlightBatch?.mesh.setMatrixAt(index * 2, headlightMatrix(actor, -1));
      this.headlightBatch?.mesh.setMatrixAt(index * 2 + 1, headlightMatrix(actor, 1));
    });
    this.headlightBatch.mesh.instanceMatrix.needsUpdate = true;
    this.headlightBatch.mesh.computeBoundingSphere();

    const projected = active.slice(0, MAX_PROJECTED_HEADLIGHTS);
    while (this.headlightBeams.length < projected.length) {
      const target = new Group();
      const light = new SpotLight(0xffe0ad, 70, 42, 0.38, 0.62, 2);
      light.castShadow = false;
      light.target = target;
      this.group.add(light, target);
      this.headlightBeams.push({ light, target });
    }
    this.headlightBeams.forEach((beam, index) => {
      const actor = projected[index];
      beam.light.visible = actor !== undefined;
      if (!actor) return;
      placeHeadlightBeam(beam.light, beam.target, actor);
    });
    return 1 + projected.length;
  }

  private syncEmergencyLights(actors: readonly ActorView[]): number {
    const active = actors
      .filter((actor) => actor.emergency === 'flashing' || actor.emergency === 'flashing_siren')
      .sort((a, b) => a.id.localeCompare(b.id));
    if (active.length === 0) {
      if (this.emergencyRedBatch) this.emergencyRedBatch.mesh.count = 0;
      if (this.emergencyBlueBatch) this.emergencyBlueBatch.mesh.count = 0;
      return 0;
    }
    const ensure = (existing: Batch | null, material: Material, name: string): Batch => {
      if (existing && existing.capacity >= active.length) return existing;
      if (existing) { this.group.remove(existing.mesh); existing.mesh.dispose(); }
      const capacity = Math.max(4, 1 << Math.ceil(Math.log2(active.length)));
      const mesh = new InstancedMesh(this.emergencyGeometry, material, capacity);
      mesh.name = name;
      this.group.add(mesh);
      return { mesh, capacity };
    };
    this.emergencyRedBatch = ensure(this.emergencyRedBatch, this.emergencyRedMaterial, 'actor-emergency-red');
    this.emergencyBlueBatch = ensure(this.emergencyBlueBatch, this.emergencyBlueMaterial, 'actor-emergency-blue');
    const ids = active.map((actor) => actor.id);
    for (const [side, batch] of [[-1, this.emergencyRedBatch], [1, this.emergencyBlueBatch]] as const) {
      batch.mesh.count = active.length;
      batch.mesh.visible = true;
      batch.mesh.userData.actorIds = ids;
      batch.mesh.userData.state = 'lights.emergency';
      active.forEach((actor, index) => batch.mesh.setMatrixAt(index, emergencyLightMatrix(actor, side)));
      batch.mesh.instanceMatrix.needsUpdate = true;
      batch.mesh.computeBoundingSphere();
    }
    return 2;
  }

  private syncIndicators(actors: readonly ActorView[]): number {
    let draws = 0;
    for (const side of ['left', 'right'] as const) {
      const active = actors.filter((actor) => actor.indicator === side || actor.indicator === 'hazard').sort((a, b) => a.id.localeCompare(b.id));
      const existing = this.indicatorBatches.get(side);
      if (active.length === 0) { if (existing) { existing.mesh.count = 0; existing.mesh.visible = false; } continue; }
      const needed = active.length * 2;
      let batch = existing;
      if (!batch || batch.capacity < needed) {
        if (batch) { this.group.remove(batch.mesh); batch.mesh.dispose(); }
        const capacity = Math.max(8, 1 << Math.ceil(Math.log2(needed)));
        const mesh = new InstancedMesh(this.indicatorGeometry, this.indicatorMaterial, capacity);
        mesh.name = `actor-indicator-${side}`;
        batch = { mesh, capacity }; this.indicatorBatches.set(side, batch); this.group.add(mesh);
      }
      batch.mesh.count = needed; batch.mesh.visible = true;
      batch.mesh.userData.actorIds = active.flatMap((actor) => [actor.id, actor.id]);
      active.forEach((actor, index) => {
        batch!.mesh.setMatrixAt(index * 2, indicatorMatrix(actor, side, true));
        batch!.mesh.setMatrixAt(index * 2 + 1, indicatorMatrix(actor, side, false));
      });
      batch.mesh.instanceMatrix.needsUpdate = true; batch.mesh.computeBoundingSphere(); draws++;
    }
    return draws;
  }
}

/** Convert an authored absolute body color into a multiplier for catalog materials. */
function instanceBodyTint(actor: ActorView): Color {
  if (!actor.bodyColor) return WHITE_INSTANCE_TINT;
  const cacheKey = `${actor.catalogId}:${actor.bodyColor}`;
  const cached = instanceTintCache.get(cacheKey);
  if (cached) return cached;
  const desired = new Color(actor.bodyColor);
  let source = WHITE_INSTANCE_TINT;
  try {
    const value = getEntry(actor.catalogId).defaultParams['color'];
    if (typeof value === 'string') source = new Color(value);
  } catch {
    // An unavailable catalog model keeps an honest neutral multiplier.
  }
  const tint = new Color(
    desired.r / Math.max(source.r, 0.001),
    desired.g / Math.max(source.g, 0.001),
    desired.b / Math.max(source.b, 0.001),
  );
  instanceTintCache.set(cacheKey, tint);
  return tint;
}

function isVehicleActor(actor: ActorView): boolean {
  try {
    return getEntry(actor.catalogId).class === 'vehicle';
  } catch {
    return ['car', 'truck', 'bus'].includes(String(actor.kind ?? ''));
  }
}

export function headlightMatrix(actor: ActorView, side: -1 | 1): Matrix4 {
  const local = new Vector3(
    actor.dims.l * 0.495,
    actor.dims.h * 0.42,
    side * actor.dims.w * 0.33,
  );
  local.applyAxisAngle(_up, actor.headingRad).add(new Vector3(actor.x, actor.y, actor.z));
  return new Matrix4().compose(
    local,
    new Quaternion().setFromAxisAngle(_up, actor.headingRad),
    new Vector3(0.08, 0.12, Math.max(0.12, actor.dims.w * 0.16)),
  );
}

function placeHeadlightBeam(light: SpotLight, target: Object3D, actor: ActorView): void {
  const source = new Vector3(actor.dims.l * 0.5, actor.dims.h * 0.43, 0)
    .applyAxisAngle(_up, actor.headingRad)
    .add(new Vector3(actor.x, actor.y, actor.z));
  const aim = new Vector3(actor.dims.l * 0.5 + 18, 0.15, 0)
    .applyAxisAngle(_up, actor.headingRad)
    .add(new Vector3(actor.x, actor.y, actor.z));
  light.position.copy(source);
  target.position.copy(aim);
  light.updateMatrixWorld();
  target.updateMatrixWorld();
}

function indicatorMatrix(actor: ActorView, side: 'left' | 'right', front: boolean): Matrix4 {
  const local = new Vector3((front ? 1 : -1) * actor.dims.l * 0.49, actor.dims.h * 0.38, (side === 'left' ? -1 : 1) * actor.dims.w * 0.47);
  local.applyAxisAngle(_up, actor.headingRad).add(new Vector3(actor.x, actor.y, actor.z));
  return new Matrix4().compose(local, new Quaternion().setFromAxisAngle(_up, actor.headingRad), new Vector3(0.12, 0.1, 0.16));
}

/**
 * Lay a knocked-down body onto the ground.
 *
 * The engine is planar and keeps the yaw it was struck with, so the fall is
 * purely presentational: pitch the model forward about its own lateral axis,
 * pivoting on the ground-contact origin, which reads as being knocked off its
 * feet in the direction of travel. Gait animation is suppressed by the caller
 * passing no speed once down.
 */
function applyDownPose(actor: ActorView, dims: Dims): void {
  const progress = Math.min(1, Math.max(0, actor.downProgress ?? 0));
  if (progress <= 0) return;
  // Ease out: the body drops fast and settles, rather than rotating linearly.
  const eased = 1 - (1 - progress) * (1 - progress);
  const angle = eased * Math.PI / 2;
  _quaternion.multiply(new Quaternion().setFromAxisAngle(_lateral, angle));
  // The origin is at the feet; rotating there would leave the body hanging off
  // them. Lift toward half a body's width so it rests flat on the surface.
  _position.y += Math.sin(angle) * Math.min(dims.h, dims.w) * 0.5;
}

export function poseMatrix(actor: ActorView, templateDims = getEntry(actor.catalogId).dims): Matrix4 {
  const animation = getEntry(actor.catalogId).animation;
  const time = actor.animationTimeS ?? 0;
  const moving = Math.abs(actor.speedMps ?? 0) > .05;
  const hover = animation?.hoverHeightM ?? 0;
  const bob = animation?.rig === 'rotorcraft'
    ? Math.sin(time * 3.2) * .035
    : moving && (animation?.rig === 'quadruped' || animation?.rig === 'humanoid' || animation?.rig === 'avian')
      ? Math.abs(Math.sin(time * 7)) * .025
      : 0;
  _position.set(actor.x, actor.y + hover + bob, actor.z);
  _quaternion.setFromAxisAngle(_up, actor.headingRad);
  applyDownPose(actor, actor.dims);
  _scale.set(
    actor.dims.l / templateDims.l,
    actor.dims.h / templateDims.h,
    actor.dims.w / templateDims.w,
  );
  return _matrix.compose(_position, _quaternion, _scale).clone();
}

function renderIdentityKey(identity: ActorRenderIdentity): string {
  return identity.source === 'catalog'
    ? `catalog:${identity.catalogId}`
    : `semantic:${identity.kind}`;
}

/** Discrete trace states map to reproducible articulation poses. */
export function doorOpenness(state: DoorState): number {
  if (state === 'open') return 1;
  if (state === 'opening' || state === 'closing') return 0.5;
  return 0;
}

/**
 * World transform for a unit door panel. The panel-local hinge edge remains at
 * one fixed world point for every state, avoiding the common centre-rotation
 * slide between closed and open poses.
 */
export function doorMatrix(actor: ActorView, name: DoorName, state: DoorState): Matrix4 {
  const openness = doorOpenness(state);
  const world = new Matrix4().compose(
    new Vector3(actor.x, actor.y, actor.z),
    new Quaternion().setFromAxisAngle(_up, actor.headingRad),
    new Vector3(1, 1, 1),
  );
  const local = new Matrix4();
  if (name === 'rear') {
    const thickness = Math.max(0.025, actor.dims.l * 0.008);
    const height = actor.dims.h * 0.64;
    const width = actor.dims.w * 0.82;
    const hinge = new Vector3(-actor.dims.l / 2 - thickness / 2, actor.dims.h * 0.78, 0);
    const rotation = new Quaternion().setFromAxisAngle(
      new Vector3(0, 0, 1),
      -openness * Math.PI * 0.42,
    );
    const center = new Vector3(0, -height / 2, 0).applyQuaternion(rotation).add(hinge);
    local.compose(center, rotation, new Vector3(thickness, height, width));
  } else {
    const side = name === 'left' ? -1 : 1;
    const thickness = Math.max(0.025, actor.dims.w * 0.018);
    const length = actor.dims.l * 0.34;
    const height = actor.dims.h * 0.62;
    const hinge = new Vector3(
      actor.dims.l * 0.16,
      actor.dims.h * 0.49,
      side * (actor.dims.w / 2 + thickness / 2),
    );
    const rotation = new Quaternion().setFromAxisAngle(
      _up,
      side * openness * Math.PI * 0.39,
    );
    const center = new Vector3(-length / 2, 0, 0).applyQuaternion(rotation).add(hinge);
    local.compose(center, rotation, new Vector3(length, height, thickness));
  }
  return world.multiply(local);
}

/** A luminous rear panel makes rear-first motion explicit without rotating the actor body. */
export function reverseLightMatrix(actor: ActorView): Matrix4 {
  const world = new Matrix4().compose(
    new Vector3(actor.x, actor.y, actor.z),
    new Quaternion().setFromAxisAngle(_up, actor.headingRad),
    new Vector3(1, 1, 1),
  );
  const thickness = Math.max(0.035, actor.dims.l * 0.01);
  return world.multiply(new Matrix4().compose(
    new Vector3(-actor.dims.l / 2 - thickness / 2, actor.dims.h * 0.42, 0),
    new Quaternion(),
    new Vector3(thickness, Math.max(0.08, actor.dims.h * 0.09), actor.dims.w * 0.52),
  ));
}

export function emergencyLightMatrix(actor: ActorView, side: -1 | 1): Matrix4 {
  const world = new Matrix4().compose(
    new Vector3(actor.x, actor.y, actor.z),
    new Quaternion().setFromAxisAngle(_up, actor.headingRad),
    new Vector3(1, 1, 1),
  );
  return world.multiply(new Matrix4().compose(
    new Vector3(0, actor.dims.h + 0.035, side * actor.dims.w * 0.18),
    new Quaternion(),
    new Vector3(actor.dims.l * 0.13, 0.07, actor.dims.w * 0.28),
  ));
}

/** The 12 edges of an actor's oriented bounding box, as line-segment pairs. */
function pushBoxEdges(out: number[], actor: ActorView): void {
  const c = Math.cos(actor.headingRad);
  const s = Math.sin(actor.headingRad);
  const hl = actor.dims.l / 2;
  const hw = actor.dims.w / 2;
  const h = actor.dims.h;
  // Local (forward, lateral) -> scene: forward is (cos, -sin), left is (-sin, -cos).
  const corner = (f: number, l: number): [number, number] => [
    actor.x + c * f - s * l,
    actor.z - s * f - c * l,
  ];
  const [x0, z0] = corner(hl, hw);
  const [x1, z1] = corner(hl, -hw);
  const [x2, z2] = corner(-hl, -hw);
  const [x3, z3] = corner(-hl, hw);
  const yLo = actor.y + 0.02;
  const yHi = actor.y + h;
  const ring = [
    [x0, z0],
    [x1, z1],
    [x2, z2],
    [x3, z3],
  ] as const;
  for (let i = 0; i < 4; i++) {
    const a = ring[i] as readonly [number, number];
    const b = ring[(i + 1) % 4] as readonly [number, number];
    // bottom, top, and the vertical at this corner
    out.push(a[0], yLo, a[1], b[0], yLo, b[1]);
    out.push(a[0], yHi, a[1], b[0], yHi, b[1]);
    out.push(a[0], yLo, a[1], a[0], yHi, a[1]);
  }
}

