import {
  AmbientLight,
  Box3,
  BufferAttribute,
  Color,
  DirectionalLight,
  LoadingManager,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Scene,
  Sphere,
  SRGBColorSpace,
  Texture,
  Vector3,
  WebGLRenderer,
} from "three";
import type { AnimationClip, BufferGeometry, Material } from "three";
import {
  GALLERY_MAX_GLB_BYTES,
  GALLERY_MAX_TRIANGLES,
  type GallerySourceFormat,
} from "./contracts";

const THUMBNAIL_SIZE = 512;
const MAX_TEXTURE_SIZE = 2048;
const SUPPORTED_FORMATS: Record<GallerySourceFormat, true> = {
  glb: true,
  gltf: true,
  fbx: true,
  obj: true,
  stl: true,
  dae: true,
  ply: true,
  usdz: true,
};

export type GalleryModelFacing = "auto" | "+x" | "-x" | "+z" | "-z";

type ImportOptions = {
  upAxis?: "auto" | "y" | "z";
  /** Which way the model's nose currently points; it is rotated onto +X. */
  facing?: GalleryModelFacing;
  scale?: number;
  relatedFiles?: readonly File[];
};

type ParsedModel = {
  root: Object3D;
  clips: AnimationClip[];
  /** Sibling-file URLs stay valid until the caller has exported the model. */
  resources: { failures: string[]; settled: () => Promise<void>; dispose: () => void };
};

