/**
 * The map's 3D mode: a MapLibre `CustomLayerInterface` running a three.js scene
 * inside the MAP'S OWN GL context and camera.
 *
 * Everything that needs a GL context lives here and nothing that does not. All
 * the mapping decisions — the frame bridge, the car proportions, the head
 * geometry, which lamp is lit — live in `app/lib/scenario-editor/map-3d/`, which
 * is where the tests are, because they can run without a canvas.
 *
 * ## Why one canvas and not two
 *
 * Sharing MapLibre's context and camera means nothing can drift: no sync lag
 * under inertial pan, no separate projection to keep honest, and depth
 * interleaving with map layers for free. The alternative — a second canvas
 * overlaid on the map with its camera copied from `map.transform` — is cheaper
 * to build and much worse to live with, because any lag makes the models swim
 * relative to the road.
 *
 * ## Rendering, and why there are no React renders in the loop
 *
 * The host component writes instances into this object and calls
 * `map.triggerRepaint()`. `render()` reconciles meshes against the previous
 * frame — same key, same meshes, new transform — and draws. Nothing here
 * unmounts anything per frame, which is the specific pathology the 2D marker
 * path has (its React key includes position, so every marker's DOM subtree is
 * torn down and rebuilt 20 times a second during playback).
 *
 * Signal heads take the same treatment for the same reason: the docked
 * viewport clears and rebuilds its whole signal group on every playhead change,
 * which is fine for 120 spheres and not fine for 120 multi-mesh heads. Here only
 * the lit lamp's material changes, and usually nothing changes at all.
 */

import * as THREE from "three";
import type { CustomLayerInterface, Map as MapLibreMap } from "maplibre-gl";
import {
  composeSceneCameraMatrix,
  type SceneAnchor,
  type ScenePoint3,
} from "@/app/lib/scenario-editor/map-3d/coordinates";
import type {
  Map3DActorModel,
  Map3DPart,
  Map3DPartMaterial,
} from "@/app/lib/scenario-editor/map-3d/car-model";
import type { SignalHeadScreenBox } from "@/app/lib/scenario-editor/map-3d/signal-picking";
import {
  buildSignalHeadParts,
  MAP_3D_SIGNAL_COLORS,
  signalHeadSignature,
  signalLampEmissiveIntensity,
  signalPartMaterialKey,
  type Map3DSignalHeadGeometrySpec,
  type Map3DSignalLampState,
  type Map3DSignalPart,
} from "@/app/lib/scenario-editor/map-3d/signal-head-model";

/** One actor, ready to draw. Positions are scene metres relative to the anchor. */
export interface Map3DActorInstance {
  key: string;
  position: ScenePoint3;
  /** Radians about scene +Y, for a +X-forward model. */
  rotationY: number;
  model: Map3DActorModel;
  /** `0xrrggbb` for the body panels. */
  colorHex: number;
  selected: boolean;
  hovered: boolean;
  /** Ghosted actors (placement previews, path-edit dimming) draw translucent. */
  dimmed: boolean;
  /** Ground disc radius in metres — see `locator-scale.ts`. */
  discRadiusM: number;
  /** True when the disc has hit its pixel floor and is acting as a locator. */
  discIsLocator: boolean;
  /**
   * The floating tag above this actor: its name, plus its speed while a
   * playback is driving it. `null` draws no tag at all.
   */
  tagText: string | null;
}

/**
 * One physical signal head, ready to draw.
 *
 * Extends the model's geometry spec rather than restating it, so a new
 * dimension of the head (an arrow lens, a mast arm reach) cannot be added to
 * `signal-head-model.ts` and silently not reach the renderer.
 */
export interface Map3DSignalHeadInstance extends Map3DSignalHeadGeometrySpec {
  key: string;
  /**
   * Scene metres at the base of the ASSEMBLY's pole, on the road surface — the
   * shared origin every co-mounted head is drawn at, not this head's own pose.
   */
  position: ScenePoint3;
  rotationY: number;
  litLampIndex: number;
  state: Map3DSignalLampState;
  authored: boolean;
  /** Armed-placement preview: same geometry, same pose, translucent. */
  ghost: boolean;
  /** The hovered junction's heads go opaque and fully lit. */
  hovered: boolean;
  /**
   * The head whose detail card is open: its fixture glows yellow.
   *
   * The lamps are not part of it — they carry the signal's own colour, and a
   * red light tinted yellow to say "selected" is a lie about the scenario.
   */
  selected?: boolean;
  /** OpenDRIVE `<signal>` id, so a pick can name the head it hit. */
  signalId?: string | null;
}

