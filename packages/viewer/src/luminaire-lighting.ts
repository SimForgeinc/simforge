import {
  Box3,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PointLight,
  SphereGeometry,
  Vector3,
} from 'three';

const LUMINAIRE_NAME = /(?:^|[_ .-])(street[_ .-]?lights?|street[_ .-]?lamps?|lamp[_ .-]?posts?|light[_ .-]?poles?|road[_ .-]?lights?|luminaires?)(?:$|[_ .-])/i;
const LUMINAIRE_HEAD_NAME = /(?:^|[_ .-])(?:luminaire|lamp)[_ .-]?head/i;
const MIN_FIXTURE_HEIGHT_M = 2;
const MAX_FIXTURE_HEIGHT_M = 20;
const MAX_FIXTURE_SPAN_M = 12;
const BULB_INSET_M = 0.25;

export const DEFAULT_ACTIVE_LUMINAIRE_LIMIT = 12;

export interface LuminaireLightingStats {
  readonly discovered: number;
  readonly active: number;
  readonly enabled: boolean;
}

interface LuminaireCandidate {
  readonly owner: Object3D;
  readonly position: Vector3;
}

interface ActiveLuminaire {
  readonly group: Group;
  readonly light: PointLight;
}

/**
 * Strict semantic-name match; generic words such as `light` never classify geometry.
 *
 * Unreal/Datasmith exports glue a UUID prefix straight onto a camelCase actor
 * name (`a70aaa6bStreetLight_30ft_DefaultSceneRoot`), so camel boundaries are
 * treated as separators before the anchored token match runs.
 */
export function isLuminaireObjectName(name: string): boolean {
  return LUMINAIRE_NAME.test(splitCamelBoundaries(name));
}

/**
 * Bounded practical-light pool for streamed city furniture.
 *
 * Source maps retain semantic Unreal/glTF node names such as `Street_Light`,
 * `Lamp_Post` and UUID-prefixed Datasmith actors like
 * `…054bStreetLight_30ft_DefaultSceneRoot`. Registration happens once when a
 * tile becomes resident; camera updates only move a small fixed pool onto the
 * nearest visible fixtures. This avoids allocating a WebGL light per lamp or
 * keeping evicted tile roots alive.
 */
export class LuminaireLightingController {
  readonly group = new Group();

  private readonly candidatesByRoot = new Map<Object3D, LuminaireCandidate[]>();
  private readonly pool: ActiveLuminaire[] = [];
  private readonly cameraPosition = new Vector3();
  private enabled = false;

  constructor(private readonly activeLimit = DEFAULT_ACTIVE_LUMINAIRE_LIMIT) {
    this.group.name = 'city-luminaires';
    this.group.userData.simforgeRole = 'city-luminaires';

    const geometry = new SphereGeometry(0.12, 8, 6);
    const material = new MeshBasicMaterial({ color: 0xffe2a8, toneMapped: false });
    for (let index = 0; index < Math.max(0, Math.floor(activeLimit)); index++) {
      const fixture = new Group();
      fixture.name = `city-luminaire.${index}`;
      fixture.visible = false;
      const bulb = new Mesh(geometry, material);
      const light = new PointLight(0xffd6a0, 34, 24, 2);
      light.castShadow = false;
      fixture.add(bulb, light);
      this.group.add(fixture);
      this.pool.push({ group: fixture, light });
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.group.visible = enabled;
    if (!enabled) for (const fixture of this.pool) fixture.group.visible = false;
  }

  registerTree(root: Object3D): void {
    this.unregisterTree(root);
    root.updateMatrixWorld(true);
    const candidates: LuminaireCandidate[] = [];
    const accepted = new Set<Object3D>();
    root.traverse((object) => {
      if (!object.name || !isLuminaireObjectName(object.name)) return;
      for (let parent = object.parent; parent && parent !== root; parent = parent.parent) {
        if (accepted.has(parent)) return;
      }
      const bounds = new Box3().setFromObject(object);
      if (bounds.isEmpty()) return;
      const size = bounds.getSize(new Vector3());
      if (
        size.y < MIN_FIXTURE_HEIGHT_M
        || size.y > MAX_FIXTURE_HEIGHT_M
        || size.x > MAX_FIXTURE_SPAN_M
        || size.z > MAX_FIXTURE_SPAN_M
      ) return;
      accepted.add(object);
      candidates.push({ owner: object, position: bulbPosition(object, bounds) });
    });
    if (candidates.length > 0) this.candidatesByRoot.set(root, candidates);
  }

  unregisterTree(root: Object3D): void {
    this.candidatesByRoot.delete(root);
  }

  update(camera: Object3D): void {
    if (!this.enabled || this.pool.length === 0) return;
    camera.getWorldPosition(this.cameraPosition);
    const visible = [...this.candidatesByRoot.values()]
      .flat()
      .filter((candidate) => hierarchyVisible(candidate.owner))
      .sort((left, right) => (
        left.position.distanceToSquared(this.cameraPosition)
        - right.position.distanceToSquared(this.cameraPosition)
      ));

    for (let index = 0; index < this.pool.length; index++) {
      const fixture = this.pool[index]!;
      const candidate = visible[index];
      fixture.group.visible = candidate !== undefined;
      if (candidate) fixture.group.position.copy(candidate.position);
    }
  }

  stats(): LuminaireLightingStats {
    return {
      discovered: [...this.candidatesByRoot.values()].reduce((total, values) => total + values.length, 0),
      active: this.pool.reduce((total, fixture) => total + Number(fixture.group.visible), 0),
      enabled: this.enabled,
    };
  }

  clear(): void {
    this.candidatesByRoot.clear();
    for (const fixture of this.pool) fixture.group.visible = false;
  }

  dispose(): void {
    this.clear();
    const first = this.pool[0]?.group.children[0] as Mesh | undefined;
    first?.geometry.dispose();
    (first?.material as MeshBasicMaterial | undefined)?.dispose();
    for (const fixture of this.pool) fixture.light.dispose();
    this.group.clear();
    this.group.removeFromParent();
  }
}

/** Camel boundaries become separators so anchored token matches survive Unreal name gluing. */
function splitCamelBoundaries(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

/**
 * World-space bulb anchor for an accepted fixture.
 *
 * Datasmith street lights carry the lamp head as a named descendant
 * (`Luminaire_Head01…`), which places the light at the arm's end instead of
 * over the pole. Fixtures without a named head fall back to top-center.
 */
function bulbPosition(fixture: Object3D, fixtureBounds: Box3): Vector3 {
  let head: Object3D | null = null;
  fixture.traverse((node) => {
    if (head || node === fixture || !node.name) return;
    if (LUMINAIRE_HEAD_NAME.test(splitCamelBoundaries(node.name))) head = node;
  });
  if (head) {
    const headBounds = new Box3().setFromObject(head);
    if (!headBounds.isEmpty()) return headBounds.getCenter(new Vector3());
  }
  return new Vector3(
    (fixtureBounds.min.x + fixtureBounds.max.x) / 2,
    fixtureBounds.max.y - BULB_INSET_M,
    (fixtureBounds.min.z + fixtureBounds.max.z) / 2,
  );
}

function hierarchyVisible(object: Object3D): boolean {
  for (let current: Object3D | null = object; current; current = current.parent) {
    if (!current.visible) return false;
  }
  return true;
}