function extensionOf(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function fileMap(files: readonly File[]) {
  const map = new Map<string, File>();
  for (const file of files) {
    map.set(file.name.toLowerCase(), file);
    map.set(file.name.split("/").pop()!.toLowerCase(), file);
  }
  return map;
}

/**
 * Serve a model's sibling files to its loader from blob URLs.
 *
 * `settled` is the important part. A loader's `parse` is synchronous but the
 * texture requests it starts are not, so revoking these URLs when `parse`
 * returns cancels every image still in flight - the textures then carry no
 * image data and `GLTFExporter` refuses the model with "No valid image data
 * found". Whoever creates the manager therefore owns the URLs until the
 * queue drains, which is what `settled` waits for.
 */
function managerFor(files: readonly File[]) {
  const byName = fileMap(files);
  const objectUrls = new Set<string>();
  const manager = new LoadingManager();
  const failures: string[] = [];
  let pending = 0;
  let drained: (() => void) | null = null;

  manager.setURLModifier((url) => {
    let decoded = url;
    try {
      decoded = decodeURIComponent(url);
    } catch {
      // Keep the original URL when a source contains malformed escaping.
    }
    // An FBX or GLB can carry its textures inside the file, in which case the
    // loader hands us a `blob:` or `data:` URL it made itself. Those are not
    // sibling lookups and must not be reported as missing files.
    if (/^(blob|data):/.test(decoded)) return url;
    const basename = decoded.split(/[\\/]/).pop()?.toLowerCase() ?? "";
    const related = byName.get(decoded.toLowerCase()) ?? byName.get(basename);
    if (!related) {
      failures.push(basename || decoded);
      return url;
    }
    const objectUrl = URL.createObjectURL(related);
    objectUrls.add(objectUrl);
    return objectUrl;
  });

  manager.onStart = () => {
    pending += 1;
  };
  const finish = () => {
    pending = Math.max(0, pending - 1);
    if (pending === 0 && drained) drained();
  };
  manager.onLoad = () => {
    pending = 0;
    if (drained) drained();
  };
  manager.onError = (url) => {
    failures.push(url.startsWith("blob:") ? "an embedded texture" : url);
    finish();
  };

  return {
    manager,
    failures,
    /** Resolves once every queued sibling request has loaded or failed. */
    settled: async () => {
      if (pending === 0) return;
      await new Promise<void>((resolve) => {
        drained = resolve;
      });
    },
    dispose: () => {
      for (const url of objectUrls) URL.revokeObjectURL(url);
      objectUrls.clear();
    },
  };
}

type LoadedModel = Omit<ParsedModel, "resources">;

async function parseModel(
  file: File,
  sourceFormat: string,
  relatedFiles: readonly File[],
): Promise<ParsedModel> {
  const resources = managerFor([file, ...relatedFiles]);
  try {
    const loaded = await loadModel(resources.manager, file, sourceFormat, relatedFiles);
    // Textures are still arriving here: the caller disposes once it has exported.
    await resources.settled();
    return { ...loaded, resources };
  } catch (error) {
    resources.dispose();
    throw error;
  }
}

async function loadModel(
  manager: LoadingManager,
  file: File,
  sourceFormat: string,
  relatedFiles: readonly File[],
): Promise<LoadedModel> {
  const resources = { manager };
  {
    // Intentional code splitting: only the loader for the selected source format is requested.
    if (sourceFormat === "glb" || sourceFormat === "gltf") {
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      const loader = new GLTFLoader(resources.manager);
      const data = sourceFormat === "glb" ? await file.arrayBuffer() : await file.text();
      const gltf = await loader.parseAsync(data, "");
      return { root: gltf.scene, clips: gltf.animations };
    }

    if (sourceFormat === "fbx") {
      const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
      const root = new FBXLoader(resources.manager).parse(await file.arrayBuffer(), "");
      return { root, clips: root.animations };
    }

    if (sourceFormat === "obj") {
      const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
      const loader = new OBJLoader(resources.manager);
      const materialFile = relatedFiles.find(
        (candidate) => extensionOf(candidate.name) === "mtl",
      );
      if (materialFile) {
        const { MTLLoader } = await import("three/examples/jsm/loaders/MTLLoader.js");
        const materials = new MTLLoader(resources.manager).parse(
          await materialFile.text(),
          "",
        );
        materials.preload();
        loader.setMaterials(materials);
      }
      return { root: loader.parse(await file.text()), clips: [] };
    }

    if (sourceFormat === "stl") {
      const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
      const geometry = new STLLoader(resources.manager).parse(await file.arrayBuffer());
      const material = new MeshStandardMaterial({
        color: 0xaeb5bd,
        metalness: 0.05,
        roughness: 0.72,
        vertexColors: geometry.hasAttribute("color"),
      });
      return { root: new Mesh(geometry, material), clips: [] };
    }

    if (sourceFormat === "dae") {
      const { ColladaLoader } = await import("three/examples/jsm/loaders/ColladaLoader.js");
      const collada = new ColladaLoader(resources.manager).parse(await file.text(), "");
      if (!collada) throw new Error("The Collada file could not be parsed.");
      return { root: collada.scene, clips: collada.scene.animations };
    }

    if (sourceFormat === "ply") {
      const { PLYLoader } = await import("three/examples/jsm/loaders/PLYLoader.js");
      const geometry = new PLYLoader(resources.manager).parse(await file.arrayBuffer());
      geometry.computeVertexNormals();
      const material = new MeshStandardMaterial({
        color: geometry.hasAttribute("color") ? 0xffffff : 0xaeb5bd,
        metalness: 0.05,
        roughness: 0.72,
        vertexColors: geometry.hasAttribute("color"),
      });
      return { root: new Mesh(geometry, material), clips: [] };
    }

    const { USDZLoader } = await import("three/examples/jsm/loaders/USDZLoader.js");
    return {
      root: new USDZLoader(resources.manager).parse(await file.arrayBuffer()),
      clips: [],
    };
  }
}

function guessedTransform(sourceFormat: string) {
  return {
    scale: sourceFormat === "fbx" ? 0.01 : 1,
    upAxis:
      sourceFormat === "obj" || sourceFormat === "stl" || sourceFormat === "ply"
        ? ("z" as const)
        : ("y" as const),
  };
}

/**
 * Which way the nose points, resolving `auto` from the footprint.
 *
 * A body is longer along the axis it travels, so a model measuring wider across
 * Z than X is lying across the editor's forward axis and needs a quarter turn.
 * The sign is not knowable from geometry - both ends of a car are car-shaped -
 * so `auto` assumes positive and the author flips it if the thumbnail disagrees.
 */
export function resolveFacing(
  requested: GalleryModelFacing,
  size: { l: number; w: number; h: number },
): Exclude<GalleryModelFacing, "auto"> {
  if (requested !== "auto") return requested;
  return size.w > size.l * 1.15 ? "+z" : "+x";
}

/** The Y rotation that brings `facing` onto +X. */
export function facingYaw(facing: Exclude<GalleryModelFacing, "auto">): number {
  if (facing === "-x") return Math.PI;
  if (facing === "+z") return Math.PI / 2;
  if (facing === "-z") return -Math.PI / 2;
  return 0;
}

function normalise(
  root: Object3D,
  sourceFormat: string,
  options: ImportOptions,
  warnings: string[],
) {
  const guessed = guessedTransform(sourceFormat);
  const scale = options.scale ?? guessed.scale;
  const upAxis = options.upAxis === "auto" || !options.upAxis
    ? guessed.upAxis
    : options.upAxis;

  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error("Model scale must be a positive number.");
  }
  if (options.scale === undefined && guessed.scale !== 1) {
    warnings.push("Applied a centimetres-to-metres scale guess; review the detected dimensions.");
  }
  if ((options.upAxis === undefined || options.upAxis === "auto") && upAxis === "z") {
    warnings.push("Applied a Z-up to Y-up rotation guess; adjust the up axis if the thumbnail is tilted.");
  }

  root.scale.multiplyScalar(scale);
  if (upAxis === "z") root.rotateX(-Math.PI / 2);
  root.updateMatrixWorld(true);

  // Editor-core anchors every actor nose-first along +X, and a model file states
  // its heading no more than it states its unit: this minibus was authored
  // facing -X, so it drove its routes backwards.
  const standing = new Box3().setFromObject(root).getSize(new Vector3());
  const facing = resolveFacing(options.facing ?? "auto", { l: standing.x, w: standing.z, h: standing.y });
  if ((!options.facing || options.facing === "auto") && facing === "+z") {
    warnings.push(
      "Turned the model to face +X because it is longer across Z; if it now drives backwards, use Flip 180°.",
    );
  }
  const yaw = facingYaw(facing);
  if (yaw !== 0) {
    root.rotateY(yaw);
    root.updateMatrixWorld(true);
  }

  const box = new Box3().setFromObject(root);
  if (box.isEmpty()) throw new Error("The file does not contain renderable model geometry.");
  const size = box.getSize(new Vector3());
  if (![size.x, size.y, size.z].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("The model has invalid or zero dimensions.");
  }

  root.position.x -= (box.min.x + box.max.x) / 2;
  root.position.y -= box.min.y;
  root.position.z -= (box.min.z + box.max.z) / 2;
  root.updateMatrixWorld(true);

  return { l: size.x, w: size.z, h: size.y };
}

