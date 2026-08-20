import { InstancedMesh, Mesh, Object3D } from 'three';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): never {
  throw new Error(`Static semantics validation failed — ${path}: ${message}`);
}

function semanticClass(value: unknown, path: string): StaticSemanticClass {
  if (typeof value !== 'string' || !(STATIC_SEMANTIC_CLASSES as readonly string[]).includes(value)) {
    return fail(path, `expected one of ${STATIC_SEMANTIC_CLASSES.join(', ')}`);
  }
  return value as StaticSemanticClass;
}

// GLTFLoader applies PropertyBinding.sanitizeNodeName before assigning
// Object3D.name. Mirror it so metadata continues to refer to authored names.
function viewerNodeName(name: string): string {
  return name.replace(/\s/g, '_').replace(/[\[\]\.:/]/g, '');
}

export function parseStaticSemantics(raw: unknown): StaticSemantics {
  if (!isRecord(raw)) fail('<root>', 'expected an object');
  if (raw.schema !== STATIC_SEMANTICS_SCHEMA) {
    fail('schema', `expected ${STATIC_SEMANTICS_SCHEMA}`);
  }
  if (!Array.isArray(raw.classes) || raw.classes.length !== STATIC_SEMANTIC_CLASSES.length) {
    fail('classes', `expected the ${STATIC_SEMANTIC_CLASSES.length}-class canonical taxonomy`);
  }
  const classes = raw.classes.map((value, index) => semanticClass(value, `classes.${index}`));
  for (let index = 0; index < STATIC_SEMANTIC_CLASSES.length; index++) {
    if (classes[index] !== STATIC_SEMANTIC_CLASSES[index]) {
      fail(`classes.${index}`, `expected ${STATIC_SEMANTIC_CLASSES[index]}`);
    }
  }
  if (!Array.isArray(raw.objects)) fail('objects', 'expected an array');

  const objects: StaticSemanticObject[] = raw.objects.map((value, index) => {
    if (!isRecord(value)) fail(`objects.${index}`, 'expected an object');
    if (typeof value.node !== 'string' || value.node.length === 0) {
      fail(`objects.${index}.node`, 'expected a non-empty string');
    }
    const objectClass = semanticClass(value.class, `objects.${index}.class`);
    if (typeof value.instanceId !== 'number' || !Number.isInteger(value.instanceId)
      || value.instanceId < 1 || value.instanceId > 0xffffff) {
      fail(`objects.${index}.instanceId`, 'expected a nonzero RGB24 integer');
    }
    return { node: value.node, class: objectClass, instanceId: value.instanceId };
  });

  const ids = new Set<number>();
  const nodes = new Map<string, StaticSemanticObject>();
  const viewerNodes = new Map<string, string>();
  for (const object of objects) {
    if (ids.has(object.instanceId)) {
      throw new Error(`Duplicate static semantic instanceId: ${object.instanceId}`);
    }
    if (nodes.has(object.node)) {
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

  return { schema: STATIC_SEMANTICS_SCHEMA, classes, objects };
}

function semanticObjectFor(
  object: Object3D,
  byNode: ReadonlyMap<string, StaticSemanticObject>,
): StaticSemanticObject | undefined {
  let current: Object3D | null = object;
  while (current) {
    if (current.name) {
      const direct = byNode.get(current.name);
      if (direct) return direct;
      if (current instanceof InstancedMesh && current.name.endsWith('_instanced')) {
        const prototype = byNode.get(current.name.slice(0, -'_instanced'.length));
        if (prototype) return prototype;
      }
    }
    current = current.parent;
  }
  return undefined;
}

/** Tag every renderable object whose GLB node is present in the semantic index. */
export function applyStaticSemantics(group: Object3D, semantics: StaticSemantics | null): number {
  if (!semantics) return 0;
  const byNode = new Map<string, StaticSemanticObject>();
  for (const object of semantics.objects) {
    byNode.set(object.node, object);
    byNode.set(viewerNodeName(object.node), object);
  }
  let tagged = 0;
  group.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const semantic = semanticObjectFor(object, byNode);
    if (!semantic) return;
    object.userData.semanticClass = semantic.class;
    object.userData.semanticInstanceId = semantic.instanceId;
    tagged += 1;
  });
  return tagged;
}

/** Capabilities contributed by validated static semantic metadata. */
export function staticSemanticsCapabilities(semantics: StaticSemantics | null): readonly string[] {
  return semantics ? [STATIC_SEMANTICS_CAPABILITY] : [];
}