/** Where a pick landed: the head, and how far off the pointer was. */
export interface Map3DSignalPick {
  key: string;
  signalId: string | null;
  distancePx: number;
}

export interface Map3DLayerHandle extends CustomLayerInterface {
  setAnchor(anchor: SceneAnchor | null): void;
  setActors(actors: readonly Map3DActorInstance[]): void;
  setSignalHeads(heads: readonly Map3DSignalHeadInstance[]): void;
  setVisible(visible: boolean): void;
  /**
   * The signal head whose LAMPS are nearest `point`, in CSS pixels.
   *
   * The lamps, not the pole and not a ground disc: the housing hangs 5.75 m up
   * on a mast arm, so under any pitch the lights an author sees are a long way
   * from the point on the ground beneath them. Picking against the ground was
   * the difference between "click the light" and "click the base of the pole".
   */
  pickSignalHeadAt(
    point: { x: number; y: number },
    viewport: { width: number; height: number },
    radiusPx?: number,
  ): Map3DSignalPick | null;
  /**
   * The screen box a head is drawn in, in CSS pixels — the whole assembly this
   * head owns, pole included.
   *
   * The detail card uses it to sit clear of the fixture instead of on top of
   * it. It is the head's own group and not just its lamps, so a card placed
   * above the box covers no part of the thing it describes.
   */
  projectSignalHeadBox(
    signalId: string,
    viewport: { width: number; height: number },
  ): SignalHeadScreenBox | null;
}

const SELECTION_COLOR = 0xe8e044;
const HOVER_COLOR = 0xfff8a8;

/**
 * Fixed material colours. Only `body` is tinted per actor — a bright red car
 * still gets black tyres and dark glass, which is most of what makes a shaped
 * model read as a vehicle instead of as a coloured blob.
 */
const MATERIAL_COLORS: Record<Map3DPartMaterial, number> = {
  // `body` and `bodyDark` are per-actor (they carry the authored colour and the
  // selection emissive), so these two are only the type's floor.
  body: 0xc8ccd4,
  bodyDark: 0x2a2e36,
  glass: 0x121820,
  tyre: 0x111318,
  trim: 0x8a9099,
  lampFront: 0xfff3d0,
  lampRear: 0xd2452f,
};

const SIGNAL_ROLE_COLORS = {
  pole: 0x3c424c,
  arm: 0x3c424c,
  drop: 0x2f343c,
  housing: 0x23272e,
  backplate: 0x14171c,
  // The recess an arrow glyph sits in. Darker than the housing so the lit glyph
  // has something to read against.
  lens: 0x0b0d11,
} as const;

/**
 * The selected head's fixture: its own dark grey lifted toward the selection
 * yellow, plus an emissive so it reads as lit from within against a night-dark
 * housing. Strong enough to find at a glance from across an intersection, which
 * is the whole point — a click that produces a card but no visible change on
 * the map leaves the author guessing which light they hit.
 */
const SELECTED_FIXTURE_TINT = 0.45;
const SELECTED_FIXTURE_EMISSIVE = 0.5;

/** Lit lamps glow; the other lenses are the same colour, nearly black. */
const LAMP_DARK_MIX = 0.14;
/** A ghost head reads as "not there yet" without disappearing. */
const GHOST_OPACITY = 0.35;
const GHOST_LAMP_OPACITY = 0.45;

interface ActorEntry {
  group: THREE.Group;
  /** Materials this actor owns outright, so selection emissive is per-actor. */
  bodyMaterials: THREE.MeshLambertMaterial[];
  disc: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  modelSignature: string;
  colorHex: number;
  /** The floating name/speed tag, or null when this actor draws none. */
  tag: THREE.Mesh | null;
  /** What the tag currently reads, so a moving actor is not re-rastered. */
  tagText: string | null;
}

/** Metres of tag width per character — the sprite is scaled from this. */
const TAG_METRES_PER_CHAR = 0.4;
const TAG_HEIGHT_M = 1;
/** Canvas pixels per metre of tag. Higher = crisper text, bigger texture. */
const TAG_PIXELS_PER_METRE = 64;
/** Clearance between the top of the body and the bottom of the tag. */
const TAG_CLEARANCE_M = 0.6;