function triangleCount(root: Object3D) {
  let count = 0;
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry as BufferGeometry;
    count += geometry.index
      ? geometry.index.count / 3
      : (geometry.getAttribute("position")?.count ?? 0) / 3;
  });
  return Math.floor(count);
}

/**
 * Shrink every texture image to `maxSize` and pick an encoding for it.
 *
 * A photogrammetry or generative export routinely arrives with 4096² maps,
 * which alone can exceed the whole upload budget once `embedImages` inlines
 * them. Colour goes to JPEG because it is the biggest map and its artefacts
 * are invisible at editor distance; normal, roughness and metalness stay PNG
 * because block artefacts in a normal map read as dents in the surface.
 */
function fitTextureBudget(root: Object3D, maxSize: number, warnings: string[]) {
  const seen = new Set<Texture>();
  let resized = 0;
  let largest = 0;
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const [slot, value] of Object.entries(material)) {
        if (!(value instanceof Texture) || seen.has(value)) continue;
        seen.add(value);
        const image = value.image as CanvasImageSource & { width?: number; height?: number };
        const width = image?.width ?? 0;
        const height = image?.height ?? 0;
        if (!width || !height) continue;
        largest = Math.max(largest, width, height);
        value.userData = {
          ...value.userData,
          mimeType: slot === "map" || slot === "emissiveMap" ? "image/jpeg" : "image/png",
        };
        if (Math.max(width, height) <= maxSize) continue;
        const factor = maxSize / Math.max(width, height);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * factor));
        canvas.height = Math.max(1, Math.round(height * factor));
        const context = canvas.getContext("2d");
        if (!context) continue;
        context.imageSmoothingQuality = "high";
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        value.image = canvas;
        value.needsUpdate = true;
        resized += 1;
      }
    }
  });
  if (resized > 0) {
    warnings.push(
      `Resized ${resized} texture${resized === 1 ? "" : "s"} down to ${maxSize}px from ${largest}px to fit the upload budget.`,
    );
  }
  return resized;
}

