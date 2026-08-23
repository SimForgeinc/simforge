import { z } from 'zod';
import * as THREE from 'three/webgpu';

export const STATIC_SEMANTICS_CAPABILITY = 'map.static_semantics' as const;
export const STATIC_SEMANTICS_SCHEMA = 'uniscenario.static-semantics/v1' as const;
export const STATIC_SEMANTIC_CLASSES = [
  'road',
  'sidewalk',
  'building',
  'vegetation',
  'pole',
  'traffic_light',
  'traffic_sign',
  'furniture',
  'terrain',
  'other',
] as const;

export type StaticSemanticClass = (typeof STATIC_SEMANTIC_CLASSES)[number];

export interface StaticSemanticObject {
  node: string;
  class: StaticSemanticClass;
  instanceId: number;
}

export interface StaticSemantics {
  schema: typeof STATIC_SEMANTICS_SCHEMA;
  classes: readonly StaticSemanticClass[];
  objects: readonly StaticSemanticObject[];
}

const staticSemanticsSchema = z.object({
  schema: z.literal(STATIC_SEMANTICS_SCHEMA),
  classes: z.tuple([
    z.literal('road'),
    z.literal('sidewalk'),
    z.literal('building'),
    z.literal('vegetation'),
    z.literal('pole'),
    z.literal('traffic_light'),
    z.literal('traffic_sign'),
    z.literal('furniture'),
    z.literal('terrain'),
    z.literal('other'),
  ]),
  objects: z.array(z.object({
    node: z.string().min(1),
    class: z.enum(STATIC_SEMANTIC_CLASSES),
    instanceId: z.number().int().min(1).max(0xffffff),
  })),
});

// GLTFLoader applies PropertyBinding.sanitizeNodeName before assigning
// Object3D.name. Mirror it so metadata continues to refer to authored names.
function viewerNodeName(name: string): string {
  return name.replace(/\s/g, '_').replace(/[\[\]\.:/]/g, '');
}

export function parseStaticSemantics(raw: unknown): StaticSemantics {
  const parsed = staticSemanticsSchema.parse(raw);
  const ids = new Set<number>();
  const nodes = new Map<string, StaticSemanticObject>();
  const viewerNodes = new Map<string, string>();
  for (const object of parsed.objects) {
    if (ids.has(object.instanceId)) {
      throw new Error(`Duplicate static semantic instanceId: ${object.instanceId}`);
    }
    const prior = nodes.get(object.node);
    if (prior) {
      throw new Error(`Duplicate static semantic node: ${object.node}`);
    }
    const viewerName = viewerNodeName(object.node);
    const priorViewerNode = viewerNodes.get(viewerName);
    if (priorViewerNode) {
      throw new Error(`Static semantic nodes collide in the viewer: ${priorViewerNode} and ${object.node}`);
    }
    ids.add(object.instanceId);
    nodes.set(object.node, object);
    viewerNodes.set(viewerName, object.node);
  }
  return parsed;
}

function semanticObjectFor(
  object: THREE.Object3D,
  byNode: ReadonlyMap<string, StaticSemanticObject>,
): StaticSemanticObject | undefined {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (current.name) {
      const direct = byNode.get(current.name);
      if (direct) return direct;
      if (current instanceof THREE.InstancedMesh && current.name.endsWith('_instanced')) {
        const prototype = byNode.get(current.name.slice(0, -'_instanced'.length));
        if (prototype) return prototype;
      }
    }
    current = current.parent;
  }
  return undefined;
}

/** Tag every renderable object whose GLB node is present in the semantic index. */
export function applyStaticSemantics(group: THREE.Object3D, semantics: StaticSemantics | null): number {
  if (!semantics) return 0;
  const byNode = new Map<string, StaticSemanticObject>();
  for (const object of semantics.objects) {
    byNode.set(object.node, object);
    byNode.set(viewerNodeName(object.node), object);
  }
  let tagged = 0;
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const semantic = semanticObjectFor(object, byNode);
    if (!semantic) return;
    object.userData.semanticClass = semantic.class;
    object.userData.semanticInstanceId = semantic.instanceId;
    tagged += 1;
  });
  return tagged;
}