/**
 * The floating tag: white text, a soft dark stroke, and nothing else.
 *
 * Deliberately not a panel. A filled chip per actor tiles the sky in a dense
 * scene and hides the very cars it annotates; the stroke does the same job of
 * separating glyphs from a bright road or a grey building without adding a
 * second rectangle to look at.
 *
 * A `Sprite`, so the tag always faces the camera — 3D mode is an orbit view,
 * and world-space text would show half the tags edge-on and unreadable.
 * Size attenuation stays ON so a tag shrinks with distance like the car it
 * belongs to, rather than swamping the scene as the camera pulls back.
 */
function buildActorTag(text: string): THREE.Mesh | null {
  const canvas = document.createElement("canvas");
  const widthM = Math.max(2, text.length * TAG_METRES_PER_CHAR);
  canvas.width = Math.round(widthM * TAG_PIXELS_PER_METRE);
  canvas.height = Math.round(TAG_HEIGHT_M * TAG_PIXELS_PER_METRE);
  const ctx = canvas.getContext("2d");
  // jsdom (and any context-less canvas) simply gets no tag rather than
  // taking the whole actor down with it.
  if (!ctx) return null;

  ctx.font = `600 ${Math.round(canvas.height * 0.6)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(2, canvas.height * 0.14);
  ctx.strokeStyle = "rgba(6, 10, 20, 0.85)";
  ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  // A textured plane, NOT a `THREE.Sprite`.
  //
  // Sprite billboarding happens in the vertex shader off `modelViewMatrix`,
  // and this layer has no view matrix to speak of: MapLibre hands us one
  // combined transform which goes straight onto `camera.projectionMatrix`,
  // leaving the camera's world rotation identity. A sprite therefore has
  // nothing to orient against and ends up pinned to the world axes — readable
  // from one bearing and edge-on from every other. `faceCamera` below turns
  // these to the viewer explicitly, once per frame.
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(canvas),
      transparent: true,
      // Over the body it names, rather than z-fighting the roof it sits on.
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  mesh.name = "actor-tag";
  mesh.scale.set(widthM, TAG_HEIGHT_M, 1);
  mesh.renderOrder = 10;
  return mesh;
}

/** Scene up. Heights are on +Y here, same axis `rotationY` turns about. */
const TAG_UP = new THREE.Vector3(0, 1, 0);
const tagNear = new THREE.Vector3();
const tagFar = new THREE.Vector3();
const tagInverse = new THREE.Matrix4();
const tagLook = new THREE.Matrix4();
const tagFacing = new THREE.Quaternion();
const tagParentUndo = new THREE.Quaternion();

/**
 * Turn every tag to face the viewer.
 *
 * The camera's world position is not available — MapLibre gives one combined
 * matrix — so the view DIRECTION is recovered by unprojecting the near and far
 * centres of clip space through its inverse. That is convention-free: it needs
 * no assumption about how bearing or pitch map onto the scene's axes, so it
 * cannot drift if that mapping ever changes.
 *
 * Every tag shares one facing, so the look matrix is built once a frame. Each
 * tag then undoes its parent's yaw, because it hangs off the actor group that
 * carries the car's heading and must not turn with the car.
 */
function faceCamera(
  entries: Iterable<ActorEntry>,
  projection: THREE.Matrix4,
): void {
  tagInverse.copy(projection).invert();
  tagNear.set(0, 0, -1).applyMatrix4(tagInverse);
  tagFar.set(0, 0, 1).applyMatrix4(tagInverse);
  // Toward the camera, which is the way a tag's face has to point.
  const toCamera = tagNear.sub(tagFar).normalize();
  if (!Number.isFinite(toCamera.x) || toCamera.lengthSq() === 0) return;

  tagLook.lookAt(toCamera, new THREE.Vector3(0, 0, 0), TAG_UP);
  tagFacing.setFromRotationMatrix(tagLook);

  for (const entry of entries) {
    if (!entry.tag) continue;
    tagParentUndo.setFromAxisAngle(TAG_UP, -entry.group.rotation.y);
    entry.tag.quaternion.copy(tagParentUndo).multiply(tagFacing);
  }
}

function disposeActorTag(tag: THREE.Mesh): void {
  tag.geometry.dispose();
  const material = tag.material as THREE.MeshBasicMaterial;
  material.map?.dispose();
  material.dispose();
  tag.removeFromParent();
}

/**
 * Put the tag above the body, or take it away.
 *
 * Re-rasters only when the TEXT changes. The speed digit changes a few times a
 * second during playback, which is fine; the position changes 20 times a second
 * and must never cost a canvas.
 */
function syncActorTag(entry: ActorEntry, instance: Map3DActorInstance): void {
  if (entry.tagText === instance.tagText) return;
  if (entry.tag) {
    disposeActorTag(entry.tag);
    entry.tag = null;
  }
  entry.tagText = instance.tagText;
  if (!instance.tagText) return;
  const tag = buildActorTag(instance.tagText);
  if (!tag) return;
  // Sized off the model's own extents so a tag clears a truck as well as it
  // clears a pedestrian. The group carries the actor's yaw, but the offset is
  // pure +Y — the rotation axis — so the tag is unaffected by it.
  tag.position.set(0, instance.model.extents.heightM + TAG_CLEARANCE_M, 0);
  entry.group.add(tag);
  entry.tag = tag;
}

interface SignalEntry {
  group: THREE.Group;
  /**
   * One entry per lamp MESH, not per lamp. An arrow lens is four meshes (a
   * recess plus a three-box glyph) sharing one `lampIndex`, so the mesh's index
   * in this array is not its lamp's index and the two must be carried together.
   */
  lampMaterials: Array<{
    material: THREE.MeshLambertMaterial;
    lampIndex: number;
  }>;
  /** The lamp meshes themselves — the pick target. */
  lampMeshes: THREE.Mesh[];
  signalId: string | null;
  /** Lenses this head has, top to bottom — what drives the unlit lens colours. */
  lampCount: number;
  signature: string;
  litLampIndex: number;
  state: Map3DSignalLampState;
  authored: boolean;
  hovered: boolean;
}

function modelSignature(model: Map3DActorModel): string {
  const { lengthM, widthM, heightM } = model.extents;
  return `${model.category}:${lengthM.toFixed(2)}:${widthM.toFixed(2)}:${heightM.toFixed(2)}`;
}

function mixToward(color: number, target: number, amount: number): number {
  const source = new THREE.Color(color);
  return source.lerp(new THREE.Color(target), amount).getHex();
}

export function createMap3DLayer(id: string): Map3DLayerHandle {
  const scene = new THREE.Scene();
  // The base `Camera`, not a `PerspectiveCamera`: the whole transform arrives
  // from MapLibre and is written straight onto `projectionMatrix`, so a camera
  // that recomputes its own projection would fight us for it.
  const camera = new THREE.Camera();

  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  const cylinderGeometry = new THREE.CylinderGeometry(1, 1, 1, 16);
  const discGeometry = new THREE.CircleGeometry(1, 28);

  const actorGroup = new THREE.Group();
  const signalGroup = new THREE.Group();
  scene.add(actorGroup, signalGroup);

  // Lighting is computed in the SCENE frame, which is a genuine right-handed
  // (east, up, south) frame, so a light "above and to the north-west" is
  // literally that. The reflection that reconciles mercator's south-positive Y
  // lives in the projection matrix and never touches normals.
  const hemisphere = new THREE.HemisphereLight(0xdfe7f5, 0x1b1f26, 2.0);
  const sun = new THREE.DirectionalLight(0xffffff, 1.35);
  sun.position.set(-60, 140, -70);
  scene.add(hemisphere, sun);

  const sharedMaterials = new Map<string, THREE.MeshLambertMaterial>();
  const shadowMaterial = new THREE.MeshBasicMaterial({
    color: 0x05070a,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
  });
  const locatorMaterial = new THREE.MeshBasicMaterial({
    color: SELECTION_COLOR,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  });

  const actorEntries = new Map<string, ActorEntry>();
  const signalEntries = new Map<string, SignalEntry>();

  let renderer: THREE.WebGLRenderer | null = null;
  let anchor: SceneAnchor | null = null;
  let visible = true;
  let disposed = false;
  /**
   * True once a frame has been drawn, so `camera.projectionMatrix` holds
   * MapLibre's transform rather than the identity it is constructed with.
   * Projecting through the identity would answer a plausible pixel from a
   * matrix that never drew anything.
   */
  let projectionReady = false;

  function sharedMaterial(
    key: string,
    color: number,
    translucent = false,
    emissive?: { color: number; intensity: number },
  ): THREE.MeshLambertMaterial {
    const existing = sharedMaterials.get(key);
    if (existing) return existing;
    const material = new THREE.MeshLambertMaterial({
      color,
      // The selection glow. A shared set rather than per-head materials, which
      // is only safe because the emissive is a property of the KEY: two heads
      // that share a key are in the same selection state by construction.
      ...(emissive
        ? { emissive: emissive.color, emissiveIntensity: emissive.intensity }
        : {}),
      // Ghost roles get their own shared set — three extra materials for the
      // whole scene, not three per head — because a material every head shares
      // cannot be made translucent for one of them.
      ...(translucent
        ? { transparent: true, opacity: GHOST_OPACITY, depthWrite: false }
        : {}),
      // The camera matrix carries a reflection (mercator's Y grows south), so
      // whether a triangle rasterises as front- or back-facing is not something
      // to bet a hollow-looking car on. `DoubleSide` is correct either way: for
      // a closed convex mesh with correct winding it renders identically to
      // `FrontSide`, and if the winding is inverted three flips the normal for
      // the visible fragments and the lighting comes out right anyway.
      side: THREE.DoubleSide,
    });
    sharedMaterials.set(key, material);
    return material;
  }

  function meshForPart(
    part: Pick<Map3DPart, "shape" | "position" | "size" | "radius" | "length" | "axis"> & {
      rotationX?: number;
      rotationY?: number;
    },
    material: THREE.Material,
  ): THREE.Mesh {
    if (part.shape === "cylinder") {
      const mesh = new THREE.Mesh(cylinderGeometry, material);
      const radius = part.radius ?? 0.5;
      const length = part.length ?? 1;
      mesh.scale.set(radius, length, radius);
      // Three's cylinders run along +Y; rotate onto the requested local axis.
      if (part.axis === "z") mesh.rotation.x = Math.PI / 2;
      else if (part.axis === "x") mesh.rotation.z = Math.PI / 2;
      mesh.position.set(part.position.x, part.position.y, part.position.z);
      return mesh;
    }
    const mesh = new THREE.Mesh(boxGeometry, material);
    mesh.scale.set(part.size.x, part.size.y, part.size.z);
    // Signal parts can ask to be swung in the ground plane (the mast arm) or
    // spun in the lens plane (an arrow glyph). Applied before the position,
    // which is already given in the head's own frame.
    if (part.rotationX) mesh.rotation.x = part.rotationX;
    if (part.rotationY) mesh.rotation.y = part.rotationY;
    mesh.position.set(part.position.x, part.position.y, part.position.z);
    return mesh;
  }

  function buildActorEntry(instance: Map3DActorInstance): ActorEntry {
    const group = new THREE.Group();
    const bodyMaterials: THREE.MeshLambertMaterial[] = [];

    for (const part of instance.model.parts) {
      let material: THREE.MeshLambertMaterial;
      if (part.material === "body") {
        // Owned per actor: the selection rim is an emissive on the body, and a
        // shared material would light up every car of the same colour.
        material = new THREE.MeshLambertMaterial({
          color: instance.colorHex,
          side: THREE.DoubleSide,
        });
        bodyMaterials.push(material);
      } else if (part.material === "bodyDark") {
        material = new THREE.MeshLambertMaterial({
          color: mixToward(instance.colorHex, MATERIAL_COLORS.bodyDark, 0.72),
          side: THREE.DoubleSide,
        });
        bodyMaterials.push(material);
      } else {
        material = sharedMaterial(
          `part:${part.material}`,
          MATERIAL_COLORS[part.material],
        );
      }
      group.add(meshForPart(part, material));
    }

    const disc = new THREE.Mesh(discGeometry, shadowMaterial);
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.03;
    disc.renderOrder = -1;
    group.add(disc);
    actorGroup.add(group);

    return {
      group,
      bodyMaterials,
      disc,
      modelSignature: modelSignature(instance.model),
      colorHex: instance.colorHex,
      // The tag is attached by `syncActorTag` on the same pass that positions
      // the actor, so a rebuilt entry re-raises it without a special case.
      tag: null,
      tagText: null,
    };
  }

  function disposeActorEntry(entry: ActorEntry): void {
    actorGroup.remove(entry.group);
    // The tag owns a canvas texture, which the material does not free for us.
    if (entry.tag) disposeActorTag(entry.tag);
    for (const material of entry.bodyMaterials) material.dispose();
  }

  function buildSignalEntry(instance: Map3DSignalHeadInstance): SignalEntry {
    const group = new THREE.Group();
    const lampMaterials: SignalEntry["lampMaterials"] = [];
    const lampMeshes: THREE.Mesh[] = [];
    const parts: Map3DSignalPart[] = buildSignalHeadParts(instance);

    for (const part of parts) {
      if (part.role === "lamp") {
        // Lamp materials are owned per head: this is the only thing that changes
        // between playhead frames, and it must not be shared with another head.
        const material = new THREE.MeshLambertMaterial({
          color: 0x000000,
          side: THREE.DoubleSide,
        });
        lampMaterials.push({ material, lampIndex: part.lampIndex ?? 0 });
        const lampMesh = meshForPart(part, material);
        lampMeshes.push(lampMesh);
        group.add(lampMesh);
        continue;
      }
      group.add(
        meshForPart(
          part,
          sharedMaterial(
            signalPartMaterialKey(part.role, instance.ghost, instance.selected),
            instance.selected
              ? mixToward(
                  SIGNAL_ROLE_COLORS[part.role],
                  SELECTION_COLOR,
                  SELECTED_FIXTURE_TINT,
                )
              : SIGNAL_ROLE_COLORS[part.role],
            // A selected ghost is opaque: it is the head the author is about to
            // create, and the card describing it is already open.
            instance.ghost && !instance.selected,
            instance.selected
              ? {
                  color: SELECTION_COLOR,
                  intensity: SELECTED_FIXTURE_EMISSIVE,
                }
              : undefined,
          ),
        ),
      );
    }

    signalGroup.add(group);
    return {
      group,
      lampMaterials,
      lampMeshes,
      signalId: instance.signalId ?? null,
      lampCount: instance.lampCount,
      signature: signalHeadSignature(instance),
      litLampIndex: -1,
      state: instance.state,
      authored: instance.authored,
      hovered: instance.hovered,
    };
  }

  function applyLampState(entry: SignalEntry, instance: Map3DSignalHeadInstance): void {
    const lit = MAP_3D_SIGNAL_COLORS[instance.state] ?? 0x000000;
    const translucent = instance.ghost && !instance.hovered;
    const emissiveIntensity = signalLampEmissiveIntensity(instance);
    for (const { material, lampIndex } of entry.lampMaterials) {
      const isLit = lampIndex === instance.litLampIndex;
      // Unlit lenses keep a trace of their own colour so a head still reads as
      // red-over-yellow-over-green when nothing is on.
      const lensColor = MAP_3D_SIGNAL_COLORS[lampStateForIndex(lampIndex, entry.lampCount)] ?? 0x000000;
      material.color.setHex(isLit ? lit : mixToward(lensColor, 0x000000, 1 - LAMP_DARK_MIX));
      material.emissive.setHex(isLit ? lit : 0x000000);
      material.emissiveIntensity = isLit ? emissiveIntensity : 0;
      // Lamp materials are per head, so hover can lift one junction's ghosts to
      // full opacity without touching anything else in the scene.
      material.transparent = translucent;
      material.opacity = translucent ? GHOST_LAMP_OPACITY : 1;
    }
    entry.litLampIndex = instance.litLampIndex;
    entry.state = instance.state;
    entry.authored = instance.authored;
    entry.hovered = instance.hovered;
  }

  function lampStateForIndex(index: number, lampCount: number): Map3DSignalLampState {
    if (lampCount <= 1) return "green";
    if (lampCount === 2) return index === 0 ? "red" : "green";
    if (index === 0) return "red";
    if (index === 1) return "yellow";
    return "green";
  }

  const handle: Map3DLayerHandle = {
    id,
    type: "custom",
    renderingMode: "3d",

    onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
      renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas(),
        context: gl as WebGLRenderingContext,
      });
      // MapLibre owns the framebuffer; clearing it would erase the basemap.
      renderer.autoClear = false;
    },

    onRemove() {
      // The GL context belongs to MapLibre, so the renderer is released without
      // `forceContextLoss()` — losing the context here would take the map down
      // with it. Geometries and materials are ours and do need disposing.
      for (const entry of actorEntries.values()) disposeActorEntry(entry);
      actorEntries.clear();
      for (const entry of signalEntries.values()) {
        signalGroup.remove(entry.group);
        for (const lamp of entry.lampMaterials) lamp.material.dispose();
      }
      signalEntries.clear();
      for (const material of sharedMaterials.values()) material.dispose();
      sharedMaterials.clear();
      shadowMaterial.dispose();
      locatorMaterial.dispose();
      boxGeometry.dispose();
      cylinderGeometry.dispose();
      discGeometry.dispose();
      renderer = null;
      disposed = true;
    },

    render(_gl, matrix) {
      if (disposed || !renderer || !anchor || !visible || !matrix) return;

      camera.projectionMatrix.fromArray(
        composeSceneCameraMatrix(matrix as unknown as ArrayLike<number>, anchor),
      );
      projectionReady = true;
      faceCamera(actorEntries.values(), camera.projectionMatrix);
      // three and MapLibre both own GL state and neither tolerates the other's
      // leftovers. This is not optional.
      renderer.resetState();
      renderer.render(scene, camera);
    },

    setAnchor(next) {
      anchor = next;
    },

    setVisible(next) {
      visible = next;
      scene.visible = next;
    },

    pickSignalHeadAt(point, viewport, radiusPx = 24) {
      if (disposed || !anchor || !visible) return null;
      if (!(viewport.width > 0) || !(viewport.height > 0)) return null;

      // Forward projection, not a raycast. `camera.projectionMatrix` already
      // carries the scene-to-clip transform this frame was rendered with (see
      // `composeSceneCameraMatrix`), so pushing a lamp's world position through
      // it lands on exactly the pixel that lamp was drawn at. A raycast would
      // need a camera with a real world matrix, which this deliberately has not
      // got — the whole transform arrives from MapLibre.
      scene.updateMatrixWorld(true);
      const m = camera.projectionMatrix.elements;
      const world = new THREE.Vector3();
      let best: Map3DSignalPick | null = null;

      for (const [key, entry] of signalEntries) {
        if (entry.lampMeshes.length === 0) continue;
        // The centroid of the lenses: the middle of the light cluster, which is
        // where an author aims when they mean "that light".
        let sumX = 0;
        let sumY = 0;
        let sumZ = 0;
        for (const mesh of entry.lampMeshes) {
          mesh.getWorldPosition(world);
          sumX += world.x;
          sumY += world.y;
          sumZ += world.z;
        }
        const count = entry.lampMeshes.length;
        const x = sumX / count;
        const y = sumY / count;
        const z = sumZ / count;

        // Manual divide rather than `applyMatrix4`, which drops the sign of w
        // and would place a head BEHIND the camera at a plausible pixel.
        const w = m[3] * x + m[7] * y + m[11] * z + m[15];
        if (!(w > 0)) continue;
        const ndcX = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
        const ndcY = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
        const pixelX = (ndcX * 0.5 + 0.5) * viewport.width;
        const pixelY = (1 - (ndcY * 0.5 + 0.5)) * viewport.height;
        const distancePx = Math.hypot(pixelX - point.x, pixelY - point.y);
        if (distancePx > radiusPx) continue;
        if (!best || distancePx < best.distancePx) {
          best = { key, signalId: entry.signalId, distancePx };
        }
      }
      return best;
    },

    projectSignalHeadBox(signalId, viewport) {
      if (disposed || !anchor || !visible || !projectionReady) return null;
      if (!(viewport.width > 0) || !(viewport.height > 0)) return null;
      const wanted = String(signalId ?? "").trim();
      if (!wanted) return null;

      let group: THREE.Group | null = null;
      for (const entry of signalEntries.values()) {
        if (entry.signalId != null && String(entry.signalId).trim() === wanted) {
          group = entry.group;
          break;
        }
      }
      if (!group) return null;

      scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(group);
      if (box.isEmpty()) return null;

      // The same forward projection the picker uses, over the eight corners of
      // the head's world box. A box in world space is not a box on screen under
      // perspective, so it is the corners' extent that is taken and not two
      // projected corners.
      const m = camera.projectionMatrix.elements;
      let top = Number.POSITIVE_INFINITY;
      let bottom = Number.NEGATIVE_INFINITY;
      let left = Number.POSITIVE_INFINITY;
      let right = Number.NEGATIVE_INFINITY;
      let projected = false;
      for (const x of [box.min.x, box.max.x]) {
        for (const y of [box.min.y, box.max.y]) {
          for (const z of [box.min.z, box.max.z]) {
            const w = m[3] * x + m[7] * y + m[11] * z + m[15];
            // Behind the camera: same guard, same reason, as the picker's.
            if (!(w > 0)) continue;
            const ndcX = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
            const ndcY = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
            const pixelX = (ndcX * 0.5 + 0.5) * viewport.width;
            const pixelY = (1 - (ndcY * 0.5 + 0.5)) * viewport.height;
            if (!Number.isFinite(pixelX) || !Number.isFinite(pixelY)) continue;
            projected = true;
            top = Math.min(top, pixelY);
            bottom = Math.max(bottom, pixelY);
            left = Math.min(left, pixelX);
            right = Math.max(right, pixelX);
          }
        }
      }
      return projected ? { top, bottom, left, right } : null;
    },

    setActors(actors) {
      const seen = new Set<string>();
      for (const instance of actors) {
        seen.add(instance.key);
        let entry = actorEntries.get(instance.key);
        const signature = modelSignature(instance.model);
        if (entry && (entry.modelSignature !== signature || entry.colorHex !== instance.colorHex)) {
          // A blueprint or colour change is rare and worth a rebuild; a position
          // change never is.
          disposeActorEntry(entry);
          actorEntries.delete(instance.key);
          entry = undefined;
        }
        if (!entry) {
          entry = buildActorEntry(instance);
          actorEntries.set(instance.key, entry);
        }

        entry.group.position.set(
          instance.position.x,
          instance.position.y,
          instance.position.z,
        );
        entry.group.rotation.y = instance.rotationY;

        const highlight = instance.selected
          ? SELECTION_COLOR
          : instance.hovered
            ? HOVER_COLOR
            : 0x000000;
        for (const material of entry.bodyMaterials) {
          material.emissive.setHex(highlight);
          material.emissiveIntensity = instance.selected ? 0.55 : 0.25;
          material.opacity = instance.dimmed ? 0.45 : 1;
          material.transparent = instance.dimmed;
        }

        entry.disc.scale.set(instance.discRadiusM, instance.discRadiusM, 1);
        entry.disc.material = instance.discIsLocator ? locatorMaterial : shadowMaterial;

        syncActorTag(entry, instance);
      }

      for (const [key, entry] of actorEntries) {
        if (seen.has(key)) continue;
        disposeActorEntry(entry);
        actorEntries.delete(key);
      }
    },

    setSignalHeads(heads) {
      const seen = new Set<string>();
      for (const instance of heads) {
        seen.add(instance.key);
        let entry = signalEntries.get(instance.key);
        // `ghost` is IN the signature: the non-lamp roles are shared materials,
        // so a head built as a ghost would keep translucent poles forever if a
        // ghost solidifying into a real head did not rebuild.
        const signature = signalHeadSignature(instance);
        if (entry && entry.signature !== signature) {
          signalGroup.remove(entry.group);
          for (const lamp of entry.lampMaterials) lamp.material.dispose();
          signalEntries.delete(instance.key);
          entry = undefined;
        }
        if (!entry) {
          entry = buildSignalEntry(instance);
          signalEntries.set(instance.key, entry);
          entry.group.position.set(
            instance.position.x,
            instance.position.y,
            instance.position.z,
          );
          entry.group.rotation.y = instance.rotationY;
          applyLampState(entry, instance);
          continue;
        }

        entry.group.position.set(
          instance.position.x,
          instance.position.y,
          instance.position.z,
        );
        entry.group.rotation.y = instance.rotationY;
        // The playhead moves 20 times a second and the lamp usually does not.
        if (
          entry.litLampIndex !== instance.litLampIndex ||
          entry.state !== instance.state ||
          entry.authored !== instance.authored ||
          entry.hovered !== instance.hovered
        ) {
          applyLampState(entry, instance);
        }
      }

      for (const [key, entry] of signalEntries) {
        if (seen.has(key)) continue;
        signalGroup.remove(entry.group);
        for (const lamp of entry.lampMaterials) lamp.material.dispose();
        signalEntries.delete(key);
      }
    },
  };

  return handle;
}