/**
 * Weld duplicate vertices so the mesh has real topology.
 *
 * An FBX or OBJ export is routinely non-indexed: every triangle carries its own
 * three vertices, so a 1.9M triangle body ships 5.8M vertices and the position,
 * normal and UV buffers alone run to hundreds of megabytes. It also cannot be
 * simplified in that state - with no shared edges every edge looks like a
 * border, and a decimator refuses to collapse borders. Merging identical
 * vertices is lossless: only vertices whose every attribute matches are joined.
 */
async function weldVertices(root: Object3D, warnings: string[]) {
  // Runtime-selected: only fetched for a model that arrives non-indexed.
  const { mergeVertices } = await import("three/examples/jsm/utils/BufferGeometryUtils.js");
  let before = 0;
  let after = 0;
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry as BufferGeometry;
    const position = geometry.getAttribute("position");
    if (!position || geometry.index) return;
    before += position.count;
    const welded = mergeVertices(geometry);
    mesh.geometry = welded;
    after += welded.getAttribute("position").count;
  });
  if (before > after && before > 0) {
    warnings.push(
      `Welded ${before.toLocaleString()} loose vertices down to ${after.toLocaleString()}; the source was not indexed.`,
    );
  }
}

/**
 * Decimate geometry to a triangle target, sharing it out by each mesh's share
 * of the total so one dense part cannot eat the whole allowance.
 */
async function fitTriangleBudget(root: Object3D, target: number, warnings: string[]) {
  const before = triangleCount(root);
  if (before <= target) return before;
  // Runtime-selected: the WASM simplifier is only fetched for a model that needs it.
  const { MeshoptSimplifier } = await import("three/examples/jsm/libs/meshopt_simplifier.module.js");
  await MeshoptSimplifier.ready;

  const meshes: Mesh[] = [];
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (mesh.isMesh) meshes.push(mesh);
  });
  const ratio = target / before;
  for (const mesh of meshes) {
    const geometry = mesh.geometry as BufferGeometry;
    const position = geometry.getAttribute("position");
    if (!position) continue;
    const index = geometry.index
      ? new Uint32Array(geometry.index.array)
      : Uint32Array.from({ length: position.count }, (_, i) => i);
    const targetIndexCount = Math.max(3, Math.floor((index.length * ratio) / 3) * 3);
    if (targetIndexCount >= index.length) continue;
    const [simplified] = MeshoptSimplifier.simplify(
      index,
      new Float32Array(position.array),
      position.itemSize,
      targetIndexCount,
      1e-2,
    );
    geometry.setIndex(new BufferAttribute(simplified, 1));
    // Simplifying only rewrites the index: every original vertex is still in
    // the attribute buffers, so the export would be no smaller. Drop the
    // vertices no triangle references any more.
    compactVertices(geometry);
  }
  const after = triangleCount(root);
  warnings.push(
    `Reduced the mesh from ${before.toLocaleString()} to ${after.toLocaleString()} triangles to fit the upload budget.`,
  );
  return after;
}

