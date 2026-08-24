import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  PerspectiveCamera,
  Scene,
  Sphere,
  SRGBColorSpace,
  Texture,
  Vector3,
  WebGLRenderer,
} from "three";
import type { BufferGeometry, Material, Object3D } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import {
  MAP_LAYER_IDS,
  MAP_UPLOAD_MAX_GLB_BYTES,
  layerIdFromFileName,
} from "@/app/lib/map-ingest/contracts";
import type { MapLayerId, MapPreflight } from "@/app/lib/map-ingest/contracts";
import { runMapPreflight } from "@/app/lib/map-ingest/preflight";

const THUMBNAIL_SIZE = 512;
const BYTES_PER_MB = 1024 * 1024;
const gltfLoader = new GLTFLoader();
gltfLoader.setMeshoptDecoder(MeshoptDecoder);

export type ImportedMapLayer = {
  layerId: MapLayerId;
  fileName: string;
  blob: Blob;
  sha256: string;
  triangleCount: number;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
};

export type ImportedMap = {
  xodr: { blob: Blob; sha256: string; text: string };
  mapName: string;
  layers: ImportedMapLayer[];
  thumbnailBlob: Blob;
  thumbnailSha256: string;
  preflight: MapPreflight;
  totalTriangles: number;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
};

type ParsedLayer = {
  layerId: MapLayerId;
  file: File;
  root: Object3D;
  triangleCount: number;
  bounds: Box3;
};

function triangleCount(root: Object3D): number {
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

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob
        ? resolve(blob)
        : reject(new Error("Could not encode the map thumbnail.")),
      "image/webp",
      0.88,
    );
  });
}

async function renderThumbnail(roots: readonly Object3D[], bounds: Box3): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = THUMBNAIL_SIZE;
  canvas.height = THUMBNAIL_SIZE;
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(1);
  renderer.setSize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, false);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setClearColor(new Color(0x000000), 0);

  const scene = new Scene();
  const mapRoot = new Group();
  mapRoot.add(...roots);
  scene.add(mapRoot);
  scene.add(new AmbientLight(0xffffff, 1.5));
  const key = new DirectionalLight(0xffffff, 3.2);
  key.position.set(4, 7, 5);
  scene.add(key);
  const fill = new DirectionalLight(0x9cbcff, 1.4);
  fill.position.set(-4, 3, -2);
  scene.add(fill);

  const sphere = bounds.getBoundingSphere(new Sphere());
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
    scene.remove(mapRoot);
    renderer.dispose();
    renderer.forceContextLoss();
  }
}

function disposeModel(root: Object3D): void {
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

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function vectorTuple(vector: Vector3): [number, number, number] {
  return [vector.x, vector.y, vector.z];
}

export async function importMapFiles(files: File[]): Promise<ImportedMap> {
  const xodrFiles = files.filter((file) => file.name.toLowerCase().endsWith(".xodr"));
  if (xodrFiles.length !== 1) {
    throw new Error(
      `Select exactly one OpenDRIVE .xodr file; received ${xodrFiles.length}.`,
    );
  }
  const xodrFile = xodrFiles[0]!;

  const glbFiles = files.filter((file) => file.name.toLowerCase().endsWith(".glb"));
  const filesByLayer = new Map<MapLayerId, File>();
  for (const file of glbFiles) {
    const layerId = layerIdFromFileName(file.name);
    if (!layerId) {
      throw new Error(
        `Unsupported map layer file “${file.name}”. Accepted layer ids are ${MAP_LAYER_IDS.join(", ")}; name each file <layer-id>.glb.`,
      );
    }
    if (filesByLayer.has(layerId)) {
      throw new Error(`Duplicate map layer “${layerId}”. Provide exactly one ${layerId}.glb file.`);
    }
    filesByLayer.set(layerId, file);
  }
  if (!filesByLayer.has("road")) {
    throw new Error("A road.glb file is required because the road surface layer is mandatory.");
  }

  const orderedLayers = MAP_LAYER_IDS.flatMap((layerId) => {
    const file = filesByLayer.get(layerId);
    return file ? [{ layerId, file }] : [];
  });
  const totalGlbBytes = orderedLayers.reduce((total, layer) => total + layer.file.size, 0);
  if (totalGlbBytes > MAP_UPLOAD_MAX_GLB_BYTES) {
    throw new Error(
      `The selected GLBs total ${(totalGlbBytes / BYTES_PER_MB).toFixed(1)} MB, above the ${MAP_UPLOAD_MAX_GLB_BYTES / BYTES_PER_MB} MB browser limit. Use the map CLI for larger city exports.`,
    );
  }

  const xodrText = await xodrFile.text();
  const preflightResult = runMapPreflight(xodrText);
  if (!preflightResult.ok) throw new Error(preflightResult.reason);

  const parsedLayers: ParsedLayer[] = [];
  const unionBounds = new Box3().makeEmpty();
  let totalTriangles = 0;
  let thumbnailBlob: Blob;

  try {
    for (const { layerId, file } of orderedLayers) {
      const gltf = await gltfLoader.parseAsync(await file.arrayBuffer(), "");
      const root = gltf.scene;
      parsedLayers.push({
        layerId,
        file,
        root,
        triangleCount: 0,
        bounds: new Box3().makeEmpty(),
      });

      root.updateMatrixWorld(true);
      const triangles = triangleCount(root);
      if (triangles === 0) {
        throw new Error(`The map layer “${file.name}” does not contain any mesh triangles.`);
      }
      const bounds = new Box3().setFromObject(root);
      const boundsValues = [
        bounds.min.x,
        bounds.min.y,
        bounds.min.z,
        bounds.max.x,
        bounds.max.y,
        bounds.max.z,
      ];
      if (bounds.isEmpty() || !boundsValues.every(Number.isFinite)) {
        throw new Error(`The map layer “${file.name}” has invalid geometry bounds.`);
      }

      const parsed = parsedLayers[parsedLayers.length - 1]!;
      parsed.triangleCount = triangles;
      parsed.bounds = bounds;
      totalTriangles += triangles;
      unionBounds.union(bounds);
    }

    const unionSize = unionBounds.getSize(new Vector3());
    if (
      unionBounds.isEmpty() ||
      ![unionSize.x, unionSize.y, unionSize.z].every(Number.isFinite) ||
      unionSize.lengthSq() === 0
    ) {
      throw new Error("The combined map layers have invalid or zero-extent geometry bounds.");
    }

    thumbnailBlob = await renderThumbnail(
      parsedLayers.map((layer) => layer.root),
      unionBounds,
    );

    const [xodrSha256, thumbnailSha256, layerSha256s] = await Promise.all([
      sha256(xodrFile),
      sha256(thumbnailBlob),
      Promise.all(parsedLayers.map((layer) => sha256(layer.file))),
    ]);

    return {
      xodr: { blob: xodrFile, sha256: xodrSha256, text: xodrText },
      mapName: preflightResult.mapName,
      layers: parsedLayers.map((layer, index) => ({
        layerId: layer.layerId,
        fileName: layer.file.name,
        blob: layer.file,
        sha256: layerSha256s[index]!,
        triangleCount: layer.triangleCount,
        boundsMin: vectorTuple(layer.bounds.min),
        boundsMax: vectorTuple(layer.bounds.max),
      })),
      thumbnailBlob,
      thumbnailSha256,
      preflight: preflightResult.preflight,
      totalTriangles,
      boundsMin: vectorTuple(unionBounds.min),
      boundsMax: vectorTuple(unionBounds.max),
    };
  } finally {
    for (const layer of parsedLayers) disposeModel(layer.root);
  }
}
