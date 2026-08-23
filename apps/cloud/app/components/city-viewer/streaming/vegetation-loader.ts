import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import {
  buildInstancedMeshes,
  type InstanceData,
  type PrototypeMesh,
} from '../vegetation-instance-builder';
import {
  ensureSimplifier,
  simplifyPrototypeGeometry,
} from '../vegetation-simplify';
import { applyLayerFlags, captureOriginals } from '../layer-material-applier';
import { applyStaticSemantics, type StaticSemantics } from '../static-semantics';
import { applyKtx2Support, type LoadedTile } from './tile-loader';
import {
  addTileTextureReferences,
  dedupeGroupTextures,
} from './texture-pool';

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

function yieldFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

// Cache instance data per vegetation tile ID (small ~3KB, never evicted)
const instanceCache = new Map<string, InstanceData>();

/** Number of entries in the global vegetation instance cache. */
export function getVegetationCacheSize(): number {
  return instanceCache.size;
}

/**
 * Release every cached `InstanceData` row. The cache is module-scope so it
 * survives `CityViewerCore.dispose()` and accumulates per-tile entries across
 * viewer remount cycles. Each entry retains the parsed sidecar JSON
 * (prototype-name arrays + per-instance transforms) plus the `Map` slot
 * itself — small individually, but a retained reference root for the
 * vegetation tiles whose prototype-name arrays it holds. ABH-106 wires this
 * into the viewer's dispose chain so the lifetime contract matches the
 * texture pool.
 */
export function clearVegetationInstanceCache(): void {
  instanceCache.clear();
}

/**
 * Pre-seed the per-tile instance cache from the pipeline's merged sidecar
 * (`variants/vegetation-instances-v1.json`) so a scene load costs one fetch
 * instead of one JSON request per vegetation tile (60 on Belmont). Existing
 * entries win — a tile already loaded through the per-tile fallback keeps
 * the data it parsed.
 */
export function seedVegetationInstanceCache(
  tiles: Record<string, InstanceData>,
): number {
  let seeded = 0;
  for (const [tileId, data] of Object.entries(tiles)) {
    if (!data || instanceCache.has(tileId)) continue;
    instanceCache.set(tileId, data);
    seeded++;
  }
  return seeded;
}

/** Key stored in `InstancedMesh.userData` to support dynamic density control. */
const VEG_MAX_COUNT_KEY = 'vegetationMaxCount';

/**
 * Resolve every prototype name in the GLB scene to a list of meshes plus the
 * node-local transform of the prototype's parent (so the per-instance
 * transform from the sidecar can be composed cleanly). Longest names match
 * first so a prototype called "SM_Maple" doesn't accidentally swallow
 * "SM_Maple_S".
 */
function extractPrototypeMeshes(
  glbScene: THREE.Group,
  prototypeNames: string[],
): Map<string, PrototypeMesh[]> {
  const sortedNames = [...prototypeNames].sort((a, b) => b.length - a.length);
  const map = new Map<string, PrototypeMesh[]>();
  const nodeMatrixByProto = new Map<string, THREE.Matrix4>();

  const matchProto = (name: string): string | null => {
    for (const protoName of sortedNames) {
      if (name === protoName || name.startsWith(protoName)) return protoName;
    }
    return null;
  };

  glbScene.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;

    let matched = child.name ? matchProto(child.name) : null;
    if (!matched && child.parent && child.parent.name) {
      matched = matchProto(child.parent.name);
    }
    if (!matched) return;

    if (!nodeMatrixByProto.has(matched)) {
      const nodeObj =
        child.parent instanceof THREE.Group && child.parent !== glbScene
          ? child.parent
          : child;
      nodeMatrixByProto.set(matched, nodeObj.matrix.clone());
    }
    const nodeMatrix = nodeMatrixByProto.get(matched)!;

    const list = map.get(matched) ?? [];
    list.push({
      geometry: child.geometry as THREE.BufferGeometry,
      material: child.material,
      nodeMatrix,
      name: child.name || matched,
    });
    map.set(matched, list);
  });

  return map;
}