/** Rebuild a geometry's attributes around only the vertices its index still uses. */
function compactVertices(geometry: BufferGeometry) {
  const index = geometry.index;
  const position = geometry.getAttribute("position");
  if (!index || !position) return;

  const mapped = new Map<number, number>();
  const rewritten = new Uint32Array(index.count);
  for (let i = 0; i < index.count; i += 1) {
    const original = index.getX(i);
    let next = mapped.get(original);
    if (next === undefined) {
      next = mapped.size;
      mapped.set(original, next);
    }
    rewritten[i] = next;
  }
  if (mapped.size >= position.count) return;

  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    const source = attribute.array;
    const packed = new (source.constructor as Float32ArrayConstructor)(
      mapped.size * attribute.itemSize,
    );
    for (const [original, next] of mapped) {
      for (let component = 0; component < attribute.itemSize; component += 1) {
        packed[next * attribute.itemSize + component] =
          source[original * attribute.itemSize + component]!;
      }
    }
    geometry.setAttribute(name, new BufferAttribute(packed, attribute.itemSize, attribute.normalized));
  }
  geometry.setIndex(new BufferAttribute(rewritten, 1));
}

/**
 * Fold `emissiveIntensity` into the emissive colour, because glTF has no
 * equivalent field and the exporter writes `material.emissive` verbatim.
 *
 * FBX stores emission as `EmissiveColor` scaled by `EmissiveFactor`, and a
 * generator commonly writes white × 0 - meaning "not emissive". three keeps
 * that faithfully as `emissive: white`, `emissiveIntensity: 0`, so it renders
 * correctly here and in the thumbnail. Exported verbatim, the intensity is lost
 * and every surface arrives in the editor fully self-lit: the model reads as a
 * flat white silhouette with no base colour and no shading at all.
 */
export function bakeEmissiveIntensity(root: Object3D) {
  const seen = new Set<Material>();
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (seen.has(material)) continue;
      seen.add(material);
      const lit = material as MeshStandardMaterial;
      if (!lit.emissive) continue;
      const intensity = lit.emissiveIntensity ?? 1;
      if (intensity === 1) continue;
      lit.emissive.multiplyScalar(Math.max(0, intensity));
      lit.emissiveIntensity = 1;
      lit.needsUpdate = true;
    }
  });
}

async function exportGlb(root: Object3D, clips: AnimationClip[]) {
  const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
  const exported = await new GLTFExporter().parseAsync(root, {
    animations: clips,
    binary: true,
    embedImages: true,
    onlyVisible: false,
  });
  if (!(exported instanceof ArrayBuffer)) {
    throw new Error("Model exporter did not produce a binary GLB.");
  }
  return new Blob([exported], { type: "model/gltf-binary" });
}

function canvasBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("Could not encode the model thumbnail.")),
      "image/webp",
      0.88,
    );
  });
}

async function renderThumbnail(root: Object3D) {
  const canvas = document.createElement("canvas");
  canvas.width = THUMBNAIL_SIZE;
  canvas.height = THUMBNAIL_SIZE;
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(1);
  renderer.setSize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, false);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setClearColor(new Color(0x000000), 0);

  const scene = new Scene();
  scene.add(root);
  scene.add(new AmbientLight(0xffffff, 1.5));
  const key = new DirectionalLight(0xffffff, 3.2);
  key.position.set(4, 7, 5);
  scene.add(key);
  const fill = new DirectionalLight(0x9cbcff, 1.4);
  fill.position.set(-4, 3, -2);
  scene.add(fill);

  const sphere = new Box3().setFromObject(root).getBoundingSphere(new Sphere());
  const radius = Math.max(sphere.radius, 0.001);
  const camera = new PerspectiveCamera(35, 1, Math.max(radius / 100, 0.001), radius * 20);
  const direction = new Vector3(1.35, 0.9, 1.35).normalize();
  camera.position.copy(sphere.center).addScaledVector(direction, radius * 3.15);
  camera.lookAt(sphere.center);
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);

  try {
    return await canvasBlob(canvas);
  } finally {
    scene.remove(root);
    renderer.dispose();
    renderer.forceContextLoss();
  }
}

function disposeModel(root: Object3D) {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of meshMaterials) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof Texture) textures.add(value);
      }
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}

/**
 * Strip texture maps that carry no decoded image.
 *
 * Returns the names of what was dropped, so the author is told which sibling
 * files to add rather than being handed an export failure.
 */