export async function loadVegetationTile(
  glbUrl: string,
  instanceUrl: string,
  lodLevel: number,
  signal: AbortSignal,
  /**
   * Manifest tile id. Optional for legacy callers — the URL-derived fallback
   * breaks as soon as the URL is a KTX2 variant path (content-hash filename)
   * or carries a cache-busting query, so the tile-manager always passes it.
   */
  explicitTileId?: string,
  semantics: StaticSemantics | null = null,
): Promise<LoadedTile> {
  const tileId =
    explicitTileId ??
    glbUrl.split('?')[0]!.replace(/.*\//, '').replace(/\.lod\d+\.glb$/, '');

  // Fetch GLB and instance JSON in parallel (reuse cached instance data —
  // possibly pre-seeded from the merged sidecar, see
  // `seedVegetationInstanceCache`).
  const cached = instanceCache.get(tileId);
  const [glbBuffer, instanceJson] = await Promise.all([
    fetch(glbUrl, { signal }).then((r) => r.arrayBuffer()),
    cached ? Promise.resolve(null) : fetch(instanceUrl, { signal }).then((r) => r.json()),
  ]);

  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

  const instanceData: InstanceData = cached ?? (instanceJson as InstanceData);
  if (!cached) instanceCache.set(tileId, instanceData);

  // Parse GLB and pull out per-prototype geometry/material pairs. The GLB
  // may be the pipeline's KTX2 variant — wire the shared transcoder first.
  applyKtx2Support(loader);
  const gltf = await loader.parseAsync(glbBuffer, '');
  const protoGroup = gltf.scene as THREE.Group;
  // Dedupe shared textures (bark/leaf/etc.) against the cross-tile pool
  // before InstancedMesh construction copies the material references out.
  const deduped = dedupeGroupTextures(protoGroup);
  if (deduped.deduped > 0) {
    console.debug(
      `[VegetationLoader] deduped ${deduped.deduped} cross-tile textures in ${tileId} (${deduped.adopted} new in pool)`,
    );
  }
  const prototypeMeshes = extractPrototypeMeshes(protoGroup, instanceData.prototypes);

  // Decimate the prototypes for this LOD before they are instanced. The
  // pipeline's vegetation LODs carry identical triangle counts at every level,
  // so without this a distant tree costs exactly what a near one does — and
  // vegetation is ~99% of the scene's triangles. Results are cached per
  // prototype, so a plant is simplified once however many tiles use it.
  const simplifier = await ensureSimplifier();
  if (simplifier) {
    for (const [protoName, meshes] of prototypeMeshes) {
      meshes.forEach((mesh, i) => {
        mesh.geometry = simplifyPrototypeGeometry(
          simplifier,
          mesh.geometry,
          protoName,
          i,
          lodLevel,
        );
      });
    }
  }

  const resultGroup = new THREE.Group();
  resultGroup.name = tileId;
  // Tag for the visual-config HUD's per-layer scoping (#04). The vegetation
  // loader produces InstancedMesh nodes, but the layerKind / captureOriginals
  // contract is per-mesh-material — same as for assets and roads.
  resultGroup.userData.layerKind = 'vegetation';
  // Which level this tile was streamed at, so the perf audit can attribute
  // triangles to LOD selection rather than guessing.
  resultGroup.userData.lodLevel = lodLevel;

  // Build the InstancedMesh array (capacity = LOD0 count, mesh.count = lod count).
  const instancedMeshes = buildInstancedMeshes(instanceData, prototypeMeshes, lodLevel);

  let totalInstanceBytes = 0;
  for (let i = 0; i < instancedMeshes.length; i++) {
    const im = instancedMeshes[i]!;
    // Tag with the LOD's natural draw count so the runtime density slider
    // scales relative to that — not relative to the full LOD0 capacity.
    im.userData[VEG_MAX_COUNT_KEY] = im.count;
    resultGroup.add(im);
    totalInstanceBytes += im.instanceMatrix.count * 64;

    if (i % 3 === 2) {
      await yieldFrame();
    }
  }
  applyStaticSemantics(resultGroup, semantics);

  // ABH-112: count this vegetation tile as one reference per distinct
  // pooled bark/leaf texture it ends up using. The InstancedMesh
  // construction copied material references out of `protoGroup`, so the
  // refcount increment must happen against `resultGroup` (not the
  // already-discarded prototype scene). Paired with
  // `releaseTileTextureReferences` in the cache's disposeSubtree path.
  addTileTextureReferences(resultGroup);
  // Snapshot original PBR values on every instanced mesh's material so the
  // per-layer multipliers in #04 compose with the glTF baseline.
  captureOriginals(resultGroup);
  // RELOAD-knob propagation (#05) — apply `forceFlatShading` and the
  // vegetation `castShadows` toggle from the saved config. Setting castShadow
  // here means mid-stream vegetation tiles inherit the user's choice without
  // depending on the one-shot scene broadcast in `city-viewer-core` (which
  // fires only on first onReady).
  applyLayerFlags(resultGroup, 'vegetation');

  const byteSize =
    glbBuffer.byteLength + JSON.stringify(instanceData).length + totalInstanceBytes;

  return { group: resultGroup, byteSize };
}

/**
 * Adjust the visible vegetation density on an already-loaded group.
 * Sets `InstancedMesh.count` based on the stored max — no GPU re-upload,
 * takes effect on the next draw call.
 */
export function applyVegetationDensity(group: THREE.Group, scale: number): void {
  group.traverse((obj) => {
    if (!(obj as THREE.InstancedMesh).isInstancedMesh) return;
    const mesh = obj as THREE.InstancedMesh;
    const maxCount = mesh.userData[VEG_MAX_COUNT_KEY] as number | undefined;
    if (maxCount == null) return;
    mesh.count = Math.max(1, Math.round(maxCount * scale));
  });
}