function dropUnusableTextures(root: Object3D) {
  const dropped: string[] = [];
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const [key, value] of Object.entries(material)) {
        if (!(value instanceof Texture)) continue;
        const image = value.image as { width?: number; height?: number } | null | undefined;
        if (image && (image.width ?? 0) > 0 && (image.height ?? 0) > 0) continue;
        dropped.push(value.name || key);
        (material as unknown as Record<string, unknown>)[key] = null;
        material.needsUpdate = true;
        value.dispose();
      }
    }
  });
  return dropped;
}

async function sha256(blob: Blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function importModelFile(file: File, options: ImportOptions = {}) {
  const sourceFormat = extensionOf(file.name);
  if (!(sourceFormat in SUPPORTED_FORMATS)) {
    throw new Error(`Unsupported model format “.${sourceFormat || "unknown"}”.`);
  }
  const validSourceFormat = sourceFormat as GallerySourceFormat;

  const warnings: string[] = [];
  const parsed = await parseModel(file, validSourceFormat, options.relatedFiles ?? []);
  const dims = normalise(parsed.root, validSourceFormat, options, warnings);
  let triangles = triangleCount(parsed.root);
  if (triangles === 0) throw new Error("The file does not contain any mesh triangles.");

  // A texture whose bytes never arrived - a sibling file the author did not
  // select, or one the browser could not decode - has no image data, and
  // `GLTFExporter` refuses the whole model over it. The geometry is still worth
  // importing, so drop those maps and say which ones went.
  const dropped = dropUnusableTextures(parsed.root);
  for (const name of new Set([...parsed.resources.failures, ...dropped])) {
    warnings.push(`Ignored a texture that could not be read: ${name}.`);
  }

  let thumbnailBlob: Blob;
  let glbBlob: Blob;
  try {
    // Fit the API's budget here rather than posting a body the schema will
    // reject: a generative or scanned export commonly lands at millions of
    // triangles and 4096px maps, and the author cannot act on a 400.
    await weldVertices(parsed.root, warnings);
    bakeEmissiveIntensity(parsed.root);
    triangles = await fitTriangleBudget(parsed.root, GALLERY_MAX_TRIANGLES, warnings);
    let textureSize = MAX_TEXTURE_SIZE;
    fitTextureBudget(parsed.root, textureSize, warnings);
    glbBlob = await exportGlb(parsed.root, parsed.clips);

    // Only the real exported size settles this: embedded images, index width
    // and animation tracks all move it. Halve the heaviest inputs and re-export
    // until it fits, so an oversized source still produces a usable asset.
    for (let attempt = 0; glbBlob.size > GALLERY_MAX_GLB_BYTES && attempt < 4; attempt += 1) {
      textureSize = Math.max(256, Math.floor(textureSize / 2));
      triangles = await fitTriangleBudget(parsed.root, Math.floor(triangles / 2), warnings);
      fitTextureBudget(parsed.root, textureSize, warnings);
      glbBlob = await exportGlb(parsed.root, parsed.clips);
    }
    if (glbBlob.size > GALLERY_MAX_GLB_BYTES) {
      throw new Error(
        [
          `The converted model is ${(glbBlob.size / (1024 * 1024)).toFixed(0)} MB, above the ${GALLERY_MAX_GLB_BYTES / (1024 * 1024)} MB limit.`,
          ...warnings.filter((warning) => warning.startsWith("Reduced") || warning.startsWith("Resized")),
          "Simplify it in your modelling tool and try again.",
        ].join(" "),
      );
    }
    thumbnailBlob = await renderThumbnail(parsed.root);
  } finally {
    disposeModel(parsed.root);
    parsed.resources.dispose();
  }
  const [glbSha256, thumbnailSha256] = await Promise.all([
    sha256(glbBlob),
    sha256(thumbnailBlob),
  ]);
  const clips = parsed.clips.map((clip, index) => clip.name.trim() || `Clip ${index + 1}`);

  return {
    glbBlob,
    glbSha256,
    thumbnailBlob,
    thumbnailSha256,
    dims,
    triangleCount: triangles,
    animated: clips.length > 0,
    clips,
    sourceFormat: validSourceFormat,
    warnings,
  };
}
